import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { GreenCoreRuntime } from '../src/runtime.js';
import { SqliteHistoryStore } from '../src/history-store.js';
import { HistoryAnalytics } from '../src/history-analytics.js';
import { close, createApiServer, listen } from '../src/api.js';

async function fixture() {
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
    history,
    analytics,
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

  return { history, server, request };
}

async function post(request, path, body) {
  return request(path, { method: 'POST', body: JSON.stringify(body) });
}

test('analytics catalog and health advertise server-side aggregation', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  const catalog = await f.request('/analytics/catalog');
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.body.telemetry_buckets['15m'], 900);

  const health = await f.request('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.version, '0.12.0');
  assert.equal(health.body.analytics_enabled, true);
  assert.equal(health.body.simulation_queue.direct_mode, true);
});

test('telemetry aggregation endpoint returns chart-ready buckets', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  for (const [timestamp, value] of [
    ['2026-07-28T13:00:00.000Z', 39],
    ['2026-07-28T13:04:00.000Z', 43],
    ['2026-07-28T13:06:00.000Z', 47]
  ]) {
    const response = await post(f.request, '/controllers/controller_primary/telemetry', {
      device_id: 'soil_01', metric: 'soil_moisture', value, unit: '%', quality: 'GOOD', timestamp
    });
    assert.equal(response.response.status, 202);
  }

  const series = await f.request('/analytics/telemetry?metric=soil_moisture&bucket=5m');
  assert.equal(series.response.status, 200);
  assert.equal(series.body.points.length, 2);
  assert.equal(series.body.points[0].avg_value, 41);
  assert.equal(series.body.points[1].avg_value, 47);

  const missing = await f.request('/analytics/telemetry?bucket=1h');
  assert.equal(missing.response.status, 400);
  assert.match(missing.body.message, /metric is required/);

  const invalid = await f.request('/analytics/telemetry?metric=soil_moisture&bucket=2h');
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.body.message, /Unsupported bucket/);
});

test('overview, command and alert analytics endpoints are available', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  await post(f.request, '/mode', { mode: 'AUTO' });
  const overview = await f.request('/analytics/overview');
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body.storage.healthy, true);
  assert.equal(typeof overview.body.commands.total, 'number');
  assert.equal(Array.isArray(overview.body.alerts.types), true);

  const commands = await f.request('/analytics/commands?mode=AUTO');
  assert.equal(commands.response.status, 200);
  assert.equal(typeof commands.body.success_rate_percent === 'number' || commands.body.success_rate_percent === null, true);

  const alerts = await f.request('/analytics/alerts?from=2026-07-28T00:00:00Z');
  assert.equal(alerts.response.status, 200);
  assert.equal(Array.isArray(alerts.body.types), true);
});
