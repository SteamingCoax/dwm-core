# dwm-core

Pure Node.js core for DWM RF power meters: device discovery, USB serial transport,
the v1/v2 wire protocol, high-level device control, live monitoring, and firmware
(Intel HEX → DFU) updates.

There is **no Electron, DOM, IPC or UI code** in this package. It runs anywhere Node
runs — an Electron main process, a CLI, a test runner, a background service.

---

## Installation

This is a private package, so install it straight from GitHub:

```bash
npm install git+ssh://git@github.com/SteamingCoax/dwm-core.git
```

or, in `package.json`:

```json
{
  "dependencies": {
    "dwm-core": "git+https://github.com/SteamingCoax/dwm-core.git"
  }
}
```

For local development against a checkout side by side with your app:

```json
{
  "dependencies": {
    "dwm-core": "file:../dwm-core"
  }
}
```

**Requirements:** Node 18+. The only runtime dependency is
[`serialport`](https://www.npmjs.com/package/serialport) v12, which ships prebuilt
binaries for macOS, Windows and Linux.

Firmware uploads additionally need a `dfu-util` binary. One is located
automatically if it sits in a `Programs/dfu-util/` folder next to your app, and
the path can always be overridden explicitly (see [Firmware updates](#firmware-updates)).

---

## Quick start

```js
const { findDevices, Device } = require('dwm-core');

const [info] = await findDevices();
const device = new Device(info);

await device.open();

const { uid, dname } = await device.getIdentity();
const power = await device.getPower('avg');

console.log(`${dname} (${uid}) is reading ${power.value} W`);

await device.close();
```

Run the bundled demo against a connected meter:

```bash
node examples/basic-cli.js 5
```

---

## Discovery

```js
const { findDevices, listPorts } = require('dwm-core');

const devices = await findDevices();  // DWM devices only (VID 0483, PID 5740 or A59C)
const all     = await listPorts();    // every serial port on the system
```

Each entry carries the raw `serialport` fields plus a stable `key` derived from the
USB serial number, so a device can be recognised across reconnects even when the
OS hands it a different `/dev/tty*` or `COM` path.

```js
{
  path: '/dev/tty.usbmodem205F33AE54421',
  key: 'usbmodem:205F33AE54421',
  manufacturer: 'STMicroelectronics',
  vendorId: '0483',
  productId: '5740'
}
```

---

## The `Device` class

`Device` is the main abstraction. It owns the port, frames and parses the wire
protocol, correlates concurrent requests by request id, paces writes, retries on
the legacy protocol when needed, and can poll the device in the background.

### Lifecycle

```js
const device = new Device('/dev/tty.usbmodem205F33AE54421'); // path or info object

await device.open();   // opens the port and negotiates the protocol version
device.isOpen;         // => true
device.protocolVersion;// => '2'
await device.close();
```

### Reading

| Method | Command | Returns |
| --- | --- | --- |
| `getIdentity()` | `sys.id` | `{ uid, dname }` |
| `getFirmwareVersion()` | `sys.fw` | `{ raw, version: [major, minor, patch] }` |
| `getSupportedCommands()` | `sys.cmds` | `string[]` |
| `getName()` | `cfg.get name` | `string` |
| `getPower(metric)` | `pwr.get` | `{ metric, value, elem, etype, eval, range }` |
| `getSnapshot()` | `pwr.snap` | all eight metrics at once (see below) |
| `getPowerInfo()` | `pwr.info` | `{ elem, etype, eval, range, maxPowerW }` |
| `getElement(n)` | `pwr.elem` | `{ element, rating, type }` |
| `getElementProfiles()` | `pwr.elems` | all eight elements |
| `getRange()` | `cfg.get range` | `{ cfg, multiplier, label }` |
| `getBrightness()` | `cfg.get bright` | `0`–`10` |
| `getAveragingWindow()` | `cfg.get avgw` | seconds |
| `getStatus()` | *(composite)* | identity + firmware + power + snapshot |

Valid metrics for `getPower()` are `inst`, `avg`, `peak`, `max`, `min` and `dev`.

A snapshot expands the device's compact CSV payload into named fields:

```js
{
  inst: 8.03, avg: 8.027, peak: 8.037, max: 9.1, min: 7.8, dev: 0.01,
  pvolt: 412,        // probe voltage, millivolts
  svolt: 5,          // supply voltage, volts
  elem: 1, etype: '30ua', eval: 5,
  range: { cfg: 2, multiplier: 4, label: '4x' },
  maxPowerW: 20,
  timestamp: 1730000000000
}
```

### Writing

```js
await device.setName('BENCH_METER');   // sanitised to the device's charset
await device.setElement(2);            // element 1-8
await device.setRange('4x');           // '1x' | '2x' | '4x', or a raw cfg number
await device.setBrightness(5);         // 0-10, clamped
await device.setAveragingWindow(1);    // seconds
await device.enterDFU();               // reboot into the bootloader
await device.identify();               // flash the display to locate the unit
```

Every setter reads the value back and resolves with what the device actually
confirmed, so a silent clamp or rejection can never go unnoticed.

Anything not wrapped is still reachable:

```js
await device.send('cfg.get', { key: 'bright' });  // framed, correlated, translated
await device.sendRaw('proto=2 type=cmd cmd=sys.id req=1\r\n'); // fire and forget
```

### Monitoring

```js
device.on('snapshot', (s) => console.log(s.inst));
device.startMonitoring({ intervalMs: 100 });
// ...
device.stopMonitoring();
```

Polling is *start-aligned*: the next poll is scheduled relative to when the current
one began, so a slow response cannot make the interval drift. Monitoring shares the
request queue with normal commands, so the two interleave safely.

### Events

| Event | Payload | Notes |
| --- | --- | --- |
| `data` | `string` | Raw decoded text off the wire |
| `frame` | `Frame` | Every parsed frame |
| `snapshot` | `Snapshot` | While monitoring |
| `protocolChange` | `string` | Negotiated version changed |
| `disconnect` | — | Port closed or device unplugged |
| `deviceError` | `Error` | Transport or unsolicited device error |
| `error` | `Error` | Same as `deviceError` |

> **`error` is safe to leave unhandled.** Node normally throws when an `error`
> event has no listener. Device errors are asynchronous and routine — an
> unsolicited `type=err` frame, or a cable pulled mid-request — so this package
> emits `error` *only when something is listening*, and always mirrors it on
> `deviceError`. Listening to `deviceError` is the recommended pattern.

### Managing several devices

`SerialManager` tracks multiple connections by key and is what an app's main
process will usually hold:

```js
const { SerialManager } = require('dwm-core');

const manager = new SerialManager();
const connection = await manager.open('/dev/tty.usbmodem205F33AE54421');

manager.get(path);        // the SerialConnection at that path
manager.isOpen(path);
manager.list();           // paths of every open port
await manager.write(path, 'proto=2 type=cmd cmd=sys.id req=1\r\n');

await manager.close(path); // one port
await manager.close();     // all of them - call this on app shutdown
```

`SerialManager` deals in raw `SerialConnection`s and is the right level for an app
that owns framing itself. If you want the full protocol handling, use `Device`.

---

## Timing

The meter is sensitive to how quickly it is written to, so the package owns all
pacing and deadlines. These values are carried over from the original
DWM-Control application rather than invented, and are exported so they can be
inspected or overridden.

| Constant | Value | Purpose |
| --- | --- | --- |
| `DEFAULT_PACING_MS` | 100 ms | Delay inserted **before every write** |
| `DEFAULT_TIMEOUT_MS` | 2000 ms | Default per-request deadline |
| `DEFAULT_POLL_INTERVAL_MS` | 250 ms | Monitoring poll interval |
| `DEFAULT_PROBE_TIMEOUT_MS` | 2500 ms | Each protocol probe during `open()` |
| `DFU_DETACH_DELAY_MS` | 1200 ms | Settling time after `sys.dfu` before closing |

Some commands need their own budget (`COMMAND_TIMEOUTS_MS`):

| Command | Timeout | Why |
| --- | --- | --- |
| `sys.fw` | 3000 ms | Can be slow to answer on older firmware |
| `sys.rst` | 1000 ms | Reboots the device, so a reply may never arrive |
| `sys.dfu` | 1000 ms | Same — the shorter budget fails fast on purpose |

Precedence is: an explicit `timeoutMs` option → the command's own budget → the
device default.

Three behaviours matter more than the numbers:

- **Requests are serialised.** Every command goes through one queue, so two
  callers can never interleave writes on the same port. Concurrent `send()`
  calls are safe and are correlated back by request id.
- **Pacing is skipped for polling.** The monitoring loop issues `pwr.snap` with
  `pacingMs: 0`; the poll interval already spaces those requests out, so adding
  the 100 ms pacing on top would slow the achievable sample rate.
- **Polling is start-aligned.** The next poll is scheduled `intervalMs` after
  the current one *started*, not after it finished, so a slow response cannot
  make the interval drift. If a cycle overruns, the next fires immediately.

Everything is adjustable per device or per request:

```js
const device = new Device(info, {
  pacingMs: 50,        // write more aggressively
  timeoutMs: 5000,     // tolerate a slow link
  pollIntervalMs: 100, // sample faster
});

await device.getPower('avg', { timeoutMs: 250, pacingMs: 0 });
```

> A timed-out request triggers the legacy proto=1 retry, so the **worst-case**
> latency of a `send()` is roughly twice its timeout. Pass
> `allowLegacyFallback: false` when that matters.

---

## Protocol v1 / v2

The package speaks **v2 by default and falls back to v1 automatically** when a
device rejects a request in a way that suggests it is a legacy unit
(`ERR_UNKNOWN_CMD`, `ERR_BAD_FRAME`, `ERR_BAD_ENUM`, or a timeout).

The two versions are identical except for the ADC range enum:

| `range` value | v1 | v2 |
| --- | --- | --- |
| `0` | 2x | 1x |
| `1` | 4x | 2x |
| `2` | — | 4x |

`protocol/translator.js` rewrites that field on the way out and on the way back, so
**callers always work in v2 terms** regardless of what is on the other end of the
cable. Command names are mapped through an identity table today, which is where any
future divergence would be handled.

Low-level helpers are exported for consumers that need them (a UI decoding frames it
receives over IPC, for example):

```js
const { protocol } = require('dwm-core');

protocol.buildFrame('pwr.get', 42, { met: 'avg' }, '2');
protocol.parseFrame('proto=2 type=rsp req=42 value=8.027');
protocol.decodeSnapshot(frame);
protocol.normalizeRange('1');
```

---

## Firmware updates

```js
const { FirmwareUpdater } = require('dwm-core');

const updater = new FirmwareUpdater();

const result = await updater.upload('./DWM_V2_3_2.hex', {
  progress: (percent) => console.log(`${percent}%`),
  log: (line) => console.log(line),
});

if (!result.success) throw new Error(result.error);
```

`upload()` parses the Intel HEX file into a raw binary, writes it to a temporary
file, and drives `dfu-util` with `-a 0 -i 0 -D <bin> -s 0x08000000:leave -R`.
It **resolves rather than rejects** on a failed flash, returning
`{ success, output, size, error }` so callers can surface the log.

The typical sequence is `device.enterDFU()` → wait for re-enumeration →
`updater.upload(...)`.

Other exports:

```js
const {
  listDfuDevices, resolveDfuUtilPath, parseHex, convertHexFileToBin,
} = require('dwm-core');

await listDfuDevices();                       // devices currently in DFU mode
resolveDfuUtilPath({ searchPaths, command }); // locate the executable
const { data, startAddress } = parseHex(hexBuffer);
```

> **Note on `dfu-util` exit codes.** `dfu-util` exits `74` both when a device
> detaches after a successful `:leave` transfer *and* when no DFU device was found
> at all. This package therefore also inspects the output, so "no device attached"
> is correctly reported as a failure instead of a successful upload.

---

## Errors

All errors extend `DwmError` and carry a `code`:

| Class | Raised when |
| --- | --- |
| `SerialError` | The port failed to open, write or read |
| `NotConnectedError` | A command was issued before `open()` |
| `TimeoutError` | No response arrived within the timeout |
| `ProtocolError` | The device returned `type=err`, or a frame was invalid |
| `FirmwareError` | HEX parsing or the DFU tooling failed |

```js
const { TimeoutError, ProtocolError } = require('dwm-core');

try {
  await device.getPower('avg', { timeoutMs: 250 });
} catch (error) {
  if (error instanceof TimeoutError) retry();
  else if (error instanceof ProtocolError) console.error(error.code, error.message);
  else throw error;
}
```

---

## Testing

```bash
npm run test:unit   # no hardware required
npm run test:live   # requires a DWM device attached over USB
npm test            # both
```

The live suite exercises discovery, the connection lifecycle, every read command,
protocol negotiation and fallback, write commands, background monitoring and the
firmware pipeline against real hardware. It **captures and restores** every setting
it changes and never writes firmware to the device.

---

## License

UNLICENSED — private.
