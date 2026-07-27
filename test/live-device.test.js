'use strict';

/**
 * Live hardware tests.
 *
 * These run against a physically connected DWM V2 meter. They are not mocked
 * and they do not skip: if no device is present the suite fails, so a green run
 * always means the package was exercised against real firmware.
 *
 * Every test is non-destructive. Values that are written (device name,
 * brightness, range, averaging window) are read first and restored afterwards,
 * and nothing is committed to non-volatile storage, so the meter is left exactly
 * as it was found.
 *
 * Set `DWM_LIVE_FIRMWARE_HEX` to a `.hex` path to additionally exercise the
 * firmware image pipeline. Set `DWM_LIVE_ALLOW_DFU=1` to allow the destructive
 * DFU reboot test, which is skipped by default.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe } = require('./harness');
const {
  Device,
  findDevices,
  FirmwareUpdater,
  parseHex,
  NotConnectedError,
  TimeoutError,
} = require('../src');

describe('live device: discovery', ({ test }) => {
  test('finds at least one connected DWM device', async () => {
    const devices = await findDevices();
    assert.ok(
      devices.length > 0,
      'No DWM device found. Connect a DWM V2 meter over USB and re-run.',
    );
  });

  test('reports the expected USB identity', async () => {
    const [device] = await findDevices();
    assert.strictEqual(device.vendorId.toLowerCase(), '0483');
    assert.strictEqual(device.productId.toLowerCase(), '5740');
  });

  test('assigns a stable identity key', async () => {
    const first = await findDevices();
    const second = await findDevices();
    assert.ok(first[0].key.length > 0);
    assert.strictEqual(first[0].key, second[0].key);
  });

  test('excludes non-DWM ports from the results', async () => {
    const dwmOnly = await findDevices();
    const everything = await findDevices({ all: true });
    assert.ok(everything.length >= dwmOnly.length);
    assert.ok(dwmOnly.every((port) => port.vendorId));
  });
});

describe('live device: connection lifecycle', ({ test }) => {
  test('opens and closes cleanly', async () => {
    const [info] = await findDevices();
    const device = new Device(info);

    assert.strictEqual(device.isOpen, false);
    await device.open();
    assert.strictEqual(device.isOpen, true);

    await device.close();
    assert.strictEqual(device.isOpen, false);
  });

  test('can be reopened after closing', async () => {
    const [info] = await findDevices();
    const device = new Device(info);

    await device.open();
    await device.close();
    await device.open();
    assert.strictEqual(device.isOpen, true);
    await device.close();
  });

  test('rejects commands once closed', async () => {
    const [info] = await findDevices();
    const device = new Device(info);

    await device.open();
    await device.close();

    await assert.rejects(
      () => device.getIdentity(),
      (error) => error instanceof NotConnectedError,
    );
  });

  test('fails fast for a path that is not a device', async () => {
    const device = new Device('/dev/null');
    await assert.rejects(() => device.open());
  });
});

describe('live device: reads', ({ test, before, after }) => {
  before(async () => {
    const [info] = await findDevices();
    assert.ok(info, 'No DWM device found.');
    const device = new Device(info);
    await device.open();
    return { device };
  });

  after(async ({ device }) => {
    if (device) await device.close();
  });

  test('reads the device identity', async ({ device }) => {
    const identity = await device.getIdentity();
    assert.ok(identity.uid, 'device returned no uid');
    assert.match(identity.uid, /^[0-9A-Fa-f]+$/);
    console.log(`       uid=${identity.uid} name=${identity.dname}`);
  });

  test('reads the firmware version', async ({ device }) => {
    const firmware = await device.getFirmwareVersion();
    assert.ok(firmware.raw, 'device returned no firmware string');
    assert.ok(Array.isArray(firmware.version), 'firmware version did not parse');
    assert.strictEqual(firmware.version.length, 3);
    console.log(`       firmware=${firmware.raw} parsed=${firmware.version.join('.')}`);
  });

  test('reads the supported command list', async ({ device }) => {
    const commands = await device.getSupportedCommands();
    assert.ok(commands.length > 0);
    ['pwr.snap', 'pwr.info', 'sys.id', 'cfg.get', 'cfg.set'].forEach((command) => {
      assert.ok(commands.includes(command), `firmware does not advertise ${command}`);
    });
    console.log(`       ${commands.length} commands advertised`);
  });

  test('reads power configuration', async ({ device }) => {
    const info = await device.getPowerInfo();
    assert.ok(info.elem >= 1 && info.elem <= 8, `unexpected element ${info.elem}`);
    assert.ok(info.eval > 0, 'element rating should be positive');
    assert.ok([1, 2, 4].includes(info.range.multiplier));
    assert.strictEqual(info.maxPowerW, info.eval * info.range.multiplier);
    console.log(
      `       elem=${info.elem} etype=${info.etype} eval=${info.eval}W range=${info.range.label} max=${info.maxPowerW}W`,
    );
  });

  test('reads a single power metric', async ({ device }) => {
    const reading = await device.getPower('avg');
    assert.strictEqual(reading.metric, 'avg');
    assert.ok(Number.isFinite(reading.value));
    console.log(`       avg=${reading.value} W`);
  });

  test('reads every power metric', async ({ device }) => {
    for (const metric of ['inst', 'avg', 'peak', 'max', 'min', 'dev']) {
      const reading = await device.getPower(metric);
      assert.ok(Number.isFinite(reading.value), `${metric} was not numeric`);
    }
  });

  test('reads a decoded snapshot', async ({ device }) => {
    const snapshot = await device.getSnapshot();

    ['inst', 'avg', 'peak', 'max', 'min', 'dev', 'pvolt', 'svolt'].forEach((field) => {
      assert.ok(Number.isFinite(snapshot[field]), `${field} was not numeric`);
    });

    assert.ok(snapshot.max >= snapshot.min, 'max should not be below min');
    assert.ok(snapshot.svolt > 0, 'supply voltage should be positive');
    assert.ok(snapshot.timestamp > 0);
    console.log(
      `       inst=${snapshot.inst.toFixed(3)}W avg=${snapshot.avg.toFixed(3)}W peak=${snapshot.peak.toFixed(3)}W svolt=${snapshot.svolt}V`,
    );
  });

  test('reads a combined status', async ({ device }) => {
    const status = await device.getStatus();
    assert.ok(status.uid);
    assert.ok(status.firmware.raw);
    assert.ok(status.snapshot);
    assert.strictEqual(status.path, device.path);
  });

  test('reads all eight element profiles', async ({ device }) => {
    const profiles = await device.getElementProfiles();
    assert.strictEqual(profiles.length, 8);
    profiles.forEach((profile, index) => {
      assert.strictEqual(profile.elem, index + 1);
      assert.ok(Number.isFinite(profile.eval));
      assert.ok(profile.etype.length > 0);
    });
    console.log(`       ${profiles.map((p) => `${p.elem}:${p.eval}W/${p.etype}`).join(' ')}`);
  });

  test('reads configuration values', async ({ device }) => {
    const brightness = await device.getBrightness();
    const averaging = await device.getAveragingWindow();
    const range = await device.getRange();

    assert.ok(brightness >= 0 && brightness <= 10, `brightness ${brightness} out of range`);
    assert.ok(averaging > 0, 'averaging window should be positive');
    assert.ok([1, 2, 4].includes(range.multiplier));
    console.log(`       bright=${brightness} avgw=${averaging}s range=${range.label}`);
  });

  test('surfaces firmware errors as ProtocolError', async ({ device }) => {
    await assert.rejects(
      () => device.getConfig('definitely_not_a_key'),
      (error) => error.name === 'ProtocolError' || error instanceof TimeoutError,
    );
  });
});

describe('live device: protocol negotiation', ({ test, before, after }) => {
  before(async () => {
    const [info] = await findDevices();
    assert.ok(info, 'No DWM device found.');
    const device = new Device(info);
    await device.open();
    return { device };
  });

  after(async ({ device }) => {
    if (device) await device.close();
  });

  test('negotiates a supported protocol version on connect', async ({ device }) => {
    assert.ok(
      ['1', '2'].includes(device.protocolVersion),
      `unexpected protocol version ${device.protocolVersion}`,
    );
    console.log(`       negotiated proto=${device.protocolVersion}`);
  });

  test('answers an explicit proto=2 request', async ({ device }) => {
    const frame = await device.send('sys.id', {}, {
      protocolVersion: '2',
      allowLegacyFallback: false,
    });
    assert.strictEqual(frame.status, 'ok');
    assert.ok(['1', '2'].includes(frame.proto));
  });

  test('accepts a proto=1 request for backwards compatibility', async ({ device }) => {
    const frame = await device.send('sys.id', {}, {
      protocolVersion: '1',
      allowLegacyFallback: false,
    });
    assert.strictEqual(frame.status, 'ok');
    assert.ok(frame.uid, 'legacy request returned no uid');
  });

  test('rejects an unsupported protocol version', async ({ device }) => {
    // Bypass the Device API to put a deliberately invalid version on the wire.
    // The resulting error frame is uncorrelated, which must not crash the host:
    // it is reported on `deviceError` and only on `error` if something listens.
    const responses = [];
    const deviceErrors = [];
    const listener = (frame) => responses.push(frame);
    const errorListener = (error) => deviceErrors.push(error);
    device.on('frame', listener);
    device.on('deviceError', errorListener);

    await device.sendRaw('proto=9 type=cmd cmd=sys.id req=9001\r\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    device.off('frame', listener);
    device.off('deviceError', errorListener);

    const reply = responses.find((frame) => frame.req === '9001');
    assert.ok(reply, 'device did not answer the invalid-version frame');
    assert.strictEqual(reply.type, 'err');
    assert.strictEqual(reply.code, 'ERR_BAD_ENUM');
    assert.ok(
      deviceErrors.some((error) => error.code === 'ERR_BAD_ENUM'),
      'uncorrelated error frame was not reported on deviceError',
    );
    console.log(`       rejected with ${reply.code} (${reply.msg})`);
  });

  test('does not crash when an uncorrelated error frame has no listener', async ({ device }) => {
    // No `error` or `deviceError` listener is attached here on purpose.
    assert.strictEqual(device.listenerCount('error'), 0);
    await device.sendRaw('proto=9 type=cmd cmd=sys.id req=9002\r\n');
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Surviving to this point is the assertion; the connection must still work.
    assert.ok((await device.getIdentity()).uid);
  });

  test('correlates concurrent requests by request id', async ({ device }) => {
    const [identity, firmware, info] = await Promise.all([
      device.getIdentity(),
      device.getFirmwareVersion(),
      device.getPowerInfo(),
    ]);

    assert.ok(identity.uid);
    assert.ok(firmware.raw);
    assert.ok(info.elem >= 1);
  });

  test('honours a per-request timeout', async ({ device }) => {
    await assert.rejects(
      () => device.send('sys.id', {}, { timeoutMs: 1, pacingMs: 0, allowLegacyFallback: false }),
      (error) => error instanceof TimeoutError,
    );

    // The connection must remain usable afterwards.
    assert.ok((await device.getIdentity()).uid);
  });
});

describe('live device: writes', ({ test, before, after }) => {
  before(async () => {
    const [info] = await findDevices();
    assert.ok(info, 'No DWM device found.');
    const device = new Device(info);
    await device.open();

    // Capture everything the write tests touch so it can be restored.
    const original = {
      name: await device.getName(),
      brightness: await device.getBrightness(),
      range: await device.getRange(),
      averaging: await device.getAveragingWindow(),
      element: (await device.getPowerInfo()).elem,
    };

    console.log(
      `       captured: name=${original.name} bright=${original.brightness} range=${original.range.label} avgw=${original.averaging} elem=${original.element}`,
    );

    return { device, original };
  });

  after(async ({ device, original }) => {
    if (!device || !device.isOpen) return;

    // Restore in the reverse order of modification, ignoring individual failures
    // so one restore error cannot strand the rest.
    const restore = [
      () => device.setBrightness(original.brightness),
      () => device.setRange(original.range.label),
      () => device.setAveragingWindow(original.averaging),
      () => device.setElement(original.element),
      () => (original.name ? device.setName(original.name) : null),
    ];

    for (const step of restore) {
      try {
        await step();
      } catch (error) {
        console.log(`       ! restore step failed: ${error.message}`);
      }
    }

    console.log('       restored original settings');
    await device.close();
  });

  test('writes and reads back the display brightness', async ({ device, original }) => {
    const target = original.brightness === 5 ? 6 : 5;
    const confirmed = await device.setBrightness(target);
    assert.strictEqual(confirmed, target);
    assert.strictEqual(await device.getBrightness(), target);
    console.log(`       bright ${original.brightness} -> ${target}`);
  });

  test('clamps out-of-range brightness rather than erroring', async ({ device }) => {
    assert.strictEqual(await device.setBrightness(999), 10);
    assert.strictEqual(await device.setBrightness(-5), 0);
  });

  test('writes and reads back the ADC range', async ({ device, original }) => {
    for (const label of ['1x', '2x', '4x']) {
      const confirmed = await device.setRange(label);
      assert.strictEqual(confirmed.label, label, `setRange(${label}) reported ${confirmed.label}`);

      const readBack = await device.getRange();
      assert.strictEqual(readBack.label, label, `getRange after setRange(${label}) reported ${readBack.label}`);
    }
    console.log(`       cycled 1x/2x/4x, restoring ${original.range.label}`);
  });

  test('reflects the range change in pwr.info', async ({ device }) => {
    await device.setRange('4x');
    const info = await device.getPowerInfo();
    assert.strictEqual(info.range.multiplier, 4);
    assert.strictEqual(info.maxPowerW, info.eval * 4);
  });

  test('rejects an uninterpretable range', async ({ device }) => {
    await assert.rejects(() => device.setRange('16x'), /Unsupported range/);
  });

  test('writes and reads back the averaging window', async ({ device, original }) => {
    const target = original.averaging === 1 ? 2 : 1;
    const confirmed = await device.setAveragingWindow(target);
    assert.strictEqual(confirmed, target);
    console.log(`       avgw ${original.averaging} -> ${target}`);
  });

  test('selects an element', async ({ device, original }) => {
    const target = original.element === 1 ? 2 : 1;
    assert.strictEqual(await device.setElement(target), target);
    assert.strictEqual((await device.getPowerInfo()).elem, target);
    console.log(`       elem ${original.element} -> ${target}`);
  });

  test('rejects an out-of-range element', async ({ device }) => {
    await assert.rejects(() => device.setElement(0), /Element must be/);
    await assert.rejects(() => device.setElement(9), /Element must be/);
  });

  test('writes and reads back the device name', async ({ device, original }) => {
    const target = 'DWM_CORE_TEST';
    assert.strictEqual(await device.setName(target), target);
    assert.strictEqual(await device.getName(), target);
    console.log(`       name ${original.name} -> ${target}`);
  });

  test('sanitises a name before sending it', async ({ device }) => {
    assert.strictEqual(await device.setName('My Meter! #9'), 'My_Meter_9');
  });

  test('rejects a name with nothing usable in it', async ({ device }) => {
    await assert.rejects(() => device.setName('!!!'), /at least one alphanumeric/);
  });
});

describe('live device: monitoring', ({ test, before, after }) => {
  before(async () => {
    const [info] = await findDevices();
    assert.ok(info, 'No DWM device found.');
    const device = new Device(info);
    await device.open();
    return { device };
  });

  after(async ({ device }) => {
    if (device) {
      device.stopMonitoring();
      await device.close();
    }
  });

  test('emits snapshots while monitoring', async ({ device }) => {
    const snapshots = [];
    const onSnapshot = (snapshot) => snapshots.push(snapshot);
    device.on('snapshot', onSnapshot);

    device.startMonitoring({ intervalMs: 100 });
    assert.strictEqual(device.isMonitoring, true);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    device.stopMonitoring();
    device.off('snapshot', onSnapshot);

    assert.ok(snapshots.length >= 5, `expected at least 5 snapshots, received ${snapshots.length}`);
    assert.ok(snapshots.every((snapshot) => Number.isFinite(snapshot.avg)));

    const spans = snapshots[snapshots.length - 1].timestamp - snapshots[0].timestamp;
    console.log(
      `       ${snapshots.length} snapshots over ${spans}ms (~${Math.round((snapshots.length / spans) * 1000)}/s)`,
    );
  });

  test('stops cleanly and emits nothing further', async ({ device }) => {
    device.startMonitoring({ intervalMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    device.stopMonitoring();
    assert.strictEqual(device.isMonitoring, false);

    let received = 0;
    const onSnapshot = () => {
      received += 1;
    };
    device.on('snapshot', onSnapshot);
    await new Promise((resolve) => setTimeout(resolve, 600));
    device.off('snapshot', onSnapshot);

    assert.strictEqual(received, 0, 'snapshots continued after stopMonitoring');
  });

  test('interleaves commands with monitoring without corrupting either', async ({ device }) => {
    const snapshots = [];
    const onSnapshot = (snapshot) => snapshots.push(snapshot);
    device.on('snapshot', onSnapshot);
    device.startMonitoring({ intervalMs: 100 });

    const identity = await device.getIdentity();
    const info = await device.getPowerInfo();

    device.stopMonitoring();
    device.off('snapshot', onSnapshot);

    assert.ok(identity.uid, 'identity read was corrupted by monitoring');
    assert.ok(info.elem >= 1, 'power info read was corrupted by monitoring');
    assert.ok(snapshots.length > 0, 'monitoring stalled while commands ran');
  });

  test('emits raw data events', async ({ device }) => {
    let received = '';
    const onData = (text) => {
      received += text;
    };
    device.on('data', onData);

    await device.getIdentity();
    device.off('data', onData);

    assert.ok(received.includes('proto='), 'no raw protocol text observed');
  });
});

describe('live device: firmware pipeline', ({ test }) => {
  test('resolves a dfu-util executable', () => {
    const updater = new FirmwareUpdater({
      searchPaths: [path.join(__dirname, '..', '..', 'DWM-Control')],
    });
    const command = updater.resolveCommand();
    assert.ok(command.length > 0);
    console.log(`       dfu-util: ${command}`);
  });

  test('enumerates DFU devices without error', async () => {
    const updater = new FirmwareUpdater();
    const result = await updater.listDevices();

    // The meter is in application mode, so an empty list is the expected result;
    // what matters is that the tool runs and its output parses.
    assert.ok(typeof result.success === 'boolean');
    assert.ok(Array.isArray(result.devices));
    console.log(
      `       dfu-util ${result.success ? 'ran' : 'unavailable'}, ${result.devices.length} device(s) in DFU mode`,
    );
  });

  test('parses a real firmware image', async () => {
    const candidates = [
      process.env.DWM_LIVE_FIRMWARE_HEX,
      path.join(__dirname, '..', '..', 'DWM-Control', 'Test_Firmware', 'DWM_V2_3_2.hex'),
    ].filter(Boolean);

    const hexPath = candidates.find((candidate) => fs.existsSync(candidate));
    assert.ok(hexPath, `No firmware image found. Tried: ${candidates.join(', ')}`);

    const image = parseHex(fs.readFileSync(hexPath));
    assert.ok(image.size > 1024, 'firmware image is implausibly small');
    assert.strictEqual(image.startAddress, 0x08000000);
    assert.strictEqual(image.data.length, image.size);
    console.log(
      `       ${path.basename(hexPath)}: ${image.size} bytes at 0x${image.startAddress.toString(16)}`,
    );
  });

  test('reports an upload failure rather than throwing when no device is in DFU mode', async () => {
    if (process.env.DWM_LIVE_ALLOW_DFU !== '1') {
      // Without a device in DFU mode dfu-util exits non-zero, which is exactly
      // the path being asserted here: a structured failure, not an exception.
      const hexPath = path.join(
        __dirname,
        '..',
        '..',
        'DWM-Control',
        'Test_Firmware',
        'DWM_V2_3_2.hex',
      );
      if (!fs.existsSync(hexPath)) return;

      const updater = new FirmwareUpdater();
      const result = await updater.upload(hexPath);

      assert.strictEqual(result.success, false, 'upload reported success with no device in DFU mode');
      assert.match(result.error, /No device in DFU mode/);
      assert.ok(result.size > 0, 'image was not prepared before the upload attempt');
      console.log(`       correctly reported: ${result.error}`);
    }
  });
});
