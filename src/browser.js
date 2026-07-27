'use strict';

/**
 * Browser entry point.
 *
 * Exposes only the pure, dependency-free parts of the protocol layer so they
 * can be bundled for a renderer process. Nothing here touches `serialport`,
 * `fs`, `child_process` or any other Node built-in.
 *
 * Consumers load the bundled output as a plain script and use the global
 * `DWMProtocol`; see `scripts/build-browser.js`.
 */

const protocol = require('./protocol');

module.exports = {
  PROTOCOL_VERSION: protocol.PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION: protocol.LEGACY_PROTOCOL_VERSION,
  buildFrame: protocol.buildFrame,
  buildTranslatedFrame: protocol.buildTranslatedFrame,
  parseFrame: protocol.parseFrame,
  isSupportedProto: protocol.isSupportedProto,
  parseRangeMultiplier: protocol.parseRangeMultiplier,
  parseRangeCfg: protocol.parseRangeCfg,
  cfgToRangeMultiplier: protocol.cfgToRangeMultiplier,
  normalizeRange: protocol.normalizeRange,
  decodeSnapshot: protocol.decodeSnapshot,
};
