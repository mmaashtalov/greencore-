import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { GreenCoreRuntime } from '../src/runtime.js';
import { SimulationService } from '../src/simulation-service.js';
import { SqliteHistoryStore } from '../src/history-store.js';
import { HistoryAnalytics } from '../src/history-analytics.js';
import { ApiSecurity } from '../src/api-security.js';
import { close, createApiServer, listen } from '../src/api.js';

const KEYS = {
  admin: 'admin-secret',
  operator: 'operator-secret',
  primary: 'primary-secret',
  secondary: 'secondary-secret'
};

async function fixture({ publicReadOnly = false, publicSimulations = false } = {}) {
  const now = () => new Date('2026-07-28T14:00:00.000Z');
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const runtime = new GreenCoreRuntime({ engine, now });
  const simulations = new SimulationService({ now });
  const history = new SqliteHistoryStore({ filePath: ':memory:', now });
  const analytics = new HistoryAnalytics({ history });
  const security = new ApiSecurity({
    mode: 'required',
    adminKey: KEYS.admin,
    operatorKey: KEYS.operator,
    controllerKeys: {
      controller_primary: KEYS.primary,
      controller_secondary: KEYS.secondary
    },
    publicReadOnly,
    publicSimulations
  });
  const persist = async snapshot => {
    if (!history.captureRuntimeSnapshot(snapshot)) throw new Error(history.stats().last_error);
  };
  const persistSimulations = async snapshot => history.saveSimulationSnapshot(snapshot);
  const server = createApiServer({
    engine: runtime,
    simulations,
    history,
    analytics,
    security,
    persist,
    persistSimulations,
    allowedOrigin: 'https://demo.example',
    logger: { error() {} }
  });
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(path, { key, headers = {}, ...options } = {}) {
    const requestHeaders = { ...headers };
    if (key) requestHeaders.authorization = `Bearer ${key}`;
    if (options.body) requestHeaders['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers: requestHeaders });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  }

  return { history, server, request };
}

async function post(request, path, body, key) {
  return request(path, { method: 'POST', body: JSON.stringify(body), key });
}

test('health and simulation catalog remain public while protected state requires operator', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  const health = await f.request('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.security.mode, 'required');
  assert.equal(health.body.security.controller_key_count, 2);
  assert.equal(JSON.stringify(health.body).includes(KEYS.admin), false);

  const catalog = await f.request('/simulations/catalog');
  assert.equal(catalog.response.status, 200);

  const missing = await f.request('/state');
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body.error, 'UNAUTHORIZED');

  const controllerDenied = await f.request('/state', { key: KEYS.primary });
  assert.equal(controllerDenied.response.status, 403);
  assert.equal(controllerDenied.body.error, 'FORBIDDEN');

  const operator = await f.request('/state', { key: KEYS.operator });
  assert.equal(operator.response.status, 200);
});

test('controller token only accesses its own controller routes', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  const ownRegistration = await post(f.request, '/controllers/register', {
    controller_id: 'controller_primary',
    name: 'Authorized controller',
    firmware: 'secure-1.0.0',
    protocol_version: '1.0',
    devices: ['soil_01', 'air_01', 'water_01', 'pump_01', 'fan_01', 'vent_01']
  }, KEYS.primary);
  assert.equal(ownRegistration.response.status, 201);

  const foreignRegistration = await post(f.request, '/controllers/register', {
    controller_id: 'controller_primary',
    name: 'Wrong controller',
    firmware: 'secure-1.0.0',
    protocol_version: '1.0',
    devices: ['soil_01']
  }, KEYS.secondary);
  assert.equal(foreignRegistration.response.status, 403);

  const heartbeat = await post(
    f.request,
    '/controllers/controller_primary/heartbeat',
    { uptime_seconds: 10 },
    KEYS.primary
  );
  assert.equal(heartbeat.response.status, 200);

  const wrongController = await post(
    f.request,
    '/controllers/controller_primary/heartbeat',
    { uptime_seconds: 11 },
    KEYS.secondary
  );
  assert.equal(wrongController.response.status, 403);

  const operatorDenied = await f.request('/controllers/controller_primary/commands', { key: KEYS.operator });
  assert.equal(operatorDenied.response.status, 403);

  const adminAllowed = await f.request('/controllers/controller_primary/commands', { key: KEYS.admin });
  assert.equal(adminAllowed.response.status, 200);
});

test('public read-only and simulation flags are independent', async t => {
  const privateApi = await fixture();
  t.after(async () => {
    await close(privateApi.server);
    privateApi.history.close();
  });

  const analyticsDenied = await privateApi.request('/analytics/overview');
  assert.equal(analyticsDenied.response.status, 401);

  const analyticsAllowed = await privateApi.request('/analytics/overview', { key: KEYS.operator });
  assert.equal(analyticsAllowed.response.status, 200);

  const simulationDenied = await post(
    privateApi.request,
    '/simulations/compare',
    { name: 'baseline_24h' }
  );
  assert.equal(simulationDenied.response.status, 401);

  const simulationAllowed = await post(
    privateApi.request,
    '/simulations/compare',
    { name: 'baseline_24h' },
    KEYS.operator
  );
  assert.equal(simulationAllowed.response.status, 201);

  const publicApi = await fixture({ publicReadOnly: true, publicSimulations: true });
  t.after(async () => {
    await close(publicApi.server);
    publicApi.history.close();
  });

  const publicAnalytics = await publicApi.request('/analytics/overview');
  assert.equal(publicAnalytics.response.status, 200);
  const publicSimulation = await post(publicApi.request, '/simulations/compare', { name: 'baseline_24h' });
  assert.equal(publicSimulation.response.status, 201);

  const stillProtected = await post(publicApi.request, '/mode', { mode: 'AUTO' });
  assert.equal(stillProtected.response.status, 401);
});

test('CORS preflight advertises authorization headers without requiring a token', async t => {
  const f = await fixture();
  t.after(async () => {
    await close(f.server);
    f.history.close();
  });

  const preflight = await f.request('/mode', { method: 'OPTIONS' });
  assert.equal(preflight.response.status, 204);
  const headers = preflight.response.headers.get('access-control-allow-headers');
  assert.match(headers, /authorization/);
  assert.match(headers, /x-api-key/);
});
