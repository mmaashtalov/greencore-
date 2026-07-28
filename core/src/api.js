import http from 'node:http';
import { ApiSecurity } from './api-security.js';

function jsonHeaders(allowedOrigin) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-api-key',
    vary: 'origin'
  };
}

function sendJson(response, statusCode, payload, allowedOrigin) {
  response.writeHead(statusCode, jsonHeaders(allowedOrigin));
  response.end(JSON.stringify(payload));
}

function sendEmpty(response, statusCode, allowedOrigin) {
  response.writeHead(statusCode, jsonHeaders(allowedOrigin));
  response.end();
}

function badRequest(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJson(request, { maxBytes = 64 * 1024 } = {}) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw badRequest('Request body too large', 413);
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  return body;
}

function boundedLimit(requestUrl, { defaultValue, maximum }) {
  const raw = requestUrl.searchParams.get('limit');
  if (raw === null) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw badRequest(`limit must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function queryFilters(requestUrl, names, { defaultLimit = 200, maximumLimit = 5000, includeLimit = true } = {}) {
  const filters = {};
  if (includeLimit) {
    filters.limit = boundedLimit(requestUrl, { defaultValue: defaultLimit, maximum: maximumLimit });
  }
  for (const name of names) {
    const value = requestUrl.searchParams.get(name);
    if (value !== null && value !== '') filters[name] = value;
  }
  return filters;
}

function controllerRoute(path) {
  const match = path.match(/^\/controllers\/([^/]+)\/(heartbeat|commands|configuration|telemetry|command-acks)$/);
  if (!match) return null;
  return { controllerId: decodeURIComponent(match[1]), action: match[2] };
}

function simulationReportRoute(path) {
  const match = path.match(/^\/simulations\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function requireCapability(target, method, message) {
  if (typeof target?.[method] !== 'function') throw badRequest(message, 501);
}

async function persistMutation(engine, persist, before) {
  try {
    await persist(engine.snapshot());
  } catch (cause) {
    engine.restore(before, { logEvent: false });
    const error = new Error('State persistence failed');
    error.statusCode = 500;
    error.cause = cause;
    throw error;
  }
}

async function persistSimulationMutation(simulations, persistSimulations, before) {
  try {
    await persistSimulations(simulations.snapshot());
  } catch (cause) {
    simulations.restore(before);
    const error = new Error('Simulation persistence failed');
    error.statusCode = 500;
    error.cause = cause;
    throw error;
  }
}

function errorCode(statusCode) {
  if (statusCode >= 500) return 'INTERNAL_ERROR';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 401) return 'UNAUTHORIZED';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 429) return 'RATE_LIMITED';
  return 'INVALID_REQUEST';
}

export function createApiServer({
  engine,
  simulations = null,
  history = null,
  analytics = null,
  security = new ApiSecurity(),
  logger = console,
  persist = async () => {},
  persistSimulations = async () => {},
  allowedOrigin = '*'
}) {
  if (!engine) throw new Error('engine is required');
  if (typeof persist !== 'function') throw new Error('persist must be a function');
  if (typeof persistSimulations !== 'function') throw new Error('persistSimulations must be a function');
  if (!security || typeof security.requireOperator !== 'function') throw new Error('security is invalid');
  if (typeof allowedOrigin !== 'string' || allowedOrigin.length === 0) {
    throw new Error('allowedOrigin must be a non-empty string');
  }

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const path = requestUrl.pathname;
    const method = request.method ?? 'GET';
    const send = (statusCode, payload) => sendJson(response, statusCode, payload, allowedOrigin);

    try {
      if (method === 'OPTIONS') return sendEmpty(response, 204, allowedOrigin);

      if (method === 'GET' && path === '/health') {
        const historyStatus = typeof history?.stats === 'function' ? history.stats() : null;
        return send(historyStatus?.healthy === false ? 503 : 200, {
          status: historyStatus?.healthy === false ? 'degraded' : 'ok',
          service: 'greencore-core',
          version: '0.11.0',
          simulations_enabled: Boolean(simulations),
          analytics_enabled: Boolean(analytics),
          security: security.status(),
          history: historyStatus
        });
      }

      if (method === 'GET' && path === '/state') {
        security.requireOperator(request);
        return send(200, engine.snapshot());
      }

      if (method === 'GET' && path === '/alerts') {
        security.requireOperator(request);
        return send(200, { alerts: [...engine.alerts] });
      }

      if (method === 'GET' && path === '/events') {
        security.requireOperator(request);
        const limit = boundedLimit(requestUrl, { defaultValue: 100, maximum: 1000 });
        return send(200, { events: engine.events.slice(-limit) });
      }

      if (method === 'GET' && path === '/history/stats') {
        security.requireOperator(request);
        requireCapability(history, 'stats', 'History database is not enabled');
        return send(200, history.stats());
      }

      if (method === 'GET' && path === '/history/telemetry') {
        security.requireOperator(request);
        requireCapability(history, 'telemetry', 'History database is not enabled');
        const filters = queryFilters(requestUrl, ['metric', 'device_id', 'controller_id', 'quality', 'from', 'to']);
        return send(200, { samples: history.telemetry(filters) });
      }

      if (method === 'GET' && path === '/history/events') {
        security.requireOperator(request);
        requireCapability(history, 'events', 'History database is not enabled');
        const filters = queryFilters(requestUrl, ['type', 'from', 'to']);
        return send(200, { events: history.events(filters) });
      }

      if (method === 'GET' && path === '/history/alerts') {
        security.requireOperator(request);
        requireCapability(history, 'alerts', 'History database is not enabled');
        const filters = queryFilters(requestUrl, ['type', 'from', 'to']);
        return send(200, { alerts: history.alerts(filters) });
      }

      if (method === 'GET' && path === '/history/commands') {
        security.requireOperator(request);
        requireCapability(history, 'commands', 'History database is not enabled');
        const filters = queryFilters(requestUrl, ['status', 'actuator_id', 'controller_id', 'action', 'from', 'to']);
        return send(200, { commands: history.commands(filters) });
      }

      if (method === 'GET' && path === '/analytics/catalog') {
        security.requireRead(request);
        requireCapability(analytics, 'catalog', 'Historical analytics is not enabled');
        return send(200, analytics.catalog());
      }

      if (method === 'GET' && path === '/analytics/overview') {
        security.requireRead(request);
        requireCapability(analytics, 'overview', 'Historical analytics is not enabled');
        const filters = queryFilters(requestUrl, ['from', 'to', 'quality'], { includeLimit: false });
        return send(200, analytics.overview(filters));
      }

      if (method === 'GET' && path === '/analytics/telemetry') {
        security.requireRead(request);
        requireCapability(analytics, 'telemetrySeries', 'Historical analytics is not enabled');
        const filters = queryFilters(
          requestUrl,
          ['metric', 'bucket', 'device_id', 'controller_id', 'quality', 'from', 'to'],
          { defaultLimit: 500, maximumLimit: 5000 }
        );
        return send(200, analytics.telemetrySeries(filters));
      }

      if (method === 'GET' && path === '/analytics/commands') {
        security.requireRead(request);
        requireCapability(analytics, 'commandSummary', 'Historical analytics is not enabled');
        const filters = queryFilters(
          requestUrl,
          ['actuator_id', 'controller_id', 'action', 'mode', 'from', 'to'],
          { includeLimit: false }
        );
        return send(200, analytics.commandSummary(filters));
      }

      if (method === 'GET' && path === '/analytics/alerts') {
        security.requireRead(request);
        requireCapability(analytics, 'alertSummary', 'Historical analytics is not enabled');
        const filters = queryFilters(requestUrl, ['from', 'to'], { includeLimit: false });
        return send(200, analytics.alertSummary(filters));
      }

      if (method === 'GET' && path === '/analytics/simulations') {
        security.requireRead(request);
        requireCapability(analytics, 'simulationSummary', 'Historical analytics is not enabled');
        const filters = queryFilters(requestUrl, ['name', 'from', 'to'], { includeLimit: false });
        return send(200, { simulations: analytics.simulationSummary(filters) });
      }

      if (method === 'GET' && path === '/simulations/catalog') {
        requireCapability(simulations, 'catalog', 'Simulation service is not enabled');
        return send(200, simulations.catalog());
      }

      if (method === 'GET' && path === '/simulations') {
        security.requireRead(request);
        requireCapability(simulations, 'list', 'Simulation service is not enabled');
        const limit = boundedLimit(requestUrl, { defaultValue: 20, maximum: 100 });
        return send(200, { reports: simulations.list({ limit }) });
      }

      if (method === 'POST' && path === '/simulations') {
        security.requireSimulation(request);
        requireCapability(simulations, 'run', 'Simulation service is not enabled');
        const body = requireObject(await readJson(request));
        const before = simulations.snapshot();
        const report = simulations.run(body);
        await persistSimulationMutation(simulations, persistSimulations, before);
        return send(201, report);
      }

      if (method === 'POST' && path === '/simulations/compare') {
        security.requireSimulation(request);
        requireCapability(simulations, 'compare', 'Simulation service is not enabled');
        const body = requireObject(await readJson(request));
        const before = simulations.snapshot();
        const report = simulations.compare(body);
        await persistSimulationMutation(simulations, persistSimulations, before);
        return send(201, report);
      }

      const reportId = simulationReportRoute(path);
      if (reportId && method === 'GET') {
        security.requireRead(request);
        requireCapability(simulations, 'get', 'Simulation service is not enabled');
        try {
          return send(200, simulations.get(reportId));
        } catch (error) {
          if (error.message.startsWith('Unknown simulation report:')) {
            throw badRequest(error.message, 404);
          }
          throw error;
        }
      }

      if (method === 'GET' && path === '/controllers') {
        security.requireOperator(request);
        requireCapability(engine, 'listControllers', 'Controller contract is not enabled');
        return send(200, { controllers: engine.listControllers() });
      }

      if (method === 'POST' && path === '/controllers/register') {
        requireCapability(engine, 'registerController', 'Controller contract is not enabled');
        const body = requireObject(await readJson(request));
        security.requireController(request, body.controller_id);
        const before = engine.snapshot();
        const controller = engine.registerController(body);
        await persistMutation(engine, persist, before);
        return send(201, {
          controller,
          configuration: engine.controllerConfiguration(controller.controller_id)
        });
      }

      const route = controllerRoute(path);
      if (route && method === 'POST' && route.action === 'heartbeat') {
        security.requireController(request, route.controllerId);
        requireCapability(engine, 'heartbeat', 'Controller contract is not enabled');
        const body = requireObject(await readJson(request));
        const before = engine.snapshot();
        const controller = engine.heartbeat(route.controllerId, body);
        await persistMutation(engine, persist, before);
        return send(200, { controller });
      }

      if (route && method === 'GET' && route.action === 'configuration') {
        security.requireController(request, route.controllerId);
        requireCapability(engine, 'controllerConfiguration', 'Controller contract is not enabled');
        return send(200, engine.controllerConfiguration(route.controllerId));
      }

      if (route && method === 'GET' && route.action === 'commands') {
        security.requireController(request, route.controllerId);
        requireCapability(engine, 'controllerCommands', 'Controller contract is not enabled');
        const before = engine.snapshot();
        const commands = engine.controllerCommands(route.controllerId);
        await persistMutation(engine, persist, before);
        return send(200, { commands });
      }

      if (route && method === 'POST' && route.action === 'telemetry') {
        security.requireController(request, route.controllerId);
        requireCapability(engine, 'ingestControllerTelemetry', 'Controller contract is not enabled');
        const body = requireObject(await readJson(request));
        const samples = Array.isArray(body.samples) ? body.samples : [body];
        if (samples.length === 0) throw badRequest('At least one telemetry sample is required');
        if (samples.length > 100) throw badRequest('Maximum 100 telemetry samples per request', 413);
        const before = engine.snapshot();
        const accepted = engine.ingestControllerTelemetry(route.controllerId, samples);
        await persistMutation(engine, persist, before);
        return send(202, { accepted });
      }

      if (route && method === 'POST' && route.action === 'command-acks') {
        security.requireController(request, route.controllerId);
        requireCapability(engine, 'acknowledge', 'Controller contract is not enabled');
        const body = requireObject(await readJson(request));
        if (body.controller_id && body.controller_id !== route.controllerId) {
          throw badRequest('controller_id does not match request path');
        }
        const before = engine.snapshot();
        const command = engine.acknowledge({ ...body, controller_id: route.controllerId });
        await persistMutation(engine, persist, before);
        return send(200, { acknowledged: true, command });
      }

      if (method === 'POST' && path === '/telemetry') {
        security.requireOperator(request);
        const body = requireObject(await readJson(request));
        const samples = Array.isArray(body.samples) ? body.samples : [body];
        if (samples.length === 0) throw badRequest('At least one telemetry sample is required');
        if (samples.length > 100) throw badRequest('Maximum 100 telemetry samples per request', 413);

        const validated = samples.map(sample => engine.validateTelemetry(sample));
        const before = engine.snapshot();
        const accepted = validated.map(sample => engine.ingest(sample));
        await persistMutation(engine, persist, before);
        return send(202, { accepted });
      }

      if (method === 'POST' && path === '/mode') {
        security.requireOperator(request);
        const body = requireObject(await readJson(request));
        const before = engine.snapshot();
        engine.setMode(body.mode);
        await persistMutation(engine, persist, before);
        return send(200, { configured_mode: engine.mode });
      }

      if (method === 'POST' && path === '/connectivity') {
        security.requireOperator(request);
        const body = requireObject(await readJson(request));
        if (typeof body.connected !== 'boolean') throw badRequest('connected must be boolean');
        const before = engine.snapshot();
        engine.setConnectivity(body.connected);
        await persistMutation(engine, persist, before);
        return send(200, { connected: engine.connected });
      }

      if (method === 'POST' && path === '/manual-commands') {
        security.requireOperator(request);
        const body = requireObject(await readJson(request));
        if (typeof body.actuator_id !== 'string' || typeof body.action !== 'string') {
          throw badRequest('actuator_id and action are required strings');
        }
        const before = engine.snapshot();
        engine.requestManual(body.actuator_id, body.action, body.reason);
        await persistMutation(engine, persist, before);
        return send(202, { queued: true });
      }

      if (method === 'POST' && path === '/command-acks') {
        security.requireOperator(request);
        const body = requireObject(await readJson(request));
        const before = engine.snapshot();
        const command = engine.acknowledge(body);
        await persistMutation(engine, persist, before);
        return send(200, { acknowledged: true, command });
      }

      if (method === 'POST' && path === '/evaluate') {
        security.requireOperator(request);
        const before = engine.snapshot();
        const commands = engine.evaluate();
        await persistMutation(engine, persist, before);
        return send(200, {
          commands,
          effective_state: engine.snapshot()
        });
      }

      return send(404, {
        error: 'NOT_FOUND',
        message: `No route for ${method} ${path}`
      });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 400;
      if (statusCode >= 500) logger.error?.(error);
      return send(statusCode, {
        error: errorCode(statusCode),
        message: error.message
      });
    }
  });
}

export async function listen(server, { host = '127.0.0.1', port = 0 } = {}) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server.address();
}

export async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
