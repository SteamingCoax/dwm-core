'use strict';

/**
 * Timing tests.
 *
 * The device is sensitive to how fast it is written to, and several commands
 * need budgets other than the default. These values were carried over from the
 * original application; this suite pins them so they cannot drift silently.
 */

const assert = require('assert');
const { describe } = require('./harness');
const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PACING_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  COMMAND_TIMEOUTS_MS,
  DFU_DETACH_DELAY_MS,
  Device,
} = require('../src');

describe('timing: documented defaults', ({ test }) => {
  test('matches the original application', () => {
    assert.strictEqual(DEFAULT_TIMEOUT_MS, 2000);
    assert.strictEqual(DEFAULT_PACING_MS, 100);
    assert.strictEqual(DEFAULT_POLL_INTERVAL_MS, 250);
    assert.strictEqual(DEFAULT_PROBE_TIMEOUT_MS, 2500);
    assert.strictEqual(DFU_DETACH_DELAY_MS, 1200);
  });

  test('gives slow and reboot commands their own budgets', () => {
    // sys.fw needs headroom on older firmware.
    assert.strictEqual(COMMAND_TIMEOUTS_MS['sys.fw'], 3000);
    // Reboot commands may never reply, so they fail fast on purpose.
    assert.strictEqual(COMMAND_TIMEOUTS_MS['sys.rst'], 1000);
    assert.strictEqual(COMMAND_TIMEOUTS_MS['sys.dfu'], 1000);
  });

  test('a Device adopts the defaults', () => {
    const device = new Device('/dev/null');
    assert.strictEqual(device.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.strictEqual(device.pacingMs, DEFAULT_PACING_MS);
    assert.strictEqual(device.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  });

  test('constructor options override the defaults', () => {
    const device = new Device('/dev/null', {
      timeoutMs: 500,
      pacingMs: 0,
      pollIntervalMs: 50,
    });
    assert.strictEqual(device.timeoutMs, 500);
    assert.strictEqual(device.pacingMs, 0);
    assert.strictEqual(device.pollIntervalMs, 50);
  });

  test('a negative pacing value is clamped rather than rejected', () => {
    assert.strictEqual(new Device('/dev/null', { pacingMs: -5 }).pacingMs, 0);
  });
});

describe('timing: request behaviour', ({ test }) => {
  /**
   * Builds a Device with a stubbed connection that records write times and
   * never answers, so timeout behaviour can be observed without hardware.
   *
   * @param {object} [options] Device options.
   * @returns {{device: Device, writes: number[]}}
   */
  function stubDevice(options = {}) {
    const device = new Device('/dev/null', options);
    const writes = [];
    device.connection = {
      isOpen: true,
      write: async () => {
        writes.push(Date.now());
      },
    };
    Object.defineProperty(device, 'isOpen', { get: () => true });
    return { device, writes };
  }

  test('waits the pacing delay before writing', async () => {
    const { device, writes } = stubDevice({ pacingMs: 120, timeoutMs: 60 });
    const startedAt = Date.now();
    await device.send('pwr.snap').catch(() => {});
    assert.ok(
      writes[0] - startedAt >= 115,
      `wrote after only ${writes[0] - startedAt}ms, expected >=120ms`,
    );
  });

  test('honours pacingMs: 0 so polling is not throttled', async () => {
    const { device, writes } = stubDevice({ pacingMs: 100, timeoutMs: 60 });
    const startedAt = Date.now();
    await device.send('pwr.snap', {}, { pacingMs: 0 }).catch(() => {});
    assert.ok(
      writes[0] - startedAt < 50,
      `pacing was applied despite pacingMs: 0 (${writes[0] - startedAt}ms)`,
    );
  });

  test('paces successive requests instead of writing back to back', async () => {
    const { device, writes } = stubDevice({ pacingMs: 80, timeoutMs: 40 });
    const noFallback = { allowLegacyFallback: false };
    await Promise.all([
      device.send('pwr.snap', {}, noFallback).catch(() => {}),
      device.send('pwr.snap', {}, noFallback).catch(() => {}),
      device.send('pwr.snap', {}, noFallback).catch(() => {}),
    ]);
    assert.strictEqual(writes.length, 3);
    for (let i = 1; i < writes.length; i += 1) {
      assert.ok(
        writes[i] - writes[i - 1] >= 75,
        `writes ${i - 1}->${i} were only ${writes[i] - writes[i - 1]}ms apart`,
      );
    }
  });

  test('serialises requests through a single queue', async () => {
    const { device, writes } = stubDevice({ pacingMs: 0, timeoutMs: 40 });
    await Promise.all([
      device.send('sys.id').catch(() => {}),
      device.send('sys.id').catch(() => {}),
    ]);
    // The second write must follow the first request's timeout, not race it.
    assert.ok(
      writes[1] - writes[0] >= 35,
      `requests overlapped (${writes[1] - writes[0]}ms apart)`,
    );
  });

  test('applies the per-command budget when none is supplied', async () => {
    const { device } = stubDevice({ pacingMs: 0 });
    const startedAt = Date.now();
    // sys.rst is budgeted at 1000ms, well below the 2000ms default.
    await device
      .send('sys.rst', {}, { allowLegacyFallback: false })
      .catch(() => {});
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed >= 950 && elapsed < 1600,
      `sys.rst timed out after ${elapsed}ms, expected ~1000ms`,
    );
  });

  test('an explicit timeout overrides the per-command budget', async () => {
    const { device } = stubDevice({ pacingMs: 0 });
    const startedAt = Date.now();
    await device
      .send('sys.rst', {}, { timeoutMs: 120, allowLegacyFallback: false })
      .catch(() => {});
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 600, `override ignored (${elapsed}ms)`);
  });

  test('reports the elapsed budget on the timeout error', async () => {
    const { device } = stubDevice({ pacingMs: 0 });
    const error = await device
      .send('pwr.snap', {}, { timeoutMs: 80, allowLegacyFallback: false })
      .catch((e) => e);
    assert.strictEqual(error.name, 'TimeoutError');
    assert.strictEqual(error.timeoutMs, 80);
    assert.match(error.message, /timed out after 80ms/);
  });
});

describe('timing: legacy fallback', ({ test }) => {
  test('retries once at proto=1, doubling the worst-case latency', async () => {
    const device = new Device('/dev/null', { pacingMs: 0 });
    const frames = [];
    device.connection = {
      isOpen: true,
      write: async (frame) => frames.push(frame),
    };
    Object.defineProperty(device, 'isOpen', { get: () => true });

    const startedAt = Date.now();
    await device.send('sys.id', {}, { timeoutMs: 100 }).catch(() => {});
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(frames.length, 2, 'expected a proto=1 retry');
    assert.match(frames[0], /^proto=2 /);
    assert.match(frames[1], /^proto=1 /);
    assert.ok(elapsed >= 190, `retry did not wait a full budget (${elapsed}ms)`);
  });
});
