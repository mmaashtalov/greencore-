import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerEmulator } from '../src/controller-emulator.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
}

function command(overrides = {}) {
  return {
    command_id: 'cmd_1',
    controller_id: 'controller_primary',
    actuator_id: 'pump_01',
    actuator_type: 'pump',
    action: 'ON',
    issued_at: '2026-07-28T07:00:00.000Z',
    expires_at: '2026-07-28T07:01:00.000Z',
    reason: 'dry soil',
    mode: 'AUTO',
    idempotency_key: 'x',
    ...overrides
  };
}

function fixture(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method ?? 'GET', body });
    return handler({ url, options, body, calls });
  };
  const now = () => new Date('2026-07-28T07:00:10.000Z');
  return {
    calls,
    emulator: new ControllerEmulator({ baseUrl: 'http://core', fetchImpl, now, random: () => 0.9 })
  };
}

test('register sends stable device ownership and accepts configuration', async () => {
  const f = fixture(({ url }) => {
    assert.equal(url, 'http://core/controllers/register');
    return response(201, { configuration: { heartbeat_interval_seconds: 7 } });
  });
  await f.emulator.register();
  assert.equal(f.calls[0].body.controller_id, 'controller_primary');
  assert.equal(f.calls[0].body.devices.includes('pump_01'), true);
  assert.equal(f.emulator.configuration.heartbeat_interval_seconds, 7);
});

test('valid command sends ACCEPTED then EXECUTED and changes actuator state', async () => {
  const f = fixture(({ url }) => {
    if (url.endsWith('/commands')) return response(200, { commands: [command()] });
    return response(200, { acknowledged: true });
  });
  const [result] = await f.emulator.pollCommands();
  const acks = f.calls.filter(call => call.url.endsWith('/command-acks')).map(call => call.body.status);
  assert.deepEqual(acks, ['ACCEPTED', 'EXECUTED']);
  assert.equal(result.status, 'EXECUTED');
  assert.equal(f.emulator.actuators.pump_01.state, 'ON');
});

test('local low-water interlock rejects pump without changing state', async () => {
  const f = fixture(({ url }) => {
    if (url.endsWith('/commands')) return response(200, { commands: [command()] });
    return response(200, { acknowledged: true });
  });
  f.emulator.setSensor('water_01', 5);
  const [result] = await f.emulator.pollCommands();
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.details, 'LOW_WATER_LOCAL_INTERLOCK');
  assert.equal(f.emulator.actuators.pump_01.state, 'OFF');
});

test('duplicate command does not repeat physical execution and replays terminal ACK', async () => {
  let polls = 0;
  const f = fixture(({ url }) => {
    if (url.endsWith('/commands')) {
      polls += 1;
      return response(200, { commands: [command()] });
    }
    return response(200, { acknowledged: true });
  });
  await f.emulator.pollCommands();
  const changedAt = f.emulator.actuators.pump_01.changed_at;
  await f.emulator.pollCommands();
  assert.equal(polls, 2);
  assert.equal(f.emulator.actuators.pump_01.changed_at, changedAt);
  const statuses = f.calls.filter(call => call.url.endsWith('/command-acks')).map(call => call.body.status);
  assert.deepEqual(statuses, ['ACCEPTED', 'EXECUTED', 'EXECUTED']);
});

test('network faults are deterministic and prevent requests', async () => {
  const f = fixture(() => response(200, {}));
  f.emulator.setFault('network_offline', true);
  await assert.rejects(() => f.emulator.heartbeat(), /network offline/);
  assert.equal(f.calls.length, 0);
});

test('physics changes soil and water only while pump is on', () => {
  const f = fixture(() => response(200, {}));
  const soil = f.emulator.sensors.soil_01.value;
  const water = f.emulator.sensors.water_01.value;
  f.emulator.actuators.pump_01.state = 'ON';
  f.emulator.tickPhysics(10);
  assert.equal(f.emulator.sensors.soil_01.value > soil, true);
  assert.equal(f.emulator.sensors.water_01.value < water, true);
});
