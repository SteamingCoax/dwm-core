'use strict';

/**
 * @module dwm-core/serial
 *
 * Serial transport: device discovery, identity keying and a thin, promise-based
 * wrapper around `serialport`.
 *
 * Platform quirks handled here:
 *
 * - **macOS** exposes the USB location as `usbmodem<UID>` in the device path;
 *   that UID is the most stable identifier available.
 * - **Windows** frequently leaves `vendorId`/`productId` unpopulated but does
 *   populate `pnpId`, so both are checked, and the USB serial number is
 *   recovered from the `pnpId` tail.
 * - **Linux** behaves like macOS but without the `usbmodem` naming, so the port
 *   path is used as a last resort.
 * - Ports are opened with `autoOpen: false` and then opened explicitly so that
 *   open failures surface as rejected promises rather than uncatchable events.
 */

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');

const {
  DEFAULT_BAUD_RATE,
  DWM_USB_VENDOR_ID,
  DWM_USB_PRODUCT_ID,
  SerialError,
} = require('./types');
const { decodeSerialBuffer } = require('./utils');

/**
 * Extracts the macOS `usbmodem` unique identifier from a port path.
 *
 * @param {string} portPath Device path such as `/dev/tty.usbmodem205F33AE54421`.
 * @returns {string|null} The UID, or `null` when the path is not a usbmodem path.
 */
function parseUsbModemUid(portPath) {
  if (!portPath) return null;
  const match = String(portPath).match(/usbmodem([A-Za-z0-9]+)/i);
  return match ? match[1] : null;
}

/**
 * Reports whether a listed serial port is a DWM V2 meter.
 *
 * Four independent checks are applied, in decreasing order of confidence:
 *
 * 1. The USB product string contains `dwm v2` (set by all DWM V2 firmware and
 *    surfaced by `serialport` in `manufacturer` on every platform).
 * 2. The Windows friendly name contains `dwm v2`.
 * 3. `vendorId` is `0483` **and** `productId` is `5740`. Both are required, so
 *    unrelated STM32 CDC devices are not misidentified.
 * 4. The Windows `pnpId` contains both `VID_0483` and `PID_5740`, covering the
 *    case where the id fields are unpopulated.
 *
 * @param {import('./types').SerialPortInfo} port Port descriptor from {@link listPorts}.
 * @returns {boolean}
 */
function isDwmPort(port) {
  const manufacturer = (port?.manufacturer || '').toLowerCase();
  if (manufacturer.includes('dwm v2')) return true;

  const friendlyName = (port?.friendlyName || '').toLowerCase();
  if (friendlyName.includes('dwm v2')) return true;

  const vendorId = (port?.vendorId || '').toLowerCase().replace(/^0x/, '');
  const productId = (port?.productId || '').toLowerCase().replace(/^0x/, '');
  if (
    vendorId === DWM_USB_VENDOR_ID.toLowerCase() &&
    productId === DWM_USB_PRODUCT_ID.toLowerCase()
  ) {
    return true;
  }

  const pnpId = port?.pnpId || '';
  if (/VID_0483/i.test(pnpId) && /PID_5740/i.test(pnpId)) return true;

  return false;
}

/**
 * Derives a stable identity key for a port.
 *
 * The key survives the port path changing between reconnects, which happens
 * routinely on macOS and after a DFU cycle.
 *
 * @param {import('./types').SerialPortInfo} port Port descriptor.
 * @returns {string} Key of the form `usbmodem:<uid>`, `usbserial:<sn>` or `port:<path>`.
 */
function buildDeviceKey(port) {
  const usbModemUid = parseUsbModemUid(port?.path);
  if (usbModemUid) return `usbmodem:${usbModemUid}`;

  // pnpId format: USB\VID_xxxx&PID_xxxx\SERIAL
  const pnpId = port?.pnpId || '';
  const serialMatch = pnpId.match(/\\([A-Za-z0-9]+)$/);
  if (serialMatch && serialMatch[1].length >= 4) {
    return `usbserial:${serialMatch[1]}`;
  }

  if (port?.serialNumber && String(port.serialNumber).length >= 4) {
    return `usbserial:${port.serialNumber}`;
  }

  return `port:${port?.path || 'unknown'}`;
}

/**
 * Lists every serial port visible to the host.
 *
 * @returns {Promise<import('./types').SerialPortInfo[]>}
 * @throws {SerialError} When enumeration fails.
 */
async function listPorts() {
  try {
    return await SerialPort.list();
  } catch (error) {
    throw new SerialError(`Failed to list serial ports: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Discovers connected DWM devices.
 *
 * @param {object} [options={}] Discovery options.
 * @param {boolean} [options.all=false] When true, returns every serial port
 *   rather than only recognised DWM devices.
 * @returns {Promise<import('./types').DeviceInfo[]>} Discovered devices, each
 *   annotated with a stable `key` and the parsed `usbModemUid`.
 *
 * @example
 * const devices = await findDevices();
 * // [{ path: '/dev/tty.usbmodem205F33AE54421', key: 'usbmodem:205F33AE54421', ... }]
 */
async function findDevices(options = {}) {
  const ports = await listPorts();
  const candidates = options.all ? ports : ports.filter(isDwmPort);

  return candidates.map((port) => ({
    ...port,
    key: buildDeviceKey(port),
    usbModemUid: parseUsbModemUid(port.path),
  }));
}

/**
 * A promise-based serial connection that emits decoded text.
 *
 * Incoming bytes are decoded with the package's lenient UTF-8 reader and emitted
 * as `data` events carrying strings, not buffers.
 *
 * @fires SerialConnection#data
 * @fires SerialConnection#close
 * @fires SerialConnection#error
 */
class SerialConnection extends EventEmitter {
  /**
   * @param {string} portPath OS device path.
   * @param {object} [options={}] Connection options.
   * @param {number} [options.baudRate=115200] Baud rate.
   */
  constructor(portPath, options = {}) {
    super();

    if (!portPath || typeof portPath !== 'string') {
      throw new SerialError('A serial port path is required');
    }

    /** @type {string} */
    this.path = portPath;
    /** @type {number} */
    this.baudRate = options.baudRate || DEFAULT_BAUD_RATE;
    /** @type {import('serialport').SerialPort|null} */
    this.port = null;
  }

  /**
   * Whether the underlying port is currently open.
   *
   * @returns {boolean}
   */
  get isOpen() {
    return Boolean(this.port && this.port.isOpen);
  }

  /**
   * Opens the port.
   *
   * Resolves immediately when already open, so callers may treat this as
   * idempotent.
   *
   * @returns {Promise<void>}
   * @throws {SerialError} When the port cannot be opened.
   */
  async open() {
    if (this.isOpen) return;

    const port = new SerialPort({
      path: this.path,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    await new Promise((resolve, reject) => {
      port.open((error) => {
        if (error) {
          reject(
            new SerialError(
              `Failed to open ${this.path}: ${error.message}`,
              { path: this.path, cause: error },
            ),
          );
          return;
        }
        resolve();
      });
    });

    port.on('data', (chunk) => {
      /**
       * Decoded text received from the device.
       *
       * @event SerialConnection#data
       * @type {string}
       */
      this.emit('data', decodeSerialBuffer(chunk));
    });

    port.on('close', () => {
      this.port = null;
      /**
       * The port closed, either locally or because the device vanished.
       *
       * @event SerialConnection#close
       */
      this.emit('close');
    });

    port.on('error', (error) => {
      /**
       * A transport-level error occurred.
       *
       * @event SerialConnection#error
       * @type {SerialError}
       */
      this.emit(
        'error',
        new SerialError(`Serial error on ${this.path}: ${error.message}`, {
          path: this.path,
          cause: error,
        }),
      );
    });

    this.port = port;
  }

  /**
   * Writes raw text or bytes to the port.
   *
   * @param {string|Buffer} data Payload to write.
   * @returns {Promise<void>}
   * @throws {SerialError} When the port is closed or the write fails.
   */
  async write(data) {
    if (!this.isOpen) {
      throw new SerialError(`Serial port ${this.path} is not open`, {
        path: this.path,
      });
    }

    await new Promise((resolve, reject) => {
      this.port.write(data, (error) => {
        if (error) {
          reject(
            new SerialError(
              `Failed to write to ${this.path}: ${error.message}`,
              { path: this.path, cause: error },
            ),
          );
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Closes the port.
   *
   * Never rejects: closing an already-closed or already-vanished port is a
   * no-op, which keeps shutdown paths simple.
   *
   * @returns {Promise<void>}
   */
  async close() {
    const port = this.port;
    this.port = null;
    if (!port || !port.isOpen) return;

    await new Promise((resolve) => {
      port.close(() => resolve());
    });
  }
}

/**
 * Tracks several simultaneously open ports, keyed by path.
 *
 * This mirrors how the DWM-Control main process multiplexes ports for the
 * renderer, and is exported so any host application can reuse it.
 *
 * @fires SerialManager#data
 * @fires SerialManager#close
 * @fires SerialManager#error
 */
class SerialManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, SerialConnection>} */
    this.connections = new Map();
  }

  /**
   * Opens a port, replacing any existing connection at the same path.
   *
   * @param {string} portPath OS device path.
   * @param {number} [baudRate=115200] Baud rate.
   * @returns {Promise<SerialConnection>} The open connection.
   */
  async open(portPath, baudRate = DEFAULT_BAUD_RATE) {
    await this.close(portPath);

    const connection = new SerialConnection(portPath, { baudRate });

    connection.on('data', (text) => {
      /**
       * Decoded text received from one of the managed ports.
       *
       * @event SerialManager#data
       * @type {{portPath: string, data: string}}
       */
      this.emit('data', { portPath, data: text });
    });

    connection.on('close', () => {
      this.connections.delete(portPath);
      /**
       * A managed port closed.
       *
       * @event SerialManager#close
       * @type {{portPath: string}}
       */
      this.emit('close', { portPath });
    });

    connection.on('error', (error) => {
      this.connections.delete(portPath);
      /**
       * A managed port raised a transport error.
       *
       * @event SerialManager#error
       * @type {{portPath: string, error: SerialError}}
       */
      this.emit('error', { portPath, error });
    });

    await connection.open();
    this.connections.set(portPath, connection);
    return connection;
  }

  /**
   * Returns the connection for a path, if one is open.
   *
   * @param {string} portPath OS device path.
   * @returns {SerialConnection|undefined}
   */
  get(portPath) {
    return this.connections.get(portPath);
  }

  /**
   * Lists the paths of every currently managed port.
   *
   * @returns {string[]} Open port paths.
   */
  list() {
    return [...this.connections.keys()];
  }

  /**
   * Reports whether a path is currently open.
   *
   * @param {string} portPath OS device path.
   * @returns {boolean}
   */
  isOpen(portPath) {
    const connection = this.connections.get(portPath);
    return Boolean(connection && connection.isOpen);
  }

  /**
   * Writes to a managed port.
   *
   * @param {string} portPath OS device path.
   * @param {string|Buffer} data Payload to write.
   * @returns {Promise<void>}
   * @throws {SerialError} When the path is not open.
   */
  async write(portPath, data) {
    const connection = this.connections.get(portPath);
    if (!connection || !connection.isOpen) {
      throw new SerialError('Serial port not open', { path: portPath });
    }
    await connection.write(data);
  }

  /**
   * Closes one managed port, or all of them when no path is given.
   *
   * @param {string} [portPath] OS device path; omit to close everything.
   * @returns {Promise<void>}
   */
  async close(portPath) {
    if (portPath) {
      const connection = this.connections.get(portPath);
      this.connections.delete(portPath);
      if (connection) await connection.close();
      return;
    }

    const entries = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(entries.map((connection) => connection.close()));
  }
}

module.exports = {
  SerialConnection,
  SerialManager,
  findDevices,
  listPorts,
  isDwmPort,
  buildDeviceKey,
  parseUsbModemUid,
};
