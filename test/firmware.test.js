'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe } = require('./harness');
const firmware = require('../src/firmware');

/**
 * Builds a well-formed Intel HEX data record.
 *
 * @param {number} address 16-bit offset.
 * @param {number[]} bytes Payload.
 * @param {number} [type=0] Record type.
 * @returns {string} A `:`-prefixed record with a valid checksum.
 */
function hexRecord(address, bytes, type = 0) {
  const length = bytes.length;
  const fields = [length, (address >> 8) & 0xff, address & 0xff, type, ...bytes];
  const checksum = (-fields.reduce((sum, b) => sum + b, 0)) & 0xff;
  return `:${[...fields, checksum]
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('')}`;
}

describe('firmware: Intel HEX parsing', ({ test }) => {
  test('parses data records into a contiguous buffer', () => {
    const hex = [
      ':020000040800F2',
      hexRecord(0x0000, [0x01, 0x02, 0x03, 0x04]),
      ':00000001FF',
    ].join('\n');

    const result = firmware.parseHex(hex);
    assert.strictEqual(result.startAddress, 0x08000000);
    assert.strictEqual(result.size, 4);
    assert.deepStrictEqual([...result.data], [1, 2, 3, 4]);
  });

  test('fills gaps between records with erased flash', () => {
    const hex = [
      ':020000040800F2',
      hexRecord(0x0000, [0xaa]),
      hexRecord(0x0004, [0xbb]),
      ':00000001FF',
    ].join('\n');

    const result = firmware.parseHex(hex);
    assert.strictEqual(result.size, 5);
    assert.deepStrictEqual([...result.data], [0xaa, 0xff, 0xff, 0xff, 0xbb]);
  });

  test('honours extended linear address records', () => {
    const hex = [
      ':020000040801F1',
      hexRecord(0x0000, [0x42]),
      ':00000001FF',
    ].join('\n');

    const result = firmware.parseHex(hex);
    assert.strictEqual(result.startAddress, 0x08010000);
  });

  test('stops at the end-of-file record', () => {
    const hex = [
      ':020000040800F2',
      hexRecord(0x0000, [0x01]),
      ':00000001FF',
      hexRecord(0x1000, [0x02]),
    ].join('\n');

    assert.strictEqual(firmware.parseHex(hex).size, 1);
  });

  test('ignores non-record lines', () => {
    const hex = [
      '# a comment',
      '',
      ':020000040800F2',
      hexRecord(0x0000, [0x01]),
      ':00000001FF',
    ].join('\n');

    assert.strictEqual(firmware.parseHex(hex).size, 1);
  });

  test('rejects images with no records', () => {
    assert.throws(() => firmware.parseHex('not a hex file'), /No Intel HEX records/);
  });

  test('rejects images larger than the flash bank', () => {
    const hex = [
      ':020000040800F2',
      hexRecord(0x0000, [0x01]),
      ':020000040830C2',
      hexRecord(0x0000, [0x02]),
      ':00000001FF',
    ].join('\n');

    assert.throws(() => firmware.parseHex(hex, { maxBytes: 1024 }), /too large/);
  });

  test('accepts a Buffer as well as a string', () => {
    const hex = Buffer.from(
      [':020000040800F2', hexRecord(0x0000, [0x7f]), ':00000001FF'].join('\n'),
    );
    assert.deepStrictEqual([...firmware.parseHex(hex).data], [0x7f]);
  });

  test('writes a temporary bin file matching the parsed image', async () => {
    const hex = [':020000040800F2', hexRecord(0x0000, [1, 2, 3]), ':00000001FF'].join('\n');
    const hexPath = path.join(os.tmpdir(), `dwm-core-test-${Date.now()}.hex`);
    await fs.promises.writeFile(hexPath, hex);

    let binPath;
    try {
      binPath = await firmware.convertHexFileToBin(hexPath);
      assert.deepStrictEqual([...(await fs.promises.readFile(binPath))], [1, 2, 3]);
    } finally {
      await fs.promises.unlink(hexPath).catch(() => {});
      if (binPath) await fs.promises.unlink(binPath).catch(() => {});
    }
  });

  test('reports a helpful error for a missing file', async () => {
    await assert.rejects(
      () => firmware.convertHexFileToBin('/nonexistent/firmware.hex'),
      /Could not read firmware file/,
    );
  });
});

describe('firmware: dfu-util output parsing', ({ test }) => {
  const sample = [
    'dfu-util 0.11',
    'Found DFU: [0483:df11] ver=2200, devnum=12, cfg=1, intf=0, path="20-3", alt=0, name="@Internal Flash  /0x08000000/04*016Kg", serial="205F33AE5442"',
    'Found DFU: [0483:df11] ver=2200, devnum=12, cfg=1, intf=0, path="20-3", alt=1, name="@Option Bytes  /0x1FFF7800/01*040 e", serial="205F33AE5442"',
  ].join('\n');

  test('parses a device from dfu-util output', () => {
    const devices = firmware.parseDfuDevices(sample);
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0].vid, '0483');
    assert.strictEqual(devices[0].pid, 'df11');
    assert.strictEqual(devices[0].serial, '205F33AE5442');
    assert.strictEqual(devices[0].alt, 0);
  });

  test('collapses alternate settings, preferring internal flash', () => {
    assert.ok(firmware.parseDfuDevices(sample)[0].name.includes('Internal Flash'));
  });

  test('keeps distinct devices apart', () => {
    const two = `${sample}\nFound DFU: [0483:df11] alt=0, name="@Internal Flash", serial="AAAABBBBCCCC"`;
    assert.strictEqual(firmware.parseDfuDevices(two).length, 2);
  });

  test('handles Windows line endings', () => {
    assert.strictEqual(
      firmware.parseDfuDevices(sample.replace(/\n/g, '\r\n')).length,
      1,
    );
  });

  test('returns an empty list when nothing is in DFU mode', () => {
    assert.deepStrictEqual(firmware.parseDfuDevices('No DFU capable USB device available'), []);
    assert.deepStrictEqual(firmware.parseDfuDevices(''), []);
  });

  test('defaults the serial when dfu-util omits it', () => {
    const devices = firmware.parseDfuDevices('Found DFU: [0483:df11] alt=0');
    assert.strictEqual(devices[0].serial, 'unknown');
  });
});

describe('firmware: dfu-util resolution', ({ test }) => {
  test('honours an explicit command', () => {
    assert.strictEqual(
      firmware.resolveDfuUtilPath({ command: '/opt/bin/dfu-util' }),
      '/opt/bin/dfu-util',
    );
  });

  test('falls back to the bare command so PATH is used', () => {
    const expected = process.platform === 'win32' ? 'dfu-util.exe' : 'dfu-util';
    assert.strictEqual(firmware.resolveDfuUtilPath(), expected);
    assert.strictEqual(
      firmware.resolveDfuUtilPath({ searchPaths: ['/nonexistent'] }),
      expected,
    );
  });

  test('finds a bundled binary under Programs/dfu-util', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dwm-core-dfu-'));
    const dir = path.join(root, 'Programs', 'dfu-util');
    const executable = process.platform === 'win32' ? 'dfu-util.exe' : 'dfu-util';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, executable), '');

    try {
      assert.strictEqual(
        firmware.resolveDfuUtilPath({ searchPaths: [root] }),
        path.join(dir, executable),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('firmware: updater', ({ test }) => {
  test('treats dfu-util exit codes 0 and 74 as success', () => {
    assert.deepStrictEqual(firmware.DFU_SUCCESS_EXIT_CODES, [0, 74]);
  });

  test('recognises output that means nothing was flashed', () => {
    // dfu-util also exits 74 when it finds no device, so the exit code alone
    // cannot be trusted to mean the firmware was written.
    assert.ok(firmware.DFU_FAILURE_PATTERN.test('dfu-util: No DFU capable USB device available'));
    assert.ok(firmware.DFU_FAILURE_PATTERN.test('dfu-util: Cannot open DFU device 0483:df11'));
    assert.ok(!firmware.DFU_FAILURE_PATTERN.test('Download\t[=========================] 100%'));
    assert.ok(!firmware.DFU_FAILURE_PATTERN.test('File downloaded successfully'));
  });

  test('extracts percentages and phases from dfu-util output', () => {
    const updater = new firmware.FirmwareUpdater();
    assert.deepStrictEqual(updater._parseProgress('Erase   [====   ]  45%'), {
      percent: 45,
      phase: 'erase',
      raw: 'Erase   [====   ]  45%',
    });
    assert.strictEqual(updater._parseProgress('Download [=====] 100%').phase, 'download');
    assert.strictEqual(updater._parseProgress('no percentage here'), null);
  });

  test('builds dfu-util arguments without a serial filter by default', () => {
    const updater = new firmware.FirmwareUpdater();
    assert.deepStrictEqual(updater.buildUploadArgs('/tmp/fw.bin'), [
      '-a', '0', '-i', '0', '-D', '/tmp/fw.bin', '-s', '0x08000000:leave', '-R',
    ]);
  });

  test('targets one DFU device with -S when a serial is given', () => {
    const updater = new firmware.FirmwareUpdater();
    const args = updater.buildUploadArgs('/tmp/fw.bin', { serial: '208834704E43' });
    assert.deepStrictEqual(args.slice(0, 6), ['-a', '0', '-i', '0', '-S', '208834704E43']);
    assert.ok(args.includes('-R'));
  });

  test('ignores an empty or unknown serial so device records can be passed as-is', () => {
    const updater = new firmware.FirmwareUpdater();
    for (const serial of ['', '   ', 'unknown', 'UNKNOWN', undefined, null, 42]) {
      assert.ok(!updater.buildUploadArgs('/tmp/fw.bin', { serial }).includes('-S'), String(serial));
    }
  });

  test('omits :leave and -R when reboot is false', () => {
    const updater = new firmware.FirmwareUpdater();
    const args = updater.buildUploadArgs('/tmp/fw.bin', { reboot: false, serial: 'ABC' });
    assert.ok(args.includes('0x08000000'));
    assert.ok(!args.includes('0x08000000:leave'));
    assert.ok(!args.includes('-R'));
    assert.ok(args.includes('-S'));
  });

  test('rejects an unusable firmware source', async () => {
    const updater = new firmware.FirmwareUpdater();
    await assert.rejects(() => updater.upload(null), /file path or a Buffer/);
  });

  test('reports the WinUSB driver as present on non-Windows hosts', async function () {
    if (process.platform === 'win32') return;
    assert.deepStrictEqual(await firmware.checkWinUsbDriver(), { installed: true });
  });
});
