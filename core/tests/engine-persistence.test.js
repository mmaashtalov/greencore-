import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { DeviceEmulator } from '../src/device-emulator.js';

function fixture(start = '2026-07-28T07:00:00.000Z') {
  let current = new Date(start);
  const now = () => new Date(current);
  const advance = seconds => { current = new Date(current.getTime() + seconds * 1000); };
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const emulator = new DeviceEmulator({ now });
  const ingestRequired = () => emulator.requiredTelemetry().forEach(sample => engine.ingest(sample));
  return { engine, emulator, advance, ingestRequired };
}

test('invalid actuator action is rejected', () => {
  const f = fixture();
  assert.throws(() => f.engine.requestManual('pump_01', 'OPEN'), /Unsupported action/);
});

test('expired manual request is never executed', () => {
  const f = fixture();
  f.ingestRequired();
  f.engine.setMode('MANUAL');
  f.engine.requestManual('pump_01', 'ON');
  f.advance(rules.commands.ttl_seconds + 1);
  assert.deepEqual(f.engine.evaluate(), []);
  assert.equal(f.engine.alerts.at(-1).type, 'MANUAL_REQUEST_EXPIRED');
});

test('snapshot restore preserves state, idempotency and policy audit', () => {
  const source = fixture();
  source.emulator.set('soil_moisture', 25);
  source.ingestRequired();
  source.engine.setMode('AUTO');
  const [command] = source.engine.evaluate();

  const restored = fixture();
  restored.engine.restore(source.engine.snapshot());

  assert.equal(restored.engine.mode, 'AUTO');
  assert.equal(restored.engine.telemetry.size, 3);
  assert.equal(restored.engine.pendingCommands.has(command.command_id), true);
  assert.equal(restored.engine.evaluate().length, 0);
  assert.ok(restored.engine.events.some(event => event.type === 'STATE_RESTORED'));
  assert.equal(restored.engine.events.at(-1).type, 'POLICY_DECISION_RECORDED');
  assert.equal(restored.engine.policyDecisionHistory(1)[0].effect, 'ALLOW');
});

test('expired pending command is dropped during restore', () => {
  const source = fixture();
  source.emulator.set('soil_moisture', 25);
  source.ingestRequired();
  source.engine.setMode('AUTO');
  source.engine.evaluate();

  const restored = fixture('2026-07-28T07:00:31.000Z');
  restored.engine.restore(source.engine.snapshot());

  assert.equal(restored.engine.pendingCommands.size, 0);
  assert.equal(restored.engine.alerts.at(-1).type, 'COMMAND_DROPPED_ON_RESTORE_EXPIRED');
});
