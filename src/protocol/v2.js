'use strict';

/**
 * @module dwm-core/protocol/v2
 *
 * Protocol version 2 - the modern DWM V2 USB API.
 *
 * Framing is identical to v1; the two versions differ only in the `range`
 * enumeration, which v2 widens to three settings:
 *
 * | `range` value | ADC gain |
 * |---------------|----------|
 * | `0` / `1x`    | 1x       |
 * | `1` / `2x`    | 2x       |
 * | `2` / `4x`    | 4x       |
 */

const { normalizeToken } = require('../utils');

/** Protocol version literal emitted in the `proto=` field. */
const VERSION = '2';

/**
 * Range configuration integer to gain multiplier.
 *
 * @type {Readonly<Record<number, number>>}
 */
const RANGE_CFG_TO_MULTIPLIER = Object.freeze({ 0: 1, 1: 2, 2: 4 });

/**
 * Gain multiplier to range configuration integer.
 *
 * @type {Readonly<Record<number, number>>}
 */
const MULTIPLIER_TO_RANGE_CFG = Object.freeze({ 1: 0, 2: 1, 4: 2 });

/** Range configuration integer used when a value cannot be interpreted. */
const DEFAULT_RANGE_CFG = 1;

/** Lowest valid range configuration integer. */
const MIN_RANGE_CFG = 0;

/** Highest valid range configuration integer. */
const MAX_RANGE_CFG = 2;

/**
 * Parses any accepted range representation into a v2 configuration integer.
 *
 * Accepts textual labels (`1x`, `x2`, `4X`), the configuration integers `0`-`2`
 * and numeric multipliers.
 *
 * @param {string|number} value Range value from a frame or from user input.
 * @returns {number|null} Configuration integer 0-2, or `null` when unparseable.
 */
function parseRangeCfg(value) {
  const raw = normalizeToken(value).toLowerCase();
  if (!raw) return null;

  if (raw === '1x' || raw === 'x1') return 0;
  if (raw === '2x' || raw === 'x2') return 1;
  if (raw === '4x' || raw === 'x4') return 2;

  if (/^-?\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (parsed >= MIN_RANGE_CFG && parsed <= MAX_RANGE_CFG) return parsed;
    return null;
  }

  return null;
}

/**
 * Converts a v2 range configuration integer to its gain multiplier.
 *
 * @param {number} cfg Configuration integer 0-2.
 * @returns {number} Gain multiplier 1, 2 or 4.
 */
function rangeCfgToMultiplier(cfg) {
  return RANGE_CFG_TO_MULTIPLIER[cfg] ?? RANGE_CFG_TO_MULTIPLIER[DEFAULT_RANGE_CFG];
}

/**
 * Converts a gain multiplier to its v2 range configuration integer.
 *
 * Values that fall between the supported gains are rounded down to the nearest
 * supported gain.
 *
 * @param {number} multiplier Gain multiplier.
 * @returns {number} Configuration integer 0-2.
 */
function multiplierToRangeCfg(multiplier) {
  const exact = MULTIPLIER_TO_RANGE_CFG[multiplier];
  if (exact !== undefined) return exact;

  const parsed = Number.parseFloat(multiplier);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RANGE_CFG;
  if (parsed >= 4) return 2;
  if (parsed >= 2) return 1;
  return 0;
}

module.exports = {
  VERSION,
  RANGE_CFG_TO_MULTIPLIER,
  MULTIPLIER_TO_RANGE_CFG,
  DEFAULT_RANGE_CFG,
  MIN_RANGE_CFG,
  MAX_RANGE_CFG,
  parseRangeCfg,
  rangeCfgToMultiplier,
  multiplierToRangeCfg,
};
