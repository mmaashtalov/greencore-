import http from 'node:http';
import { ApiSecurity } from './api-security.js';

function jsonHeaders(allowedOrigin) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-api-key, last-event-id',
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
  if (includeLimit) filters.limit = boundedLimit(requestUrl, { defaultValue: defaultLimit, maximum: maximumLimit });
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
  if (statusCode === 503) return 'OVERLOADED';
  if (statusCode >= 500) return 'INTERNAL_ERROR';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 401) return 'UNAUTHORIZED';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 429) return 'RATE_LIMITED';
  return 'INVALID_REQUEST';
}

function setRateLimitHeaders(response, result) {
  if (!result) return;
  response.setHeader('ratelimit-limit', String(result.limit));
  response.setHeader('ratelimit-remaining', String(result.remaining));
  response.setHeader('ratelimit-reset', result.reset_at);
}

function compactState(engine) {
  const state = engine.snapshot();
  return {
    generated_at: new Date().toISOString(),
    mode: state.mode,
    connected: state.connected,
    telemetry: state.telemetry,
    actuators: state.actuators,
    controllers: state.controllers,
    pending_commands: state.pending_commands,
    alerts: (state.alerts ?? []).slice(-20),
    policy_contract: state.policy_contract,
    policy_decisions: (state.policy_decisions ?? []).slice(-20)
  };
}

function publishLive(live, event, payload) {
  if (typeof live?.publish !== 'function') return null;
  return live.publish(event, payload);
}

export function createApiServer({
  engine,
  simulations = null,
  history = null,
  analytics = null,
  live = null,
  rateLimiter = null,
  simulationScheduler = null,
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
  if (typeof allowedOrigin !== 'string' || allowedOrigin.length === 0) throw new Error('allowedOrigin must be a non-empty string');
  const scheduler = simulationScheduler ?? {
    submit: async (_label, task) => task(),
    status: () => ({ active: 0, queued: 0, max_concurrent: 1, max_queued: 0, direct_mode: true })
  };

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const path = requestUrl.pathname;
    const method = request.method ?? 'GET';
    const send = (statusCode, payload) => sendJson(response, statusCode, payload, allowedOrigin);

    const limit = (policy, principal = { role: 'public' }) => {
      if (!rateLimiter) return null;
      const identity = security.clientIdentity(request, principal);
      const result = rateLimiter.enforce(policy, identity);
      setRateLimitHeaders(response, result);
      return result;
    };
    const guard = (access, policy, controllerId = null) => {
      let principal;
      if (access === 'read') principal = security.requireRead(request);
      else if (access === 'simulation') principal = security.requireSimulation(request);
      else if (access === 'operator') principal = security.requireOperator(request);
      else if (access === 'controller') principal = security.requireController(request, controllerId);
      else principal = { role: 'public' };
      limit(policy, principal);
      return principal;
    };

    try {
      if (method === 'OPTIONS') return sendEmpty(response, 204, allowedOrigin);

      if (method === 'GET' && path === '/health') {
        const historyStatus = typeof history?.stats === 'function' ? history.stats() : null;
        return send(historyStatus?.healthy === false ? 503 : 200, {
          status: historyStatus?.healthy === false ? 'degraded' : 'ok',
          service: 'greencore-core',
          version: '0.12.0',
          simulations_enabled: Boolean(simulations),
          analytics_enabled: Boolean(analytics),
          security: security.status(),
          rate_limits: rateLimiter?.status?.() ?? null,
          simulation_queue: scheduler.status(),
          live_stream: live?.status?.() ?? null,
          history: historyStatus
        });
      }

      if (method === 'GET' && path === '/live/status') {
        guard('read', 'read');
        requireCapability(live, 'status', 'Live stream is not enabled');
        return send(200, live.status());
      }

      if (method === 'GET' && path === '/live') {
        guard('read', 'stream');
        requireCapability(live, 'connect', 'Live stream is not enabled');
        live.connect(request, response, {
          allowedOrigin,
          initialEvent: {
            event: 'snapshot',
            data: { state: compactState(engine), simulation_queue: scheduler.status() }
          }
        });
        return;
      }

      if (method === 'GET' && path === '/state') {
        guard('operator', 'operator');
        return send(200, engine.snapshot());
      }

      if (method === 'GET' && path === '/policy/catalog') {
        guard('read', 'read');
        requireCapability(engine, 'policyCatalog', 'Policy engine is not enabled');
        return send(200, engine.policyCatalog());
      }

      if (method === 'GET' && path === '/policy/decisions') {
        guard('operator', 'operator');
        requireCapability(engine, 'policyDecisionHistory', 'Policy decision journal is not enabled');
        const requestedLimit = boundedLimit(requestUrl, { defaultValue: 100, maximum: 1000 });
        return send(200, { decisions: engine.policyDecisionHistory(requestedLimit) });
      }

      if (method === 'GET' && path === '/alerts') {
        guard('operator', 'operator');
        return send(200, { alerts: [...engine.alerts] });
      }

      if (method === 'GET' && path === '/events') {
        guard('operator', 'operator');
        const requestedLimit = boundedLimit(requestUrl, { defaultValue: 100, maximum: 1000 });
        return send(200, { events: engine.events.slice(-requestedLimit) });
      }

      if (method === 'GET' && path === '/history/stats') {
        guard('operator', 'operator');
        requireCapability(history, 'stats', 'History database is not enabled');
        return send(200, history.stats());
      }

      if (method === 'GET' && path === '/history/telemetry') {
        guard('operator', 'operator');
        requireCapability(history, 'telemetry', 'History database is not enabled');
        const filters = queryFilters(requestUrl, ['metric', 'device_id', 'controller_id', 'quality', 'from', 'to']);
        return send(200, { samples: history.telemetry(filters) });
      }

      if (method === 'GET' && path === '/history/events') {
        guard('operator', 'operator');
        requireCapability(history, 'events', 'History database is not enabled');
        const filters = queryFilters(requestUrl, ['type', 'from', 'to']);
        return send(200, { events: history.events(filters) });
      }

      if (method === 'GET' && path === '/history/alerts') {
        guard('operator', 'operator');
        requireCapability(history, 'alerts', 'History database is not enabled');
        const filters = queryFilters(requestUrl, ['type', 'from', 'to']);
        return send(200, { alerts: history.alerts(filters) });
      }

      if (method === 'GET' && path === '/history/policy-decisions') {
        guard('operator', 'operator');
        requireCapability(history, 'policyDecisions', 'Policy decision history is not enabled');
        const filters = queryFilters(requestUrl, ['effect', 'policy_id', 'actuator_id', 'action', 'from', 'to']);
        return send(200, { decisions: history.policyDecisions(filters) });
      }

      if (method === 'GET' && path === '/history/commands') {
        guard('operator', 'operator');
        requireCapability(history, 'commands', 'History database is not enabled');
        const filters = queryFilters(requestUrl, ['status', 'actuator_id', 'controller_id', 'action', 'from', 'to']);
        return send(200, { commands: history.commands(filters) });
      }

      if (method === 'GET' && path === '/analytics/catalog') {
        guard('read', 'read');
        requireCapability(analytics, 'catalog', 'Historical analytics is not enabled');
        return send(200, analytics.catalog());
      }

      if (method === 'GET' && path === '/analytics/overview') {
        guard('read', 'read');
        requireCapability(analytics, 'overview', 'Historical analytics is not enabled');
        const filters = queryFilters(requestUrl, ['from', 'to', 'quality'], { includeLimit: false });
        return send(200, analytics.overview(filters));
      }

      if (method === 'GET' && path === '/analytics/telemetry') {
        guard('read', 'read');
        requireCapability(analytics, 'telemetrySeries', 'Historical analytics is not enabled');
        const filters = queryFilters(requestUrl, ['metric', 'bucket', 'device_id', 'controller_id', 'quality', 'from', 'to'], {
          defaultLimit: 500,
          maximumLimit: 5000
        });
        return send(200, analytics.telemetrySeries(filters));
      }

      if (method === 'GET' && path === '/analytics/commands') {
        guard('read', 'read');
        requireCapability(analytics, 'commandSummary', 'Historical analytics is not enabled');
        const filters = queryFilters(requestUrl, ['actuator_id', 'controller_id', 'action', 'mode', 'from', 'to'], { includeLimit: false });
        return send(200, analytics.commandSummary(filters));
      }

      if (method === 'GET' && path === '/analytics/alerts') {
        guard('read', 'read');
        requireCapability(analytics, 'alertSummary', 'Historical analytics is not enabled');
        const filters = queryFilters(requestUrl, ['from', 'to'], { includeLimit: false });
        return send(200, analytics.alertSummary(filters));
      }

      if (method === 'GET' && path === '/analytics/simulations') {
        guard('read', 'read');
        requireCapability(analytics, 'simulationSummary', 'Historical analytics is not enabled');
        const filters = queryFilters(requestUrl, ['name', 'from', 'to'], { includeLimit: false });
        return send(200, { simulations: analytics.simulationSummary(filters) });
      }

      if (method === 'GET' && path === '/simulations/catalog') {
        limit('read');
        requireCapability(simulations, 'catalog', 'Simulation service is not enabled');
        return send(200, simulations.catalog());
      }

      if (method === 'GET' && path === '/simulations/status') {
        guard('read', 'read');
        return send(200, scheduler.status());
      }

      if (method === 'GET' && path === '/simulations') {
        guard('read', 'read');
        requireCapability(simulations, 'list', 'Simulation service is not enabled');
        const requestedLimit = boundedLimit(requestUrl, { defaultValue: 20, maximum: 100 });
        return send(200, { reports: simulations.list({ limit: requestedLimit }) });
      }

      if (method === 'POST' && (path === '/simulations' || path === '/simulations/compare')) {
        guard('simulation', 'simulation');
        requireCapability(simulations, path.endsWith('/compare') ? 'compare' : 'run', 'Simulation service is not enabled');
        const body = requireObject(await readJson(request));
        const report = await scheduler.submit(path.endsWith('/compare') ? 'compare' : 'run', async () => {
          const before = simulations.snapshot();
          const generated = path.endsWith('/compare') ? await simulations.compare(body) : await simulations.run(body);
          await persistSimulationMutation(simulations, persistSimulations, before);
          publishLive(live, 'simulation.completed', {
            report_id: generated.report_id,
            type: generated.type,
            kind: generated.kind,
            name: generated.name,
            passed: generated.passed ?? null,
            created_at: generated.created_at
          });
          return generated;
        });
        return send(201, report);
      }

      const reportId = simulationReportRoute(path);
      if (reportId && method === 'GET') {
        guard('read', 'read');
        requireCapability(simulations, 'get', 'Simulation service is not enabled');
        try {
          return send(200, simulations.get(reportId));
        } catch (error) {
          if (error.message.startsWith('Unknown simulation report:')) throw badRequest(error.message, 404);
          throw error;
        }
      }

      if (method === 'GET' && path === '/controllers') {
        guard('operator', 'operator');
        requireCapability(engine, 'listControllers', 'Controller contract is not enabled');
        return send(200, { controllers: engine.listControllers() });
      }

      if (method === 'POST' && path === '/controllers/register') {
        requireCapability(engine, 'registerController', 'Controller contract is not enabled');
        const body = requireObject(await readJson(request));
        guard('controller', 'controller', body.controller_id);
        const before = engine.snapshot();
        const controller = engine.registerController(body);
        await persistMutation(engine, persist, before);
        publishLive(live, 'controller.registered', { controller });
        return send(201, { controller, configuration: engine.controllerConfiguration(controller.controller_id) });
      }

      const route = controllerRoute(path);
      if (route && method === 'POST' && route.action === 'heartbeat') {
        guard('controller', 'controller', route.controllerId);
        requireCapability(engine, 'heartbeat', 'Controller contract is not enabled');
        const body = requireObject(await readJson(request));
        const before = engine.snapshot();
        const controller = engine.heartbeat(route.controllerId, body);
        await persistMutation(engine, persist, before);
        publishLive(live, 'controller.heartbeat', {
          controller_id: route.controllerId,
          status: controller.status,
          last_heartbeat: controller.last_heartbeat
        });
        return send(200, { controller });
      }

      if (route && method === 'GET' && route.action === 'configuration') {
        guard('controller', 'controller', route.controllerId);
        requireCapability(engine, 'controllerConfiguration', 'Controller contract is not enabled');
        return send(200, engine.controllerConfiguration(route.controllerId));
      }

      if (route && method === 'GET' && route.action === 'commands') {
        guard('controller', 'controller', route.controllerId);
        requireCapability(engine, 'controllerCommands', 'Controller contract is not enabled');
        const before = engine.snapshot();
        const commands = engine.controllerCommands(route.controllerId);
        await persistMutation(engine, persist, before);
        if (commands.length > 0) publishLive(live, 'commands.delivered', { controller_id: route.controllerId, commands });
        return send(200, { commands });
      }

      if (route && method === 'POST' && route.action === 'telemetry') {
        guard('controller', 'controller', route.controllerId);
        requireCapability(engine, 'ingestControllerTelemetry', 'Controller contract is not enabled');
        const body = requireObject(await readJson(request));
        const samples = Array.isArray(body.samples) ? body.samples : [body];
        if (samples.length === 0) throw badRequest('At least one telemetry sample is required');
        if (samples.length > 100) throw badRequest('Maximum 100 telemetry samples per request', 413);
        const before = engine.snapshot();
        const accepted = engine.ingestControllerTelemetry(route.controllerId, samples);
        await persistMutation(engine, persist, before);
        publishLive(live, 'telemetry', {
          controller_id: route.controllerId,
          accepted_count: accepted.length,
          samples: accepted.slice(-20)
        });
        return send(202, { accepted });
      }

      if (route && method === 'POST' && route.action === 'command-acks') {
        guard('controller', 'controller', route.controllerId);
        requireCapability(engine, 'acknowledge', 'Controller contract is not enabled');
        const body = requireObject(await readJson(request));
        if (body.controller_id && body.controller_id !== route.controllerId) throw badRequest('controller_id does not match request path');
        const before = engine.snapshot();
        const command = engine.acknowledge({ ...body, controller_id: route.controllerId });
        await persistMutation(engine, persist, before);
        publishLive(live, 'command.acknowledged', { controller_id: route.controllerId, command });
        return send(200, { acknowledged: true, command });
      }

      if (method === 'POST' && path === '/telemetry') {
        guard('operator', 'operator');
        const body = requireObject(await readJson(request));
        const samples = Array.isArray(body.samples) ? body.samples : [body];
        if (samples.length === 0) throw badRequest('At least one telemetry sample is required');
        if (samples.length > 100) throw badRequest('Maximum 100 telemetry samples per request', 413);
        const validated = samples.map(sample => engine.validateTelemetry(sample));
        const before = engine.snapshot();
        const accepted = validated.map(sample => engine.ingest(sample));
        await persistMutation(engine, persist, before);
        publishLive(live, 'telemetry', { controller_id: null, accepted_count: accepted.length, samples: accepted.slice(-20) });
        return send(202, { accepted });
      }

      if (method === 'POST' && path === '/mode') {
        guard('operator', 'operator');
        const body = requireObject(await readJson(request));
        const before = engine.snapshot();
        engine.setMode(body.mode);
        await persistMutation(engine, persist, before);
        publishLive(live, 'mode.changed', { configured_mode: engine.mode });
        return send(200, { configured_mode: engine.mode });
      }

      if (method === 'POST' && path === '/connectivity') {
        guard('operator', 'operator');
        const body = requireObject(await readJson(request));
        if (typeof body.connected !== 'boolean') throw badRequest('connected must be boolean');
        const before = engine.snapshot();
        engine.setConnectivity(body.connected);
        await persistMutation(engine, persist, before);
        publishLive(live, 'connectivity.changed', { connected: engine.connected });
        return send(200, { connected: engine.connected });
      }

      if (method === 'POST' && path === '/manual-commands') {
        guard('operator', 'operator');
        const body = requireObject(await readJson(request));
        if (typeof body.actuator_id !== 'string' || typeof body.action !== 'string') {
          throw badRequest('actuator_id and action are required strings');
        }
        const before = engine.snapshot();
        engine.requestManual(body.actuator_id, body.action, body.reason);
        await persistMutation(engine, persist, before);
        publishLive(live, 'manual-command.queued', {
          actuator_id: body.actuator_id,
          action: body.action,
          reason: body.reason ?? null
        });
        return send(202, { queued: true });
      }

      if (method === 'POST' && path === '/command-acks') {
        guard('operator', 'operator');
        const body = requireObject(await readJson(request));
        const before = engine.snapshot();
        const command = engine.acknowledge(body);
        await persistMutation(engine, persist, before);
        publishLive(live, 'command.acknowledged', { controller_id: body.controller_id ?? null, command });
        return send(200, { acknowledged: true, command });
      }

      if (method === 'POST' && path === '/evaluate') {
        guard('operator', 'operator');
        const before = engine.snapshot();
        const commands = engine.evaluate();
        await persistMutation(engine, persist, before);
        const effectiveState = engine.snapshot();
        publishLive(live, 'automation.evaluated', { commands, state: compactState(engine) });
        return send(200, { commands, effective_state: effectiveState });
      }

      return send(404, { error: 'NOT_FOUND', message: `No route for ${method} ${path}` });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 400;
      if (error.rateLimit) setRateLimitHeaders(response, error.rateLimit);
      if (error.retryAfterSeconds) response.setHeader('retry-after', String(error.retryAfterSeconds));
      if (statusCode >= 500) logger.error?.(error);
      return send(statusCode, { error: errorCode(statusCode), message: error.message });
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
