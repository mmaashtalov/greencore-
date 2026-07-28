import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { DeviceEmulator } from '../src/device-emulator.js';
import { close, createApiServer, listen } from '../src/api.js';

async function fixture() {
  const now = () => new Date('2026-07-28T07:00:00.000Z');
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const emulator = new DeviceEmulator({ now });
  const server = createApiServer({ engine, logger: { error() {} } });
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers
    });
    return { response, body: await response.json() };
  }

  return { engine, emulator, server, request };
}

async function post(request, path, body) {
  return request(path, { method: 'POST', body: JSON.stringify(body) });
}

test('health and initial state are available', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  const health = await f.request('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');

  const state = await f.request('/state');
  assert.equal(state.response.status, 200);
  assert.equal(state.body.configured_mode, 'SAFE');
});

test('telemetry batch can drive automatic pump command', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  f.emulator.set('soil_moisture', 25);
  const telemetry = await post(f.request, '/telemetry', { samples: f.emulator.requiredTelemetry() });
  assert.equal(telemetry.response.status, 202);
  assert.equal(telemetry.body.accepted.length, 3);

  const mode = await post(f.request, '/mode', { mode: 'AUTO' });
  assert.equal(mode.body.configured_mode, 'AUTO');

  const evaluation = await post(f.request, '/evaluate', {});
  assert.equal(evaluation.response.status, 200);
  assert.equal(evaluation.body.commands.length, 1);
  assert.equal(evaluation.body.commands[0].actuator_id, 'pump_01');
  assert.equal(evaluation.body.commands[0].action, 'ON');
});

test('telemetry batch is rejected atomically', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  const valid = f.emulator.sample('air_temperature');
  const invalid = f.emulator.sample('soil_moisture', { unit: 'invalid' });
  const result = await post(f.request, '/telemetry', { samples: [valid, invalid] });

  assert.equal(result.response.status, 400);
  assert.equal(f.engine.telemetry.size, 0);
});

test('low water rejects manual pump activation', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  f.emulator.set('water_level', 5);
  await post(f.request, '/telemetry', { samples: f.emulator.requiredTelemetry() });
  await post(f.request, '/mode', { mode: 'MANUAL' });
  await post(f.request, '/manual-commands', {
    actuator_id: 'pump_01',
    action: 'ON',
    reason: 'operator test'
  });

  const evaluation = await post(f.request, '/evaluate', {});
  assert.equal(evaluation.body.commands.some(command => command.action === 'ON'), false);

  const alerts = await f.request('/alerts');
  assert.equal(alerts.body.alerts.at(-1).type, 'MANUAL_COMMAND_REJECTED_LOW_WATER');
});

test('command acknowledgement updates actuator state', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  f.emulator.set('air_temperature', 35);
  await post(f.request, '/telemetry', { samples: f.emulator.requiredTelemetry() });
  await post(f.request, '/mode', { mode: 'AUTO' });
  const evaluation = await post(f.request, '/evaluate', {});
  const command = evaluation.body.commands[0];

  const ack = await post(f.request, '/command-acks', {
    command_id: command.command_id,
    actuator_id: command.actuator_id,
    status: 'EXECUTED',
    timestamp: '2026-07-28T07:00:01.000Z'
  });
  assert.equal(ack.response.status, 200);

  const state = await f.request('/state');
  assert.equal(state.body.actuators.fan_01.state, 'ON');
  assert.equal(state.body.pending_commands.length, 0);
});

test('invalid JSON and unknown routes return controlled errors', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  const invalid = await f.request('/mode', { method: 'POST', body: '{' });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, 'INVALID_REQUEST');

  const missing = await f.request('/missing');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error, 'NOT_FOUND');
});

test('events endpoint enforces a bounded limit', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  await post(f.request, '/connectivity', { connected: false });
  await post(f.request, '/connectivity', { connected: true });

  const result = await f.request('/events?limit=1');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.events.length, 1);

  const invalid = await f.request('/events?limit=not-a-number');
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, 'INVALID_REQUEST');
});
