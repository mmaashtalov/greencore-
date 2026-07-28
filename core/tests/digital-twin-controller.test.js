import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { GreenCoreRuntime } from '../src/runtime.js';
import { DigitalTwinControllerEmulator } from '../src/digital-twin-controller.js';
import { close, createApiServer, listen } from '../src/api.js';

function fixedNow() {
  return new Date('2026-07-28T07:00:00.000Z');
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

test('digital twin controller exposes coupled telemetry including humidity', () => {
  const emulator = new DigitalTwinControllerEmulator({
    baseUrl: 'http://127.0.0.1:3000',
    now: fixedNow,
    twinOptions: { startTime: fixedNow().toISOString() }
  });
  const samples = emulator.telemetrySamples();
  assert.equal(samples.some(sample => sample.metric === 'air_humidity'), true);
  assert.equal(samples.every(sample => sample.simulation_time === fixedNow().toISOString()), true);
});

test('simulation speed advances the twin and actuator effects are coupled', () => {
  const emulator = new DigitalTwinControllerEmulator({
    baseUrl: 'http://127.0.0.1:3000',
    now: fixedNow,
    simulationSpeed: 60,
    twinOptions: { startTime: fixedNow().toISOString() }
  });
  emulator.actuators.pump_01.state = 'ON';
  const before = emulator.digitalTwinSnapshot();
  emulator.tickPhysics(60);
  const after = emulator.digitalTwinSnapshot();
  assert.equal(new Date(after.twin.simulation_time) - new Date(before.twin.simulation_time), 3600 * 1000);
  assert.equal(after.twin.state.soil_moisture_percent > before.twin.state.soil_moisture_percent, true);
  assert.equal(after.twin.state.water_level_percent < before.twin.state.water_level_percent, true);
});

test('sensor overrides and scenario presets update the canonical twin', () => {
  const emulator = new DigitalTwinControllerEmulator({
    baseUrl: 'http://127.0.0.1:3000',
    now: fixedNow
  });
  emulator.setSensor('water_01', 40).applyScenarioPreset('leak');
  assert.equal(emulator.digitalTwin.state.water_level_percent, 40);
  assert.equal(emulator.digitalTwin.scenario.tank_leak_percent_per_hour, 8);
});

test('digital twin controller snapshot restores simulation and actuator state', () => {
  const source = new DigitalTwinControllerEmulator({
    baseUrl: 'http://127.0.0.1:3000',
    now: fixedNow,
    simulationSpeed: 20
  });
  source.actuators.fan_01.state = 'ON';
  source.tickPhysics(120);
  const snapshot = source.digitalTwinSnapshot();

  const restored = new DigitalTwinControllerEmulator({
    baseUrl: 'http://127.0.0.1:3000',
    now: fixedNow
  });
  restored.restoreDigitalTwin(snapshot);
  assert.deepEqual(restored.digitalTwinSnapshot(), snapshot);
  assert.equal(restored.sensors.air_01.value, snapshot.twin.state.air_temperature_c);
});

test('closed loop changes simulated environment after GreenCore command execution', async t => {
  const engine = new GreenCoreEngine({ contracts, rules, now: fixedNow });
  const runtime = new GreenCoreRuntime({ engine, now: fixedNow });
  const server = createApiServer({ engine: runtime, logger: { error() {} } });
  const address = await listen(server);
  t.after(() => close(server));
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const emulator = new DigitalTwinControllerEmulator({
    baseUrl,
    now: fixedNow,
    twinOptions: {
      startTime: fixedNow().toISOString(),
      state: { soil_moisture_percent: 25, water_level_percent: 80 }
    }
  });
  await emulator.register();
  await emulator.heartbeat();
  await emulator.publishTelemetry();
  await post(baseUrl, '/mode', { mode: 'AUTO' });
  const evaluation = await post(baseUrl, '/evaluate', {});
  assert.equal(evaluation.commands[0].action, 'ON');

  const before = emulator.digitalTwin.snapshot().state;
  const [ack] = await emulator.pollCommands();
  assert.equal(ack.status, 'EXECUTED');
  emulator.tickPhysics(3600);
  const after = emulator.digitalTwin.snapshot().state;
  assert.equal(after.soil_moisture_percent > before.soil_moisture_percent, true);
  assert.equal(after.water_level_percent < before.water_level_percent, true);
});
