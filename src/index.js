'use strict';

/**
 * @module dwm-core
 *
 * Shared device, USB serial protocol and firmware-update core for DWM V2 power
 * meters.
 *
 * This package is pure Node.js: it has no Electron, DOM or IPC dependencies and
 * runs unchanged in a CLI, an Electron main process, a test harness or a server.
 *
 * @example <caption>Discover, connect, read, disconnect</caption>
 * const { Device, findDevices } = require('dwm-core');
 *
 * const [info] = await findDevices();
 * const device = new Device(info);
 * await device.open();
 *
 * console.log(await device.getStatus());
 * await device.setRange('4x');
 *
 * await device.close();
 *
 * @example <caption>Live monitoring</caption>
 * device.on('snapshot', (s) => console.log(s.avg.toFixed(3), 'W'));
 * device.startMonitoring({ intervalMs: 250 });
 *
 * @example <caption>Firmware update</caption>
 * const { FirmwareUpdater } = require('dwm-core');
 *
 * await device.enterDFU();
 * const updater = new FirmwareUpdater();
 * await updater.upload('firmware.hex', {
 *   progress: ({ percent }) => console.log(`${percent}%`),
 * });
 */

const protocol = require('./protocol');
const serial = require('./serial');
const firmware = require('./firmware');
const types = require('./types');
const utils = require('./utils');
const { Device, openFirstDevice } = require('./device');

module.exports = {
  // Primary abstractions
  Device,
  openFirstDevice,
  FirmwareUpdater: firmware.FirmwareUpdater,

  // Discovery and transport
  findDevices: serial.findDevices,
  listPorts: serial.listPorts,
  isDwmPort: serial.isDwmPort,
  buildDeviceKey: serial.buildDeviceKey,
  parseUsbModemUid: serial.parseUsbModemUid,
  SerialConnection: serial.SerialConnection,
  SerialManager: serial.SerialManager,

  // Firmware helpers
  parseHex: firmware.parseHex,
  convertHexFileToBin: firmware.convertHexFileToBin,
  parseDfuDevices: firmware.parseDfuDevices,
  listDfuDevices: firmware.listDfuDevices,
  resolveDfuUtilPath: firmware.resolveDfuUtilPath,
  checkWinUsbDriver: firmware.checkWinUsbDriver,

  // Errors
  DwmError: types.DwmError,
  SerialError: types.SerialError,
  NotConnectedError: types.NotConnectedError,
  TimeoutError: types.TimeoutError,
  ProtocolError: types.ProtocolError,
  FirmwareError: types.FirmwareError,

  // Namespaces
  protocol,
  serial,
  firmware,
  types,
  utils,

  // Frequently used constants, re-exported for convenience
  PROTOCOL_VERSION: types.PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION: types.LEGACY_PROTOCOL_VERSION,
  COMMANDS: types.COMMANDS,
  CONFIG_KEYS: types.CONFIG_KEYS,
  DEFAULT_BAUD_RATE: types.DEFAULT_BAUD_RATE,
  DEFAULT_TIMEOUT_MS: types.DEFAULT_TIMEOUT_MS,
  DEFAULT_PACING_MS: types.DEFAULT_PACING_MS,
  DEFAULT_POLL_INTERVAL_MS: types.DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PROBE_TIMEOUT_MS: types.DEFAULT_PROBE_TIMEOUT_MS,
  COMMAND_TIMEOUTS_MS: types.COMMAND_TIMEOUTS_MS,
  DFU_DETACH_DELAY_MS: types.DFU_DETACH_DELAY_MS,
};
