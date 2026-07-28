import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteHistoryStore } from '../src/history-store.js';

const NOW = '2026-07-28T14:00:00.000Z';

function runtimeSnapshot() {
  const pending = {
    command_id: 'cmd_pending',
    controller_id: 'controller_primary',
    actuator_id: 'pump_01',
    actuator_type: 'pump',
    action: 'ON',
    issued_at: '2026-07-28T13:59:00.000Z',
    expires_at: '2026-07-28T14:05:00.000Z',
    reason: 'soil moisture below configured minimum',
    mode: 'AUTO',
    delivery_status: 'DELIVERED'
  };
  const completed = {
    command_id: 'cmd_completed',
    controller_id: 'controller_primary',
    actuator_id: 'fan_01',
    actuator_type: 'fan',
    action: 'ON',
    issued_at: '2026-07-28T13:50:00.000Z',
    expires_at: '2026-07-28T13:55:00.000Z',
    reason: 'air temperature above configured maximum',
    mode: 'AUTO',
    delivery_status: 'EXECUTED'
  };
  return {
    telemetry: {
      soil_moisture: {
        device_id: 'soil_01',
        metric: 'soil_moisture',
        value: 38.5,
        unit: '%',
        quality: 'GOOD',
        timestamp: '2026-07-28T13:59:30.000Z',
        simulation_time: '2026-08-01T10:00:00.000Z'
      }
    },
    device_owners: { soil_01: 'controller_primary' },
    events: [{
      type: 'COMMAND_ISSUED',
      details: { command_id: pending.command_id },
      timestamp: '2026-07-28T13:59:00.000Z'
    }],
    alerts: [{
      type: 'LOW_WATER_LEVEL',
      details: { value: 18 },
      timestamp: '2026-07-28T13:58:00.000Z'
    }],
    pending_commands: [pending],
    completed_command_acks: [{
      command_id: completed.command_id,
      controller_id: completed.controller_id,
      actuator_id: completed.actuator_id,
      status: 'EXECUTED',
      acknowledged_at: '2026-07-28T13:51:00.000Z',
      details: 'virtual actuator switched',
      command: completed
    }]
  };
}

test('runtime snapshots are normalized, deduplicated and queryable', () => {
  const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => new Date(NOW) });
  const snapshot = runtimeSnapshot();

  assert.equal(store.captureRuntimeSnapshot(snapshot), true);
  assert.equal(store.captureRuntimeSnapshot(snapshot), true);

  const stats = store.stats();
  assert.equal(stats.healthy, true);
  assert.equal(stats.counts.telemetry_history, 1);
  assert.equal(stats.counts.event_history, 1);
  assert.equal(stats.counts.alert_history, 1);
  assert.equal(stats.counts.command_history, 2);

  const telemetry = store.telemetry({ metric: 'soil_moisture' });
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].controller_id, 'controller_primary');
  assert.equal(telemetry[0].value, 38.5);

  const events = store.events({ type: 'COMMAND_ISSUED' });
  assert.deepEqual(events[0].details, { command_id: 'cmd_pending' });

  const alerts = store.alerts({ from: '2026-07-28T13:57:00Z', to: '2026-07-28T13:59:00Z' });
  assert.equal(alerts.length, 1);

  const completed = store.commands({ status: 'EXECUTED' });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].command_id, 'cmd_completed');
  assert.equal(completed[0].acknowledged_at, '2026-07-28T13:51:00.000Z');
  assert.equal(completed[0].command.action, 'ON');

  assert.throws(() => store.telemetry({ from: 'not-a-date' }), /valid date/);
  assert.throws(() => store.telemetry({ limit: 5001 }), /limit/);
  store.close();
});

test('retention limits keep only the newest runtime history', () => {
  let current = new Date('2026-07-28T14:00:00.000Z');
  const store = new SqliteHistoryStore({
    filePath: ':memory:',
    now: () => new Date(current),
    limits: { telemetry: 2, events: 2, alerts: 2, commands: 2, simulations: 2 }
  });

  for (let index = 0; index < 4; index += 1) {
    const timestamp = new Date(current.getTime() + index * 1000).toISOString();
    store.captureRuntimeSnapshot({
      telemetry: {
        air_temperature: {
          device_id: 'air_01', metric: 'air_temperature', value: 20 + index,
          unit: '°C', quality: 'GOOD', timestamp
        }
      },
      device_owners: { air_01: 'controller_primary' },
      events: [{ type: `EVENT_${index}`, details: { index }, timestamp }],
      alerts: [{ type: `ALERT_${index}`, details: { index }, timestamp }],
      pending_commands: [{
        command_id: `cmd_${index}`, controller_id: 'controller_primary', actuator_id: 'fan_01',
        actuator_type: 'fan', action: index % 2 ? 'OFF' : 'ON', issued_at: timestamp,
        expires_at: new Date(new Date(timestamp).getTime() + 60000).toISOString(), mode: 'AUTO'
      }],
      completed_command_acks: []
    });
  }

  const stats = store.stats();
  assert.equal(stats.counts.telemetry_history, 2);
  assert.equal(stats.counts.event_history, 2);
  assert.equal(stats.counts.alert_history, 2);
  assert.equal(stats.counts.command_history, 2);
  assert.deepEqual(store.telemetry().map(item => item.value), [23, 22]);
  store.close();
});

test('simulation reports are stored in SQLite and restored in service format', () => {
  const store = new SqliteHistoryStore({
    filePath: ':memory:',
    now: () => new Date(NOW),
    limits: { simulations: 2 }
  });
  const reports = [0, 1, 2].map(index => ({
    report_id: `sim_${index}`,
    created_at: `2026-07-28T14:0${index}:00.000Z`,
    type: 'simulation',
    kind: 'scenario',
    name: `scenario_${index}`,
    description: `Scenario ${index}`,
    passed: index !== 1,
    summary: { index }
  }));

  store.saveSimulationSnapshot({ state_version: 1, max_reports: 2, reports });
  const restored = store.loadSimulationSnapshot({ maxReports: 5 });

  assert.equal(restored.max_reports, 2);
  assert.deepEqual(restored.reports.map(report => report.report_id), ['sim_1', 'sim_2']);
  assert.equal(store.stats().counts.simulation_reports, 2);
  store.close();
});

test('expired command events update persisted command status', () => {
  const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => new Date(NOW) });
  const snapshot = runtimeSnapshot();
  store.captureRuntimeSnapshot(snapshot);
  snapshot.pending_commands = [];
  snapshot.events.push({
    type: 'COMMAND_EXPIRED_WITHOUT_ACK',
    details: { command_id: 'cmd_pending' },
    timestamp: NOW
  });
  store.captureRuntimeSnapshot(snapshot);

  const expired = store.commands({ status: 'EXPIRED' });
  assert.equal(expired.length, 1);
  assert.equal(expired[0].command_id, 'cmd_pending');
  store.close();
});
