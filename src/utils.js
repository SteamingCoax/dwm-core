'use strict';

/**
 * @module dwm-core/utils
 *
 * Small, dependency-free helpers shared across the package.
 */

/**
 * Coerces a value to a trimmed string, mapping `null`/`undefined` to `''`.
 *
 * @param {*} value Value to normalise.
 * @returns {string} Trimmed string representation.
 */
function normalizeToken(value) {
  return String(value ?? '').trim();
}

/**
 * Resolves after the given number of milliseconds.
 *
 * @param {number} ms Delay in milliseconds; non-positive values resolve immediately.
 * @returns {Promise<void>}
 */
function delay(ms) {
  const wait = Number(ms);
  if (!Number.isFinite(wait) || wait <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Parses a value as a float, returning a fallback when it is not finite.
 *
 * @param {*} value Value to parse.
 * @param {number} [fallback=0] Value returned when parsing fails.
 * @returns {number}
 */
function toFiniteNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parses a value as a base-10 integer, returning a fallback when it is not finite.
 *
 * @param {*} value Value to parse.
 * @param {number|null} [fallback=null] Value returned when parsing fails.
 * @returns {number|null}
 */
function toFiniteInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Constrains a number to an inclusive range.
 *
 * @param {*} value Value to clamp.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @param {number} [fallback=min] Value used when `value` is not a finite number.
 * @returns {number}
 */
function clamp(value, min, max, fallback = min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Decodes a byte buffer into a string using a deliberately lenient UTF-8 reader.
 *
 * Malformed sequences are **skipped silently** rather than replaced with U+FFFD.
 * This mirrors the DWM-Control application's historical behaviour: the meter
 * occasionally emits partial frames across USB packet boundaries, and inserting
 * replacement characters would corrupt the line-oriented parser downstream.
 *
 * @param {Buffer|Uint8Array|number[]} input Bytes received from the serial port.
 * @returns {string} Decoded text.
 */
function decodeSerialBuffer(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let text = '';

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];

    if (byte < 0x80) {
      text += String.fromCharCode(byte);
    } else if ((byte & 0xe0) === 0xc0 && i + 1 < buffer.length) {
      const b2 = buffer[i + 1];
      if ((b2 & 0xc0) === 0x80) {
        text += String.fromCharCode(((byte & 0x1f) << 6) | (b2 & 0x3f));
        i += 1;
      } else {
        text += String.fromCharCode(byte);
      }
    } else if ((byte & 0xf0) === 0xe0 && i + 2 < buffer.length) {
      const b2 = buffer[i + 1];
      const b3 = buffer[i + 2];
      if ((b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80) {
        text += String.fromCharCode(
          ((byte & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f),
        );
        i += 2;
      } else {
        text += String.fromCharCode(byte);
      }
    } else if ((byte & 0xf8) === 0xf0 && i + 3 < buffer.length) {
      const b2 = buffer[i + 1];
      const b3 = buffer[i + 2];
      const b4 = buffer[i + 3];
      if ((b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80 && (b4 & 0xc0) === 0x80) {
        const codePoint =
          ((byte & 0x07) << 18) |
          ((b2 & 0x3f) << 12) |
          ((b3 & 0x3f) << 6) |
          (b4 & 0x3f);
        if (codePoint > 0xffff) {
          const adjusted = codePoint - 0x10000;
          text += String.fromCharCode(
            0xd800 + (adjusted >> 10),
            0xdc00 + (adjusted & 0x3ff),
          );
        } else {
          text += String.fromCharCode(codePoint);
        }
        i += 3;
      } else {
        text += String.fromCharCode(byte);
      }
    }
    // Invalid sequences are skipped silently, by design.
  }

  return text;
}

/**
 * Expands the backslash escapes accepted by the app's raw-command debug input.
 *
 * Supports `\\`, `\r`, `\n`, `\t` and `\0`.
 *
 * @param {string} value Raw user input.
 * @returns {string} Decoded command string.
 */
function decodeEscapes(value) {
  return String(value || '')
    .replace(/\\\\/g, '\\')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\0/g, '\0');
}

/**
 * Splits an accumulated buffer into complete lines plus a trailing remainder.
 *
 * Lines are delimited by `\n`; a trailing `\r` is stripped and blank lines are
 * dropped. The remainder is whatever followed the final `\n` and should be fed
 * back in on the next call.
 *
 * @param {string} buffered Previously buffered text plus newly received text.
 * @returns {{lines: string[], remainder: string}}
 */
function splitLines(buffered) {
  const parts = String(buffered ?? '').split('\n');
  const remainder = parts.pop() || '';
  const lines = parts
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0);
  return { lines, remainder };
}

/**
 * Extracts a dotted semver triple from an arbitrary version string.
 *
 * @param {string} value Version string, e.g. `FW:_2.6.5_-_Ranger`.
 * @returns {number[]|null} `[major, minor, patch]`, or `null` when absent.
 */
function parseSemver(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

/**
 * Reports whether semver triple `a` is strictly newer than `b`.
 *
 * @param {number[]} a Candidate version.
 * @param {number[]} b Baseline version.
 * @returns {boolean}
 */
function semverIsNewer(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  for (let i = 0; i < 3; i++) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

/**
 * Sanitises a device name to the character set the firmware accepts.
 *
 * Spaces become underscores, all other non-alphanumeric characters are removed,
 * and the result is truncated to 20 characters.
 *
 * @param {string} value Proposed device name.
 * @returns {string} Firmware-safe name.
 */
function sanitizeDeviceName(value) {
  return String(value ?? '')
    .replace(/ /g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 20);
}

module.exports = {
  normalizeToken,
  delay,
  toFiniteNumber,
  toFiniteInt,
  clamp,
  decodeSerialBuffer,
  decodeEscapes,
  splitLines,
  parseSemver,
  semverIsNewer,
  sanitizeDeviceName,
};
