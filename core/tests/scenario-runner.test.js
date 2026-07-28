import test from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioRunner } from '../src/scenario-runner.js';
import { SCENARIO_CATALOG, scenarioDefinition } from '../src/scenario-catalog.js';

test('scenario runner produces deterministic summaries', () => {
  const options = {
    startTime: '2026-07-28T06:00:00.000Z',
    stepSeconds: 300,
    recordEverySteps: 3,
    scenarioPreset: 'normal'
  };
  const first = new ScenarioRunner(options).run({
    durationSeconds: 3 * 3600,
    expectations: { max_safety_violations: 0 }
  });
  const second = new ScenarioRunner(options).run({
    durationSeconds: 3 * 3600,
    expectations: { max_safety_violations: 0 }
  });
  assert.equal(first.passed, true);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.timeline, second.timeline);
});

test('low water campaign never runs the pump', () => {
  const runner = new ScenarioRunner({
    stepSeconds: 300,
    initialState: { soil_moisture_percent: 20, water_level_percent: 10 }
  });
  const result = runner.run({
    durationSeconds: 2 * 3600,
    expectations: {
      max_safety_violations: 0,
      max_pump_runtime_seconds: 0,
      require_alert_types: ['LOW_WATER_LEVEL']
    }
  });
  assert.equal(result.passed, true);
  assert.equal(result.summary.actuator_runtime_seconds.pump_01, 0);
});

test('actuator failure is visible in command results and criteria', () => {
  const runner = new ScenarioRunner({
    stepSeconds: 300,
    initialState: { soil_moisture_percent: 25, water_level_percent: 80 },
    faults: { pump_failure: true }
  });
  const result = runner.run({
    durationSeconds: 3600,
    expectations: { min_failed_commands: 1, max_pump_runtime_seconds: 0 }
  });
  assert.equal(result.passed, true);
  assert.equal((result.summary.commands.by_status.FAILED ?? 0) >= 1, true);
});

test('failed expectation produces a machine-readable failure', () => {
  const runner = new ScenarioRunner({ stepSeconds: 300 });
  const result = runner.run({
    durationSeconds: 3600,
    expectations: { min_water_level_percent: 101 }
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].name, 'min_water_level_percent');
  assert.equal(result.checks[0].passed, false);
});

test('every catalog scenario passes its declared safety criteria', () => {
  for (const name of Object.keys(SCENARIO_CATALOG)) {
    const definition = scenarioDefinition(name);
    const result = new ScenarioRunner(definition.runner).run({
      durationSeconds: definition.durationSeconds,
      expectations: definition.expectations
    });
    assert.equal(result.passed, true, `${name}: ${JSON.stringify(result.checks)}`);
  }
});
