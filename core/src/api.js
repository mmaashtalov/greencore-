import http from 'node:http';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

async function readJson(request, { maxBytes = 64 * 1024 } = {}) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be a JSON object');
    error.statusCode = 400;
    throw error;
  }
  return body;
}

export function createApiServer({ engine, logger = console }) {
  if (!engine) throw new Error('engine is required');

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
        const limit = Math.min(Math.max(Number(requestUrl.searchParams.get('limit') ?? 100), 1), 1000);
        return sendJson(response, 200, { events: engine.events.slice(-limit) });
      }

      if (method === 'POST' && path === '/telemetry') {
        const body = requireObject(await readJson(request));
        const samples = Array.isArray(body.samples) ? body.samples : [body];
        if (samples.length === 0) {
          const error = new Error('At least one telemetry sample is required');
          error.statusCode = 400;
          throw error;
        }
        if (samples.length > 100) {
          const error = new Error('Maximum 100 telemetry samples per request');
          error.statusCode = 413;
          throw error;
        }
        const accepted = samples.map(sample => engine.ingest(sample));
        return sendJson(response, 202, { accepted });
      }

      if (method === 'POST' && path === '/mode') {
        const body = requireObject(await readJson(request));
        engine.setMode(body.mode);
        return sendJson(response, 200, { configured_mode: engine.mode });
      }

      if (method === 'POST' && path === '/connectivity') {
        const body = requireObject(await readJson(request));
        if (typeof body.connected !== 'boolean') {
          const error = new Error('connected must be boolean');
          error.statusCode = 400;
          throw error;
        }
        engine.setConnectivity(body.connected);
        return sendJson(response, 200, { connected: engine.connected });
      }

      if (method === 'POST' && path === '/manual-commands') {
        const body = requireObject(await readJson(request));
        if (typeof body.actuator_id !== 'string' || typeof body.action !== 'string') {
          const error = new Error('actuator_id and action are required strings');
          error.statusCode = 400;
          throw error;
        }
        engine.requestManual(body.actuator_id, body.action, body.reason);
        return sendJson(response, 202, { queued: true });
      }

      if (method === 'POST' && path === '/command-acks') {
        const body = requireObject(await readJson(request));
        const command = engine.acknowledge(body);
        return sendJson(response, 200, { acknowledged: true, command });
      }

      if (method === 'POST' && path === '/evaluate') {
        const commands = engine.evaluate();
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
