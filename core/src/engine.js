import crypto from 'node:crypto';

const QUALITY = new Set(['GOOD', 'SUSPECT', 'BAD', 'MISSING']);
const MODES = new Set(['AUTO', 'MANUAL', 'SAFE', 'OFFLINE']);
const TERMINAL_ACK = new Set(['EXECUTED', 'REJECTED', 'EXPIRED', 'FAILED']);
const ACTIONS_BY_TYPE = {
  pump: new Set(['ON', 'OFF']),
  fan: new Set(['ON', 'OFF']),
  vent: new Set(['OPEN', 'CLOSE'])
};
const STATES_BY_TYPE = {
  pump: new Set(['ON', 'OFF']),
  fan: new Set(['ON', 'OFF']),
  vent: new Set(['OPEN', 'CLOSED'])
};

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  if (value === null) return true;
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

export class GreenCoreEngine {
  constructor({
    contracts,
    rules,
    now = () => new Date(),
    limits = {}
  }) {
    if (!contracts?.telemetry || !contracts?.command || !rules?.required_metrics) {
      throw new Error('Invalid GreenCore configuration');
    }
    this.contracts = contracts;
    this.rules = rules;
    this.now = now;
    this.limits = {
      events: limits.events ?? 5000,
      alerts: limits.alerts ?? 1000,
      idempotencyKeys: limits.idempotencyKeys ?? 10000
    };
    this.mode = 'SAFE';
    this.connected = true;
    this.telemetry = new Map();
    this.actuators = new Map([
      ['pump_01', { type: 'pump', state: 'OFF', changedAt: null }],
      ['fan_01', { type: 'fan', state: 'OFF', changedAt: null }],
      ['vent_01', { type: 'vent', state: 'CLOSED', changedAt: null }]
    ]);
    this.pendingCommands = new Map();
    this.seenIdempotencyKeys = new Set();
    this.events = [];
    this.alerts = [];
    this.manualRequests = new Map();
  }

  setConnectivity(connected) {
    this.connected = Boolean(connected);
    this.log('CONNECTIVITY_CHANGED', { connected: this.connected });
  }

  setMode(mode) {
    if (!MODES.has(mode)) throw new Error(`Unsupported mode: ${mode}`);
    this.mode = mode;
    this.log('MODE_CHANGED', { mode });
  }

  requestManual(actuatorId, action, reason = 'manual operator request') {
    const actuator = this.actuators.get(actuatorId);
    if (!actuator) throw new Error(`Unknown actuator: ${actuatorId}`);
    this.validateAction(actuator.type, action);
    const requestedAt = this.now();
    this.manualRequests.set(actuatorId, {
      action,
      reason,
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(requestedAt.getTime() + this.rules.commands.ttl_seconds * 1000).toISOString()
    });
    this.log('MANUAL_REQUEST_QUEUED', { actuator_id: actuatorId, action, reason });
  }

  ingest(sample) {
    const checked = this.validateTelemetry(sample);
    this.telemetry.set(checked.metric, checked);
    this.log('TELEMETRY_ACCEPTED', {
      device_id: checked.device_id,
      metric: checked.metric,
      value: checked.value,
      quality: checked.quality
    });
    return checked;
  }

  validateTelemetry(sample) {
    for (const field of this.contracts.telemetry.required) {
      if (sample?.[field] === undefined || sample?.[field] === null) {
        throw new Error(`Telemetry missing field: ${field}`);
      }
    }
    const metric = this.contracts.telemetry.metrics[sample.metric];
    if (!metric) throw new Error(`Unsupported metric: ${sample.metric}`);
    if (sample.unit !== metric.unit) throw new Error(`Invalid unit for ${sample.metric}: ${sample.unit}`);
    if (typeof sample.value !== 'number' || !Number.isFinite(sample.value)) {
      throw new Error('Telemetry value must be a finite number');
    }
    if (sample.value < metric.min || sample.value > metric.max) {
      throw new Error(`Telemetry value out of range for ${sample.metric}`);
    }
    if (!QUALITY.has(sample.quality)) throw new Error(`Invalid telemetry quality: ${sample.quality}`);
    const timestamp = new Date(sample.timestamp);
    if (Number.isNaN(timestamp.getTime())) throw new Error('Invalid telemetry timestamp');
    const futureMs = timestamp.getTime() - this.now().getTime();
    if (futureMs > this.rules.telemetry.future_tolerance_seconds * 1000) {
      throw new Error('Telemetry timestamp is too far in the future');
    }
    return { ...sample, timestamp: timestamp.toISOString() };
  }

  metricState(metricName) {
    const sample = this.telemetry.get(metricName);
    if (!sample) return { state: 'UNKNOWN', usable: false, sample: null };
    if (sample.quality === 'BAD' || sample.quality === 'MISSING') {
      return { state: 'FAULT', usable: false, sample };
    }
    const ageSeconds = (this.now().getTime() - new Date(sample.timestamp).getTime()) / 1000;
    if (ageSeconds > this.rules.telemetry.offline_after_seconds) {
      return { state: 'OFFLINE', usable: false, sample };
    }
    if (ageSeconds > this.rules.telemetry.stale_after_seconds) {
      return { state: 'STALE', usable: false, sample };
    }
    return { state: 'ONLINE', usable: sample.quality === 'GOOD', sample };
  }

  evaluate() {
    this.expireCommands();
    this.expireManualRequests();
    const required = Object.fromEntries(
      this.rules.required_metrics.map(metric => [metric, this.metricState(metric)])
    );
    const hasInvalidRequired = Object.values(required).some(item => !item.usable);

    if (hasInvalidRequired || this.mode === 'SAFE') {
      if (hasInvalidRequired) this.raiseAlert('REQUIRED_TELEMETRY_UNAVAILABLE', { required });
      return this.ensureSafeState(
        hasInvalidRequired ? 'required telemetry unavailable or untrusted' : 'safe mode requested',
        'SAFE'
      );
    }

    const effectiveMode = !this.connected ? 'OFFLINE' : this.mode;
    if (effectiveMode === 'OFFLINE') this.log('LOCAL_OFFLINE_AUTOMATION', {});

    if (this.pumpRuntimeExceeded()) {
      this.raiseAlert('PUMP_RUNTIME_LIMIT_EXCEEDED', {});
      return [this.issue('pump_01', 'OFF', 'pump continuous runtime safety limit reached', effectiveMode)].filter(Boolean);
    }

    if (effectiveMode === 'MANUAL') return this.applyManualRequests(required, effectiveMode);
    return this.applyAutomaticRules(required, effectiveMode);
  }

  expireManualRequests() {
    for (const [actuatorId, request] of this.manualRequests) {
      if (new Date(request.expiresAt) < this.now()) {
        this.manualRequests.delete(actuatorId);
        this.raiseAlert('MANUAL_REQUEST_EXPIRED', { actuator_id: actuatorId });
      }
    }
  }

  applyManualRequests(required, effectiveMode) {
    const commands = [];
    for (const [actuatorId, request] of this.manualRequests) {
      if (
        actuatorId === 'pump_01' &&
        request.action === 'ON' &&
        required.water_level.sample.value < this.rules.water_level.minimum_for_pump_percent
      ) {
        this.raiseAlert('MANUAL_COMMAND_REJECTED_LOW_WATER', { actuatorId });
        commands.push(this.issue('pump_01', 'OFF', 'manual pump request rejected: water level too low', effectiveMode));
      } else {
        commands.push(this.issue(actuatorId, request.action, request.reason, effectiveMode));
      }
    }
    this.manualRequests.clear();
    return commands.filter(Boolean);
  }

  applyAutomaticRules(required, effectiveMode) {
    const commands = [];
    const soil = required.soil_moisture.sample.value;
    const water = required.water_level.sample.value;
    const air = required.air_temperature.sample.value;
    const pump = this.actuators.get('pump_01');
    const fan = this.actuators.get('fan_01');

    if (water < this.rules.water_level.minimum_for_pump_percent) {
      this.raiseAlert('LOW_WATER_LEVEL', { value: water });
      if (pump.state !== 'OFF') commands.push(this.issue('pump_01', 'OFF', 'water level below pump safety minimum', effectiveMode));
    } else if (soil < this.rules.soil_moisture.pump_on_below_percent && pump.state !== 'ON') {
      commands.push(this.issue('pump_01', 'ON', 'soil moisture below configured minimum', effectiveMode));
    } else if (soil > this.rules.soil_moisture.pump_off_above_percent && pump.state !== 'OFF') {
      commands.push(this.issue('pump_01', 'OFF', 'soil moisture reached configured upper threshold', effectiveMode));
    }

    if (air > this.rules.air_temperature.fan_on_above_c && fan.state !== 'ON') {
      commands.push(this.issue('fan_01', 'ON', 'air temperature above configured maximum', effectiveMode));
    } else if (air < this.rules.air_temperature.fan_off_below_c && fan.state !== 'OFF') {
      commands.push(this.issue('fan_01', 'OFF', 'air temperature returned below hysteresis threshold', effectiveMode));
    }
    return commands.filter(Boolean);
  }

  ensureSafeState(reason, effectiveMode) {
    const commands = [];
    for (const [id, actuator] of this.actuators) {
      const safeAction = actuator.type === 'vent' ? 'OPEN' : 'OFF';
      const expectedState = actuator.type === 'vent' ? 'OPEN' : 'OFF';
      if (actuator.state !== expectedState) commands.push(this.issue(id, safeAction, reason, effectiveMode));
    }
    return commands.filter(Boolean);
  }

  validateAction(actuatorType, action) {
    if (!ACTIONS_BY_TYPE[actuatorType]?.has(action)) {
      throw new Error(`Unsupported action ${action} for actuator type ${actuatorType}`);
    }
  }

  issue(actuatorId, action, reason, effectiveMode) {
    const actuator = this.actuators.get(actuatorId);
    if (!actuator) throw new Error(`Unknown actuator: ${actuatorId}`);
    this.validateAction(actuator.type, action);
    const issuedAt = this.now();
    const bucket = issuedAt.toISOString().slice(0, 16);
    const idempotencyKey = `${actuatorId}:${action}:${bucket}`;
    if (this.seenIdempotencyKeys.has(idempotencyKey)) return null;
    this.seenIdempotencyKeys.add(idempotencyKey);
    this.trimSet(this.seenIdempotencyKeys, this.limits.idempotencyKeys);
    const command = {
      command_id: `cmd_${crypto.randomUUID()}`,
      actuator_id: actuatorId,
      actuator_type: actuator.type,
      action,
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + this.rules.commands.ttl_seconds * 1000).toISOString(),
      reason,
      mode: effectiveMode,
      idempotency_key: idempotencyKey
    };
    this.pendingCommands.set(command.command_id, command);
    this.log('COMMAND_ISSUED', command);
    return command;
  }

  acknowledge(ack) {
    if (!ack?.command_id || !ack?.status) throw new Error('Invalid acknowledgement payload');
    const command = this.pendingCommands.get(ack.command_id);
    if (!command) throw new Error(`Unknown or completed command: ${ack.command_id}`);
    if (ack.actuator_id && ack.actuator_id !== command.actuator_id) {
      throw new Error(`Acknowledgement actuator mismatch: ${ack.actuator_id}`);
    }
    if (new Date(command.expires_at) < this.now()) throw new Error(`Command expired: ${ack.command_id}`);
    if (!this.contracts.command.ack_status.includes(ack.status)) {
      throw new Error(`Unsupported acknowledgement status: ${ack.status}`);
    }
    if (ack.status === 'EXECUTED') {
      const actuator = this.actuators.get(command.actuator_id);
      actuator.state = command.action === 'CLOSE' ? 'CLOSED' : command.action;
      actuator.changedAt = new Date(ack.timestamp ?? this.now()).toISOString();
    }
    if (TERMINAL_ACK.has(ack.status)) this.pendingCommands.delete(command.command_id);
    this.log('COMMAND_ACKNOWLEDGED', { ...ack, actuator_id: command.actuator_id });
    return command;
  }

  expireCommands() {
    for (const [id, command] of this.pendingCommands) {
      if (new Date(command.expires_at) < this.now()) {
        this.pendingCommands.delete(id);
        this.raiseAlert('COMMAND_EXPIRED_WITHOUT_ACK', { command_id: id });
      }
    }
  }

  pumpRuntimeExceeded() {
    const pump = this.actuators.get('pump_01');
    if (pump.state !== 'ON' || !pump.changedAt) return false;
    return (this.now().getTime() - new Date(pump.changedAt).getTime()) / 1000 > this.rules.pump.max_continuous_runtime_seconds;
  }

  raiseAlert(type, details) {
    const last = this.alerts.at(-1);
    if (last?.type === type && JSON.stringify(last.details) === JSON.stringify(details)) return;
    const alert = { type, details, timestamp: this.now().toISOString() };
    this.alerts.push(alert);
    this.trimArray(this.alerts, this.limits.alerts);
    this.log('ALERT_RAISED', alert);
  }

  log(type, details) {
    this.events.push({ type, details, timestamp: this.now().toISOString() });
    this.trimArray(this.events, this.limits.events);
  }

  trimArray(items, limit) {
    if (items.length > limit) items.splice(0, items.length - limit);
  }

  trimSet(items, limit) {
    while (items.size > limit) items.delete(items.values().next().value);
  }

  validatePersistentEvent(entry, label) {
    if (!isObject(entry) || typeof entry.type !== 'string' || !validDate(entry.timestamp)) {
      throw new Error(`Invalid persisted ${label}`);
    }
    return structuredClone(entry);
  }

  validatePersistentCommand(command) {
    if (!isObject(command)) throw new Error('Invalid persisted command');
    for (const field of this.contracts.command.required) {
      if (command[field] === undefined || command[field] === null) {
        throw new Error(`Persisted command missing field: ${field}`);
      }
    }
    const actuator = this.actuators.get(command.actuator_id);
    if (!actuator || actuator.type !== command.actuator_type) {
      throw new Error(`Invalid persisted command actuator: ${command.actuator_id}`);
    }
    this.validateAction(command.actuator_type, command.action);
    if (!validDate(command.issued_at) || !validDate(command.expires_at)) {
      throw new Error(`Invalid persisted command timestamps: ${command.command_id}`);
    }
    return structuredClone(command);
  }

  restore(snapshot, { logEvent = true } = {}) {
    if (!isObject(snapshot)) throw new Error('Invalid persisted GreenCore state');
    if (!MODES.has(snapshot.configured_mode)) throw new Error('Invalid persisted mode');
    if (typeof snapshot.connected !== 'boolean') throw new Error('Invalid persisted connectivity');
    if (!isObject(snapshot.telemetry) || !isObject(snapshot.actuators)) {
      throw new Error('Invalid persisted telemetry or actuators');
    }

    const telemetry = new Map();
    for (const [metric, sample] of Object.entries(snapshot.telemetry)) {
      const checked = this.validateTelemetry(sample);
      if (checked.metric !== metric) throw new Error(`Persisted telemetry key mismatch: ${metric}`);
      telemetry.set(metric, checked);
    }

    const actuators = new Map();
    for (const [id, current] of this.actuators) {
      const saved = snapshot.actuators[id];
      if (!isObject(saved) || saved.type !== current.type || !validDate(saved.changedAt)) {
        throw new Error(`Invalid persisted actuator: ${id}`);
      }
      if (!STATES_BY_TYPE[saved.type]?.has(saved.state)) {
        throw new Error(`Invalid persisted actuator state: ${id}`);
      }
      actuators.set(id, { type: saved.type, state: saved.state, changedAt: saved.changedAt });
    }

    const pendingCommands = new Map();
    const expiredCommands = [];
    for (const raw of snapshot.pending_commands ?? []) {
      const command = this.validatePersistentCommand(raw);
      if (new Date(command.expires_at) < this.now()) expiredCommands.push(command.command_id);
      else pendingCommands.set(command.command_id, command);
    }

    const manualRequests = new Map();
    const expiredManual = [];
    for (const [actuatorId, request] of Object.entries(snapshot.manual_requests ?? {})) {
      const actuator = actuators.get(actuatorId);
      if (!actuator || !isObject(request) || typeof request.reason !== 'string') {
        throw new Error(`Invalid persisted manual request: ${actuatorId}`);
      }
      this.validateAction(actuator.type, request.action);
      if (!validDate(request.requestedAt) || !validDate(request.expiresAt)) {
        throw new Error(`Invalid persisted manual request timestamps: ${actuatorId}`);
      }
      if (new Date(request.expiresAt) < this.now()) expiredManual.push(actuatorId);
      else manualRequests.set(actuatorId, structuredClone(request));
    }

    const events = (snapshot.events ?? []).map(entry => this.validatePersistentEvent(entry, 'event'));
    const alerts = (snapshot.alerts ?? []).map(entry => this.validatePersistentEvent(entry, 'alert'));
    const keys = snapshot.seen_idempotency_keys ?? [];
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) {
      throw new Error('Invalid persisted idempotency keys');
    }

    this.mode = snapshot.configured_mode;
    this.connected = snapshot.connected;
    this.telemetry = telemetry;
    this.actuators = actuators;
    this.pendingCommands = pendingCommands;
    this.manualRequests = manualRequests;
    this.events = events.slice(-this.limits.events);
    this.alerts = alerts.slice(-this.limits.alerts);
    this.seenIdempotencyKeys = new Set(keys.slice(-this.limits.idempotencyKeys));

    for (const commandId of expiredCommands) {
      this.raiseAlert('COMMAND_DROPPED_ON_RESTORE_EXPIRED', { command_id: commandId });
    }
    for (const actuatorId of expiredManual) {
      this.raiseAlert('MANUAL_REQUEST_DROPPED_ON_RESTORE_EXPIRED', { actuator_id: actuatorId });
    }
    if (logEvent) {
      this.log('STATE_RESTORED', {
        telemetry_count: telemetry.size,
        pending_command_count: pendingCommands.size,
        manual_request_count: manualRequests.size
      });
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      state_version: 1,
      configured_mode: this.mode,
      effective_mode: !this.connected && this.mode !== 'SAFE' ? 'OFFLINE' : this.mode,
      connected: this.connected,
      telemetry: Object.fromEntries(this.telemetry),
      actuators: Object.fromEntries(this.actuators),
      pending_commands: [...this.pendingCommands.values()],
      manual_requests: Object.fromEntries(this.manualRequests),
      seen_idempotency_keys: [...this.seenIdempotencyKeys],
      alerts: [...this.alerts],
      events: [...this.events]
    };
  }
}
