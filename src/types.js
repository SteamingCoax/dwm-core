'use strict';

/**
 * @module dwm-core/types
 *
 * Shared constants, enumerations and error classes for the DWM V2 USB API.
 *
 * This module contains no I/O and no side effects; it is safe to require from
 * anywhere (main process, worker, browser bundler, test harness).
 */

/** Modern protocol version spoken by current firmware. */
const PROTOCOL_VERSION = '2';

/** Legacy protocol version retained for older firmware. */
const LEGACY_PROTOCOL_VERSION = '1';

/** Every protocol version this package can speak. */
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
]);

/** Default USB CDC baud rate for DWM V2 meters. */
const DEFAULT_BAUD_RATE = 115200;

/** Default per-request timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Default delay inserted before each write, in milliseconds.
 *
 * The firmware's USB CDC endpoint drops frames when they arrive back-to-back,
 * so every request is paced. Historically this was the app's
 * `globalApiPacingMs` setting.
 */
const DEFAULT_PACING_MS = 100;

/** Default snapshot polling interval, in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Per-command timeout overrides, in milliseconds.
 *
 * Some commands cannot meet the default deadline on every meter, so the
 * original application gave them their own budgets. Those values are preserved
 * here rather than in the caller, so every consumer inherits them:
 *
 * - `sys.fw` can be slow to answer on older firmware, which is why it was given
 *   3000 ms. A healthy FW 2.6.5 unit replies in ~23 ms, so this is headroom
 *   rather than an expected latency.
 * - `sys.rst` and `sys.dfu` reboot the device, so a reply may never arrive at
 *   all. Their shorter budget makes the inevitable timeout quick; see
 *   `Device#_fireAndForget`, which treats it as success.
 *
 * A caller-supplied `timeoutMs` always wins over these values.
 */
const COMMAND_TIMEOUTS_MS = Object.freeze({
  'sys.fw': 3000,
  'sys.rst': 1000,
  'sys.dfu': 1000,
});

/**
 * Delay between `sys.dfu` being accepted and the port being closed.
 *
 * The device needs time to detach and re-enumerate as a DFU device. Closing the
 * port too eagerly can interrupt that, so the original application's 1200 ms
 * settling period is preserved.
 */
const DFU_DETACH_DELAY_MS = 1200;

/** Timeout for each protocol probe performed while opening a connection. */
const DEFAULT_PROBE_TIMEOUT_MS = 2500;

/** USB vendor ID of the STM32 CDC interface used by DWM V2 meters. */
const DWM_USB_VENDOR_ID = '0483';

/**
 * USB product ID of the DWM V2 CDC (application/run) interface on firmware
 * released before ST assigned the meter its own PID (ST's generic CDC PID).
 */
const DWM_USB_PRODUCT_ID = '5740';

/** USB product ID assigned by STMicroelectronics to the DWM V2. */
const DWM_USB_ASSIGNED_PRODUCT_ID = 'A59C';

/**
 * Every USB product ID a DWM V2 may present in normal operation, oldest first.
 * All are under {@link DWM_USB_VENDOR_ID}.
 */
const DWM_USB_PRODUCT_IDS = Object.freeze([DWM_USB_PRODUCT_ID, DWM_USB_ASSIGNED_PRODUCT_ID]);

/** USB vendor ID presented while the device is in DFU mode. */
const DFU_USB_VENDOR_ID = '0483';

/** USB product ID presented while the device is in DFU mode. */
const DFU_USB_PRODUCT_ID = 'DF11';

/** Start address of the STM32 internal flash bank the firmware is written to. */
const STM32_FLASH_BASE_ADDRESS = 0x08000000;

/** Largest firmware image accepted by {@link module:dwm-core/firmware}. */
const MAX_FIRMWARE_BYTES = 1024 * 1024;

/**
 * Field order of the compact `d=` CSV payload returned by `pwr.snap`.
 *
 * `pvolt` is reported in millivolts and `svolt` in volts; every other field is
 * in watts.
 */
const SNAPSHOT_FIELD_ORDER = Object.freeze([
  'inst',
  'avg',
  'peak',
  'max',
  'min',
  'dev',
  'pvolt',
  'svolt',
]);

/** Metrics accepted by the `met=` field of `pwr.get`. */
const POWER_METRICS = Object.freeze([
  'inst',
  'avg',
  'peak',
  'max',
  'min',
  'dev',
]);

/** Every command name in the v1/v2 USB API. */
const COMMANDS = Object.freeze({
  POWER_GET: 'pwr.get',
  POWER_SNAPSHOT: 'pwr.snap',
  POWER_INFO: 'pwr.info',
  SYSTEM_ID: 'sys.id',
  SYSTEM_FIRMWARE: 'sys.fw',
  SYSTEM_NAME_GET: 'sys.nget',
  SYSTEM_NAME_SET: 'sys.nset',
  SYSTEM_COMMANDS: 'sys.cmds',
  SYSTEM_DFU: 'sys.dfu',
  SYSTEM_SAVE: 'sys.save',
  SYSTEM_RESET: 'sys.rst',
  CONFIG_GET: 'cfg.get',
  CONFIG_SET: 'cfg.set',
  CONFIG_ELEMENT: 'cfg.elem',
  CONFIG_ELEMENTS: 'cfg.elems',
});

/** Configuration keys accepted by `cfg.get` / `cfg.set`. */
const CONFIG_KEYS = Object.freeze({
  BRIGHTNESS: 'bright',
  AVERAGING_WINDOW: 'avgw',
  ELEMENT: 'elem',
  ELEMENT_RATING: 'eval',
  ELEMENT_TYPE: 'etype',
  RANGE: 'range',
});

/**
 * Config keys that address a specific element and therefore require an `elem`
 * field to be sent alongside `val`.
 */
const ELEMENT_SCOPED_CONFIG_KEYS = Object.freeze([
  CONFIG_KEYS.ELEMENT_RATING,
  CONFIG_KEYS.ELEMENT_TYPE,
]);

/** Lowest addressable element index. */
const MIN_ELEMENT = 1;

/** Highest addressable element index. */
const MAX_ELEMENT = 8;

/** Lowest accepted display brightness. */
const MIN_BRIGHTNESS = 0;

/** Highest accepted display brightness. */
const MAX_BRIGHTNESS = 10;

/** Human-readable descriptions for each firmware error code. */
const ERROR_CODE_DESCRIPTIONS = Object.freeze({
  ERR_BAD_FRAME: 'Frame could not be parsed as key=value tokens',
  ERR_MISSING_KEY: 'A required key was absent from the frame',
  ERR_UNKNOWN_CMD: 'Command not recognised by firmware',
  ERR_UNKNOWN_METRIC: 'Metric name is not supported',
  ERR_BAD_ENUM: 'A key had an unsupported value',
  ERR_BAD_VALUE: 'A value could not be parsed',
  ERR_VALUE_RANGE: 'Numeric value was out of the accepted range',
  ERR_SETTING_REJECTED: 'Firmware rejected the setting',
  ERR_BUSY: 'Device is temporarily unable to service the command',
  ERR_INTERNAL: 'Internal firmware error',
});

/**
 * Matches error messages that indicate the device may only speak the legacy
 * protocol, and that a proto=1 retry is therefore worth attempting.
 */
const LEGACY_FALLBACK_PATTERN =
  /timed out|Failed to write|ERR_(UNKNOWN_CMD|BAD_FRAME|BAD_ENUM)/i;

/** Base class for every error thrown by this package. */
class DwmError extends Error {
  /**
   * @param {string} message Human-readable description.
   * @param {object} [details] Arbitrary structured context.
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'DwmError';
    this.details = details;
  }
}

/** Raised when a serial port cannot be opened, written to or closed. */
class SerialError extends DwmError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'SerialError';
  }
}

/** Raised when an operation requires an open connection but none exists. */
class NotConnectedError extends DwmError {
  constructor(message = 'Device is not connected', details = {}) {
    super(message, details);
    this.name = 'NotConnectedError';
  }
}

/** Raised when the device does not answer a request within its timeout. */
class TimeoutError extends DwmError {
  /**
   * @param {string} command Command that timed out.
   * @param {number} timeoutMs Timeout that elapsed.
   */
  constructor(command, timeoutMs) {
    super(`${command} timed out after ${timeoutMs}ms`, { command, timeoutMs });
    this.name = 'TimeoutError';
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

/** Raised when the device answers with `type=err`. */
class ProtocolError extends DwmError {
  /**
   * @param {string} message Human-readable description.
   * @param {object} [details] Structured context.
   * @param {string} [details.code] Firmware `ERR_*` code.
   * @param {string} [details.command] Command that failed.
   * @param {object} [details.frame] Raw parsed response frame.
   */
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'ProtocolError';
    this.code = details.code || null;
    this.command = details.command || null;
    this.frame = details.frame || null;
  }
}

/** Raised when firmware parsing, DFU discovery or DFU upload fails. */
class FirmwareError extends DwmError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'FirmwareError';
  }
}

/**
 * @typedef {object} SerialPortInfo
 * @property {string} path OS device path, e.g. `/dev/tty.usbmodem1234` or `COM4`.
 * @property {string} [manufacturer] USB manufacturer/product string.
 * @property {string} [serialNumber] USB serial number.
 * @property {string} [vendorId] Four hex digits, no `0x` prefix.
 * @property {string} [productId] Four hex digits, no `0x` prefix.
 * @property {string} [pnpId] Windows PnP identifier.
 * @property {string} [friendlyName] Windows friendly name.
 */

/**
 * @typedef {SerialPortInfo} DeviceInfo
 * @property {string} key Stable identity key, e.g. `usbserial:205F33AE5442`.
 * @property {string|null} usbModemUid macOS `usbmodem` suffix, when present.
 */

/**
 * @typedef {object} Frame
 * @property {string} raw Original line, without its trailing CR/LF.
 * @property {string} [proto] Protocol version the device replied with.
 * @property {string} [type] `cmd`, `resp` or `err`.
 * @property {string} [status] `ok` or `error`.
 * @property {string} [cmd] Command name.
 * @property {string} [req] Request identifier.
 * @property {string} [code] Firmware error code, on `type=err`.
 * @property {string} [msg] Firmware error detail, on `type=err`.
 */

/**
 * @typedef {object} RangeInfo
 * @property {number} cfg Protocol-native range configuration integer.
 * @property {number} multiplier ADC gain multiplier: 1, 2 or 4.
 * @property {string} label Human label: `1x`, `2x` or `4x`.
 */

/**
 * @typedef {object} ElementProfile
 * @property {number} elem Element index, 1-8.
 * @property {number} eval Full-scale rating, in watts.
 * @property {string} etype Element type, e.g. `30ua`.
 */

/**
 * @typedef {object} Snapshot
 * @property {number} inst Instantaneous power, in watts.
 * @property {number} avg Averaged power, in watts.
 * @property {number} peak Peak envelope power, in watts.
 * @property {number} max Maximum observed power, in watts.
 * @property {number} min Minimum observed power, in watts.
 * @property {number} dev Standard deviation, in watts.
 * @property {number} pvolt Probe voltage, in millivolts.
 * @property {number} svolt Supply voltage, in volts.
 * @property {number} elem Active element index.
 * @property {string} etype Active element type.
 * @property {number} eval Active element rating, in watts.
 * @property {RangeInfo} range Active ADC range.
 * @property {number} maxPowerW `eval * range.multiplier`.
 * @property {number} timestamp `Date.now()` at decode time.
 * @property {Frame} frame Raw response frame.
 */

module.exports = {
  PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  DEFAULT_BAUD_RATE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PACING_MS,
  DEFAULT_POLL_INTERVAL_MS,
  COMMAND_TIMEOUTS_MS,
  DFU_DETACH_DELAY_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DWM_USB_VENDOR_ID,
  DWM_USB_PRODUCT_ID,
  DWM_USB_ASSIGNED_PRODUCT_ID,
  DWM_USB_PRODUCT_IDS,
  DFU_USB_VENDOR_ID,
  DFU_USB_PRODUCT_ID,
  STM32_FLASH_BASE_ADDRESS,
  MAX_FIRMWARE_BYTES,
  SNAPSHOT_FIELD_ORDER,
  POWER_METRICS,
  COMMANDS,
  CONFIG_KEYS,
  ELEMENT_SCOPED_CONFIG_KEYS,
  MIN_ELEMENT,
  MAX_ELEMENT,
  MIN_BRIGHTNESS,
  MAX_BRIGHTNESS,
  ERROR_CODE_DESCRIPTIONS,
  LEGACY_FALLBACK_PATTERN,
  DwmError,
  SerialError,
  NotConnectedError,
  TimeoutError,
  ProtocolError,
  FirmwareError,
};
