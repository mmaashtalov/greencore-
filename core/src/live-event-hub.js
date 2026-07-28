const EVENT_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function serviceUnavailable(message, retryAfterSeconds = 5) {
  const error = new Error(message);
  error.statusCode = 503;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function encodeEvent(record) {
  return `id: ${record.id}\nevent: ${record.event}\ndata: ${record.data}\n\n`;
}

export class LiveEventHub {
  constructor({
    now = () => new Date(),
    heartbeatIntervalMs = 15000,
    replayLimit = 100,
    maxClients = 100,
    maxEventBytes = 64 * 1024,
    logger = console,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval
  } = {}) {
    this.now = now;
    this.heartbeatIntervalMs = positiveInteger(heartbeatIntervalMs, 'heartbeatIntervalMs');
    this.replayLimit = positiveInteger(replayLimit, 'replayLimit');
    this.maxClients = positiveInteger(maxClients, 'maxClients');
    this.maxEventBytes = positiveInteger(maxEventBytes, 'maxEventBytes');
    this.logger = logger;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.clients = new Map();
    this.replay = [];
    this.sequence = 0;
    this.heartbeatTimer = null;
    this.metrics = { published: 0, delivered: 0, dropped_clients: 0, rejected_connections: 0 };
  }

  record(event, payload) {
    if (!EVENT_NAME.test(event)) throw new Error(`Invalid live event name: ${event}`);
    let data = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(data) > this.maxEventBytes) {
      data = JSON.stringify({
        truncated: true,
        reason: 'event payload exceeds maxEventBytes',
        original_bytes: Buffer.byteLength(data)
      });
    }
    const record = { id: ++this.sequence, event, data, created_at: this.now().toISOString() };
    this.replay.push(record);
    while (this.replay.length > this.replayLimit) this.replay.shift();
    return record;
  }

  write(client, chunk) {
    if (client.response.destroyed || client.response.writableEnded) {
      this.remove(client.id);
      return false;
    }
    try {
      client.response.write(chunk);
      this.metrics.delivered += 1;
      return true;
    } catch (error) {
      this.logger.error?.('GreenCore live-stream write failed', error);
      this.metrics.dropped_clients += 1;
      this.remove(client.id);
      return false;
    }
  }

  publish(event, payload) {
    const record = this.record(event, payload);
    const encoded = encodeEvent(record);
    this.metrics.published += 1;
    for (const client of this.clients.values()) this.write(client, encoded);
    return { ...record, data: JSON.parse(record.data) };
  }

  direct(response, event, payload) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload ?? null)}\n\n`);
  }

  connect(request, response, { allowedOrigin = '*', initialEvent = null } = {}) {
    if (this.clients.size >= this.maxClients) {
      this.metrics.rejected_connections += 1;
      throw serviceUnavailable('Maximum live-stream connections reached');
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': allowedOrigin,
      vary: 'origin'
    });
    response.write('retry: 3000\n: greencore live stream connected\n\n');

    const clientId = `client_${this.sequence + 1}_${Math.random().toString(36).slice(2)}`;
    const client = { id: clientId, request, response, connectedAt: this.now().toISOString() };
    this.clients.set(clientId, client);

    const rawLastEventId = request.headers['last-event-id'];
    const lastEventId = Number(Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId);
    if (Number.isInteger(lastEventId) && lastEventId >= 0) {
      for (const record of this.replay) {
        if (record.id > lastEventId) this.write(client, encodeEvent(record));
      }
    }
    if (initialEvent) this.direct(response, initialEvent.event ?? 'snapshot', initialEvent.data);

    const cleanup = () => this.remove(clientId);
    request.once('close', cleanup);
    request.once('aborted', cleanup);
    response.once('close', cleanup);
    this.ensureHeartbeat();
    return { client_id: clientId, connected_at: client.connectedAt };
  }

  ensureHeartbeat() {
    if (this.heartbeatTimer || this.clients.size === 0) return;
    this.heartbeatTimer = this.setIntervalImpl(() => {
      const chunk = `: heartbeat ${this.now().toISOString()}\n\n`;
      for (const client of this.clients.values()) this.write(client, chunk);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  remove(clientId) {
    const removed = this.clients.delete(clientId);
    if (removed && this.clients.size === 0 && this.heartbeatTimer) {
      this.clearIntervalImpl(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    return removed;
  }

  status() {
    return {
      connected_clients: this.clients.size,
      max_clients: this.maxClients,
      replay_events: this.replay.length,
      replay_limit: this.replayLimit,
      heartbeat_interval_ms: this.heartbeatIntervalMs,
      last_event_id: this.sequence,
      ...this.metrics
    };
  }

  close() {
    if (this.heartbeatTimer) {
      this.clearIntervalImpl(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients.values()) {
      try { client.response.end(); } catch {}
    }
    this.clients.clear();
  }
}

export { encodeEvent, serviceUnavailable };
