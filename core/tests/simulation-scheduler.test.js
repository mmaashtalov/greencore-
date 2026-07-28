import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationScheduler } from '../src/simulation-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('scheduler bounds active work and queue and preserves FIFO order', async () => {
  const gate = deferred();
  const order = [];
  const scheduler = new SimulationScheduler({ maxConcurrent: 1, maxQueued: 1 });

  const first = scheduler.submit('first', async () => {
    order.push('first:start');
    await gate.promise;
    order.push('first:end');
    return 1;
  });
  await new Promise(resolve => setImmediate(resolve));
  const second = scheduler.submit('second', async () => {
    order.push('second');
    return 2;
  });
  await assert.rejects(
    scheduler.submit('third', async () => 3),
    error => error.statusCode === 503 && error.retryAfterSeconds === 2
  );

  gate.resolve();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
  assert.equal(scheduler.status().completed, 2);
  assert.equal(scheduler.status().rejected, 1);
});

test('closing scheduler rejects queued work but lets active task settle', async () => {
  const gate = deferred();
  const scheduler = new SimulationScheduler({ maxConcurrent: 1, maxQueued: 2 });
  const active = scheduler.submit('active', () => gate.promise);
  await new Promise(resolve => setImmediate(resolve));
  const queued = scheduler.submit('queued', async () => 2);
  scheduler.close();
  await assert.rejects(queued, /closed before task execution/);
  gate.resolve(1);
  assert.equal(await active, 1);
  assert.equal(scheduler.status().closed, true);
});
