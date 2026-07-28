import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { GreenCoreRuntime } from '../src/runtime.js';
import { SimulationService } from '../src/simulation-service.js';
import { close, createApiServer, listen } from '../src/api.js';

async function fixture({ persistSimulations = async () => {} } = {}) {
  const now = () => new Date('2026-07-28T07:00:00.000Z');
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const runtime = new GreenCoreRuntime({ engine, now });
  const simulations = new SimulationService({ now });
  const server = createApiServer({
    engine: runtime,
    simulations,
    persistSimulations,
    allowedOrigin: 'https://demo.example',
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

  return { runtime, simulations, server, request };
}

async function post(request, path, body) {
  return request(path, { method: 'POST', body: JSON.stringify(body) });
}

test('catalog and CORS preflight are public', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  const catalog = await f.request('/simulations/catalog');
  assert.equal(catalog.response.status, 200);
  assert.equal(Boolean(catalog.body.scenarios.baseline_24h), true);
  assert.equal(catalog.response.headers.get('access-control-allow-origin'), 'https://demo.example');

  const preflight = await f.request('/simulations', { method: 'OPTIONS' });
  assert.equal(preflight.response.status, 204);
  assert.match(preflight.response.headers.get('access-control-allow-methods'), /POST/);
});

test('scenario report can be created, listed and fetched', async t => {
  let persisted = 0;
  const f = await fixture({ persistSimulations: async () => { persisted += 1; } });
  t.after(() => close(f.server));

  const created = await post(f.request, '/simulations', {
    kind: 'scenario',
    name: 'low_water_safety_2h'
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.passed, true);
  assert.equal(persisted, 1);

  const list = await f.request('/simulations?limit=1');
  assert.equal(list.body.reports.length, 1);
  assert.equal(list.body.reports[0].report_id, created.body.report_id);

  const fetched = await f.request(`/simulations/${created.body.report_id}`);
  assert.equal(fetched.response.status, 200);
  assert.equal(fetched.body.name, 'low_water_safety_2h');
});

test('comparison endpoint returns automatic and passive manual strategies', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  const result = await post(f.request, '/simulations/compare', { name: 'baseline_24h' });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.type, 'comparison');
  assert.equal(result.body.strategies.automatic.label, 'AUTO');
  assert.equal(result.body.strategies.manual_baseline.label, 'MANUAL_WITHOUT_OPERATOR_INTERVENTIONS');
  assert.match(result.body.interpretation.note, /not a model of a skilled human operator/i);
});

test('simulation persistence failure rolls report mutation back', async t => {
  const f = await fixture({
    persistSimulations: async () => { throw new Error('disk unavailable'); }
  });
  t.after(() => close(f.server));

  const result = await post(f.request, '/simulations', {
    kind: 'scenario',
    name: 'low_water_safety_2h'
  });
  assert.equal(result.response.status, 500);
  assert.equal(result.body.error, 'INTERNAL_ERROR');
  assert.equal(f.simulations.reports.size, 0);
});

test('unknown report and invalid list limit return controlled errors', async t => {
  const f = await fixture();
  t.after(() => close(f.server));

  const missing = await f.request('/simulations/missing');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error, 'NOT_FOUND');

  const invalid = await f.request('/simulations?limit=101');
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, 'INVALID_REQUEST');
});
