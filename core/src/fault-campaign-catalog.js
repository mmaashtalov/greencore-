export const FAULT_CAMPAIGN_CATALOG = {
  command_delivery_blackout: {
    description: 'Commands expire safely while delivery is unavailable and recover when polling returns',
    runner: {
      startTime: '2026-07-28T06:00:00.000Z',
      stepSeconds: 60,
      recordEverySteps: 5,
      initialState: { soil_moisture_percent: 25, water_level_percent: 80 },
      faultSchedule: [
        { at_seconds: 0, type: 'COMMAND_DELIVERY_OFF' },
        { at_seconds: 300, type: 'COMMAND_DELIVERY_ON' }
      ]
    },
    durationSeconds: 12 * 60,
    expectations: {
      max_safety_violations: 0,
      require_alert_types: ['COMMAND_EXPIRED_WITHOUT_ACK'],
      min_fault_events_applied: 2,
      max_pending_commands: 0,
      final_controller_status: 'ONLINE'
    }
  },
  controller_outage_recovery: {
    description: 'Controller outage causes stale telemetry safety behavior and recovers on heartbeat return',
    runner: {
      startTime: '2026-07-28T11:00:00.000Z',
      stepSeconds: 60,
      recordEverySteps: 5,
      initialState: { air_temperature_c: 35, soil_moisture_percent: 50, water_level_percent: 80 },
      faultSchedule: [
        { at_seconds: 300, type: 'CONTROLLER_OFFLINE' },
        { at_seconds: 900, type: 'CONTROLLER_ONLINE' }
      ]
    },
    durationSeconds: 20 * 60,
    expectations: {
      max_safety_violations: 0,
      require_alert_types: ['REQUIRED_TELEMETRY_UNAVAILABLE', 'COMMAND_EXPIRED_WITHOUT_ACK'],
      min_fault_events_applied: 2,
      max_pending_commands: 0,
      final_controller_status: 'ONLINE'
    }
  },
  runtime_restart_and_ack_replay: {
    description: 'Completed ACK cache survives runtime restart and safely accepts network retries',
    runner: {
      startTime: '2026-07-28T11:00:00.000Z',
      stepSeconds: 60,
      recordEverySteps: 2,
      initialState: { air_temperature_c: 35, soil_moisture_percent: 50, water_level_percent: 80 },
      faultSchedule: [
        { at_seconds: 60, type: 'DUPLICATE_LAST_ACK' },
        { at_seconds: 120, type: 'RUNTIME_RESTART' },
        { at_seconds: 180, type: 'DUPLICATE_LAST_ACK' }
      ]
    },
    durationSeconds: 6 * 60,
    expectations: {
      max_safety_violations: 0,
      min_runtime_restarts: 1,
      min_duplicate_acks_accepted: 2,
      max_duplicate_ack_failures: 0,
      min_fault_events_applied: 3,
      max_pending_commands: 0,
      final_controller_status: 'ONLINE'
    }
  },
  cloud_connectivity_recovery: {
    description: 'Core enters OFFLINE automation while controller telemetry remains available',
    runner: {
      startTime: '2026-07-28T06:00:00.000Z',
      stepSeconds: 60,
      recordEverySteps: 5,
      initialState: { soil_moisture_percent: 25, water_level_percent: 80 },
      faultSchedule: [
        { at_seconds: 180, type: 'CLOUD_CONNECTIVITY_OFF' },
        { at_seconds: 600, type: 'CLOUD_CONNECTIVITY_ON' }
      ]
    },
    durationSeconds: 12 * 60,
    expectations: {
      max_safety_violations: 0,
      min_fault_events_applied: 2,
      max_pending_commands: 0,
      final_controller_status: 'ONLINE'
    }
  }
};

export function faultCampaignDefinition(name) {
  const definition = FAULT_CAMPAIGN_CATALOG[name];
  if (!definition) throw new Error(`Unknown fault campaign: ${name}`);
  return structuredClone(definition);
}
