'use strict';

/**
 * Test entry point.
 *
 * Usage:
 *   node test/run.js          run every suite
 *   node test/run.js --unit   run only offline suites
 *   node test/run.js --live   run only hardware suites
 *
 * Live suites require a DWM V2 device to be connected; they fail rather than
 * skip, so a green run is meaningful.
 */

const { run } = require('./harness');

const args = process.argv.slice(2);
const unitOnly = args.includes('--unit');
const liveOnly = args.includes('--live');

if (!liveOnly) {
  require('./protocol.test');
  require('./serial.test');
  require('./firmware.test');
  require('./timing.test');
}

if (!unitOnly) {
  require('./live-device.test');
}

run().then(({ failed }) => {
  process.exit(failed > 0 ? 1 : 0);
});
