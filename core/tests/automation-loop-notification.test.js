import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationLoop } from '../src/automation-loop.js';

function runtime() {
  let state = { cycles: 0 };
  return {
    evaluate() { state.cycles += 1; return [{ command_id: `cmd_${state.cycles}` }]; },
    snapshot() { return structuredClone(state); },
    restore(snapshot) { state = structuredClone(snapshot); }
  };
}

test('automation loop emits non-critical cycle notifications after persistence', async () => {
  const notifications = [];
  const loop = new AutomationLoop({
    runtime: runtime(),
    persist: async () => notifications.push('persisted'),
    onCycle: async payload => notifications.push(payload)
  });
  const result = await loop.runCycle();
  assert.equal(result.commands.length, 1);
  assert.equal(notifications[0], 'persisted');
  assert.equal(notifications[1].snapshot.cycles, 1);
  assert.equal(notifications[1].status.cycles, 1);
});

test('notification failure does not roll back a successful control cycle', async () => {
  const errors = [];
  const loop = new AutomationLoop({
    runtime: runtime(),
    persist: async () => {},
    onCycle: async () => { throw new Error('stream unavailable'); },
    logger: { error: (...args) => errors.push(args) }
  });
  const result = await loop.runCycle();
  assert.equal(result.commands.length, 1);
  assert.equal(loop.status().failed_cycles, 0);
  assert.equal(loop.status().cycles, 1);
  assert.equal(errors.length, 1);
});
