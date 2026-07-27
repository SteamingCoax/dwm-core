'use strict';

/**
 * @module dwm-core/device
 *
 * High-level, promise-based control of a single DWM V2 meter.
 *
 * `Device` owns the request/response engine that sits on top of
 * {@link module:dwm-core/serial} and {@link module:dwm-core/protocol}:
 *
 * - **Correlation.** Every request carries a monotonically increasing `req=` id;
 *   responses are matched back to their pending promise by that id.
 * - **Serialisation.** Requests are queued so only one is in flight at a time.
 *   The firmware has a single command buffer and silently drops overlapping
 *   requests.
 * - **Pacing.** A short delay precedes every write. Back-to-back writes overrun
 *   the device's USB CDC endpoint.
 * - **Version negotiation.** Requests default to `proto=2`. If a request fails
 *   in a way that suggests the firmware is older, it is retried once at
 *   `proto=1` and the connection latches to that version. Whatever version the
 *   device answers with also latches, so a device that upgrades mid-session is
 *   followed automatically.
 * - **Translation.** Callers always use the v2 vocabulary; requests and
 *   responses are translated per-version on the way in and out.
 */

const { EventEmitter } = require('events');

const protocol = require('./protocol');
const { SerialConnection, findDevices } = require('./serial');
const {
  PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  DEFAULT_BAUD_RATE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PACING_MS,
  DEFAULT_POLL_INTERVAL_MS,
  COMMAND_TIMEOUTS_MS,
  DFU_DETACH_DELAY_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  LEGACY_FALLBACK_PATTERN,
  COMMANDS,
  CONFIG_KEYS,
  MIN_ELEMENT,
  MAX_ELEMENT,
  MIN_BRIGHTNESS,
  MAX_BRIGHTNESS,
  NotConnectedError,
  TimeoutError,
  ProtocolError,
  DwmError,
} = require('./types');
const {
  delay,
  clamp,
  toFiniteInt,
  toFiniteNumber,
  sanitizeDeviceName,
  parseSemver,
  semverIsNewer,
} = require('./utils');

/**
 * A connected DWM V2 meter.
 *
 * @fires Device#data
 * @fires Device#frame
 * @fires Device#snapshot
 * @fires Device#disconnect
 * @fires Device#error
 * @fires Device#deviceError
 * @fires Device#protocolChange
 *
 * @example
 * const device = new Device('/dev/tty.usbmodem205F33AE54421');
 * await device.open();
 * const status = await device.getStatus();
 * await device.close();
 */
class Device extends EventEmitter {
  /**
   * @param {string|import('./types').DeviceInfo} pathOrInfo Port path, or a
   *   descriptor from {@link module:dwm-core/serial.findDevices}.
   * @param {object} [options={}] Device options.
   * @param {number} [options.baudRate=115200] Baud rate.
   * @param {number} [options.timeoutMs=2000] Default per-request timeout.
   * @param {number} [options.pacingMs=100] Delay inserted before each write.
   * @param {string} [options.protocolVersion='2'] Protocol version to start with.
   * @param {boolean} [options.allowLegacyFallback=true] Whether to retry failed
   *   requests at `proto=1`.
   * @param {number} [options.pollIntervalMs=250] Default monitoring interval.
   */
  constructor(pathOrInfo, options = {}) {
    super();

    const info = typeof pathOrInfo === 'string' ? { path: pathOrInfo } : pathOrInfo || {};

    if (!info.path) {
      throw new DwmError('A device path or descriptor with a path is required');
    }

    /** @type {import('./types').DeviceInfo} */
    this.info = info;
    /** @type {string} */
    this.path = info.path;
    /** @type {string|null} */
    this.key = info.key || null;

    /** @type {number} */
    this.baudRate = options.baudRate || DEFAULT_BAUD_RATE;
    /** @type {number} */
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    /** @type {number} */
    this.pacingMs = Number.isFinite(options.pacingMs)
      ? Math.max(0, options.pacingMs)
      : DEFAULT_PACING_MS;
    /** @type {number} */
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs)
      ? options.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
    /** @type {boolean} */
    this.allowLegacyFallback = options.allowLegacyFallback !== false;
    /** @type {string} */
    this.protocolVersion = protocol.normalizeProtocolVersion(
      options.protocolVersion,
      PROTOCOL_VERSION,
    );

    /** @type {SerialConnection|null} */
    this.connection = null;

    /** @type {Map<string, {command: string, resolve: Function, reject: Function, timeoutId: NodeJS.Timeout}>} */
    this._pending = new Map();
    /** @type {number} */
    this._nextRequestId = 1;
    /** @type {string} */
    this._rxBuffer = '';
    /** @type {Promise<*>} */
    this._queue = Promise.resolve();
    /** @type {NodeJS.Timeout|null} */
    this._monitorTimer = null;
    /** @type {boolean} */
    this._monitoring = false;
  }

  /**
   * Whether the underlying serial port is open.
   *
   * @returns {boolean}
   */
  get isOpen() {
    return Boolean(this.connection && this.connection.isOpen);
  }

  /**
   * Whether snapshot monitoring is running.
   *
   * @returns {boolean}
   */
  get isMonitoring() {
    return this._monitoring;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Opens the serial port and, unless disabled, verifies the device answers the
   * API.
   *
   * The probe mirrors the DWM-Control application exactly: `sys.id` is attempted
   * at `proto=1` first and then at `proto=2`, each without fallback. A device
   * that answers neither is present on USB but not running the API firmware, and
   * the port is closed again.
   *
   * @param {object} [options={}] Open options.
   * @param {boolean} [options.probe=true] Whether to verify API responsiveness.
   * @param {number} [options.probeTimeoutMs=2500] Timeout for each probe attempt.
   * @returns {Promise<Device>} This device, for chaining.
   * @throws {ProtocolError} When the probe fails.
   */
  async open(options = {}) {
    if (this.isOpen) return this;

    const connection = new SerialConnection(this.path, {
      baudRate: this.baudRate,
    });

    connection.on('data', (text) => this._handleData(text));
    connection.on('close', () => this._handleClose());
    connection.on('error', (error) => this._emitError(error));

    await connection.open();
    this.connection = connection;

    if (options.probe === false) return this;

    const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs)
      ? options.probeTimeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS;

    try {
      await this._probe(probeTimeoutMs);
    } catch (error) {
      await this.close();
      throw error;
    }

    return this;
  }

  /**
   * Verifies the device speaks the API, latching the version that answered.
   *
   * @param {number} timeoutMs Timeout for each attempt.
   * @returns {Promise<void>}
   * @private
   */
  async _probe(timeoutMs) {
    const attempts = [LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION];
    let lastError = null;

    for (const version of attempts) {
      try {
        await this.send(COMMANDS.SYSTEM_ID, {}, {
          timeoutMs,
          protocolVersion: version,
          allowLegacyFallback: false,
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw new ProtocolError(
      `Device at ${this.path} did not respond to the API probe - it is not configured for API access`,
      { command: COMMANDS.SYSTEM_ID, cause: lastError },
    );
  }

  /**
   * Stops monitoring, rejects in-flight requests and closes the port.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.stopMonitoring();
    this._rejectPending(new NotConnectedError('Device connection closed'));

    const connection = this.connection;
    this.connection = null;
    this._rxBuffer = '';

    if (connection) await connection.close();
  }

  // ---------------------------------------------------------------------------
  // Receive path
  // ---------------------------------------------------------------------------

  /**
   * Consumes decoded serial text, reassembling and dispatching frames.
   *
   * @param {string} text Decoded text from the port.
   * @private
   */
  _handleData(text) {
    if (typeof text !== 'string' || text.length === 0) return;

    /**
     * Raw decoded text received from the device.
     *
     * @event Device#data
     * @type {string}
     */
    this.emit('data', text);

    this._rxBuffer += text;
    const { lines, remainder } = protocol.extractLines(this._rxBuffer);
    this._rxBuffer = remainder;

    lines.forEach((line) => this._handleLine(line));
  }

  /**
   * Dispatches one complete line.
   *
   * @param {string} line Line without its terminator.
   * @private
   */
  _handleLine(line) {
    if (!protocol.isFrameLine(line)) return;

    const parsed = protocol.parseFrame(line);
    if (!protocol.isSupportedProto(parsed.proto) || !parsed.type) return;

    const frame = protocol.translator.translateResponse(parsed, parsed.proto);

    /**
     * A well-formed frame arrived from the device.
     *
     * @event Device#frame
     * @type {import('./types').Frame}
     */
    this.emit('frame', frame);

    this._latchProtocolVersion(frame.proto);

    if (!frame.req) {
      // Unsolicited error frames are surfaced but cannot be correlated.
      if (frame.type === 'err') {
        this._emitError(protocol.toProtocolError(frame));
      }
      return;
    }

    const pending = this._pending.get(frame.req);
    if (!pending) {
      // The request already timed out, or the frame belongs to a raw write.
      if (frame.type === 'err') {
        this._emitError(protocol.toProtocolError(frame));
      }
      return;
    }

    clearTimeout(pending.timeoutId);
    this._pending.delete(frame.req);

    if (frame.type === 'resp' && frame.status === 'ok') {
      pending.resolve(frame);
    } else {
      pending.reject(protocol.toProtocolError(frame));
    }
  }

  /**
   * Handles the port closing underneath us.
   *
   * @private
   */
  _handleClose() {
    this.stopMonitoring();
    this._rejectPending(new NotConnectedError('Device disconnected'));
    this.connection = null;

    /**
     * The device went away.
     *
     * @event Device#disconnect
     */
    this.emit('disconnect');
  }

  /**
   * Rejects and clears every in-flight request.
   *
   * @param {Error} error Rejection reason.
   * @private
   */
  _rejectPending(error) {
    const pending = [...this._pending.values()];
    this._pending.clear();
    pending.forEach((entry) => {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
    });
  }

  /**
   * Emits an error without ever crashing the host process.
   *
   * Node treats `error` as a reserved event and throws when it is emitted with
   * no listener attached. Device-reported errors are asynchronous and entirely
   * routine - an unsolicited `type=err` frame, or a cable pulled mid-request -
   * so they must never be able to take down an application that has not opted
   * in to handling them. The error is always emitted on `deviceError`, and
   * additionally on `error` only when something is listening.
   *
   * @param {Error} error Error to emit.
   * @private
   */
  _emitError(error) {
    /**
     * An error reported by the device or its transport.
     *
     * Unlike `error`, this event is always safe to leave unhandled.
     *
     * @event Device#deviceError
     * @type {Error}
     */
    this.emit('deviceError', error);

    if (this.listenerCount('error') > 0) {
      /**
       * An error reported by the device or its transport.
       *
       * @event Device#error
       * @type {Error}
       */
      this.emit('error', error);
    }
  }

  /**
   * Adopts the protocol version the device replied with.
   *
   * @param {string} version Version from a response frame.
   * @private
   */
  _latchProtocolVersion(version) {
    if (!protocol.isSupportedProto(version)) return;
    const next = String(version);
    if (next === this.protocolVersion) return;

    const previous = this.protocolVersion;
    this.protocolVersion = next;

    /**
     * The negotiated protocol version changed.
     *
     * @event Device#protocolChange
     * @type {{from: string, to: string}}
     */
    this.emit('protocolChange', { from: previous, to: next });
  }

  // ---------------------------------------------------------------------------
  // Send path
  // ---------------------------------------------------------------------------

  /**
   * Sends a command and resolves with its response frame.
   *
   * Requests are queued, so concurrent calls are executed one after another in
   * call order.
   *
   * @param {string} command Command name, e.g. `pwr.snap`.
   * @param {Record<string, *>} [fields={}] Request fields, in emission order.
   * @param {object} [options={}] Per-request overrides.
   * @param {number} [options.timeoutMs] Response timeout.
   * @param {number} [options.pacingMs] Delay before writing.
   * @param {string} [options.protocolVersion] Version to send with.
   * @param {boolean} [options.allowLegacyFallback] Whether to retry at `proto=1`.
   * @returns {Promise<import('./types').Frame>} The `type=resp status=ok` frame.
   * @throws {NotConnectedError} When the port is closed.
   * @throws {TimeoutError} When the device does not answer in time.
   * @throws {ProtocolError} When the device answers `type=err`.
   */
  send(command, fields = {}, options = {}) {
    const allowFallback =
      options.allowLegacyFallback !== undefined
        ? options.allowLegacyFallback !== false
        : this.allowLegacyFallback;

    const preferred = protocol.normalizeProtocolVersion(
      options.protocolVersion || this.protocolVersion,
      PROTOCOL_VERSION,
    );

    const attempt = this._queue
      .catch(() => {})
      .then(() => this._execute(command, fields, options, preferred));

    const withFallback =
      allowFallback && preferred !== LEGACY_PROTOCOL_VERSION
        ? attempt.catch((error) => {
            if (!LEGACY_FALLBACK_PATTERN.test(error?.message || '')) throw error;
            this._latchProtocolVersion(LEGACY_PROTOCOL_VERSION);
            return this._execute(
              command,
              fields,
              options,
              LEGACY_PROTOCOL_VERSION,
            );
          })
        : attempt;

    // Keep the queue alive regardless of individual request outcomes.
    this._queue = withFallback.catch(() => {});
    return withFallback;
  }

  /**
   * Performs a single request attempt at a fixed protocol version.
   *
   * @param {string} command Command name.
   * @param {Record<string, *>} fields Request fields.
   * @param {object} options Per-request overrides.
   * @param {string} version Protocol version to use.
   * @returns {Promise<import('./types').Frame>}
   * @private
   */
  async _execute(command, fields, options, version) {
    if (!this.isOpen) throw new NotConnectedError();

    const requestId = String(this._nextRequestId++);
    // Explicit override wins, then the command's own budget, then the default.
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : COMMAND_TIMEOUTS_MS[command] || this.timeoutMs;
    const pacingMs = Number.isFinite(options.pacingMs)
      ? Math.max(0, options.pacingMs)
      : this.pacingMs;

    const frame = protocol.buildTranslatedFrame(
      command,
      requestId,
      fields,
      version,
    );

    if (pacingMs > 0) await delay(pacingMs);
    if (!this.isOpen) throw new NotConnectedError();

    const response = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new TimeoutError(command, timeoutMs));
      }, timeoutMs);
      this._pending.set(requestId, { command, resolve, reject, timeoutId });
    });

    try {
      await this.connection.write(frame);
    } catch (error) {
      const pending = this._pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this._pending.delete(requestId);
      }
      throw new DwmError(`Failed to write ${command}: ${error.message}`, {
        command,
        cause: error,
      });
    }

    return response;
  }

  /**
   * Writes an uninterpreted string to the device.
   *
   * Intended for debugging consoles. No response correlation is performed;
   * anything the device replies arrives via the `data` and `frame` events.
   *
   * @param {string} text Text to write verbatim.
   * @returns {Promise<void>}
   * @throws {NotConnectedError} When the port is closed.
   */
  async sendRaw(text) {
    if (!this.isOpen) throw new NotConnectedError();
    await this.connection.write(text);
  }

  // ---------------------------------------------------------------------------
  // System commands
  // ---------------------------------------------------------------------------

  /**
   * Reads the device's unique id and stored name (`sys.id`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<{uid: string|null, dname: string|null, frame: import('./types').Frame}>}
   */
  async getIdentity(options = {}) {
    const frame = await this.send(COMMANDS.SYSTEM_ID, {}, options);
    return { uid: frame.uid || null, dname: frame.dname || null, frame };
  }

  /**
   * Reads the firmware version string (`sys.fw`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<{raw: string|null, version: number[]|null, frame: import('./types').Frame}>}
   *   `version` is the parsed `[major, minor, patch]` triple, when present.
   */
  async getFirmwareVersion(options = {}) {
    const frame = await this.send(COMMANDS.SYSTEM_FIRMWARE, {}, options);
    const raw = frame.fver || null;
    return { raw, version: parseSemver(raw), frame };
  }

  /**
   * Lists the commands the firmware advertises (`sys.cmds`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<string[]>}
   */
  async getSupportedCommands(options = {}) {
    const frame = await this.send(COMMANDS.SYSTEM_COMMANDS, {}, options);
    return protocol.decodeSupportedCommands(frame);
  }

  /**
   * Reads the stored device name (`sys.nget`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<string|null>}
   */
  async getName(options = {}) {
    const frame = await this.send(COMMANDS.SYSTEM_NAME_GET, {}, options);
    return frame.dname || null;
  }

  /**
   * Stores a new device name (`sys.nset`).
   *
   * The name is sanitised to the firmware's accepted character set before being
   * sent: spaces become underscores, other punctuation is stripped, and the
   * result is truncated to 20 characters.
   *
   * @param {string} name Desired name.
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<string|null>} The name the device confirmed.
   * @throws {DwmError} When the sanitised name is empty.
   */
  async setName(name, options = {}) {
    const sanitized = sanitizeDeviceName(name);
    if (!sanitized) {
      throw new DwmError('A device name must contain at least one alphanumeric character');
    }
    const frame = await this.send(
      COMMANDS.SYSTEM_NAME_SET,
      { name: sanitized },
      options,
    );
    return frame.dname || sanitized;
  }

  /**
   * Persists the current configuration to non-volatile storage (`sys.save`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<import('./types').Frame>}
   */
  async save(options = {}) {
    return this.send(COMMANDS.SYSTEM_SAVE, {}, options);
  }

  /**
   * Reboots the device (`sys.rst`).
   *
   * The device typically resets before its response is transmitted, so a short
   * timeout is used and a timeout is **not** treated as a failure.
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<boolean>} `true` when the command was accepted or the
   *   device reset before answering.
   */
  async reset(options = {}) {
    return this._fireAndForget(COMMANDS.SYSTEM_RESET, options);
  }

  /**
   * Reboots the device into DFU mode (`sys.dfu`).
   *
   * As with {@link Device#reset}, the device reboots immediately, so a missing
   * response is expected and not an error. The port is closed afterwards because
   * the CDC interface disappears.
   *
   * @param {object} [options={}] Per-request overrides.
   * @param {boolean} [options.close=true] Whether to close the port afterwards.
   * @param {number} [options.detachDelayMs=1200] How long to wait before
   *   closing, giving the device time to re-enumerate in DFU mode.
   * @returns {Promise<boolean>} `true` when the command was accepted.
   */
  async enterDFU(options = {}) {
    const accepted = await this._fireAndForget(COMMANDS.SYSTEM_DFU, options);
    if (options.close !== false) {
      // Give the device time to detach and re-enumerate in DFU mode before the
      // port disappears underneath it.
      const settleMs = Number.isFinite(options.detachDelayMs)
        ? Math.max(0, options.detachDelayMs)
        : DFU_DETACH_DELAY_MS;
      await delay(settleMs);
      await this.close();
    }
    return accepted;
  }

  /**
   * Sends a command that reboots the device, tolerating a missing response.
   *
   * @param {string} command Command name.
   * @param {object} options Per-request overrides.
   * @returns {Promise<boolean>}
   * @private
   */
  async _fireAndForget(command, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : 1000;
    try {
      await this.send(command, {}, { ...options, timeoutMs });
      return true;
    } catch (error) {
      // A timeout or a dropped connection means the device rebooted as asked.
      if (error instanceof TimeoutError || error instanceof NotConnectedError) {
        return true;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Power commands
  // ---------------------------------------------------------------------------

  /**
   * Reads a single power metric (`pwr.get`).
   *
   * @param {string} [metric='avg'] One of `inst`, `avg`, `peak`, `max`, `min`, `dev`.
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<{metric: string, value: number, elem: number|null, etype: string|null, eval: number, range: import('./types').RangeInfo|null, frame: import('./types').Frame}>}
   */
  async getPower(metric = 'avg', options = {}) {
    const frame = await this.send(
      COMMANDS.POWER_GET,
      { met: metric },
      options,
    );
    return {
      metric: frame.met || metric,
      value: toFiniteNumber(frame.value, 0),
      elem: toFiniteInt(frame.elem, null),
      etype: frame.etype ? String(frame.etype).toLowerCase() : null,
      eval: toFiniteNumber(frame.eval, 0),
      range: protocol.normalizeRange(frame.range),
      frame,
    };
  }

  /**
   * Reads a full measurement snapshot (`pwr.snap`).
   *
   * The compact `d=` CSV is expanded into named numeric fields.
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<import('./types').Snapshot>}
   */
  async getSnapshot(options = {}) {
    const frame = await this.send(COMMANDS.POWER_SNAPSHOT, {}, options);
    return protocol.decodeSnapshot(frame);
  }

  /**
   * Reads the active element and range configuration (`pwr.info`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<{elem: number|null, etype: string|null, eval: number, range: import('./types').RangeInfo|null, maxPowerW: number, frame: import('./types').Frame}>}
   */
  async getPowerInfo(options = {}) {
    const frame = await this.send(COMMANDS.POWER_INFO, {}, options);
    const range = protocol.normalizeRange(frame.range);
    const rating = toFiniteNumber(frame.eval, 0);
    return {
      elem: toFiniteInt(frame.elem, null),
      etype: frame.etype ? String(frame.etype).toLowerCase() : null,
      eval: rating,
      range,
      maxPowerW: rating * (range ? range.multiplier : 1),
      frame,
    };
  }

  /**
   * Reads identity, firmware, power configuration and a live snapshot in one go.
   *
   * This is the convenience entry point for "what is this device doing right
   * now"; it issues four requests sequentially.
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<{path: string, key: string|null, protocolVersion: string, uid: string|null, name: string|null, firmware: object, power: object, snapshot: import('./types').Snapshot}>}
   */
  async getStatus(options = {}) {
    const identity = await this.getIdentity(options);
    const firmware = await this.getFirmwareVersion(options);
    const power = await this.getPowerInfo(options);
    const snapshot = await this.getSnapshot(options);

    return {
      path: this.path,
      key: this.key,
      protocolVersion: this.protocolVersion,
      uid: identity.uid,
      name: identity.dname,
      firmware,
      power,
      snapshot,
    };
  }

  // ---------------------------------------------------------------------------
  // Configuration commands
  // ---------------------------------------------------------------------------

  /**
   * Reads a configuration value (`cfg.get`).
   *
   * @param {string} key Configuration key, e.g. `bright`.
   * @param {object} [options={}] Per-request overrides.
   * @param {number} [options.element] Element index, for element-scoped keys.
   * @returns {Promise<string|undefined>} The raw `val` field.
   */
  async getConfig(key, options = {}) {
    const fields = { key };
    const element = toFiniteInt(options.element, null);
    if (element !== null) fields.elem = element;

    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : 1200;
    const frame = await this.send(COMMANDS.CONFIG_GET, fields, {
      ...options,
      timeoutMs,
    });
    return frame.val;
  }

  /**
   * Writes a configuration value (`cfg.set`).
   *
   * Element-scoped keys (`eval`, `etype`) require an element index, which is
   * emitted before `val` as the firmware demands.
   *
   * @param {string} key Configuration key.
   * @param {string|number} value New value.
   * @param {object} [options={}] Per-request overrides.
   * @param {number} [options.element] Element index, for element-scoped keys.
   * @returns {Promise<{key: string, value: string, frame: import('./types').Frame}>}
   */
  async setConfig(key, value, options = {}) {
    const fields = protocol.buildConfigSetFields(key, value, options);
    const frame = await this.send(COMMANDS.CONFIG_SET, fields, options);
    return { key: frame.key || key, value: frame.val, frame };
  }

  /**
   * Reads all eight element profiles (`cfg.elems`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<import('./types').ElementProfile[]>}
   */
  async getElementProfiles(options = {}) {
    const frame = await this.send(COMMANDS.CONFIG_ELEMENTS, {}, options);
    return protocol.decodeElementProfiles(frame);
  }

  /**
   * Reads one element's profile (`cfg.elem`).
   *
   * @param {number} element Element index, 1-8.
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<import('./types').ElementProfile>}
   */
  async getElement(element, options = {}) {
    const index = this._assertElement(element);
    const frame = await this.send(
      COMMANDS.CONFIG_ELEMENT,
      { elem: index },
      options,
    );
    return {
      elem: toFiniteInt(frame.elem, index),
      eval: toFiniteNumber(frame.eval, 0),
      etype: String(frame.etype || '30ua').toLowerCase(),
    };
  }

  /**
   * Selects the active element (`cfg.set key=elem`).
   *
   * @param {number} element Element index, 1-8.
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<number>} The element the device confirmed.
   */
  async setElement(element, options = {}) {
    const index = this._assertElement(element);
    const result = await this.setConfig(CONFIG_KEYS.ELEMENT, index, options);
    return toFiniteInt(result.value, index);
  }

  /**
   * Sets an element's full-scale rating in watts (`cfg.set key=eval`).
   *
   * @param {number} watts New rating.
   * @param {object} [options={}] Per-request overrides.
   * @param {number} options.element Element index, 1-8.
   * @returns {Promise<number>} The rating the device confirmed.
   */
  async setElementRating(watts, options = {}) {
    const element = this._assertElement(options.element);
    const result = await this.setConfig(CONFIG_KEYS.ELEMENT_RATING, watts, {
      ...options,
      element,
    });
    return toFiniteNumber(result.value, toFiniteNumber(watts, 0));
  }

  /**
   * Sets an element's type (`cfg.set key=etype`).
   *
   * @param {string} type Element type, e.g. `30ua`.
   * @param {object} [options={}] Per-request overrides.
   * @param {number} options.element Element index, 1-8.
   * @returns {Promise<string>} The type the device confirmed.
   */
  async setElementType(type, options = {}) {
    const element = this._assertElement(options.element);
    const result = await this.setConfig(
      CONFIG_KEYS.ELEMENT_TYPE,
      String(type).toLowerCase(),
      { ...options, element },
    );
    return String(result.value || type).toLowerCase();
  }

  /**
   * Sets the ADC gain range (`cfg.set key=range`).
   *
   * Accepts a multiplier (`1`, `2`, `4`), a label (`1x`, `2x`, `4x`) or a v2
   * configuration integer. The value is translated to the connection's
   * protocol version automatically, so `4x` means 4x on both v1 and v2 firmware.
   *
   * @param {string|number} range Desired range.
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<import('./types').RangeInfo>} The range the device confirmed.
   * @throws {DwmError} When the range cannot be interpreted.
   */
  async setRange(range, options = {}) {
    const multiplier = protocol.translator.wireRangeToMultiplier(
      range,
      PROTOCOL_VERSION,
    );

    if (multiplier === null) {
      throw new DwmError(
        `Unsupported range "${range}" - expected 1x, 2x, 4x or a config integer`,
      );
    }

    // Callers speak v2; the translator re-encodes for legacy firmware.
    const cfg = protocol.v2.multiplierToRangeCfg(multiplier);
    const result = await this.setConfig(CONFIG_KEYS.RANGE, cfg, options);

    return (
      protocol.normalizeRange(result.value) || {
        cfg,
        multiplier,
        label: `${multiplier}x`,
      }
    );
  }

  /**
   * Reads the current ADC gain range (`cfg.get key=range`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<import('./types').RangeInfo|null>}
   */
  async getRange(options = {}) {
    const value = await this.getConfig(CONFIG_KEYS.RANGE, options);
    return protocol.normalizeRange(value);
  }

  /**
   * Reads the display brightness (`cfg.get key=bright`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<number|null>} Brightness 0-10.
   */
  async getBrightness(options = {}) {
    const value = await this.getConfig(CONFIG_KEYS.BRIGHTNESS, options);
    return toFiniteInt(value, null);
  }

  /**
   * Sets the display brightness (`cfg.set key=bright`).
   *
   * @param {number} level Brightness 0-10; out-of-range values are clamped.
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<number>} The brightness the device confirmed.
   */
  async setBrightness(level, options = {}) {
    const clamped = clamp(level, MIN_BRIGHTNESS, MAX_BRIGHTNESS, MIN_BRIGHTNESS);
    const result = await this.setConfig(
      CONFIG_KEYS.BRIGHTNESS,
      Math.round(clamped),
      options,
    );
    return toFiniteInt(result.value, Math.round(clamped));
  }

  /**
   * Reads the averaging window in seconds (`cfg.get key=avgw`).
   *
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<number|null>}
   */
  async getAveragingWindow(options = {}) {
    const value = await this.getConfig(CONFIG_KEYS.AVERAGING_WINDOW, options);
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Sets the averaging window in seconds (`cfg.set key=avgw`).
   *
   * @param {number} seconds New window.
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<number>} The window the device confirmed.
   */
  async setAveragingWindow(seconds, options = {}) {
    const result = await this.setConfig(
      CONFIG_KEYS.AVERAGING_WINDOW,
      seconds,
      options,
    );
    return toFiniteNumber(result.value, toFiniteNumber(seconds, 0));
  }

  /**
   * Validates an element index.
   *
   * @param {*} element Candidate index.
   * @returns {number} Validated index.
   * @throws {DwmError} When out of range.
   * @private
   */
  _assertElement(element) {
    const index = toFiniteInt(element, null);
    if (index === null || index < MIN_ELEMENT || index > MAX_ELEMENT) {
      throw new DwmError(
        `Element must be an integer between ${MIN_ELEMENT} and ${MAX_ELEMENT}, received "${element}"`,
      );
    }
    return index;
  }

  // ---------------------------------------------------------------------------
  // Composite operations
  // ---------------------------------------------------------------------------

  /**
   * Blinks the display so a specific meter can be picked out on a bench.
   *
   * The current brightness is read first, the blink sequence is played, and the
   * original brightness is restored even if the sequence fails.
   *
   * @param {object} [options={}] Identify options.
   * @param {number[]} [options.sequence=[0,8,0,8,0,8]] Brightness levels to play.
   * @param {number} [options.stepMs=800] Delay between steps.
   * @returns {Promise<number>} The restored brightness.
   */
  async identify(options = {}) {
    const sequence = Array.isArray(options.sequence) && options.sequence.length
      ? options.sequence
      : [0, 8, 0, 8, 0, 8];
    const stepMs = Number.isFinite(options.stepMs) ? options.stepMs : 800;

    const original = await this.getBrightness();
    if (original === null) {
      throw new DwmError('Identify failed: could not read current brightness');
    }

    try {
      for (let index = 0; index < sequence.length; index += 1) {
        await this.setBrightness(sequence[index]);
        if (index < sequence.length - 1) await delay(stepMs);
      }
      await delay(stepMs);
    } finally {
      if (this.isOpen) await this.setBrightness(original);
    }

    return original;
  }

  /**
   * Compares the installed firmware against a candidate version.
   *
   * @param {string} latestVersion Version string to compare against, e.g. `2.7.0`.
   * @param {object} [options={}] Per-request overrides.
   * @returns {Promise<{installed: string|null, latest: string|null, updateAvailable: boolean}>}
   */
  async checkFirmwareUpdate(latestVersion, options = {}) {
    const firmware = await this.getFirmwareVersion(options);
    const latest = parseSemver(latestVersion);

    return {
      installed: firmware.version ? firmware.version.join('.') : null,
      latest: latest ? latest.join('.') : null,
      updateAvailable: Boolean(
        firmware.version && latest && semverIsNewer(latest, firmware.version),
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Monitoring
  // ---------------------------------------------------------------------------

  /**
   * Starts polling snapshots and emitting them as events.
   *
   * Scheduling is **start-aligned**: the next poll is scheduled relative to when
   * the current one began, so a slow response shortens the following gap rather
   * than causing drift. Polls never overlap.
   *
   * @param {object} [options={}] Monitoring options.
   * @param {number} [options.intervalMs=250] Polling interval.
   * @returns {void}
   * @fires Device#snapshot
   * @fires Device#monitorError
   */
  startMonitoring(options = {}) {
    if (this._monitoring) return;

    const intervalMs = Number.isFinite(options.intervalMs)
      ? Math.max(0, options.intervalMs)
      : this.pollIntervalMs;

    this._monitoring = true;

    const cycle = () => {
      if (!this._monitoring) return;
      const startedAt = Date.now();

      this.getSnapshot({ pacingMs: 0 })
        .then((snapshot) => {
          if (!this._monitoring) return;
          /**
           * A polled measurement snapshot.
           *
           * @event Device#snapshot
           * @type {import('./types').Snapshot}
           */
          this.emit('snapshot', snapshot);
        })
        .catch((error) => {
          if (!this._monitoring) return;
          /**
           * A polling cycle failed. Monitoring continues.
           *
           * @event Device#monitorError
           * @type {Error}
           */
          this.emit('monitorError', error);
        })
        .finally(() => {
          if (!this._monitoring) return;
          const elapsed = Date.now() - startedAt;
          this._monitorTimer = setTimeout(
            cycle,
            Math.max(0, intervalMs - elapsed),
          );
        });
    };

    cycle();
  }

  /**
   * Stops snapshot polling.
   *
   * @returns {void}
   */
  stopMonitoring() {
    this._monitoring = false;
    if (this._monitorTimer) {
      clearTimeout(this._monitorTimer);
      this._monitorTimer = null;
    }
  }
}

/**
 * Opens the first discovered DWM device.
 *
 * @param {object} [options={}] Passed to the {@link Device} constructor.
 * @returns {Promise<Device>} An open device.
 * @throws {DwmError} When no device is connected.
 */
async function openFirstDevice(options = {}) {
  const devices = await findDevices();
  if (devices.length === 0) {
    throw new DwmError('No DWM devices found');
  }
  const device = new Device(devices[0], options);
  await device.open(options);
  return device;
}

module.exports = { Device, openFirstDevice };
