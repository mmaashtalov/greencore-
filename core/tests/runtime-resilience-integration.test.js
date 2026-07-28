import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { GreenCoreRuntime } from '../src/runtime.js';
import { SqliteHistoryStore } from '../src/history-store.js';
import { HistoryAnalytics } from '../src/history-analytics.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { SimulationScheduler } from '../src/simulation-scheduler.js';
import { LiveEventHub } from '../src/live-event-hub.js';
import { close, createApiServer, listen } from '../src/api.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function policies(overrides = {}) {
  return {
    read: { limit: 100, windowMs: 60000 },
    operator: { limit: 100, windowMs: 60000 },
    controller: { limit: 100, windowMs: 60000 },
    simulation: { limit: 100, windowMs: 60000 },
    stream: { limit: 100, windowMs: 60000 },
    ...overrides
  };
}

async function fixture({
  simulations = null,
  rateLimiter = new RateLimiter({ policies: policies() }),
  simulationScheduler = new SimulationScheduler(),
  live = new LiveEventHub({ heartbeatIntervalMs: 60000 })
} = {}) {
  const now = () => new Date('2026-07-28T14:00:00.000Z');
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const runtime = new GreenCoreRuntime({ engine, now });
  const history = new SqliteHistoryStore({ filePath: ':memory:', now });
  const analytics = new HistoryAnalytics({ history });
  const persist = async snapshot => {
    if (!history.captureRuntimeSnapshot(snapshot)) throw new Error(history.stats().last_error);
  };
  const server = createApiServer({
    engine: runtime,
    simulations,
    history,
    analytics,
    rateLimiter,
    simulationScheduler,
    live,
    persist,
    persistSimulations: async () => {},
    logger: { error() {} }
  });
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, options);
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  }

  async function cleanup() {
    simulationScheduler.close();
    live.close();
    await close(server);
    history.close();
  }

  return { baseUrl, history, live, rateLimiter, request, cleanup };
}

test('API applies per-client rate limits with standard response headers', async t => {
  const f = await fixture({
    rateLimiter: new RateLimiter({ policies: policies({ read: { limit: 1, windowMs: 60000 } }), now: () => 1000 })
  });
  t.after(f.cleanup);

  const first = await f.request('/analytics/catalog');
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get('ratelimit-limit'), '1');
  assert.equal(first.response.headers.get('ratelimit-remaining'), '0');

  const second = await f.request('/analytics/catalog');
  assert.equal(second.response.status, 429);
  assert.equal(second.body.error, 'RATE_LIMITED');
  assert.equal(second.response.headers.get('retry-after'), '60');
  assert.equal(second.response.headers.get('ratelimit-remaining'), '0');
});

test('simulation scheduler rejects excess concurrent public work with 503', async t => {
  const gate = deferred();
  const started = deferred();
  const reports = [];
  const simulations = {
    catalog: () => ({ scenarios: {} }),
    list: () => [],
    get: id => reports.find(report => report.report_id === id),
    snapshot: () => ({ state_version: 1, max_reports: 10, reports: structuredClone(reports) }),
    restore: snapshot => { reports.splice(0, reports.length, ...structuredClone(snapshot.reports)); },
    run: async body => {
      started.resolve();
      await gate.promise;
      const report = {
        report_id: 'sim_slow',
        created_at: '2026-07-28T14:00:00.000Z',
        type: 'simulation',
        kind: 'scenario',
        name: body.name,
        passed: true
      };
      reports.push(report);
      return report;
    }
  };
  const scheduler = new SimulationScheduler({ maxConcurrent: 1, maxQueued: 0, retryAfterSeconds: 3 });
  const f = await fixture({ simulations, simulationScheduler: scheduler });
  t.after(f.cleanup);

  const firstPromise = f.request('/simulations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'slow' })
  });
  await started.promise;

  const overloaded = await f.request('/simulations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'second' })
  });
  assert.equal(overloaded.response.status, 503);
  assert.equal(overloaded.body.error, 'OVERLOADED');
  assert.equal(overloaded.response.headers.get('retry-after'), '3');

  gate.resolve();
  const first = await firstPromise;
  assert.equal(first.response.status, 201);
  assert.equal(scheduler.status().rejected, 1);
});

test('live endpoint opens SSE stream, sends snapshot and broadcasts events', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const controller = new AbortController();
  const response = await fetch(`${f.baseUrl}/live`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  async function readUntil(pattern) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), 1000))
      ]);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
      if (pattern.test(text)) return;
    }
    assert.fail(`Pattern ${pattern} was not found in SSE stream: ${text}`);
  }

  await readUntil(/event: snapshot/);
  f.live.publish('telemetry', { device_id: 'soil_01', value: 44 });
  await readUntil(/event: telemetry/);
  assert.match(text, /"device_id":"soil_01"/);

  controller.abort();
  await reader.cancel().catch(() => {});
});
