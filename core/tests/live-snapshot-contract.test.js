import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { GreenCoreRuntime } from '../src/runtime.js';

test('runtime snapshot exposes effective mode for live consumers', () => {
  const engine = new GreenCoreEngine({ contracts, rules });
  const runtime = new GreenCoreRuntime({ engine });

  assert.equal(runtime.snapshot().mode, 'SAFE');
  runtime.setMode('AUTO');
  assert.equal(runtime.snapshot().mode, 'AUTO');
  runtime.setConnectivity(false);
  assert.equal(runtime.snapshot().mode, 'OFFLINE');
});
