'use strict';

/**
 * @module dwm-core/protocol/translator
 *
 * Bidirectional translation between the modern (v2) command vocabulary used
 * throughout this package and the wire representation expected by a particular
 * firmware protocol version.
 *
 * Callers always speak v2. When a device turns out to only understand v1, the
 * translator rewrites outbound requests on the way down and normalises inbound
 * responses on the way back up, so no caller ever has to branch on version.
 *
 * Two things can differ between versions:
 *
 * 1. **Command names.** They are currently identical in v1 and v2, so the maps
 *    below are effectively identity maps. They exist so that a future rename is
 *    a single-line change rather than a refactor.
 * 2. **The `range` enumeration.** This genuinely differs - see
 *    {@link module:dwm-core/protocol/v1} and {@link module:dwm-core/protocol/v2}.
 */

const v1 = require('./v1');
const v2 = require('./v2');
const { normalizeToken } = require('../utils');

/**
 * Modern command name to its v1 equivalent.
 *
 * Only entries whose name actually differs need to be listed; anything absent
 * is passed through unchanged.
 *
 * @type {Readonly<Record<string, string>>}
 */
const MODERN_TO_LEGACY_COMMANDS = Object.freeze({
  // v1 and v2 share every command name. Add divergences here as they appear.
});

/**
 * Legacy command name to its modern equivalent.
 *
 * Derived automatically from {@link MODERN_TO_LEGACY_COMMANDS}.
 *
 * @type {Readonly<Record<string, string>>}
 */
const LEGACY_TO_MODERN_COMMANDS = Object.freeze(
  Object.fromEntries(
    Object.entries(MODERN_TO_LEGACY_COMMANDS).map(([modern, legacy]) => [
      legacy,
      modern,
    ]),
  ),
);

/**
 * Returns the version-specific range codec.
 *
 * @param {string} protocolVersion `'1'` or `'2'`.
 * @returns {typeof v1|typeof v2}
 */
function codecFor(protocolVersion) {
  return normalizeToken(protocolVersion) === v1.VERSION ? v1 : v2;
}

/**
 * Translates a command name from the modern vocabulary to the wire vocabulary.
 *
 * @param {string} command Modern command name, e.g. `pwr.snap`.
 * @param {string} protocolVersion Target protocol version.
 * @returns {string} Command name to place in the `cmd=` field.
 */
function toWireCommand(command, protocolVersion) {
  const name = normalizeToken(command);
  if (normalizeToken(protocolVersion) !== v1.VERSION) return name;
  return MODERN_TO_LEGACY_COMMANDS[name] || name;
}

/**
 * Translates a command name from the wire vocabulary to the modern vocabulary.
 *
 * @param {string} command Command name as it appeared in a frame.
 * @param {string} protocolVersion Protocol version the frame used.
 * @returns {string} Modern command name.
 */
function toModernCommand(command, protocolVersion) {
  const name = normalizeToken(command);
  if (normalizeToken(protocolVersion) !== v1.VERSION) return name;
  return LEGACY_TO_MODERN_COMMANDS[name] || name;
}

/**
 * Converts a gain multiplier into the range configuration integer understood by
 * the given protocol version.
 *
 * @param {number} multiplier Gain multiplier: 1, 2 or 4.
 * @param {string} protocolVersion Target protocol version.
 * @returns {number} Wire-encoded range configuration integer.
 */
function multiplierToWireRange(multiplier, protocolVersion) {
  return codecFor(protocolVersion).multiplierToRangeCfg(multiplier);
}

/**
 * Converts a range value received from a device into a gain multiplier.
 *
 * Textual labels such as `4x` are unambiguous and are honoured regardless of
 * version; bare integers are decoded using the version's enumeration.
 *
 * @param {string|number} value Value of the `range=` field.
 * @param {string} protocolVersion Protocol version the frame used.
 * @returns {number|null} Gain multiplier, or `null` when unparseable.
 */
function wireRangeToMultiplier(value, protocolVersion) {
  const raw = normalizeToken(value).toLowerCase();
  if (!raw) return null;

  // Textual labels carry the gain directly and need no version context.
  if (raw === '1x' || raw === 'x1') return 1;
  if (raw === '2x' || raw === 'x2') return 2;
  if (raw === '4x' || raw === 'x4') return 4;

  const codec = codecFor(protocolVersion);
  const cfg = codec.parseRangeCfg(raw);
  if (cfg === null) return null;
  return codec.rangeCfgToMultiplier(cfg);
}

/**
 * Re-encodes a range configuration integer from one protocol version to another.
 *
 * @param {number} cfg Range configuration integer in the source encoding.
 * @param {string} fromVersion Protocol version `cfg` is expressed in.
 * @param {string} toVersion Protocol version to convert to.
 * @returns {number} Range configuration integer in the target encoding.
 */
function translateRangeCfg(cfg, fromVersion, toVersion) {
  const multiplier = codecFor(fromVersion).rangeCfgToMultiplier(cfg);
  return codecFor(toVersion).multiplierToRangeCfg(multiplier);
}

/**
 * Rewrites an outbound request so it is valid for the target protocol version.
 *
 * Field values are otherwise passed through untouched; only `range`-bearing
 * fields are re-encoded.
 *
 * @param {object} request Modern request description.
 * @param {string} request.command Modern command name.
 * @param {object} [request.fields] Field map, values in modern encoding.
 * @param {string} protocolVersion Target protocol version.
 * @returns {{command: string, fields: object}} Wire-ready request.
 */
function translateRequest({ command, fields = {} }, protocolVersion) {
  const version = normalizeToken(protocolVersion) || v2.VERSION;
  const wireFields = { ...fields };

  // `cfg.set key=range val=N` carries the enumeration in `val`.
  if (
    normalizeToken(command) === 'cfg.set' &&
    normalizeToken(wireFields.key) === 'range' &&
    wireFields.val !== undefined &&
    wireFields.val !== null &&
    wireFields.val !== ''
  ) {
    const multiplier = wireRangeToMultiplier(wireFields.val, v2.VERSION);
    if (multiplier !== null) {
      wireFields.val = String(multiplierToWireRange(multiplier, version));
    }
  }

  // A bare `range=` field, used by some direct-set helpers.
  if (
    wireFields.range !== undefined &&
    wireFields.range !== null &&
    wireFields.range !== ''
  ) {
    const multiplier = wireRangeToMultiplier(wireFields.range, v2.VERSION);
    if (multiplier !== null) {
      wireFields.range = String(multiplierToWireRange(multiplier, version));
    }
  }

  return {
    command: toWireCommand(command, version),
    fields: wireFields,
  };
}

/**
 * Normalises an inbound frame into the modern vocabulary.
 *
 * The returned object is a shallow copy; the original frame is not mutated. The
 * `cmd` field is mapped to its modern name and any `range` field is rewritten to
 * its canonical textual label so downstream code never sees version-specific
 * integers.
 *
 * @param {import('../types').Frame} frame Parsed response frame.
 * @param {string} [protocolVersion] Version to decode with; defaults to the
 *   frame's own `proto=` value.
 * @returns {import('../types').Frame} Normalised frame.
 */
function translateResponse(frame, protocolVersion) {
  if (!frame || typeof frame !== 'object') return frame;

  const version =
    normalizeToken(protocolVersion) || normalizeToken(frame.proto) || v2.VERSION;
  const translated = { ...frame };

  if (translated.cmd) {
    translated.cmd = toModernCommand(translated.cmd, version);
  }

  if (
    translated.range !== undefined &&
    translated.range !== null &&
    translated.range !== ''
  ) {
    const multiplier = wireRangeToMultiplier(translated.range, version);
    if (multiplier !== null) translated.range = `${multiplier}x`;
  }

  // `cfg.get key=range` / `cfg.set key=range` return the enumeration in `val`.
  if (
    normalizeToken(translated.key) === 'range' &&
    translated.val !== undefined &&
    translated.val !== null &&
    translated.val !== ''
  ) {
    const multiplier = wireRangeToMultiplier(translated.val, version);
    if (multiplier !== null) {
      translated.val = String(v2.multiplierToRangeCfg(multiplier));
    }
  }

  return translated;
}

module.exports = {
  MODERN_TO_LEGACY_COMMANDS,
  LEGACY_TO_MODERN_COMMANDS,
  toWireCommand,
  toModernCommand,
  multiplierToWireRange,
  wireRangeToMultiplier,
  translateRangeCfg,
  translateRequest,
  translateResponse,
};
