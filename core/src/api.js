import http from 'node:http';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
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

function eventLimit(requestUrl) {
  const raw = requestUrl.searchParams.get('limit');
  if (raw === null) return 100;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw badRequest('limit must be an integer from 1 to 1000');
  }
  return parsed;
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

export function createApiServer({
  engine,
  logger = console,
  persist = async () => {}
}) {
  if (!engine) throw new Error('engine is required');
  if (typeof persist !== 'function') throw new Error('persist must be a function');

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const path = requestUrl.pathname;
    const method = request.method ?? 'GET';

    try {
      if (method === 'GET' && path === '/health') {
        return sendJson(response, 200, {
          status: 'ok',
          service: 'greencore-core',
          version: '0.1.0'
        });
      }

      if (method === 'GET' && path === '/state') {
        return sendJson(response, 200, engine.snapshot());
      }

      if (method === 'GET' && path === '/alerts') {
        return sendJson(response, 200, { alerts: [...engine.alerts] });
      }

      if (method === 'GET' && path === '/events') {
        const limit = eventLimit(requestUrl);
        return sendJson(response, 200, { events: engine.events.slice(-limit) });
      }

      if (method === 'POST' && path === '/telemetry') {
        const body = requireObject(await readJson(request));
        const samples = Array.isArray(body.samples) ? body.samples : [body];
        if (samples.length === 0) throw badRequest('At least one telemetry sample is required');
        if (samples.length > 100) throw badRequest('Maximum 100 telemetry samples per request', 413);

        const validated = samples.map(sample => engine.validateTelemetry(sample));
        const before = engine.snapshot();
        const accepted = validated.map(sample => engine.ingest(sample));
        await persistMutation(engine, persist, before);
        return sendJson(response, 202, { accepted });
      }

      if (method === 'POST' && path === '/mode') {
        const body = requireObject(await readJson(request));
        const before = engine.snapshot();
        engine.setMode(body.mode);
        await persistMutation(engine, persist, before);
        return sendJson(response, 200, { configured_mode: engine.mode });
      }

      if (method === 'POST' && path === '/connectivity') {
        const body = requireObject(await readJson(request));
        if (typeof body.connected !== 'boolean') throw badRequest('connected must be boolean');
        const before = engine.snapshot();
        engine.setConnectivity(body.connected);
        await persistMutation(engine, persist, before);
        return sendJson(response, 200, { connected: engine.connected });
      }

      if (method === 'POST' && path === '/manual-commands') {
        const body = requireObject(await readJson(request));
        if (typeof body.actuator_id !== 'string' || typeof body.action !== 'string') {
          throw badRequest('actuator_id and action are required strings');
        }
        const before = engine.snapshot();
        engine.requestManual(body.actuator_id, body.action, body.reason);
        await persistMutation(engine, persist, before);
        return sendJson(response, 202, { queued: true });
      }

      if (method === 'POST' && path === '/command-acks') {
        const body = requireObject(await readJson(request));
        const before = engine.snapshot();
        const command = engine.acknowledge(body);
        await persistMutation(engine, persist, before);
        return sendJson(response, 200, { acknowledged: true, command });
      }

      if (method === 'POST' && path === '/evaluate') {
        const before = engine.snapshot();
        const commands = engine.evaluate();
        await persistMutation(engine, persist, before);
        return sendJson(response, 200, {
          commands,
          effective_state: engine.snapshot()
        });
      }

      return sendJson(response, 404, {
        error: 'NOT_FOUND',
        message: `No route for ${method} ${path}`
      });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 400;
      if (statusCode >= 500) logger.error?.(error);
      return sendJson(response, statusCode, {
        error: statusCode >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
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
