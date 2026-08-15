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

test('policy journal exposes decisions, evidence and SQLite history', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  await post(f.request, '/mode', { mode: 'AUTO' });
  for (const sample of [
    { device_id: 'soil_01', metric: 'soil_moisture', value: 40, unit: '%', quality: 'GOOD', timestamp: '2026-07-28T13:59:30.000Z' },
    { device_id: 'air_01', metric: 'air_temperature', value: 30, unit: '°C', quality: 'GOOD', timestamp: '2026-07-28T13:59:30.000Z' },
    { device_id: 'water_01', metric: 'water_level', value: 50, unit: '%', quality: 'GOOD', timestamp: '2026-07-28T13:59:30.000Z' }
  ]) {
    const accepted = await post(f.request, '/controllers/controller_primary/telemetry', sample);
    assert.equal(accepted.response.status, 202);
  }

  const evaluated = await post(f.request, '/evaluate', {});
  assert.equal(evaluated.response.status, 200);
  assert.equal(evaluated.body.commands.length, 2);

  const journal = await f.request('/policy/decisions?limit=10');
  assert.equal(journal.response.status, 200);
  assert.equal(journal.body.decisions.length, 2);
  assert.ok(journal.body.decisions.every(decision => decision.effect === 'ALLOW'));
  assert.ok(journal.body.decisions.every(decision => decision.decision_id.startsWith('pdec_')));
  assert.ok(journal.body.decisions.some(decision => decision.context.telemetry.soil_moisture.value === 40));

  const history = await f.request('/history/policy-decisions?effect=ALLOW&limit=10');
  assert.equal(history.response.status, 200);
  assert.equal(history.body.decisions.length, 2);
  assert.deepEqual(
    new Set(history.body.decisions.map(decision => decision.decision_id)),
    new Set(journal.body.decisions.map(decision => decision.decision_id))
  );

  const stats = await f.request('/history/stats');
  assert.equal(stats.body.schema_version, 2);
  assert.equal(stats.body.counts.policy_decision_history, 2);
});

test('denied policy decision is journaled with evidence and a specialized alert', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  await post(f.request, '/mode', { mode: 'MANUAL' });
  for (const sample of [
    { device_id: 'soil_01', metric: 'soil_moisture', value: 30, unit: '%', quality: 'GOOD', timestamp: '2026-07-28T13:59:30.000Z' },
    { device_id: 'air_01', metric: 'air_temperature', value: 22, unit: '°C', quality: 'GOOD', timestamp: '2026-07-28T13:59:30.000Z' },
    { device_id: 'water_01', metric: 'water_level', value: 10, unit: '%', quality: 'GOOD', timestamp: '2026-07-28T13:59:30.000Z' }
  ]) {
    const accepted = await post(f.request, '/controllers/controller_primary/telemetry', sample);
    assert.equal(accepted.response.status, 202);
  }

  const queued = await post(f.request, '/manual-commands', {
    actuator_id: 'pump_01',
    action: 'ON',
    reason: 'journal deny test'
  });
  assert.equal(queued.response.status, 202);
  const evaluated = await post(f.request, '/evaluate', {});
  assert.equal(evaluated.response.status, 200);
  assert.equal(evaluated.body.commands.length, 0);

  const journal = await f.request('/policy/decisions?limit=10');
  assert.equal(journal.response.status, 200);
  assert.equal(journal.body.decisions.length, 1);
  assert.equal(journal.body.decisions[0].effect, 'DENY');
  assert.equal(journal.body.decisions[0].policy_id, 'deny-pump-on-low-water');
  assert.equal(journal.body.decisions[0].evidence.some(item => item.fact === 'telemetry.water_level.value' && item.observed === 10), true);

  const alerts = await f.request('/alerts');
  assert.equal(alerts.body.alerts.some(alert => alert.type === 'POLICY_DENIED_PUMP_LOW_WATER'), true);
  const history = await f.request('/history/policy-decisions?effect=DENY&policy_id=deny-pump-on-low-water');
  assert.equal(history.body.decisions.length, 1);
  assert.equal(history.body.decisions[0].decision_id, journal.body.decisions[0].decision_id);
});

test('history routes report capability absence explicitly', async t => {
  const f = await fixture({ withHistory: false });
  t.after(() => close(f.server));

  const response = await f.request('/history/stats');
  assert.equal(response.response.status, 501);
  assert.equal(response.body.error, 'INTERNAL_ERROR');
  assert.match(response.body.message, /not enabled/i);
});
