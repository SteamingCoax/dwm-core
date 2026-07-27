#!/usr/bin/env node
'use strict';

/**
 * Minimal command-line demonstration of the `dwm-core` public API.
 *
 * Discovers the first attached DWM meter, prints its identity and a live power
 * reading, then streams snapshots for a few seconds before disconnecting.
 *
 * Usage:
 *   node examples/basic-cli.js [seconds]
 */

const { findDevices, Device } = require('../src');

/** Number of seconds to stream for when no argument is supplied. */
const DEFAULT_STREAM_SECONDS = 5;

async function main() {
  const seconds = Number(process.argv[2]) || DEFAULT_STREAM_SECONDS;

  console.log('Scanning for DWM devices...');
  const devices = await findDevices();

  if (devices.length === 0) {
    console.error('No DWM device found. Check the USB cable and try again.');
    process.exitCode = 1;
    return;
  }

  devices.forEach((info, index) => {
    console.log(`  [${index}] ${info.path}  (${info.manufacturer || 'unknown'})`);
  });

  const device = new Device(devices[0]);

  // Always attach an error listener in real applications; the library will not
  // crash without one, but you will silently lose transport errors.
  device.on('error', (error) => console.error('device error:', error.message));
  device.on('disconnect', () => console.error('device disconnected'));

  await device.open();

  try {
    const identity = await device.getIdentity();
    const firmware = await device.getFirmwareVersion();
    console.log(`\nConnected to ${identity.dname} (uid ${identity.uid})`);
    console.log(`Firmware:  ${firmware.raw}`);
    console.log(`Protocol:  v${device.protocolVersion}`);

    const info = await device.getPowerInfo();
    const power = await device.getPower('avg');
    console.log(
      `Range:     ${info.range.label}   Element ${info.elem} (${info.etype}, ${info.eval} W)`,
    );
    console.log(`Power:     ${power.value.toFixed(3)} W average`);

    console.log(`\nStreaming for ${seconds}s...`);
    device.on('snapshot', (snapshot) => {
      process.stdout.write(
        `\r  inst ${snapshot.inst.toFixed(3)} W   ` +
          `avg ${snapshot.avg.toFixed(3)} W   ` +
          `peak ${snapshot.peak.toFixed(3)} W   ` +
          `supply ${snapshot.svolt} V   `,
      );
    });

    device.startMonitoring({ intervalMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    device.stopMonitoring();
    console.log('\n\nDone.');
  } finally {
    await device.close();
  }
}

main().catch((error) => {
  console.error(`\n${error.name}: ${error.message}`);
  process.exitCode = 1;
});
