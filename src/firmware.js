'use strict';

/**
 * @module dwm-core/firmware
 *
 * Intel HEX parsing and DFU firmware upload.
 *
 * Uploading is delegated to `dfu-util`, which must either be on `PATH` or be
 * supplied as a bundled binary via the `searchPaths` option. The HEX to binary
 * conversion is performed in-process so no external toolchain is required for
 * that step.
 *
 * ## Intel HEX support
 *
 * The parser implements the subset the STM32 toolchain emits:
 *
 * | Record type | Meaning | Handling |
 * |-------------|---------|----------|
 * | `0x00` | Data | Written at `base + offset` |
 * | `0x01` | End of file | Terminates parsing |
 * | `0x02` | Extended segment address | Sets `base` to `value << 4` |
 * | `0x03` | Start segment address | Ignored |
 * | `0x04` | Extended linear address | Sets `base` to `value << 16` |
 * | `0x05` | Start linear address | Ignored |
 *
 * Gaps between records are filled with `0xFF`, matching erased flash.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  STM32_FLASH_BASE_ADDRESS,
  MAX_FIRMWARE_BYTES,
  DFU_USB_VENDOR_ID,
  DFU_USB_PRODUCT_ID,
  FirmwareError,
} = require('./types');

/**
 * `dfu-util` exit codes that indicate a successful upload.
 *
 * Code 74 is returned when the device detaches immediately after a `:leave`
 * transfer, which is the expected outcome here - but it is *also* returned when
 * no DFU device could be found at all. The exit code alone therefore cannot
 * distinguish "flashed and rebooted" from "did nothing", which is why
 * {@link DFU_FAILURE_PATTERN} is consulted as well.
 */
const DFU_SUCCESS_EXIT_CODES = Object.freeze([0, 74]);

/**
 * Output that unambiguously means no firmware was written, regardless of the
 * process exit code.
 *
 * Kept deliberately narrow so a genuine upload is never misreported as a
 * failure; each phrase is emitted by `dfu-util` only when nothing was flashed.
 */
const DFU_FAILURE_PATTERN =
  /No DFU capable USB device available|Cannot open DFU device|No DFU capable USB device found/i;

/**
 * Parses an Intel HEX image into a contiguous binary buffer.
 *
 * @param {string|Buffer} source HEX file contents.
 * @param {object} [options={}] Parsing options.
 * @param {number} [options.baseAddress=0x08000000] Address assumed to be the
 *   image origin when the file contains no lower address.
 * @param {number} [options.maxBytes=1048576] Largest accepted image.
 * @returns {{data: Buffer, startAddress: number, endAddress: number, size: number}}
 * @throws {FirmwareError} When the image is malformed or too large.
 *
 * @example
 * const { data, startAddress } = parseHex(fs.readFileSync('fw.hex'));
 */
function parseHex(source, options = {}) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source ?? '');
  const baseDefault = Number.isFinite(options.baseAddress)
    ? options.baseAddress
    : STM32_FLASH_BASE_ADDRESS;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? options.maxBytes
    : MAX_FIRMWARE_BYTES;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(':'));

  if (lines.length === 0) {
    throw new FirmwareError('No Intel HEX records found in firmware image');
  }

  // First pass: establish the address range spanned by the data records.
  let minAddress = baseDefault;
  let maxAddress = baseDefault;
  let base = 0;
  let sawData = false;

  for (const line of lines) {
    if (line.length < 11) continue;

    const recordType = parseInt(line.substr(7, 2), 16);

    if (recordType === 0x04) {
      base = parseInt(line.substr(9, 4), 16) << 16;
    } else if (recordType === 0x02) {
      base = parseInt(line.substr(9, 4), 16) << 4;
    } else if (recordType === 0x01) {
      break;
    } else if (recordType === 0x00) {
      const address = base + parseInt(line.substr(3, 4), 16);
      const length = parseInt(line.substr(1, 2), 16);
      if (!Number.isFinite(address) || !Number.isFinite(length)) continue;

      if (!sawData) {
        minAddress = address;
        maxAddress = address + length - 1;
        sawData = true;
      } else {
        minAddress = Math.min(minAddress, address);
        maxAddress = Math.max(maxAddress, address + length - 1);
      }
    }
  }

  if (!sawData) {
    throw new FirmwareError('Firmware image contains no data records');
  }

  const size = maxAddress - minAddress + 1;
  if (size > maxBytes) {
    throw new FirmwareError(`Firmware too large: ${size} bytes`, {
      size,
      maxBytes,
    });
  }

  // Second pass: materialise the image, leaving unwritten gaps erased.
  const data = Buffer.alloc(size, 0xff);
  base = 0;

  for (const line of lines) {
    if (line.length < 11) continue;

    const recordType = parseInt(line.substr(7, 2), 16);

    if (recordType === 0x04) {
      base = parseInt(line.substr(9, 4), 16) << 16;
    } else if (recordType === 0x02) {
      base = parseInt(line.substr(9, 4), 16) << 4;
    } else if (recordType === 0x01) {
      break;
    } else if (recordType === 0x00) {
      const address = base + parseInt(line.substr(3, 4), 16);
      const length = parseInt(line.substr(1, 2), 16);

      for (let i = 0; i < length; i++) {
        const byte = parseInt(line.substr(9 + i * 2, 2), 16);
        const index = address + i - minAddress;
        if (index >= 0 && index < data.length) data[index] = byte;
      }
    }
  }

  return {
    data,
    startAddress: minAddress,
    endAddress: maxAddress,
    size: data.length,
  };
}

/**
 * Converts an Intel HEX file into a temporary binary file.
 *
 * The caller owns the returned file and is responsible for deleting it.
 *
 * @param {string} hexFilePath Path to the `.hex` file.
 * @param {object} [options={}] Passed through to {@link parseHex}.
 * @returns {Promise<string>} Path to the written `.bin` file.
 * @throws {FirmwareError} When the file cannot be read or parsed.
 */
async function convertHexFileToBin(hexFilePath, options = {}) {
  let contents;
  try {
    contents = await fs.promises.readFile(hexFilePath, 'utf8');
  } catch (error) {
    throw new FirmwareError(
      `Could not read firmware file ${hexFilePath}: ${error.message}`,
      { cause: error },
    );
  }

  const { data } = parseHex(contents, options);
  const binPath = path.join(
    os.tmpdir(),
    `firmware_temp_${Date.now()}_${process.pid}.bin`,
  );

  await fs.promises.writeFile(binPath, data);
  return binPath;
}

/**
 * Parses the output of `dfu-util -l` into a device list.
 *
 * Devices exposing several alternate settings are collapsed to one entry each,
 * preferring `alt=0` or an interface named "Internal Flash", which is the
 * setting the main application flash lives behind.
 *
 * @param {string} output Combined stdout and stderr from `dfu-util -l`.
 * @returns {Array<{vid: string, pid: string, serial: string, alt: number, name: string, description: string}>}
 */
function parseDfuDevices(output) {
  const found = [];
  const lines = String(output ?? '').split(/\r?\n/);

  for (const line of lines) {
    if (!line.includes('Found DFU')) continue;

    const match = line.match(/Found DFU: \[([0-9a-f]{4}):([0-9a-f]{4})\]/i);
    if (!match) continue;

    let serial = 'unknown';
    const quotedSerial = line.match(/serial="([^"]+)"/);
    if (quotedSerial) {
      serial = quotedSerial[1];
    } else {
      const bareSerial = line.match(/serial=([^\s,]+)/);
      if (bareSerial) serial = bareSerial[1];
    }

    const altMatch = line.match(/alt=(\d+)/);
    const nameMatch = line.match(/name="([^"]+)"/);

    found.push({
      vid: match[1],
      pid: match[2],
      serial,
      alt: altMatch ? parseInt(altMatch[1], 10) : 0,
      name: nameMatch ? nameMatch[1] : '',
      description: line.trim(),
    });
  }

  const byDevice = {};
  for (const device of found) {
    const id = `${device.vid}:${device.pid}:${device.serial}`;
    const isPreferred =
      device.alt === 0 || device.name.toLowerCase().includes('internal flash');
    if (!byDevice[id] || isPreferred) byDevice[id] = device;
  }

  return Object.values(byDevice);
}

/**
 * Locates a usable `dfu-util` executable.
 *
 * Candidate paths are probed in order and the first executable file wins; on
 * POSIX systems the file is also made executable, because binaries extracted
 * from an application bundle frequently lose that bit. When no candidate
 * matches, the bare command name is returned so the system `PATH` is used.
 *
 * @param {object} [options={}] Resolution options.
 * @param {string[]} [options.searchPaths=[]] Directories to probe. Each is
 *   checked for `dfu-util`, `dfu-util.exe`, `Programs/dfu-util/dfu-util` and the
 *   platform/arch-specific variants.
 * @param {string} [options.command] Explicit executable path, bypassing the search.
 * @returns {string} Path to `dfu-util`, or the bare command name.
 */
function resolveDfuUtilPath(options = {}) {
  if (options.command) return options.command;

  const isWindows = process.platform === 'win32';
  const executable = isWindows ? 'dfu-util.exe' : 'dfu-util';
  const searchPaths = Array.isArray(options.searchPaths)
    ? options.searchPaths
    : [];

  const candidates = [];
  for (const base of searchPaths) {
    if (!base) continue;
    candidates.push(path.join(base, executable));
    candidates.push(path.join(base, 'Programs', 'dfu-util', executable));
    candidates.push(
      path.join(base, 'app.asar.unpacked', 'Programs', 'dfu-util', executable),
    );
    candidates.push(
      path.join(base, 'resources', 'Programs', 'dfu-util', executable),
    );
    candidates.push(
      path.join(
        base,
        'resources',
        'app.asar.unpacked',
        'Programs',
        'dfu-util',
        executable,
      ),
    );

    if (process.platform === 'linux') {
      candidates.push(
        path.join(
          base,
          'Programs',
          'dfu-util',
          `linux-${process.arch}`,
          executable,
        ),
      );
      candidates.push(
        path.join(
          base,
          'app.asar.unpacked',
          'Programs',
          'dfu-util',
          `linux-${process.arch}`,
          executable,
        ),
      );
    }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      if (!isWindows) {
        try {
          fs.chmodSync(candidate, 0o755);
        } catch {
          // Read-only install locations are fine as long as the bit is already set.
        }
      }
      return candidate;
    } catch {
      // Unreadable candidates are simply skipped.
    }
  }

  return executable;
}

/**
 * Runs `dfu-util`, streaming its combined output.
 *
 * @param {string} command Executable path.
 * @param {string[]} args Arguments.
 * @param {(line: string) => void} [onOutput] Called for each output chunk.
 * @returns {Promise<{code: number|null, output: string}>}
 * @throws {FirmwareError} When the executable cannot be launched.
 */
function runDfuUtil(command, args, onOutput) {
  return new Promise((resolve, reject) => {
    let child;

    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      reject(
        new FirmwareError(`Failed to run dfu-util: ${error.message}`, {
          cause: error,
        }),
      );
      return;
    }

    let output = '';
    const collect = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (onOutput) onOutput(text);
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (error) => {
      reject(
        new FirmwareError(`Failed to run dfu-util: ${error.message}`, {
          cause: error,
          command,
        }),
      );
    });

    child.on('close', (code) => resolve({ code, output }));
  });
}

/**
 * Lists devices currently in DFU mode.
 *
 * `dfu-util` writes its findings to stdout on some platforms and stderr on
 * others (notably ARM Linux builds), so both streams are merged before parsing.
 *
 * @param {object} [options={}] Options forwarded to {@link resolveDfuUtilPath}.
 * @returns {Promise<{success: boolean, devices: Array<object>, output: string, error?: string}>}
 */
async function listDfuDevices(options = {}) {
  const command = resolveDfuUtilPath(options);

  try {
    const { output } = await runDfuUtil(command, ['-l'], options.onOutput);
    const devices = parseDfuDevices(output);
    return { success: true, devices, output };
  } catch (error) {
    return {
      success: false,
      devices: [],
      output: '',
      error: error.message,
    };
  }
}

/**
 * Uploads firmware to a device in DFU mode.
 *
 * @fires FirmwareUpdater#progress
 * @fires FirmwareUpdater#log
 *
 * @example
 * const updater = new FirmwareUpdater({ searchPaths: [app.getAppPath()] });
 * await updater.upload('firmware.hex', {
 *   progress: (p) => console.log(`${p.percent}%`),
 *   log: (line) => process.stdout.write(line),
 * });
 */
class FirmwareUpdater extends EventEmitter {
  /**
   * @param {object} [options={}] Updater options.
   * @param {string[]} [options.searchPaths] Directories to probe for a bundled
   *   `dfu-util`.
   * @param {string} [options.command] Explicit `dfu-util` path.
   * @param {number} [options.flashAddress=0x08000000] Target flash address.
   */
  constructor(options = {}) {
    super();
    /** @type {object} */
    this.options = options;
    /** @type {number} */
    this.flashAddress = Number.isFinite(options.flashAddress)
      ? options.flashAddress
      : STM32_FLASH_BASE_ADDRESS;
  }

  /**
   * Resolves the `dfu-util` executable this updater will use.
   *
   * @returns {string}
   */
  resolveCommand() {
    return resolveDfuUtilPath(this.options);
  }

  /**
   * Lists devices currently in DFU mode.
   *
   * @returns {Promise<{success: boolean, devices: Array<object>, output: string, error?: string}>}
   */
  async listDevices() {
    return listDfuDevices(this.options);
  }

  /**
   * Writes a firmware image to the device and reboots it.
   *
   * Accepts a path to a `.hex` file, or a `Buffer` containing either HEX text or
   * an already-converted binary image. The image is written to a temporary file
   * which is always removed, including on failure.
   *
   * @param {string|Buffer} hexPathOrBuffer Firmware source.
   * @param {object} [options={}] Upload options.
   * @param {(progress: {percent: number, phase: string, raw: string}) => void} [options.progress]
   *   Called as `dfu-util` reports erase and download progress.
   * @param {(line: string) => void} [options.log] Called for every output chunk.
   * @param {boolean} [options.binary=false] Treat a `Buffer` input as a raw
   *   binary image rather than HEX text.
   * @param {boolean} [options.reboot=true] Append `:leave` and `-R` so the device
   *   restarts into the new firmware.
   * @returns {Promise<{success: boolean, output: string, size: number, error?: string}>}
   * @throws {FirmwareError} When the image cannot be prepared.
   */
  async upload(hexPathOrBuffer, options = {}) {
    const binPath = await this._prepareImage(hexPathOrBuffer, options);
    const size = (await fs.promises.stat(binPath)).size;
    const command = this.resolveCommand();

    const target = options.reboot === false
      ? `0x${this.flashAddress.toString(16).padStart(8, '0')}`
      : `0x${this.flashAddress.toString(16).padStart(8, '0')}:leave`;

    const args = ['-a', '0', '-i', '0', '-D', binPath, '-s', target];
    if (options.reboot !== false) args.push('-R');

    const onOutput = (text) => {
      /**
       * A chunk of `dfu-util` output.
       *
       * @event FirmwareUpdater#log
       * @type {string}
       */
      this.emit('log', text);
      if (options.log) options.log(text);

      const progress = this._parseProgress(text);
      if (progress) {
        /**
         * Upload progress.
         *
         * @event FirmwareUpdater#progress
         * @type {{percent: number, phase: string, raw: string}}
         */
        this.emit('progress', progress);
        if (options.progress) options.progress(progress);
      }
    };

    try {
      const { code, output } = await runDfuUtil(command, args, onOutput);

      if (DFU_FAILURE_PATTERN.test(output)) {
        return {
          success: false,
          output,
          size,
          error:
            'No device in DFU mode was found. Put the meter into DFU mode and try again.',
        };
      }

      if (DFU_SUCCESS_EXIT_CODES.includes(code)) {
        return { success: true, output, size };
      }

      return {
        success: false,
        output,
        size,
        error: `Upload failed with code ${code}`,
      };
    } catch (error) {
      return { success: false, output: '', size, error: error.message };
    } finally {
      await fs.promises.unlink(binPath).catch(() => {});
    }
  }

  /**
   * Materialises the upload source as a temporary binary file.
   *
   * @param {string|Buffer} source Firmware source.
   * @param {object} options Upload options.
   * @returns {Promise<string>} Path to the temporary `.bin`.
   * @private
   */
  async _prepareImage(source, options) {
    if (Buffer.isBuffer(source)) {
      const data = options.binary ? source : parseHex(source).data;
      const binPath = path.join(
        os.tmpdir(),
        `firmware_temp_${Date.now()}_${process.pid}.bin`,
      );
      await fs.promises.writeFile(binPath, data);
      return binPath;
    }

    if (typeof source !== 'string' || source.length === 0) {
      throw new FirmwareError(
        'Firmware source must be a file path or a Buffer',
      );
    }

    return convertHexFileToBin(source);
  }

  /**
   * Extracts a percentage from a line of `dfu-util` output.
   *
   * @param {string} text Output chunk.
   * @returns {{percent: number, phase: string, raw: string}|null}
   * @private
   */
  _parseProgress(text) {
    const line = String(text ?? '');
    const match = line.match(/(\d{1,3})%/);
    if (!match) return null;

    const percent = Math.max(0, Math.min(100, parseInt(match[1], 10)));
    const phase = /erase/i.test(line)
      ? 'erase'
      : /download/i.test(line)
        ? 'download'
        : 'transfer';

    return { percent, phase, raw: line };
  }
}

/**
 * Checks whether a WinUSB driver is bound to the DFU interface.
 *
 * Always reports `installed: true` off Windows, where no driver step exists.
 *
 * @returns {Promise<{installed: boolean, output?: string}>}
 */
async function checkWinUsbDriver() {
  if (process.platform !== 'win32') return { installed: true };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('pnputil', ['/enum-devices', '/connected'], {
        windowsHide: true,
      });
    } catch {
      resolve({ installed: false });
      return;
    }

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ installed: false }));
    child.on('close', () => {
      const installed =
        /WinUSB/i.test(output) &&
        new RegExp(DFU_USB_VENDOR_ID, 'i').test(output);
      resolve({ installed, output });
    });
  });
}

module.exports = {
  FirmwareUpdater,
  parseHex,
  convertHexFileToBin,
  parseDfuDevices,
  listDfuDevices,
  resolveDfuUtilPath,
  checkWinUsbDriver,
  DFU_SUCCESS_EXIT_CODES,
  DFU_FAILURE_PATTERN,
  DFU_USB_VENDOR_ID,
  DFU_USB_PRODUCT_ID,
};
