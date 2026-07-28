import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationService } from '../src/simulation-service.js';

test('catalog exposes normal and resilience simulations with model notice', () => {
  const service = new SimulationService();
  const catalog = service.catalog();
  assert.equal(Boolean(catalog.scenarios.baseline_24h), true);
  assert.equal(Boolean(catalog.fault_campaigns.controller_outage_recovery), true);
  assert.match(catalog.model_notice, /not agronomic yield forecasts/i);
});

test('named scenario produces a stored report', () => {
  const service = new SimulationService();
  const report = service.run({ kind: 'scenario', name: 'low_water_safety_2h' });
  assert.equal(report.type, 'simulation');
  assert.equal(report.passed, true);
  assert.equal(service.get(report.report_id).report_id, report.report_id);
  assert.equal(service.list()[0].name, 'low_water_safety_2h');
  assert.equal('timeline' in report, true);
  assert.equal(report.timeline, undefined);
});

test('fault campaign can include timeline in its report', () => {
  const service = new SimulationService();
  const report = service.run({
    kind: 'fault',
    name: 'runtime_restart_and_ack_replay',
    include_timeline: true
  });
  assert.equal(report.passed, true);
  assert.equal(report.timeline.length > 0, true);
  assert.equal(report.summary.resilience.runtime_restarts, 1);
});

test('automatic comparison is explicit about passive manual baseline', () => {
  const service = new SimulationService();
  const report = service.compare({ name: 'baseline_24h' });
  assert.equal(report.type, 'comparison');
  assert.equal(report.strategies.automatic.label, 'AUTO');
  assert.equal(report.strategies.manual_baseline.label, 'MANUAL_WITHOUT_OPERATOR_INTERVENTIONS');
  assert.equal(
    report.strategies.automatic.metrics.command_count
      > report.strategies.manual_baseline.metrics.command_count,
    true
  );
  assert.match(report.interpretation.note, /not a model of a skilled human operator/i);
});

test('report store is bounded and snapshot survives restore', () => {
  let current = new Date('2026-07-28T07:00:00.000Z');
  const now = () => new Date(current);
  const service = new SimulationService({ now, maxReports: 2 });
  const ids = [];
  for (const name of ['low_water_safety_2h', 'pump_failure_2h', 'tank_leak_12h']) {
    ids.push(service.run({ kind: 'scenario', name }).report_id);
    current = new Date(current.getTime() + 1000);
  }
  assert.equal(service.reports.size, 2);
  assert.throws(() => service.get(ids[0]), /Unknown simulation report/);

  const restored = new SimulationService();
  restored.restore(service.snapshot());
  assert.deepEqual(restored.list(), service.list());
});

test('unknown simulation and invalid list limits are rejected', () => {
  const service = new SimulationService();
  assert.throws(() => service.run({ kind: 'scenario', name: 'missing' }), /Unknown scenario/);
  assert.throws(() => service.run({ kind: 'invalid', name: 'x' }), /Unsupported simulation kind/);
  assert.throws(() => service.list({ limit: 101 }), /must not exceed 100/);
});
