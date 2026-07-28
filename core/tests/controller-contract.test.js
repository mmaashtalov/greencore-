import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerRegistry } from '../src/controller-registry.js';
import { GreenCoreRuntime } from '../src/runtime.js';
import { close, createApiServer, listen } from '../src/api.js';

function clock(start = '2026-07-28T07:00:00.000Z') {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(seconds) { current = new Date(current.getTime() + seconds * 1000); }
  };
}

class FakeEngine {
  constructor(now) {
    this.now = now;
    this.mode = 'AUTO';
    this.connected = true;
    this.telemetry = new Map();
    this.pendingCommands = new Map();
    this.events = [];
    this.alerts = [];
    this.issued = false;
  }

  log(type, details) { this.events.push({ type, details, timestamp: this.now().toISOString() }); }
  setMode(mode) { this.mode = mode; }
  setConnectivity(connected) { this.connected = connected; }
  requestManual() {}
  validateTelemetry(sample) {
    if (!sample?.device_id || !sample?.metric) throw new Error('Invalid telemetry');
    return structuredClone(sample);
  }
  ingest(sample) { this.telemetry.set(sample.metric, structuredClone(sample)); return sample; }
  expireCommands() {}
  evaluate() {
    if (this.issued) return [];
    this.issued = true;
    const command = {
      command_id: 'cmd_1',
      actuator_id: 'pump_01',
      actuator_type: 'pump',
      action: 'ON',
      issued_at: this.now().toISOString(),
      expires_at: new Date(this.now().getTime() + 60000).toISOString(),
      reason: 'test',
      mode: 'AUTO',
      idempotency_key: 'pump_01:ON:test'
    };
    this.pendingCommands.set(command.command_id, command);
    return [command];
  }
  acknowledge(ack) {
    const command = this.pendingCommands.get(ack.command_id);
    if (!command) throw new Error(`Unknown or completed command: ${ack.command_id}`);
    if (['EXECUTED', 'REJECTED', 'EXPIRED', 'FAILED'].includes(ack.status)) {
      this.pendingCommands.delete(ack.command_id);
    }
    return command;
  }
  snapshot() {
    return {
      state_version: 1,
      configured_mode: this.mode,
      connected: this.connected,
      pending_commands: [...this.pendingCommands.values()].map(item => structuredClone(item)),
      telemetry: Object.fromEntries(this.telemetry),
      events: structuredClone(this.events),
      alerts: structuredClone(this.alerts),
      issued: this.issued
    };
  }
  restore(snapshot) {
    this.mode = snapshot.configured_mode;
    this.connected = snapshot.connected;
    this.pendingCommands = new Map((snapshot.pending_commands ?? []).map(item => [item.command_id, structuredClone(item)]));
    this.telemetry = new Map(Object.entries(snapshot.telemetry ?? {}));
    this.events = structuredClone(snapshot.events ?? []);
    this.alerts = structuredClone(snapshot.alerts ?? []);
    this.issued = Boolean(snapshot.issued);
  }
}

function runtimeFixture() {
  const time = clock();
  const engine = new FakeEngine(time.now);
  const registry = new ControllerRegistry({ now: time.now, heartbeatTimeoutSeconds: 30 });
  const runtime = new GreenCoreRuntime({ engine, registry, now: time.now });
  return { time, engine, registry, runtime };
}

test('controller registration owns devices and rejects ownership conflicts', () => {
  const time = clock();
  const registry = new ControllerRegistry({ now: time.now });
  registry.register({ controller_id: 'a', devices: ['pump_01'] });
  assert.equal(registry.ownerOf('pump_01'), 'a');
  assert.throws(
    () => registry.register({ controller_id: 'b', devices: ['pump_01'] }),
    /already belongs/
  );
});

test('heartbeat marks controller online and timeout marks it offline', () => {
  const time = clock();
  const registry = new ControllerRegistry({ now: time.now, heartbeatTimeoutSeconds: 30 });
  registry.register({ controller_id: 'a', devices: ['pump_01'] });
  assert.equal(registry.heartbeat('a', { uptime_seconds: 5 }).status, 'ONLINE');
  time.advance(31);
  assert.equal(registry.list()[0].status, 'OFFLINE');
});

test('runtime queues commands for the owning controller and validates ACK ownership', () => {
  const f = runtimeFixture();
  const [command] = f.runtime.evaluate();
  assert.equal(command.controller_id, 'controller_primary');
  assert.equal(command.delivery_status, 'QUEUED');

  const delivered = f.runtime.controllerCommands('controller_primary');
  assert.equal(delivered[0].delivery_status, 'DELIVERED');

  f.registry.register({ controller_id: 'controller_secondary', devices: ['sensor_secondary'] });
  assert.throws(() => f.runtime.acknowledge({
    controller_id: 'controller_secondary',
    command_id: command.command_id,
    status: 'EXECUTED'
  }), /controller mismatch/);

  f.runtime.acknowledge({
    controller_id: 'controller_primary',
    command_id: command.command_id,
    actuator_id: 'pump_01',
    status: 'EXECUTED'
  });
  assert.equal(f.engine.pendingCommands.size, 0);
});

test('controller registry and queued command survive snapshot restore', () => {
  const f = runtimeFixture();
  f.runtime.heartbeat('controller_primary', { uptime_seconds: 10 });
  f.runtime.evaluate();
  f.runtime.controllerCommands('controller_primary');
  const snapshot = f.runtime.snapshot();

  const restoredEngine = new FakeEngine(f.time.now);
  const restored = new GreenCoreRuntime({ engine: restoredEngine, now: f.time.now });
  restored.restore(snapshot);

  assert.equal(restored.listControllers()[0].status, 'ONLINE');
  const commands = restored.controllerCommands('controller_primary');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].controller_id, 'controller_primary');
});

test('controller HTTP contract registers, heartbeats, delivers and acknowledges', async t => {
  const f = runtimeFixture();
  const server = createApiServer({ engine: f.runtime, logger: { error() {} } });
  const address = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : undefined
    });
    return { response, body: await response.json() };
  };
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });

  const registration = await post('/controllers/register', {
    controller_id: 'controller_primary',
    name: 'Primary',
    firmware: '1.0.0',
    devices: ['soil_01', 'air_01', 'water_01', 'pump_01', 'fan_01', 'vent_01']
  });
  assert.equal(registration.response.status, 201);

  const heartbeat = await post('/controllers/controller_primary/heartbeat', { uptime_seconds: 12 });
  assert.equal(heartbeat.body.controller.status, 'ONLINE');

  const evaluation = await post('/evaluate', {});
  assert.equal(evaluation.body.commands[0].controller_id, 'controller_primary');

  const delivery = await request('/controllers/controller_primary/commands');
  assert.equal(delivery.body.commands[0].delivery_status, 'DELIVERED');

  const ack = await post('/controllers/controller_primary/command-acks', {
    command_id: 'cmd_1',
    actuator_id: 'pump_01',
    status: 'EXECUTED'
  });
  assert.equal(ack.response.status, 200);
});
