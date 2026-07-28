import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { GreenCoreRuntime } from '../src/runtime.js';
import { ControllerEmulator } from '../src/controller-emulator.js';
import { close, createApiServer, listen } from '../src/api.js';

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

test('real API and controller emulator complete a pump command loop', async t => {
  const now = () => new Date('2026-07-28T07:00:00.000Z');
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const runtime = new GreenCoreRuntime({ engine, now });
  const server = createApiServer({ engine: runtime, logger: { error() {} } });
  const address = await listen(server);
  t.after(() => close(server));
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const emulator = new ControllerEmulator({ baseUrl, now });
  await emulator.register();
  await emulator.heartbeat();
  emulator.setSensor('soil_01', 25);
  await emulator.publishTelemetry();

  await post(baseUrl, '/mode', { mode: 'AUTO' });
  const evaluation = await post(baseUrl, '/evaluate', {});
  assert.equal(evaluation.commands.length, 1);
  assert.equal(evaluation.commands[0].controller_id, 'controller_primary');
  assert.equal(evaluation.commands[0].actuator_id, 'pump_01');

  const [ack] = await emulator.pollCommands();
  assert.equal(ack.status, 'EXECUTED');
  assert.equal(emulator.actuators.pump_01.state, 'ON');
  assert.equal(engine.actuators.get('pump_01').state, 'ON');
  assert.equal(engine.pendingCommands.size, 0);
});
