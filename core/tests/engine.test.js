import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { DeviceEmulator, executeCommands } from '../src/device-emulator.js';

function fixture(start = '2026-07-28T07:00:00.000Z') {
  let current = new Date(start);
  const now = () => new Date(current);
  const advance = seconds => { current = new Date(current.getTime() + seconds * 1000); };
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const emulator = new DeviceEmulator({ now });
  const ingestRequired = () => emulator.requiredTelemetry().forEach(sample => engine.ingest(sample));
  return { engine, emulator, now, advance, ingestRequired };
}

function actions(commands) {
  return commands.map(command => `${command.actuator_id}:${command.action}`);
}

test('normal conditions produce no commands', () => {
  const f = fixture();
  f.ingestRequired();
  f.engine.setMode('AUTO');
  assert.deepEqual(f.engine.evaluate(), []);
});

test('dry soil starts pump', () => {
  const f = fixture();
  f.emulator.set('soil_moisture', 30);
  f.ingestRequired();
  f.engine.setMode('AUTO');
  assert.deepEqual(actions(f.engine.evaluate()), ['pump_01:ON']);
});

test('overheat starts fan', () => {
  const f = fixture();
  f.emulator.set('air_temperature', 35);
  f.ingestRequired();
  f.engine.setMode('AUTO');
  assert.deepEqual(actions(f.engine.evaluate()), ['fan_01:ON']);
});

test('low water blocks pump even with dry soil', () => {
  const f = fixture();
  f.emulator.set('soil_moisture', 20).set('water_level', 10);
  f.ingestRequired();
  f.engine.setMode('AUTO');
  assert.equal(actions(f.engine.evaluate()).includes('pump_01:ON'), false);
  assert.equal(f.engine.alerts.at(-1).type, 'LOW_WATER_LEVEL');
});

test('missing required sensor forces safe mode', () => {
  const f = fixture();
  f.engine.ingest(f.emulator.sample('air_temperature'));
  f.engine.ingest(f.emulator.sample('water_level'));
  f.engine.setMode('AUTO');
  f.engine.evaluate();
  assert.equal(f.engine.alerts.at(-1).type, 'REQUIRED_TELEMETRY_UNAVAILABLE');
});

test('stale telemetry forces safe mode', () => {
  const f = fixture();
  f.ingestRequired();
  f.engine.setMode('AUTO');
  f.advance(rules.telemetry.stale_after_seconds + 1);
  f.engine.evaluate();
  assert.equal(f.engine.alerts.at(-1).type, 'REQUIRED_TELEMETRY_UNAVAILABLE');
});

test('manual pump request is rejected when water is low', () => {
  const f = fixture();
  f.emulator.set('water_level', 5);
  f.ingestRequired();
  f.engine.setMode('MANUAL');
  f.engine.requestManual('pump_01', 'ON');
  const commands = f.engine.evaluate();
  assert.equal(actions(commands).includes('pump_01:ON'), false);
  assert.equal(f.engine.alerts.at(-1).type, 'MANUAL_COMMAND_REJECTED_LOW_WATER');
});

test('offline mode continues local automatic control', () => {
  const f = fixture();
  f.emulator.set('soil_moisture', 25);
  f.ingestRequired();
  f.engine.setMode('AUTO');
  f.engine.setConnectivity(false);
  const commands = f.engine.evaluate();
  assert.deepEqual(actions(commands), ['pump_01:ON']);
  assert.equal(commands[0].mode, 'OFFLINE');
});

test('pump runtime limit forces pump off', () => {
  const f = fixture();
  f.emulator.set('soil_moisture', 25);
  f.ingestRequired();
  f.engine.setMode('AUTO');
  const start = f.engine.evaluate();
  executeCommands(f.engine, start, f.now);
  f.advance(rules.pump.max_continuous_runtime_seconds + 1);
  f.emulator.requiredTelemetry().forEach(sample => f.engine.ingest(sample));
  assert.deepEqual(actions(f.engine.evaluate()), ['pump_01:OFF']);
  assert.equal(f.engine.alerts.at(-1).type, 'PUMP_RUNTIME_LIMIT_EXCEEDED');
});

test('duplicate decision in one minute is idempotent', () => {
  const f = fixture();
  f.emulator.set('soil_moisture', 25);
  f.ingestRequired();
  f.engine.setMode('AUTO');
  assert.equal(f.engine.evaluate().length, 1);
  assert.equal(f.engine.evaluate().length, 0);
});

test('bad quality telemetry is not trusted', () => {
  const f = fixture();
  f.emulator.setQuality('soil_moisture', 'BAD');
  f.ingestRequired();
  f.engine.setMode('AUTO');
  f.engine.evaluate();
  assert.equal(f.engine.alerts.at(-1).type, 'REQUIRED_TELEMETRY_UNAVAILABLE');
});
