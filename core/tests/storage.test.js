import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { DeviceEmulator } from '../src/device-emulator.js';
import { JsonStateStore } from '../src/storage.js';

async function tempState(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'greencore-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filePath: path.join(directory, 'state.json') };
}

test('missing state file is reported without failure', async t => {
  const { filePath } = await tempState(t);
  const store = new JsonStateStore({ filePath });
  assert.deepEqual(await store.load(), { status: 'missing', state: null });
});

test('state is saved atomically and loaded from envelope', async t => {
  const { directory, filePath } = await tempState(t);
  const now = () => new Date('2026-07-28T07:00:00.000Z');
  const store = new JsonStateStore({ filePath, now });
  const state = { configured_mode: 'SAFE', connected: true };

  await store.save(state);
  const loaded = await store.load();

  assert.equal(loaded.status, 'loaded');
  assert.deepEqual(loaded.state, state);
  assert.equal(loaded.savedAt, now().toISOString());
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);

  const envelope = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(envelope.schema_version, 1);
});

test('corrupt state is quarantined', async t => {
  const { directory, filePath } = await tempState(t);
  await writeFile(filePath, '{broken', 'utf8');
  const store = new JsonStateStore({
    filePath,
    now: () => new Date('2026-07-28T07:00:00.000Z')
  });

  const loaded = await store.load();
  assert.equal(loaded.status, 'corrupt');
  assert.match(path.basename(loaded.quarantinePath), /^state\.json\.corrupt-/);
  assert.equal((await readdir(directory)).some(name => name.startsWith('state.json.corrupt-')), true);
});

test('saved engine state survives a process-style restart', async t => {
  const { filePath } = await tempState(t);
  const now = () => new Date('2026-07-28T07:00:00.000Z');
  const source = new GreenCoreEngine({ contracts, rules, now });
  const emulator = new DeviceEmulator({ now });
  emulator.set('soil_moisture', 25);
  emulator.requiredTelemetry().forEach(sample => source.ingest(sample));
  source.setMode('AUTO');
  const [command] = source.evaluate();

  const store = new JsonStateStore({ filePath, now });
  await store.save(source.snapshot());
  const loaded = await store.load();
  const restored = new GreenCoreEngine({ contracts, rules, now });
  restored.restore(loaded.state);

  assert.equal(restored.mode, 'AUTO');
  assert.equal(restored.pendingCommands.has(command.command_id), true);
  assert.equal(restored.telemetry.get('soil_moisture').value, 25);
});
