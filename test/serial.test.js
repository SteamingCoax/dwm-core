'use strict';

const assert = require('assert');
const { describe } = require('./harness');
const serial = require('../src/serial');
const { decodeSerialBuffer, sanitizeDeviceName, splitLines } = require('../src/utils');

describe('serial: device identification', ({ test }) => {
  test('matches on the DWM V2 USB product string', () => {
    assert.strictEqual(serial.isDwmPort({ manufacturer: 'DWM V2 ComPort' }), true);
    assert.strictEqual(serial.isDwmPort({ friendlyName: 'DWM V2 (COM4)' }), true);
  });

  test('matches on the STM32 CDC vendor and product id pair', () => {
    assert.strictEqual(
      serial.isDwmPort({ vendorId: '0483', productId: '5740' }),
      true,
    );
    assert.strictEqual(
      serial.isDwmPort({ vendorId: '0x0483', productId: '0x5740' }),
      true,
    );
  });

  test('requires both ids, so other STM32 devices are not claimed', () => {
    assert.strictEqual(serial.isDwmPort({ vendorId: '0483' }), false);
    assert.strictEqual(
      serial.isDwmPort({ vendorId: '0483', productId: 'df11' }),
      false,
    );
  });

  test('falls back to the Windows pnpId when id fields are missing', () => {
    assert.strictEqual(
      serial.isDwmPort({ pnpId: 'USB\\VID_0483&PID_5740\\205F33AE5442' }),
      true,
    );
    assert.strictEqual(
      serial.isDwmPort({ pnpId: 'USB\\VID_1234&PID_5678\\ABCD' }),
      false,
    );
  });

  test('matches the product ID ST assigned to the DWM V2 (A59C) as well as 5740', () => {
    assert.strictEqual(serial.isDwmPort({ vendorId: '0483', productId: 'a59c' }), true);
    assert.strictEqual(serial.isDwmPort({ vendorId: '0x0483', productId: '0xA59C' }), true);
    assert.strictEqual(
      serial.isDwmPort({ pnpId: 'USB\\VID_0483&PID_A59C\\205F33AE5442' }),
      true,
    );
    assert.strictEqual(serial.isDwmPort({ vendorId: '0483', productId: 'a59d' }), false);
    assert.strictEqual(serial.isDwmPort({ vendorId: '1234', productId: 'a59c' }), false);
  });

  test('matches the COAXON-branded firmware (new PID, new manufacturer string)', () => {
    assert.strictEqual(
      serial.isDwmPort({
        path: '/dev/ttyACM0',
        manufacturer: 'COAXON Systems Inc.',
        pnpId: 'usb-COAXON_Systems_Inc._DWM_V2_ComPort_205F33AE5442-if00',
        vendorId: '0483',
        productId: 'a59c',
      }),
      true,
    );
    // macOS: no product string, so VID/PID alone must be enough.
    assert.strictEqual(
      serial.isDwmPort({ manufacturer: 'COAXON Systems Inc.', vendorId: '0483', productId: 'A59C' }),
      true,
    );
    // The manufacturer string is not used for matching on its own.
    assert.strictEqual(serial.isDwmPort({ manufacturer: 'COAXON Systems Inc.' }), false);
  });

  test('matches the Linux pnpId product string independent of PID', () => {
    // Real Linux listing: manufacturer is the USB vendor string, not the product string.
    assert.strictEqual(
      serial.isDwmPort({
        path: '/dev/ttyACM0',
        manufacturer: 'STMicroelectronics',
        pnpId: 'usb-STMicroelectronics_DWM_V2_ComPort_205F33AE5442-if00',
      }),
      true,
    );
    assert.strictEqual(
      serial.isDwmPort({
        path: '/dev/ttyACM1',
        manufacturer: 'STMicroelectronics',
        pnpId: 'usb-STMicroelectronics_STM32_Virtual_ComPort_1234-if00',
        vendorId: '0483',
        productId: '5741',
      }),
      false,
    );
  });

  test('rejects unrelated and empty ports', () => {
    assert.strictEqual(serial.isDwmPort({ path: '/dev/tty.Bluetooth' }), false);
    assert.strictEqual(serial.isDwmPort({}), false);
    assert.strictEqual(serial.isDwmPort(null), false);
  });
});

describe('serial: identity keys', ({ test }) => {
  test('extracts the macOS usbmodem uid', () => {
    assert.strictEqual(
      serial.parseUsbModemUid('/dev/tty.usbmodem205F33AE54421'),
      '205F33AE54421',
    );
    assert.strictEqual(serial.parseUsbModemUid('/dev/ttyACM0'), null);
    assert.strictEqual(serial.parseUsbModemUid(null), null);
  });

  test('prefers the usbmodem uid for the key', () => {
    assert.strictEqual(
      serial.buildDeviceKey({ path: '/dev/tty.usbmodem205F33AE54421' }),
      'usbmodem:205F33AE54421',
    );
  });

  test('uses the pnpId serial number on Windows', () => {
    assert.strictEqual(
      serial.buildDeviceKey({
        path: 'COM4',
        pnpId: 'USB\\VID_0483&PID_5740\\205F33AE5442',
      }),
      'usbserial:205F33AE5442',
    );
  });

  test('uses the USB serial number when no pnpId is available', () => {
    assert.strictEqual(
      serial.buildDeviceKey({ path: '/dev/ttyACM0', serialNumber: '205F33AE5442' }),
      'usbserial:205F33AE5442',
    );
  });

  test('falls back to the port path', () => {
    assert.strictEqual(
      serial.buildDeviceKey({ path: '/dev/ttyACM0' }),
      'port:/dev/ttyACM0',
    );
    assert.strictEqual(serial.buildDeviceKey({}), 'port:unknown');
  });

  test('ignores implausibly short pnpId serial numbers', () => {
    assert.strictEqual(
      serial.buildDeviceKey({ path: 'COM4', pnpId: 'USB\\VID_0483&PID_5740\\AB' }),
      'port:COM4',
    );
  });
});

describe('serial: text decoding', ({ test }) => {
  test('decodes ASCII frames unchanged', () => {
    assert.strictEqual(
      decodeSerialBuffer(Buffer.from('proto=2 type=resp status=ok\r\n')),
      'proto=2 type=resp status=ok\r\n',
    );
  });

  test('decodes multi-byte UTF-8 sequences', () => {
    assert.strictEqual(decodeSerialBuffer(Buffer.from('°C ± 5', 'utf8')), '°C ± 5');
  });

  test('skips malformed bytes instead of emitting replacement characters', () => {
    const decoded = decodeSerialBuffer(Buffer.from([0x61, 0xff, 0x62]));
    assert.strictEqual(decoded, 'ab');
    assert.ok(!decoded.includes('\uFFFD'));
  });

  test('handles an empty buffer', () => {
    assert.strictEqual(decodeSerialBuffer(Buffer.alloc(0)), '');
  });

  test('splits complete lines and keeps the remainder', () => {
    assert.deepStrictEqual(splitLines('a\r\nb\r\nc'), {
      lines: ['a', 'b'],
      remainder: 'c',
    });
    assert.deepStrictEqual(splitLines('a\r\n\r\nb\r\n'), {
      lines: ['a', 'b'],
      remainder: '',
    });
  });
});

describe('serial: name sanitisation', ({ test }) => {
  test('replaces spaces with underscores and strips punctuation', () => {
    assert.strictEqual(sanitizeDeviceName('My Meter! #1'), 'My_Meter_1');
  });

  test('truncates to the firmware limit of 20 characters', () => {
    assert.strictEqual(sanitizeDeviceName('a'.repeat(40)).length, 20);
  });

  test('returns an empty string for input with nothing usable', () => {
    assert.strictEqual(sanitizeDeviceName('!!!'), '');
    assert.strictEqual(sanitizeDeviceName(null), '');
  });
});
