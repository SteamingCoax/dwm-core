'use strict';

const assert = require('assert');
const { describe } = require('./harness');
const {
  parseArgs,
  normalizeFver,
  fverEquals,
  extractEmbeddedFver,
  embeddedMatches,
} = require('../scripts/dfu-roundtrip');

describe('dfu-roundtrip: argument parsing', ({ test }) => {
  test('requires --bin', () => {
    assert.ok(parseArgs([]).error);
  });

  test('applies defaults', () => {
    const { options } = parseArgs(['--bin', 'fw.bin']);
    assert.strictEqual(options.dfuTimeoutMs, 15000);
    assert.strictEqual(options.returnTimeoutMs, 20000);
    assert.strictEqual(options.repeat, 1);
    assert.strictEqual(options.port, null);
  });

  test('parses every option, including --opt=value', () => {
    const { options } = parseArgs([
      '--bin', 'fw.bin', '--port', '/dev/x', '--serial', 'ABC123',
      '--expect-fver=FW: 2.6.5', '--dfu-timeout', '5', '--return-timeout', '2.5',
      '--repeat', '3',
    ]);
    assert.strictEqual(options.port, '/dev/x');
    assert.strictEqual(options.serial, 'ABC123');
    assert.strictEqual(options.expectFver, 'FW: 2.6.5');
    assert.strictEqual(options.dfuTimeoutMs, 5000);
    assert.strictEqual(options.returnTimeoutMs, 2500);
    assert.strictEqual(options.repeat, 3);
  });

  test('rejects bad input', () => {
    assert.ok(parseArgs(['--bin', 'a', '--repeat', '0']).error);
    assert.ok(parseArgs(['--bin', 'a', '--dfu-timeout', 'x']).error);
    assert.ok(parseArgs(['--bin', 'a', '--nope']).error);
    assert.ok(parseArgs(['--bin']).error);
  });

  test('--help short-circuits', () => {
    assert.strictEqual(parseArgs(['--help']).help, true);
  });
});

describe('dfu-roundtrip: version handling', ({ test }) => {
  test('extracts the embedded version string from a binary', () => {
    const buf = Buffer.concat([
      Buffer.from([0xff, 0x00, 0x12]),
      Buffer.from('FW: 2.6.5 beta\0junk', 'latin1'),
    ]);
    assert.strictEqual(extractEmbeddedFver(buf), 'FW: 2.6.5 beta');
  });

  test('returns null when no version is embedded', () => {
    assert.strictEqual(extractEmbeddedFver(Buffer.from('nothing here')), null);
  });

  test('normalisation collapses underscores and spaces', () => {
    assert.strictEqual(normalizeFver('FW:_2.6.5__x'), 'FW: 2.6.5 x');
    assert.ok(fverEquals('FW:_2.6.5', 'FW: 2.6.5'));
    assert.ok(!fverEquals('FW: 2.6.5', 'FW: 2.6.6'));
  });

  test('embedded match tolerates trailing bytes captured by the pattern', () => {
    assert.ok(embeddedMatches('FW: 2.6.5 ', 'FW:_2.6.5'));
    assert.ok(!embeddedMatches('FW: 2.6.4', 'FW:_2.6.5'));
  });
});
