import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddedDemoController } from '../src/embedded-demo-controller.js';

function fixture(overrides = {}) {
  const calls = [];
  const emulator = {
    running: false,
    async start() { calls.push('emulator.start'); this.running = true; },
    stop() { calls.push('emulator.stop'); this.running = false; }
  };
  const runtime = {
    mode: 'SAFE',
    setMode(mode) { calls.push(`mode:${mode}`); this.mode = mode; },
    snapshot() { return { mode: this.mode }; }
  };
  const controller = new EmbeddedDemoController({
    enabled: true,
    apiKey: 'controller-secret',
    simulationSpeed: 60,
    createEmulator(options) {
      calls.push({ options });
      return emulator;
    },
    ...overrides
  });
  return { calls, emulator, runtime, controller };
}

test('disabled embedded demo is a no-op', async () => {
  const controller = new EmbeddedDemoController();
  const status = await controller.start({ baseUrl: 'http://127.0.0.1:3000' });
  assert.equal(status.enabled, false);
  assert.equal(status.running, false);
});

test('embedded demo requires its generated controller secret', async () => {
  const controller = new EmbeddedDemoController({ enabled: true });
  await assert.rejects(
    () => controller.start({ baseUrl: 'http://127.0.0.1:3000', runtime: { setMode() {}, snapshot() {} } }),
    /EMBEDDED_CONTROLLER_API_KEY/
  );
});

test('embedded demo sets mode, persists, starts digital twin and stops cleanly', async () => {
  const f = fixture();
  const persisted = [];
  const status = await f.controller.start({
    baseUrl: 'http://127.0.0.1:3000',
    runtime: f.runtime,
    persist: async snapshot => persisted.push(snapshot)
  });

  assert.equal(status.running, true);
  assert.equal(f.runtime.mode, 'AUTO');
  assert.deepEqual(persisted, [{ mode: 'AUTO' }]);
  const creation = f.calls.find(value => typeof value === 'object');
  assert.equal(creation.options.apiKey, 'controller-secret');
  assert.equal(creation.options.simulationSpeed, 60);
  assert.equal(creation.options.scenarioPreset, 'normal');
  assert.equal(f.calls.includes('emulator.start'), true);

  const stopped = f.controller.stop();
  assert.equal(stopped.running, false);
  assert.equal(f.calls.includes('emulator.stop'), true);
});

test('environment configuration enables the embedded demo', () => {
  const controller = EmbeddedDemoController.fromEnv({
    EMBEDDED_DEMO_ENABLED: 'true',
    EMBEDDED_CONTROLLER_API_KEY: 'generated-secret',
    EMBEDDED_CONTROLLER_ID: 'controller_demo',
    EMBEDDED_DEMO_SPEED: '120',
    EMBEDDED_DEMO_PRESET: 'heatwave',
    EMBEDDED_DEMO_MODE: 'AUTO'
  });
  const status = controller.status();
  assert.equal(status.enabled, true);
  assert.equal(status.controller_id, 'controller_demo');
  assert.equal(status.simulation_speed, 120);
  assert.equal(status.scenario_preset, 'heatwave');
});
