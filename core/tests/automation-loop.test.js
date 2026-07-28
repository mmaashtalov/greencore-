import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationLoop } from '../src/automation-loop.js';

class FakeRuntime {
  constructor() {
    this.value = 0;
    this.restores = 0;
  }
  evaluate() {
    this.value += 1;
    return [{ command_id: `cmd_${this.value}` }];
  }
  snapshot() { return { value: this.value }; }
  restore(snapshot) { this.value = snapshot.value; this.restores += 1; }
}

test('cycle evaluates and persists state', async () => {
  const runtime = new FakeRuntime();
  const saved = [];
  const loop = new AutomationLoop({ runtime, persist: async state => saved.push(state), intervalMs: 1000 });
  const result = await loop.runCycle();
  assert.equal(result.commands.length, 1);
  assert.deepEqual(saved, [{ value: 1 }]);
  assert.equal(loop.status().cycles, 1);
  assert.equal(loop.status().commands_created, 1);
});

test('persistence failure rolls runtime back', async () => {
  const runtime = new FakeRuntime();
  const loop = new AutomationLoop({
    runtime,
    persist: async () => { throw new Error('disk unavailable'); },
    intervalMs: 1000
  });
  await assert.rejects(() => loop.runCycle(), /disk unavailable/);
  assert.equal(runtime.value, 0);
  assert.equal(runtime.restores, 1);
  assert.equal(loop.status().failed_cycles, 1);
});

test('overlapping cycle is skipped', async () => {
  const runtime = new FakeRuntime();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const loop = new AutomationLoop({
    runtime,
    persist: async () => blocked,
    intervalMs: 1000
  });
  const first = loop.runCycle();
  const second = await loop.runCycle();
  assert.equal(second.skipped, true);
  assert.equal(loop.status().skipped_cycles, 1);
  release();
  await first;
});

test('start and stop manage one timer and wait for current cycle', async () => {
  const runtime = new FakeRuntime();
  const timers = [];
  const cleared = [];
  const loop = new AutomationLoop({
    runtime,
    intervalMs: 1000,
    setIntervalImpl: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearIntervalImpl: timer => cleared.push(timer)
  });
  assert.equal(loop.start({ immediate: false }), true);
  assert.equal(loop.start({ immediate: false }), false);
  assert.equal(timers.length, 1);
  assert.equal(loop.status().running, true);
  await loop.stop();
  assert.deepEqual(cleared, timers);
  assert.equal(loop.status().running, false);
});
