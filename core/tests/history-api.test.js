import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { GreenCoreRuntime } from '../src/runtime.js';
import { SqliteHistoryStore } from '../src/history-store.js';
import { close, createApiServer, listen } from '../src/api.js';

async function fixture({ withHistory = true } = {}) {
  const now = () => new Date('2026-07-28T14:00:00.000Z');
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const runtime = new GreenCoreRuntime({ engine, now });
  const history = withHistory ? new SqliteHistoryStore({ filePath: ':memory:', now }) : null;
  const persist = async snapshot => {
    if (history && !history.captureRuntimeSnapshot(snapshot)) throw new Error(history.stats().last_error);
  };
  const server = createApiServer({
    engine: runtime,
    history,
    persist,
    logger: { error() {} }
  });
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  }

  return { runtime, history, server, request };
}

async function post(request, path, body) {
  return request(path, { method: 'POST', body: JSON.stringify(body) });
}

test('accepted controller telemetry is available from SQLite history API', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  const accepted = await post(f.request, '/controllers/controller_primary/telemetry', {
    device_id: 'soil_01',
    metric: 'soil_moisture',
    value: 41.2,
    unit: '%',
    quality: 'GOOD',
    timestamp: '2026-07-28T13:59:30.000Z'
  });
  assert.equal(accepted.response.status, 202);

  const result = await f.request('/history/telemetry?metric=soil_moisture&limit=10');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.samples.length, 1);
  assert.equal(result.body.samples[0].device_id, 'soil_01');
  assert.equal(result.body.samples[0].controller_id, 'controller_primary');
  assert.equal(result.body.samples[0].value, 41.2);

  const stats = await f.request('/history/stats');
  assert.equal(stats.response.status, 200);
  assert.equal(stats.body.healthy, true);
  assert.equal(stats.body.counts.telemetry_history, 1);
});

test('events and commands are exposed with bounded filters', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  await post(f.request, '/mode', { mode: 'AUTO' });
  const events = await f.request('/history/events?type=MODE_CHANGED');
  assert.equal(events.response.status, 200);
  assert.equal(events.body.events.length, 1);
  assert.deepEqual(events.body.events[0].details, { mode: 'AUTO' });

  const invalidLimit = await f.request('/history/commands?limit=5001');
  assert.equal(invalidLimit.response.status, 400);
  assert.equal(invalidLimit.body.error, 'INVALID_REQUEST');

  const invalidDate = await f.request('/history/alerts?from=invalid');
  assert.equal(invalidDate.response.status, 400);
  assert.match(invalidDate.body.message, /valid date/);
});

test('history routes report capability absence explicitly', async t => {
  const f = await fixture({ withHistory: false });
  t.after(() => close(f.server));

  const response = await f.request('/history/stats');
  assert.equal(response.response.status, 501);
  assert.equal(response.body.error, 'INTERNAL_ERROR');
  assert.match(response.body.message, /not enabled/i);
});
