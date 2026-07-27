'use strict';

/**
 * @module dwm-core/protocol
 *
 * Pure, stateless encoding and decoding of the DWM V2 USB API.
 *
 * ## Framing
 *
 * Every frame is a single line of space-separated `key=value` tokens terminated
 * by CRLF:
 *
 * ```text
 * proto=2 type=cmd  cmd=<command> [req=<id>] [key=value ...]\r\n
 * proto=2 type=resp status=ok    cmd=<command> [req=<id>] <payload>\r\n
 * proto=2 type=err  status=error cmd=<command> [req=<id>] code=<ERR_*> msg=<detail>\r\n
 * ```
 *
 * There is no checksum, length prefix or byte stuffing: the line terminator is
 * the only delimiter, which is why a lenient UTF-8 decoder and a line-oriented
 * reassembler are used on the receiving side.
 *
 * Nothing in this module performs I/O.
 */

const v1 = require('./v1');
const v2 = require('./v2');
const translator = require('./translator');
const {
  normalizeToken,
  toFiniteNumber,
  toFiniteInt,
  splitLines,
} = require('../utils');
const {
  PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SNAPSHOT_FIELD_ORDER,
  ERROR_CODE_DESCRIPTIONS,
  ELEMENT_SCOPED_CONFIG_KEYS,
  MIN_ELEMENT,
  MAX_ELEMENT,
  ProtocolError,
} = require('../types');

/**
 * Reports whether a protocol version is one this package can speak.
 *
 * @param {string|number} proto Version to test.
 * @returns {boolean}
 */
function isSupportedProto(proto) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(normalizeToken(proto));
}

/**
 * Coerces a value to a supported protocol version.
 *
 * @param {string|number} value Candidate version.
 * @param {string} [fallback=PROTOCOL_VERSION] Version used when `value` is invalid.
 * @returns {string} `'1'` or `'2'`.
 */
function normalizeProtocolVersion(value, fallback = PROTOCOL_VERSION) {
  const version = normalizeToken(value);
  if (isSupportedProto(version)) return version;
  return normalizeToken(fallback) === LEGACY_PROTOCOL_VERSION
    ? LEGACY_PROTOCOL_VERSION
    : PROTOCOL_VERSION;
}

/**
 * Serialises a request frame.
 *
 * Fields whose value is `undefined`, `null` or the empty string are omitted, so
 * callers can pass optional fields unconditionally. Key order is preserved,
 * which matters for `cfg.set`, where the firmware expects `elem` before `val`.
 *
 * @param {string} command Command name for the `cmd=` field.
 * @param {string|number} [requestId] Correlation id for the `req=` field.
 * @param {Record<string, *>} [fields={}] Additional fields, in emission order.
 * @param {string} [protocolVersion=PROTOCOL_VERSION] Protocol version to emit.
 * @returns {string} A complete CRLF-terminated frame.
 *
 * @example
 * buildFrame('pwr.snap', '101', { met: 'avg' });
 * // => 'proto=2 type=cmd cmd=pwr.snap req=101 met=avg\r\n'
 */
function buildFrame(
  command,
  requestId,
  fields = {},
  protocolVersion = PROTOCOL_VERSION,
) {
  const version = normalizeToken(protocolVersion) || PROTOCOL_VERSION;
  const tokens = [
    ['proto', isSupportedProto(version) ? version : PROTOCOL_VERSION],
    ['type', 'cmd'],
    ['cmd', String(command || '')],
  ];

  if (
    requestId !== undefined &&
    requestId !== null &&
    String(requestId).length > 0
  ) {
    tokens.push(['req', String(requestId)]);
  }

  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    tokens.push([key, String(value)]);
  });

  return `${tokens.map(([key, value]) => `${key}=${value}`).join(' ')}\r\n`;
}

/**
 * Serialises a request frame, applying version-specific translation first.
 *
 * Prefer this over {@link buildFrame} when the command originates from the
 * modern (v2) vocabulary and may be sent to a legacy device.
 *
 * @param {string} command Modern command name.
 * @param {string|number} [requestId] Correlation id.
 * @param {Record<string, *>} [fields={}] Fields in modern encoding.
 * @param {string} [protocolVersion=PROTOCOL_VERSION] Target protocol version.
 * @returns {string} A complete CRLF-terminated frame.
 */
function buildTranslatedFrame(
  command,
  requestId,
  fields = {},
  protocolVersion = PROTOCOL_VERSION,
) {
  const version = normalizeProtocolVersion(protocolVersion);
  const wire = translator.translateRequest({ command, fields }, version);
  return buildFrame(wire.command, requestId, wire.fields, version);
}

/**
 * Parses a single frame line into a field map.
 *
 * Tokens are split on spaces and each token on its **first** `=`, so values may
 * themselves contain `=`. Tokens without a leading key are ignored. The original
 * line is preserved on the `raw` property.
 *
 * @param {string} line One line of device output, without its terminator.
 * @returns {import('../types').Frame} Parsed frame.
 */
function parseFrame(line) {
  const frame = { raw: String(line ?? '') };

  frame.raw.split(' ').forEach((token) => {
    const separator = token.indexOf('=');
    if (separator <= 0) return;
    frame[token.slice(0, separator)] = token.slice(separator + 1);
  });

  return frame;
}

/**
 * Reports whether a line looks like a protocol frame.
 *
 * The device also emits free-form boot and diagnostic text, which must be
 * ignored rather than parsed.
 *
 * @param {string} line Candidate line.
 * @returns {boolean}
 */
function isFrameLine(line) {
  return String(line ?? '').startsWith('proto=');
}

/**
 * Splits accumulated serial text into complete frame lines plus a remainder.
 *
 * @param {string} buffered Buffered text including any newly received bytes.
 * @returns {{lines: string[], remainder: string}}
 */
function extractLines(buffered) {
  return splitLines(buffered);
}

/**
 * Builds a human-readable description of an error frame.
 *
 * @param {import('../types').Frame} frame Frame with `type=err`.
 * @returns {string} Message of the form `<cmd> failed: <reason>`.
 */
function describeError(frame) {
  const source = frame || {};
  const description = source.code
    ? ERROR_CODE_DESCRIPTIONS[source.code] || source.code
    : null;
  const detail =
    source.msg && source.msg !== description ? ` (${source.msg})` : '';
  const summary = description
    ? `${description}${detail}`
    : source.msg || source.error || 'Unknown device error';

  return `${source.cmd || 'command'} failed: ${summary}`;
}

/**
 * Builds a {@link ProtocolError} from an error frame.
 *
 * @param {import('../types').Frame} frame Frame with `type=err`.
 * @returns {ProtocolError}
 */
function toProtocolError(frame) {
  return new ProtocolError(describeError(frame), {
    code: frame?.code || null,
    command: frame?.cmd || null,
    frame: frame || null,
  });
}

/**
 * Parses any accepted range representation into a v2 configuration integer.
 *
 * Retained with exactly the semantics the DWM-Control renderer relied on:
 * `'0'`/`'1x'` are 1x, `'1'`/`'2x'` are 2x, `'2'`/`'4x'` are 4x, and anything
 * else yields `null`.
 *
 * @param {string|number} rangeCfg Range value.
 * @returns {number|null} Configuration integer 0-2, or `null`.
 */
function parseRangeCfg(rangeCfg) {
  return v2.parseRangeCfg(rangeCfg);
}

/**
 * Converts a range configuration integer to its gain multiplier.
 *
 * Unparseable input falls back to 2x, matching the renderer's behaviour.
 *
 * @param {string|number} rangeCfg Configuration integer or label.
 * @returns {number} Gain multiplier 1, 2 or 4.
 */
function cfgToRangeMultiplier(rangeCfg) {
  const cfg = parseRangeCfg(rangeCfg);
  if (cfg === null) return 2;
  return v2.rangeCfgToMultiplier(cfg);
}

/**
 * Parses a range value into a gain multiplier.
 *
 * Accepts labels, configuration integers and bare multipliers; unparseable
 * input falls back to 2x.
 *
 * @param {string|number} rangeValue Range value.
 * @returns {number} Gain multiplier 1, 2 or 4.
 */
function parseRangeMultiplier(rangeValue) {
  const normalized = normalizeToken(rangeValue).toLowerCase();
  const cfg = parseRangeCfg(normalized);
  if (cfg !== null) return v2.rangeCfgToMultiplier(cfg);

  // Tolerate bare multipliers such as '4' that are not valid config integers.
  const numeric = Number.parseFloat(normalized);
  if (Number.isFinite(numeric)) {
    if (numeric === 4) return 4;
    if (numeric === 1) return 1;
  }

  return 2;
}

/**
 * Expands a range value into its configuration integer, multiplier and label.
 *
 * @param {string|number} rangeValue Range value.
 * @returns {import('../types').RangeInfo|null} Range description, or `null`.
 */
function normalizeRange(rangeValue) {
  const cfg = parseRangeCfg(rangeValue);
  if (cfg === null) return null;
  const multiplier = v2.rangeCfgToMultiplier(cfg);
  return { cfg, multiplier, label: `${multiplier}x` };
}

/**
 * Decodes a `pwr.snap` response into fully expanded, numeric fields.
 *
 * The firmware packs the six power metrics plus two voltages into a single
 * compact `d=` CSV in the fixed order
 * `inst,avg,peak,max,min,dev,pvolt,svolt`. This expands that CSV, converts every
 * field to a number, and derives the active range and full-scale power.
 *
 * @param {import('../types').Frame} frame Parsed `pwr.snap` response.
 * @returns {import('../types').Snapshot} Decoded snapshot.
 */
function decodeSnapshot(frame) {
  const source = frame || {};
  const expanded = { ...source };

  if (typeof source.d === 'string' && source.d.length > 0) {
    source.d.split(',').forEach((value, index) => {
      if (index < SNAPSHOT_FIELD_ORDER.length) {
        expanded[SNAPSHOT_FIELD_ORDER[index]] = value;
      }
    });
  }

  const range = normalizeRange(expanded.range) || {
    cfg: v2.DEFAULT_RANGE_CFG,
    multiplier: 2,
    label: '2x',
  };
  const elementRating = toFiniteNumber(expanded.eval, 0);

  const snapshot = {
    elem: toFiniteInt(expanded.elem, null),
    etype: String(expanded.etype || '').toLowerCase() || null,
    eval: elementRating,
    range,
    maxPowerW: elementRating * range.multiplier,
    timestamp: Date.now(),
    frame: source,
  };

  SNAPSHOT_FIELD_ORDER.forEach((field) => {
    snapshot[field] = toFiniteNumber(expanded[field], 0);
  });

  return snapshot;
}

/**
 * Decodes a `cfg.elems` response into the eight element profiles.
 *
 * The response carries `e1v`/`e1t` through `e8v`/`e8t`. Missing entries default
 * to a 0 W `30ua` element so the returned array always has eight members.
 *
 * @param {import('../types').Frame} frame Parsed `cfg.elems` response.
 * @returns {import('../types').ElementProfile[]} Eight profiles, ordered by index.
 */
function decodeElementProfiles(frame) {
  const source = frame || {};
  const profiles = [];

  for (let index = MIN_ELEMENT; index <= MAX_ELEMENT; index += 1) {
    const rating = Number.parseFloat(source[`e${index}v`]);
    const type = String(source[`e${index}t`] || '30ua').toLowerCase();
    profiles.push({
      elem: index,
      eval: Number.isFinite(rating) ? rating : 0,
      etype: type || '30ua',
    });
  }

  return profiles;
}

/**
 * Decodes a `sys.cmds` response into an array of command names.
 *
 * @param {import('../types').Frame} frame Parsed `sys.cmds` response.
 * @returns {string[]} Supported command names.
 */
function decodeSupportedCommands(frame) {
  return String(frame?.cmds || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Builds the field map for a `cfg.set` request.
 *
 * The firmware requires element-scoped keys (`eval`, `etype`) to carry an `elem`
 * field, emitted **before** `val`. Key insertion order is therefore significant
 * and is preserved by {@link buildFrame}.
 *
 * @param {string} key Configuration key.
 * @param {string|number} value New value.
 * @param {object} [options={}] Additional options.
 * @param {number} [options.element] Element index, required for element-scoped keys.
 * @returns {Record<string, string|number>} Field map ready for {@link buildFrame}.
 * @throws {ProtocolError} When an element-scoped key is missing a valid element.
 */
function buildConfigSetFields(key, value, options = {}) {
  const configKey = normalizeToken(key);

  if (ELEMENT_SCOPED_CONFIG_KEYS.includes(configKey)) {
    const element = toFiniteInt(options.element, null);
    if (element === null || element < MIN_ELEMENT || element > MAX_ELEMENT) {
      throw new ProtocolError(
        `cfg.set ${configKey} requires an element between ${MIN_ELEMENT} and ${MAX_ELEMENT}`,
        { code: 'ERR_MISSING_KEY', command: 'cfg.set' },
      );
    }
    return { key: configKey, elem: element, val: value };
  }

  return { key: configKey, val: value };
}

module.exports = {
  PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  v1,
  v2,
  translator,
  isSupportedProto,
  normalizeProtocolVersion,
  buildFrame,
  buildTranslatedFrame,
  parseFrame,
  isFrameLine,
  extractLines,
  describeError,
  toProtocolError,
  parseRangeCfg,
  parseRangeMultiplier,
  cfgToRangeMultiplier,
  normalizeRange,
  decodeSnapshot,
  decodeElementProfiles,
  decodeSupportedCommands,
  buildConfigSetFields,
};
