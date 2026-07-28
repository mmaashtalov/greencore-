import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteHistoryStore } from '../src/history-store.js';
import { HistoryAnalytics } from '../src/history-analytics.js';

function telemetrySnapshot({ timestamp, value, metric = 'soil_moisture', unit = '%', quality = 'GOOD' }) {
  return {
    telemetry: {
      [metric]: {
        device_id: metric === 'soil_moisture' ? 'soil_01' : 'air_01',
        metric,
        value,
        unit,
        quality,
        timestamp
      }
    },
    device_owners: {
      soil_01: 'controller_primary',
      air_01: 'controller_primary'
    },
    events: [],
    alerts: [],
    pending_commands: [],
    completed_command_acks: []
  };
}

function completedAck({ id, status, actuator = 'pump_01', action = 'ON', issuedAt }) {
  const command = {
    command_id: id,
    controller_id: 'controller_primary',
    actuator_id: actuator,
    actuator_type: actuator.startsWith('pump') ? 'pump' : 'fan',
    action,
    issued_at: issuedAt,
    expires_at: new Date(new Date(issuedAt).getTime() + 60000).toISOString(),
    reason: 'analytics test',
    mode: 'AUTO',
    delivery_status: status
  };
  return {
    command_id: id,
    controller_id: 'controller_primary',
    actuator_id: actuator,
    status,
    acknowledged_at: new Date(new Date(issuedAt).getTime() + 10000).toISOString(),
    details: `status ${status}`,
    command
  };
}

test('telemetry is aggregated into deterministic time buckets', () => {
  const store = new SqliteHistoryStore({ filePath: ':memory:' });
  const analytics = new HistoryAnalytics({ history: store });
  for (const [timestamp, value] of [
    ['2026-07-28T10:00:00.000Z', 40],
    ['2026-07-28T10:03:00.000Z', 44],
    ['2026-07-28T10:07:00.000Z', 50]
  ]) {
    store.captureRuntimeSnapshot(telemetrySnapshot({ timestamp, value }));
  }
  store.captureRuntimeSnapshot(telemetrySnapshot({
    timestamp: '2026-07-28T10:08:00.000Z',
    value: 99,
    quality: 'BAD'
  }));

  const result = analytics.telemetrySeries({
    metric: 'soil_moisture',
    bucket: '5m',
    quality: 'GOOD'
  });
  assert.equal(result.bucket_seconds, 300);
  assert.equal(result.points.length, 2);
  assert.deepEqual(result.points[0], {
    bucket_start: '2026-07-28T10:00:00Z',
    metric: 'soil_moisture',
    unit: '%',
    min_value: 40,
    max_value: 44,
    avg_value: 42,
    sample_count: 2
  });
  assert.equal(result.points[1].avg_value, 50);

  const latestGood = analytics.latestTelemetry({ quality: 'GOOD' });
  assert.equal(latestGood.length, 1);
  assert.equal(latestGood[0].value, 50);
  assert.equal(latestGood[0].quality, 'GOOD');

  assert.throws(() => analytics.telemetrySeries({ metric: 'soil_moisture', bucket: '2h' }), /Unsupported bucket/);
  assert.throws(() => analytics.telemetrySeries({}), /metric is required/);
  store.close();
});

test('command and alert summaries calculate operational quality', () => {
  const store = new SqliteHistoryStore({ filePath: ':memory:' });
  const analytics = new HistoryAnalytics({ history: store });
  store.captureRuntimeSnapshot({
    telemetry: {},
    device_owners: {},
    events: [],
    alerts: [
      { type: 'LOW_WATER_LEVEL', details: { value: 15 }, timestamp: '2026-07-28T10:00:00.000Z' },
      { type: 'LOW_WATER_LEVEL', details: { value: 14 }, timestamp: '2026-07-28T10:05:00.000Z' },
      { type: 'PUMP_RUNTIME_LIMIT_EXCEEDED', details: {}, timestamp: '2026-07-28T10:06:00.000Z' }
    ],
    pending_commands: [],
    completed_command_acks: [
      completedAck({ id: 'cmd_1', status: 'EXECUTED', issuedAt: '2026-07-28T10:00:00.000Z' }),
      completedAck({ id: 'cmd_2', status: 'EXECUTED', actuator: 'fan_01', issuedAt: '2026-07-28T10:01:00.000Z' }),
      completedAck({ id: 'cmd_3', status: 'FAILED', issuedAt: '2026-07-28T10:02:00.000Z' })
    ]
  });

  const commands = analytics.commandSummary();
  assert.equal(commands.total, 3);
  assert.equal(commands.terminal, 3);
  assert.equal(commands.executed, 2);
  assert.equal(commands.success_rate_percent, 66.67);
  assert.equal(commands.by_status.FAILED, 1);

  const alerts = analytics.alertSummary();
  assert.equal(alerts.total, 3);
  assert.equal(alerts.types[0].type, 'LOW_WATER_LEVEL');
  assert.equal(alerts.types[0].count, 2);
  store.close();
});

test('simulation summary and overview expose dashboard-ready data', () => {
  const store = new SqliteHistoryStore({ filePath: ':memory:' });
  const analytics = new HistoryAnalytics({ history: store });
  store.captureRuntimeSnapshot(telemetrySnapshot({
    timestamp: '2026-07-28T10:00:00.000Z',
    value: 27,
    metric: 'air_temperature',
    unit: '°C'
  }));
  store.saveSimulationSnapshot({
    state_version: 1,
    max_reports: 10,
    reports: [
      {
        report_id: 'sim_1', created_at: '2026-07-28T10:00:00.000Z',
        type: 'simulation', kind: 'scenario', name: 'baseline_24h', passed: true
      },
      {
        report_id: 'sim_2', created_at: '2026-07-28T11:00:00.000Z',
        type: 'simulation', kind: 'scenario', name: 'baseline_24h', passed: false
      }
    ]
  });

  const simulations = analytics.simulationSummary({ name: 'baseline_24h' });
  assert.equal(simulations.length, 1);
  assert.equal(simulations[0].count, 2);
  assert.equal(simulations[0].passed_count, 1);
  assert.equal(simulations[0].failed_count, 1);

  const overview = analytics.overview();
  assert.equal(overview.storage.healthy, true);
  assert.equal(overview.latest_telemetry[0].metric, 'air_temperature');
  assert.equal(overview.simulations[0].name, 'baseline_24h');
  assert.equal(analytics.catalog().telemetry_buckets['1h'], 3600);
  store.close();
});
