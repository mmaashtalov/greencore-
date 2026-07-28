import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { close, createApiServer, listen } from '../src/api.js';

async function fixture(persist) {
  const now = () => new Date('2026-07-28T07:00:00.000Z');
  const engine = new GreenCoreEngine({ contracts, rules, now });
  const server = createApiServer({ engine, persist, logger: { error() {} } });
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const post = async (path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { response, body: await response.json() };
  };
  return { engine, server, post };
}

test('mutating request persists resulting snapshot', async t => {
  const snapshots = [];
  const f = await fixture(async snapshot => snapshots.push(structuredClone(snapshot)));
  t.after(() => close(f.server));

  const result = await f.post('/mode', { mode: 'AUTO' });
  assert.equal(result.response.status, 200);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].configured_mode, 'AUTO');
});

test('persistence failure rolls engine state back', async t => {
  const f = await fixture(async () => { throw new Error('disk unavailable'); });
  t.after(() => close(f.server));

  const result = await f.post('/mode', { mode: 'AUTO' });
  assert.equal(result.response.status, 500);
  assert.equal(result.body.error, 'INTERNAL_ERROR');
  assert.equal(f.engine.mode, 'SAFE');
});
