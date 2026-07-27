'use strict';

/**
 * @module dwm-core/protocol/v1
 *
 * Protocol version 1 - the legacy DWM V2 USB API.
 *
 * Framing, command names and payload keys are identical to v2. The sole
 * difference is the `range` enumeration, which v1 restricts to two settings:
 *
 * | `range` value | ADC gain |
 * |---------------|----------|
 * | `0` / `2x`    | 2x       |
 * | `1` / `4x`    | 4x       |
 *
 * The 1x gain introduced in v2 has no v1 representation. See
 * {@link module:dwm-core/protocol/translator} for how that is reconciled.
 */

const { normalizeToken } = require('../utils');

/** Protocol version literal emitted in the `proto=` field. */
const VERSION = '1';

/**
 * Range configuration integer to gain multiplier.
 *
 * @type {Readonly<Record<number, number>>}
 */
const RANGE_CFG_TO_MULTIPLIER = Object.freeze({ 0: 2, 1: 4 });

/**
 * Gain multiplier to range configuration integer.
 *
 * @type {Readonly<Record<number, number>>}
 */
const MULTIPLIER_TO_RANGE_CFG = Object.freeze({ 2: 0, 4: 1 });

/** Range configuration integer used when a value cannot be interpreted. */
const DEFAULT_RANGE_CFG = 0;

/** Lowest valid range configuration integer. */
const MIN_RANGE_CFG = 0;

/** Highest valid range configuration integer. */
const MAX_RANGE_CFG = 1;

/**
 * Parses any accepted range representation into a v1 configuration integer.
 *
 * @param {string|number} value Range value from a frame or from user input.
 * @returns {number|null} Configuration integer 0-1, or `null` when unparseable.
 */
function parseRangeCfg(value) {
  const raw = normalizeToken(value).toLowerCase();
  if (!raw) return null;

  if (raw === '2x' || raw === 'x2') return 0;
  if (raw === '4x' || raw === 'x4') return 1;

  if (/^-?\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (parsed >= MIN_RANGE_CFG && parsed <= MAX_RANGE_CFG) return parsed;
    return null;
  }

  return null;
}

/**
 * Converts a v1 range configuration integer to its gain multiplier.
 *
 * @param {number} cfg Configuration integer 0-1.
 * @returns {number} Gain multiplier 2 or 4.
 */
function rangeCfgToMultiplier(cfg) {
  return RANGE_CFG_TO_MULTIPLIER[cfg] ?? RANGE_CFG_TO_MULTIPLIER[DEFAULT_RANGE_CFG];
}

/**
 * Converts a gain multiplier to its v1 range configuration integer.
 *
 * The 1x gain has no v1 encoding and is mapped to the nearest available gain, 2x.
 *
 * @param {number} multiplier Gain multiplier.
 * @returns {number} Configuration integer 0-1.
 */
function multiplierToRangeCfg(multiplier) {
  const exact = MULTIPLIER_TO_RANGE_CFG[multiplier];
  if (exact !== undefined) return exact;

  const parsed = Number.parseFloat(multiplier);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RANGE_CFG;
  if (parsed >= 4) return 1;
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
