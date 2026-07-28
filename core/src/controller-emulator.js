const TERMINAL = new Set(['EXECUTED', 'REJECTED', 'EXPIRED', 'FAILED']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export class ControllerEmulator {
  constructor({
    baseUrl,
    controllerId = 'controller_primary',
    name = 'GreenCore virtual controller',
    firmware = 'emulator-1.0.0',
    protocolVersion = '1.0',
    apiKey = null,
    now = () => new Date(),
    fetchImpl = globalThis.fetch,
    random = Math.random,
    localWaterMinimumPercent = 15,
    initialSensors = {},
    faults = {}
  }) {
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') throw new Error('baseUrl is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.controllerId = controllerId;
    this.name = name;
    this.firmware = firmware;
    this.protocolVersion = protocolVersion;
    this.apiKey = typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : null;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.localWaterMinimumPercent = localWaterMinimumPercent;
    this.startedAt = now();
    this.configuration = {
      heartbeat_interval_seconds: 10,
      command_poll_interval_seconds: 2,
      telemetry_interval_seconds: 5
    };
    this.sensors = {
      soil_01: { metric: 'soil_moisture', value: 50, unit: '%', quality: 'GOOD' },
      air_01: { metric: 'air_temperature', value: 24, unit: '°C', quality: 'GOOD' },
      water_01: { metric: 'water_level', value: 80, unit: '%', quality: 'GOOD' },
      ...structuredClone(initialSensors)
    };
    this.actuators = {
      pump_01: { type: 'pump', state: 'OFF' },
      fan_01: { type: 'fan', state: 'OFF' },
      vent_01: { type: 'vent', state: 'CLOSED' }
    };
    this.faults = {
      network_offline: false,
      latency_ms: 0,
      packet_loss_rate: 0,
      pump_failure: false,
      fan_failure: false,
      vent_failure: false,
      relay_stuck: false,
      ...faults
    };
    this.processedCommands = new Map();
    this.running = false;
    this.timers = new Set();
  }

  devices() {
    return [...Object.keys(this.sensors), ...Object.keys(this.actuators)];
  }

  setSensor(deviceId, value, quality = undefined) {
    const sensor = this.sensors[deviceId];
    if (!sensor) throw new Error(`Unknown sensor: ${deviceId}`);
    if (!Number.isFinite(value)) throw new Error('Sensor value must be finite');
    sensor.value = value;
    if (quality !== undefined) sensor.quality = quality;
    return this;
  }

  setFault(name, value) {
    if (!(name in this.faults)) throw new Error(`Unknown fault: ${name}`);
    this.faults[name] = value;
    return this;
  }

  telemetrySamples() {
    const timestamp = this.now().toISOString();
    return Object.entries(this.sensors).map(([deviceId, sensor]) => ({
      device_id: deviceId,
      metric: sensor.metric,
      value: sensor.value,
      unit: sensor.unit,
      timestamp,
      quality: sensor.quality
    }));
  }

  async request(path, { method = 'GET', body } = {}) {
    if (this.faults.network_offline) throw new Error('Emulated network offline');
    const lossRate = Math.max(0, Math.min(1, finite(this.faults.packet_loss_rate, 0)));
    if (lossRate > 0 && this.random() < lossRate) throw new Error('Emulated packet loss');
    const latency = Math.max(0, finite(this.faults.latency_ms, 0));
    if (latency > 0) await sleep(latency);

    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
    return payload;
  }

  async register() {
    const payload = await this.request('/controllers/register', {
      method: 'POST',
      body: {
        controller_id: this.controllerId,
        name: this.name,
        firmware: this.firmware,
        protocol_version: this.protocolVersion,
        capabilities: ['heartbeat', 'telemetry', 'command-polling', 'local-safety'],
        devices: this.devices(),
        metadata: { emulator: true }
      }
    });
    this.configuration = { ...this.configuration, ...payload.configuration };
    return payload;
  }

  async heartbeat() {
    return this.request(`/controllers/${encodeURIComponent(this.controllerId)}/heartbeat`, {
      method: 'POST',
      body: {
        firmware: this.firmware,
        uptime_seconds: Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
        wifi_rssi: -55,
        free_memory_bytes: 192 * 1024,
        cpu_temperature_c: 42,
        queue_size: 0,
        timestamp: this.now().toISOString()
      }
    });
  }

  async publishTelemetry() {
    return this.request(`/controllers/${encodeURIComponent(this.controllerId)}/telemetry`, {
      method: 'POST',
      body: { samples: this.telemetrySamples() }
    });
  }

  async pollCommands() {
    const payload = await this.request(`/controllers/${encodeURIComponent(this.controllerId)}/commands`);
    const results = [];
    for (const command of payload.commands ?? []) results.push(await this.handleCommand(command));
    return results;
  }

  validateCommand(command) {
    if (!command || typeof command !== 'object') return 'invalid command payload';
    if (command.controller_id !== this.controllerId) return 'controller mismatch';
    if (!this.actuators[command.actuator_id]) return 'unknown actuator';
    if (Number.isNaN(new Date(command.expires_at).getTime())) return 'invalid expiry';
    if (new Date(command.expires_at) < this.now()) return 'command expired';
    const actions = {
      pump: new Set(['ON', 'OFF']),
      fan: new Set(['ON', 'OFF']),
      vent: new Set(['OPEN', 'CLOSE'])
    };
    const actuator = this.actuators[command.actuator_id];
    if (!actions[actuator.type]?.has(command.action)) return 'unsupported action';
    return null;
  }

  localSafety(command) {
    if (command.actuator_id === 'pump_01' && command.action === 'ON') {
      if (this.sensors.water_01.value < this.localWaterMinimumPercent) {
        return 'LOW_WATER_LOCAL_INTERLOCK';
      }
      if (this.faults.pump_failure) return 'PUMP_FAILURE';
    }
    if (command.actuator_id === 'fan_01' && this.faults.fan_failure) return 'FAN_FAILURE';
    if (command.actuator_id === 'vent_01' && this.faults.vent_failure) return 'VENT_FAILURE';
    if (this.faults.relay_stuck) return 'RELAY_STUCK';
    return null;
  }

  applyCommand(command) {
    const actuator = this.actuators[command.actuator_id];
    actuator.state = command.action === 'CLOSE' ? 'CLOSED' : command.action;
    actuator.changed_at = this.now().toISOString();
  }

  async sendAck(command, status, details) {
    const ack = {
      command_id: command.command_id,
      actuator_id: command.actuator_id,
      status,
      timestamp: this.now().toISOString(),
      details
    };
    await this.request(`/controllers/${encodeURIComponent(this.controllerId)}/command-acks`, {
      method: 'POST',
      body: ack
    });
    return ack;
  }

  async handleCommand(command) {
    const previous = this.processedCommands.get(command.command_id);
    if (previous && TERMINAL.has(previous.status)) {
      await this.sendAck(command, previous.status, `replayed: ${previous.details}`);
      return previous;
    }

    const invalid = this.validateCommand(command);
    if (invalid) {
      const ack = await this.sendAck(command, invalid === 'command expired' ? 'EXPIRED' : 'REJECTED', invalid);
      this.processedCommands.set(command.command_id, ack);
      return ack;
    }

    const safetyReason = this.localSafety(command);
    if (safetyReason) {
      const status = safetyReason.endsWith('_FAILURE') || safetyReason === 'RELAY_STUCK' ? 'FAILED' : 'REJECTED';
      const ack = await this.sendAck(command, status, safetyReason);
      this.processedCommands.set(command.command_id, ack);
      return ack;
    }

    await this.sendAck(command, 'ACCEPTED', 'local validation passed');
    this.applyCommand(command);
    const ack = await this.sendAck(command, 'EXECUTED', 'virtual actuator applied command');
    this.processedCommands.set(command.command_id, ack);
    return ack;
  }

  tickPhysics(seconds = 1) {
    if (this.actuators.pump_01.state === 'ON') {
      this.sensors.soil_01.value = Math.min(100, this.sensors.soil_01.value + 0.18 * seconds);
      this.sensors.water_01.value = Math.max(0, this.sensors.water_01.value - 0.08 * seconds);
    } else {
      this.sensors.soil_01.value = Math.max(0, this.sensors.soil_01.value - 0.01 * seconds);
    }
    if (this.actuators.fan_01.state === 'ON') {
      this.sensors.air_01.value = Math.max(10, this.sensors.air_01.value - 0.06 * seconds);
    }
  }

  schedule(task, intervalSeconds) {
    const intervalMs = Math.max(100, intervalSeconds * 1000);
    const timer = setInterval(() => void task().catch(() => {}), intervalMs);
    this.timers.add(timer);
  }

  async start() {
    if (this.running) return;
    await this.register();
    await this.heartbeat();
    await this.publishTelemetry();
    this.running = true;
    this.schedule(() => this.heartbeat(), this.configuration.heartbeat_interval_seconds);
    this.schedule(() => this.publishTelemetry(), this.configuration.telemetry_interval_seconds);
    this.schedule(async () => {
      this.tickPhysics(this.configuration.command_poll_interval_seconds);
      await this.pollCommands();
    }, this.configuration.command_poll_interval_seconds);
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    this.running = false;
  }
}
