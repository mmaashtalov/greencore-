import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { GreenCoreRuntime } from '../src/runtime.js';
import { close, createApiServer, listen } from '../src/api.js';

function fixture() {
  const now = () => new Date('2026-07-28T07:00:00.000Z');
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const runtime = new GreenCoreRuntime({ engine, now });
  runtime.ingestControllerTelemetry('controller_primary', [
    { device_id: 'air_01', metric: 'air_temperature', value: 35, unit: '°C', timestamp: now().toISOString(), quality: 'GOOD' },
    { device_id: 'soil_01', metric: 'soil_moisture', value: 50, unit: '%', timestamp: now().toISOString(), quality: 'GOOD' },
    { device_id: 'water_01', metric: 'water_level', value: 80, unit: '%', timestamp: now().toISOString(), quality: 'GOOD' }
  ]);
  runtime.setMode('AUTO');
  const [command] = runtime.evaluate();
  const ack = {
    controller_id: 'controller_primary',
    command_id: command.command_id,
    actuator_id: command.actuator_id,
    status: 'EXECUTED',
    timestamp: now().toISOString(),
    details: 'applied'
  };
  return { now, engine, runtime, command, ack };
}

test('duplicate terminal ACK is accepted without repeating actuator transition', () => {
  const f = fixture();
  const first = f.runtime.acknowledge(f.ack);
  const changedAt = f.engine.actuators.get('fan_01').changedAt;
  const duplicate = f.runtime.acknowledge({ ...f.ack, details: 'replayed' });

  assert.equal(first.command_id, f.command.command_id);
  assert.equal(duplicate.duplicate_ack, true);
  assert.equal(f.engine.actuators.get('fan_01').changedAt, changedAt);
  assert.equal(f.runtime.completedAcks.size, 1);
  assert.equal(f.engine.events.at(-1).type, 'DUPLICATE_TERMINAL_ACK_IGNORED');
});

test('duplicate ACK with different controller, actuator or status is rejected', () => {
  const f = fixture();
  f.runtime.acknowledge(f.ack);

  assert.throws(
    () => f.runtime.acknowledge({ ...f.ack, controller_id: 'other' }),
    /controller mismatch/
  );
  assert.throws(
    () => f.runtime.acknowledge({ ...f.ack, actuator_id: 'pump_01' }),
    /actuator mismatch/
  );
  assert.throws(
    () => f.runtime.acknowledge({ ...f.ack, status: 'FAILED' }),
    /terminal status mismatch/
  );
});

test('completed ACK cache survives runtime restart', () => {
  const f = fixture();
  f.runtime.acknowledge(f.ack);
  const snapshot = f.runtime.snapshot();

  const restoredEngine = new GreenCoreEngine({ contracts, rules, now: f.now });
  const restored = new GreenCoreRuntime({ engine: restoredEngine, now: f.now });
  restored.restore(snapshot);
  const duplicate = restored.acknowledge({ ...f.ack, details: 'network retry after restart' });

  assert.equal(duplicate.duplicate_ack, true);
  assert.equal(restored.completedAcks.size, 1);
  assert.equal(restoredEngine.actuators.get('fan_01').state, 'ON');
});

test('completed ACK cache is bounded', () => {
  const f = fixture();
  f.runtime.completedAckLimit = 2;
  const base = {
    controller_id: 'controller_primary',
    actuator_id: 'fan_01',
    status: 'EXECUTED',
    acknowledged_at: f.now().toISOString(),
    details: null
  };

  for (const commandId of ['one', 'two', 'three']) {
    f.runtime.completedAcks.set(commandId, {
      ...base,
      command_id: commandId,
      command: {
        ...f.command,
        command_id: commandId,
        controller_id: 'controller_primary'
      }
    });
  }
  while (f.runtime.completedAcks.size > f.runtime.completedAckLimit) {
    f.runtime.completedAcks.delete(f.runtime.completedAcks.keys().next().value);
  }

  const snapshot = f.runtime.snapshot();
  assert.deepEqual(snapshot.completed_command_acks.map(item => item.command_id), ['two', 'three']);
});

test('controller HTTP endpoint accepts duplicate terminal ACK after success', async t => {
  const f = fixture();
  const server = createApiServer({ engine: f.runtime, logger: { error() {} } });
  const address = await listen(server);
  t.after(() => close(server));
  const url = `http://127.0.0.1:${address.port}/controllers/controller_primary/command-acks`;
  const body = JSON.stringify({
    command_id: f.ack.command_id,
    actuator_id: f.ack.actuator_id,
    status: f.ack.status,
    timestamp: f.ack.timestamp
  });

  const first = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const duplicate = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const duplicateBody = await duplicate.json();

  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.command.duplicate_ack, true);
});
