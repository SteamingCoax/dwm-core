#!/usr/bin/env node
'use strict';

/**
 * Hardware-in-the-loop test: "the meter restarts into the application by itself
 * after a DFU update".
 *
 * Round trip: sys.fw (before) -> sys.dfu -> wait for 0483:df11 -> dfu-util
 * download with `:leave` and `-R` -> wait for the CDC port to re-enumerate ->
 * sys.fw (after) -> compare. Run with --help for options.
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 usage error.
 */

const fs = require('fs');
const {
  Device,
  findDevices,
  FirmwareUpdater,
  listDfuDevices,
} = require('../src');
const { DFU_USB_VENDOR_ID, DFU_USB_PRODUCT_ID } = require('../src/types');

const HELP = `Usage: node scripts/dfu-roundtrip.js --bin <file.bin> [options]

Puts the meter into DFU with sys.dfu, flashes <file.bin> at 0x08000000 with
:leave and -R, then verifies the meter re-enumerates and answers sys.fw
without any manual reset.

Options:
  --bin <path>            Raw .bin image (required)
  --port <path>           Serial port to use (skips discovery)
  --serial <usb serial>   After DFU, only accept a port with this USB serial
  --expect-fver <string>  Required firmware version after the update
                          (underscores and spaces are treated alike)
  --dfu-timeout <sec>     Wait for the DFU device (default 15)
  --return-timeout <sec>  Wait for the serial port to return (default 20)
  --repeat <n>            Repeat the round trip n times; stop at first FAIL
  --help                  Show this help

If --expect-fver is absent, a "FW: x.y.z..." string embedded in the .bin is
used when present. dfu-util is taken from PATH.
Exit: 0 PASS, 1 FAIL, 2 usage error.
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown to abort a run with a named step. */
class StepFailure extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

/**
 * Parses command-line arguments.
 *
 * @param {string[]} argv Arguments without the node/script prefix.
 * @returns {{options?: object, help?: boolean, error?: string}}
 */
function parseArgs(argv) {
  const options = {
    port: null,
    serial: null,
    bin: null,
    expectFver: null,
    dfuTimeoutMs: 15000,
    returnTimeoutMs: 20000,
    repeat: 1,
  };
  const valued = {
    '--port': 'port',
    '--serial': 'serial',
    '--bin': 'bin',
    '--expect-fver': 'expectFver',
    '--dfu-timeout': 'dfuTimeoutMs',
    '--return-timeout': 'returnTimeoutMs',
    '--repeat': 'repeat',
  };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };

    let inline;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const key = valued[arg];
    if (!key) return { error: `Unknown argument: ${argv[i]}` };

    let value = inline;
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) return { error: `Missing value for ${arg}` };
    }

    if (key === 'dfuTimeoutMs' || key === 'returnTimeoutMs') {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { error: `${arg} must be a positive number of seconds` };
      }
      options[key] = Math.round(seconds * 1000);
    } else if (key === 'repeat') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        return { error: '--repeat must be a positive integer' };
      }
      options.repeat = n;
    } else {
      options[key] = value;
    }
  }

  if (!options.bin) return { error: '--bin <path> is required' };
  return { options };
}

/**
 * Collapses spaces and underscores so a device-encoded version
 * ("FW:_2.6.5") compares equal to the human form ("FW: 2.6.5").
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function normalizeFver(value) {
  return String(value ?? '')
    .replace(/[_\s]+/g, ' ')
    .trim();
}

/**
 * Compares two firmware version strings after normalisation.
 *
 * @returns {boolean}
 */
function fverEquals(a, b) {
  return normalizeFver(a) === normalizeFver(b);
}

/**
 * Finds a "FW: x.y.z..." version string embedded in a firmware image.
 *
 * @param {Buffer} buffer Image contents.
 * @returns {string|null} The match, or null.
 */
function extractEmbeddedFver(buffer) {
  const text = buffer.toString('latin1');
  const match = text.match(/FW: [0-9]+\.[0-9]+\.[0-9]+[^\x00]{0,24}/);
  return match ? match[0] : null;
}

/**
 * Whether an embedded string and a reported version match. The reported value
 * may be shorter than the embedded one (the pattern grabs up to 24 trailing
 * non-NUL bytes), so a prefix match is accepted too.
 */
function embeddedMatches(embedded, reported) {
  const e = normalizeFver(embedded);
  const r = normalizeFver(reported);
  return e === r || (r.length > 0 && e.startsWith(r)) || (e.length > 0 && r.startsWith(e));
}

const t0 = Date.now();
function log(message) {
  console.log(`[${new Date().toISOString()}] +${((Date.now() - t0) / 1000).toFixed(2)}s ${message}`);
}

/** Lists attached meters, optionally filtered by USB serial. */
async function findMeters(serial) {
  const devices = await findDevices();
  if (!serial) return devices;
  const want = serial.toLowerCase();
  return devices.filter(
    (d) =>
      String(d.serialNumber || '').toLowerCase() === want ||
      String(d.key || '').toLowerCase().endsWith(want.toLowerCase()) ||
      String(d.pnpId || '').toLowerCase().includes(want),
  );
}

function describeMeter(d) {
  return `${d.path} (VID ${d.vendorId || '?'} PID ${d.productId || '?'} serial ${d.serialNumber || '?'})`;
}

/** Polls until `probe` returns a truthy value or the timeout passes. */
async function pollUntil(probe, timeoutMs, intervalMs = 250) {
  const start = Date.now();
  for (;;) {
    let value = null;
    try {
      value = await probe();
    } catch {
      value = null;
    }
    if (value) return { value, elapsedMs: Date.now() - start };
    if (Date.now() - start >= timeoutMs) return { value: null, elapsedMs: Date.now() - start };
    await sleep(intervalMs);
  }
}

/** Opens a port without the sys.id probe and reads sys.fw at proto=2. */
async function readFver(portPath) {
  const device = new Device({ path: portPath });
  try {
    await device.open({ probe: false });
    const { raw } = await device.getFirmwareVersion({
      allowLegacyFallback: false,
      timeoutMs: 3000,
    });
    if (!raw) throw new Error('sys.fw response had no fver field');
    return raw;
  } finally {
    await device.close().catch(() => {});
  }
}

/** One full round trip. Returns the summary object. */
async function roundTrip(options, image, updater) {
  const summary = {
    result: 'FAIL',
    before: null,
    after: null,
    dfuAppearMs: null,
    downloadMs: null,
    returnMs: null,
    reason: null,
  };

  try {
    // Step 1: discover
    let portPath = options.port;
    if (!portPath) {
      const meters = await findMeters(null);
      if (meters.length === 0) throw new StepFailure(1, 'No DWM meter found on USB (VID 0483, PID 5740/A59C)');
      if (meters.length > 1) {
        throw new StepFailure(
          1,
          `More than one meter attached; pass --port. Found:\n  ${meters.map(describeMeter).join('\n  ')}`,
        );
      }
      portPath = meters[0].path;
      log(`Step 1: found meter ${describeMeter(meters[0])}`);
    } else {
      log(`Step 1: using --port ${portPath}`);
    }

    // Step 2: before
    try {
      summary.before = await readFver(portPath);
    } catch (error) {
      throw new StepFailure(2, `sys.fw (before) failed: ${error.message}`);
    }
    log(`Step 2: before fver=${summary.before}`);

    // Step 3: sys.dfu
    log('Step 3: sending sys.dfu');
    const dfuSentAt = Date.now();
    const device = new Device({ path: portPath });
    try {
      await device.open({ probe: false });
      await device.enterDFU({ detachDelayMs: 300, timeoutMs: 2000 });
      log('Step 3: sys.dfu sent (acknowledged or device already detached)');
    } catch (error) {
      throw new StepFailure(3, `sys.dfu failed: ${error.message}`);
    } finally {
      await device.close().catch(() => {});
    }

    // Step 4: wait for DFU
    log(`Step 4: waiting up to ${options.dfuTimeoutMs / 1000}s for ${DFU_USB_VENDOR_ID}:${DFU_USB_PRODUCT_ID} (dfu-util -l)`);
    const isDfu = async () => {
      const listing = await listDfuDevices(updater.options);
      if (!listing.success) throw new Error(listing.error);
      return listing.devices.find(
        (d) =>
          d.vid.toLowerCase() === DFU_USB_VENDOR_ID.toLowerCase() &&
          d.pid.toLowerCase() === DFU_USB_PRODUCT_ID.toLowerCase(),
      );
    };
    const dfu = await pollUntil(isDfu, options.dfuTimeoutMs, 300);
    if (!dfu.value) {
      throw new StepFailure(4, `Timed out after ${options.dfuTimeoutMs} ms waiting for the DFU device`);
    }
    summary.dfuAppearMs = Date.now() - dfuSentAt;
    log(`Step 4: DFU device present ${summary.dfuAppearMs} ms after sys.dfu (serial ${dfu.value.serial})`);

    // Step 5: download
    log(`Step 5: downloading ${image.length} bytes to 0x08000000 with :leave and -R`);
    const dlStart = Date.now();
    const result = await updater.upload(image, {
      binary: true,
      reboot: true,
      log: (text) => {
        String(text)
          .split(/\r?\n|\r/)
          .filter((l) => l.trim())
          .forEach((l) => console.log(`dfu-util: ${l}`));
      },
    });
    const dlEnd = Date.now();
    summary.downloadMs = dlEnd - dlStart;
    if (!result.success) {
      throw new StepFailure(5, `dfu-util download failed: ${result.error}`);
    }
    log(`Step 5: dfu-util finished OK in ${summary.downloadMs} ms (exit 0 or 74 accepted)`);

    // Step 6: wait for CDC to return
    log(`Step 6: waiting up to ${options.returnTimeoutMs / 1000}s for the serial port${options.serial ? ` (serial ${options.serial})` : ''}`);
    const back = await pollUntil(async () => {
      const meters = await findMeters(options.serial);
      if (options.port) return meters.find((m) => m.path === options.port) || meters[0];
      return meters[0];
    }, options.returnTimeoutMs, 250);
    if (!back.value) {
      console.log('Meter did not re-enumerate after DFU leave; it is probably hung in the application start or still in DFU');
      const listing = await listDfuDevices(updater.options);
      console.log('Current `dfu-util -l` output:');
      console.log(listing.output || listing.error || '(no output)');
      throw new StepFailure(6, `Serial port did not return within ${options.returnTimeoutMs} ms`);
    }
    summary.returnMs = Date.now() - dlEnd;
    log(`Step 6: port ${back.value.path} back ${summary.returnMs} ms after dfu-util exited`);

    // Step 7: after + compare. The port can enumerate slightly before the
    // application answers, so retry sys.fw briefly.
    const retry = await pollUntil(async () => {
      try {
        summary.after = await readFver(back.value.path);
        return true;
      } catch (error) {
        summary.reason = error.message;
        return false;
      }
    }, 5000, 500);
    if (!retry.value) {
      throw new StepFailure(7, `sys.fw (after) failed: ${summary.reason}`);
    }
    summary.reason = null;
    log(`Step 7: after fver=${summary.after}`);

    if (options.expectFver) {
      if (!fverEquals(summary.after, options.expectFver)) {
        throw new StepFailure(7, `fver mismatch: expected "${options.expectFver}", got "${summary.after}"`);
      }
      log('Step 7: matches --expect-fver');
    } else {
      const embedded = extractEmbeddedFver(image);
      if (embedded) {
        log(`Step 7: version embedded in .bin: "${embedded}"`);
        if (!embeddedMatches(embedded, summary.after)) {
          throw new StepFailure(7, `fver mismatch: .bin embeds "${embedded}", meter reports "${summary.after}"`);
        }
      } else {
        log('Step 7: no embedded "FW: x.y.z" string in .bin and no --expect-fver; only checking the meter answers');
      }
    }

    summary.result = 'PASS';
  } catch (error) {
    summary.result = 'FAIL';
    summary.reason = error instanceof StepFailure ? `step ${error.step}: ${error.message}` : `unexpected: ${error.message}`;
    log(`FAIL ${summary.reason}`);
  }
  return summary;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.error) {
    console.error(`${parsed.error}\n`);
    console.error(HELP);
    return 2;
  }
  const { options } = parsed;

  let image;
  try {
    image = fs.readFileSync(options.bin);
  } catch (error) {
    console.error(`Cannot read --bin ${options.bin}: ${error.message}`);
    return 2;
  }
  if (image.length === 0) {
    console.error('--bin file is empty');
    return 2;
  }

  const updater = new FirmwareUpdater();
  log(`dfu-util: ${updater.resolveCommand()}; image ${options.bin} (${image.length} bytes); repeat ${options.repeat}`);

  const summaries = [];
  for (let run = 1; run <= options.repeat; run++) {
    log(`=== Run ${run}/${options.repeat} ===`);
    const summary = await roundTrip(options, image, updater);
    summaries.push(summary);
    console.log(JSON.stringify(summary));
    if (summary.result !== 'PASS') break;
  }

  if (options.repeat > 1) {
    const passed = summaries.filter((s) => s.result === 'PASS').length;
    log(`Summary: ${passed}/${options.repeat} passed${summaries.length < options.repeat ? ' (stopped at first FAIL)' : ''}`);
  }
  return summaries[summaries.length - 1].result === 'PASS' ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}

module.exports = {
  parseArgs,
  normalizeFver,
  fverEquals,
  extractEmbeddedFver,
  embeddedMatches,
};
