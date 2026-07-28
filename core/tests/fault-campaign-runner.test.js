import test from 'node:test';
import assert from 'node:assert/strict';
import { FaultCampaignRunner } from '../src/fault-campaign-runner.js';
import { FAULT_CAMPAIGN_CATALOG, faultCampaignDefinition } from '../src/fault-campaign-catalog.js';

test('delivery blackout expires commands and recovers without pending work', () => {
  const runner = new FaultCampaignRunner({
    stepSeconds: 60,
    initialState: { soil_moisture_percent: 25, water_level_percent: 80 },
    faultSchedule: [
      { at_seconds: 0, type: 'COMMAND_DELIVERY_OFF' },
      { at_seconds: 300, type: 'COMMAND_DELIVERY_ON' }
    ]
  });
  const result = runner.run({
    durationSeconds: 720,
    expectations: {
      require_alert_types: ['COMMAND_EXPIRED_WITHOUT_ACK'],
      max_pending_commands: 0,
      max_safety_violations: 0
    }
  });

  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.equal(result.summary.commands.by_status.EXECUTED >= 1, true);
});

test('controller outage produces stale telemetry safety and recovers online', () => {
  const runner = new FaultCampaignRunner({
    startTime: '2026-07-28T11:00:00.000Z',
    stepSeconds: 60,
    initialState: { air_temperature_c: 35, soil_moisture_percent: 50, water_level_percent: 80 },
    faultSchedule: [
      { at_seconds: 300, type: 'CONTROLLER_OFFLINE' },
      { at_seconds: 900, type: 'CONTROLLER_ONLINE' }
    ]
  });
  const result = runner.run({
    durationSeconds: 1200,
    expectations: {
      require_alert_types: ['REQUIRED_TELEMETRY_UNAVAILABLE'],
      final_controller_status: 'ONLINE',
      max_pending_commands: 0,
      max_safety_violations: 0
    }
  });

  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.equal(result.summary.resilience.fault_events_applied.length, 2);
});

test('runtime restart preserves completed ACK cache for duplicate replay', () => {
  const runner = new FaultCampaignRunner({
    startTime: '2026-07-28T11:00:00.000Z',
    stepSeconds: 60,
    initialState: { air_temperature_c: 35, soil_moisture_percent: 50, water_level_percent: 80 },
    faultSchedule: [
      { at_seconds: 60, type: 'DUPLICATE_LAST_ACK' },
      { at_seconds: 120, type: 'RUNTIME_RESTART' },
      { at_seconds: 180, type: 'DUPLICATE_LAST_ACK' }
    ]
  });
  const result = runner.run({
    durationSeconds: 360,
    expectations: {
      min_runtime_restarts: 1,
      min_duplicate_acks_accepted: 2,
      max_duplicate_ack_failures: 0,
      max_safety_violations: 0
    }
  });

  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.equal(result.summary.resilience.completed_ack_cache_size >= 1, true);
});

test('unknown fault event is rejected at construction', () => {
  assert.throws(
    () => new FaultCampaignRunner({ faultSchedule: [{ at_seconds: 0, type: 'UNKNOWN' }] }),
    /Unknown fault event type/
  );
});

test('all catalog fault campaigns pass declared resilience criteria', () => {
  for (const name of Object.keys(FAULT_CAMPAIGN_CATALOG)) {
    const definition = faultCampaignDefinition(name);
    const result = new FaultCampaignRunner(definition.runner).run({
      durationSeconds: definition.durationSeconds,
      expectations: definition.expectations
    });
    assert.equal(result.passed, true, `${name}: ${JSON.stringify(result.checks)}`);
  }
});
