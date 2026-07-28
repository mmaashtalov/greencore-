import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveEventHub } from '../src/live-event-hub.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = null;
    this.statusCode = null;
    this.chunks = [];
    this.destroyed = false;
    this.writableEnded = false;
  }
  writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; }
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end() { this.writableEnded = true; this.emit('close'); }
  text() { return this.chunks.join(''); }
}

function request(headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  return req;
}

test('live hub connects, publishes and cleans clients', () => {
  const hub = new LiveEventHub({
    heartbeatIntervalMs: 1000,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {}
  });
  const req = request();
  const response = new FakeResponse();
  hub.connect(req, response, { initialEvent: { event: 'snapshot', data: { mode: 'AUTO' } } });
  hub.publish('telemetry', { value: 42 });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.match(response.text(), /event: snapshot/);
  assert.match(response.text(), /event: telemetry/);
  assert.match(response.text(), /"value":42/);
  assert.equal(hub.status().connected_clients, 1);

  req.emit('close');
  assert.equal(hub.status().connected_clients, 0);
});

test('last-event-id replays buffered events and connection cap is enforced', () => {
  const hub = new LiveEventHub({
    maxClients: 1,
    replayLimit: 3,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {}
  });
  hub.publish('one', { n: 1 });
  hub.publish('two', { n: 2 });

  const firstRequest = request({ 'last-event-id': '1' });
  const firstResponse = new FakeResponse();
  hub.connect(firstRequest, firstResponse);
  assert.doesNotMatch(firstResponse.text(), /event: one/);
  assert.match(firstResponse.text(), /event: two/);

  assert.throws(() => hub.connect(request(), new FakeResponse()), error => error.statusCode === 503);
  firstRequest.emit('close');
  assert.equal(hub.status().rejected_connections, 1);
});
