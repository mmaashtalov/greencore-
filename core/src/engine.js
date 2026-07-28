import crypto from 'node:crypto';

const QUALITY = new Set(['GOOD', 'SUSPECT', 'BAD', 'MISSING']);
const MODES = new Set(['AUTO', 'MANUAL', 'SAFE', 'OFFLINE']);

export class GreenCoreEngine {
  constructor({ contracts, rules, now = () => new Date() }) {
    this.contracts = contracts;
    this.rules = rules;
    this.now = now;
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
    this.manualRequests.set(actuatorId, { action, reason, requestedAt: this.now().toISOString() });
  }

  ingest(sample) {
    const checked = this.validateTelemetry(sample);
    this.telemetry.set(checked.metric, checked);
    this.log('TELEMETRY_ACCEPTED', { device_id: checked.device_id, metric: checked.metric, value: checked.value, quality: checked.quality });
    return checked;
  }

  validateTelemetry(sample) {
    const required = this.contracts.telemetry.required;
    for (const field of required) {
      if (sample?.[field] === undefined || sample?.[field] === null) throw new Error(`Telemetry missing field: ${field}`);
    }
    const metric = this.contracts.telemetry.metrics[sample.metric];
    if (!metric) throw new Error(`Unsupported metric: ${sample.metric}`);
    if (sample.unit !== metric.unit) throw new Error(`Invalid unit for ${sample.metric}: ${sample.unit}`);
    if (typeof sample.value !== 'number' || !Number.isFinite(sample.value)) throw new Error('Telemetry value must be a finite number');
    if (sample.value < metric.min || sample.value > metric.max) throw new Error(`Telemetry value out of range for ${sample.metric}`);
    if (!QUALITY.has(sample.quality)) throw new Error(`Invalid telemetry quality: ${sample.quality}`);
    const timestamp = new Date(sample.timestamp);
    if (Number.isNaN(timestamp.getTime())) throw new Error('Invalid telemetry timestamp');
    const futureMs = timestamp.getTime() - this.now().getTime();
    if (futureMs > this.rules.telemetry.future_tolerance_seconds * 1000) throw new Error('Telemetry timestamp is too far in the future');
    return { ...sample, timestamp: timestamp.toISOString() };
  }

  metricState(metricName) {
    const sample = this.telemetry.get(metricName);
    if (!sample) return { state: 'UNKNOWN', usable: false, sample: null };
    if (sample.quality === 'BAD' || sample.quality === 'MISSING') return { state: 'FAULT', usable: false, sample };
    const ageSeconds = (this.now().getTime() - new Date(sample.timestamp).getTime()) / 1000;
    if (ageSeconds > this.rules.telemetry.offline_after_seconds) return { state: 'OFFLINE', usable: false, sample };
    if (ageSeconds > this.rules.telemetry.stale_after_seconds) return { state: 'STALE', usable: false, sample };
    return { state: 'ONLINE', usable: sample.quality === 'GOOD', sample };
  }

  evaluate() {
    this.expireCommands();
    const required = Object.fromEntries(this.rules.required_metrics.map(metric => [metric, this.metricState(metric)]));
    const hasInvalidRequired = Object.values(required).some(item => !item.usable);
    const effectiveMode = !this.connected ? 'OFFLINE' : hasInvalidRequired ? 'SAFE' : this.mode;

    if (effectiveMode === 'SAFE') {
      this.raiseAlert('REQUIRED_TELEMETRY_UNAVAILABLE', { required });
      return this.ensureSafeState('required telemetry unavailable or untrusted', effectiveMode);
    }

    if (effectiveMode === 'OFFLINE') {
      this.log('LOCAL_OFFLINE_AUTOMATION', {});
    }

    if (this.pumpRuntimeExceeded()) {
      this.raiseAlert('PUMP_RUNTIME_LIMIT_EXCEEDED', {});
      return [this.issue('pump_01', 'OFF', 'pump continuous runtime safety limit reached', effectiveMode)].filter(Boolean);
    }

    if (effectiveMode === 'MANUAL') return this.applyManualRequests(required, effectiveMode);
    return this.applyAutomaticRules(required, effectiveMode);
  }

  applyManualRequests(required, effectiveMode) {
    const commands = [];
    for (const [actuatorId, request] of this.manualRequests) {
      if (actuatorId === 'pump_01' && request.action === 'ON' && required.water_level.sample.value < this.rules.water_level.minimum_for_pump_percent) {
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

  issue(actuatorId, action, reason, effectiveMode) {
    const actuator = this.actuators.get(actuatorId);
    if (!actuator) throw new Error(`Unknown actuator: ${actuatorId}`);
    const issuedAt = this.now();
    const bucket = issuedAt.toISOString().slice(0, 16);
    const idempotencyKey = `${actuatorId}:${action}:${bucket}`;
    if (this.seenIdempotencyKeys.has(idempotencyKey)) return null;
    this.seenIdempotencyKeys.add(idempotencyKey);
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
    const command = this.pendingCommands.get(ack.command_id);
    if (!command) throw new Error(`Unknown or completed command: ${ack.command_id}`);
    if (new Date(command.expires_at) < this.now()) throw new Error(`Command expired: ${ack.command_id}`);
    if (!this.contracts.command.ack_status.includes(ack.status)) throw new Error(`Unsupported acknowledgement status: ${ack.status}`);
    if (ack.status === 'EXECUTED') {
      const actuator = this.actuators.get(command.actuator_id);
      actuator.state = command.action === 'CLOSE' ? 'CLOSED' : command.action;
      actuator.changedAt = new Date(ack.timestamp ?? this.now()).toISOString();
    }
    if (['EXECUTED', 'REJECTED', 'EXPIRED', 'FAILED'].includes(ack.status)) this.pendingCommands.delete(command.command_id);
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
    this.log('ALERT_RAISED', alert);
  }

  log(type, details) {
    this.events.push({ type, details, timestamp: this.now().toISOString() });
  }

  snapshot() {
    return {
      configured_mode: this.mode,
      connected: this.connected,
      telemetry: Object.fromEntries([...this.telemetry.entries()]),
      actuators: Object.fromEntries([...this.actuators.entries()]),
      pending_commands: [...this.pendingCommands.values()],
      alerts: [...this.alerts],
      events: [...this.events]
    };
  }
}
