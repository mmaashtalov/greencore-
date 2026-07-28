export const SCENARIO_CATALOG = {
  baseline_24h: {
    description: 'Normal 24-hour automatic operation',
    runner: {
      startTime: '2026-07-28T06:00:00.000Z',
      stepSeconds: 300,
      recordEverySteps: 12,
      scenarioPreset: 'normal'
    },
    durationSeconds: 24 * 3600,
    expectations: {
      max_safety_violations: 0,
      max_failed_commands: 0,
      min_plant_health_percent: 95
    }
  },
  heatwave_48h: {
    description: 'Two-day heatwave with automatic ventilation',
    runner: {
      startTime: '2026-07-28T06:00:00.000Z',
      stepSeconds: 300,
      recordEverySteps: 24,
      scenarioPreset: 'heatwave'
    },
    durationSeconds: 48 * 3600,
    expectations: {
      max_safety_violations: 0,
      max_failed_commands: 0
    }
  },
  tank_leak_12h: {
    description: 'Tank leak must reach low-water protection without unsafe pump execution',
    runner: {
      startTime: '2026-07-28T06:00:00.000Z',
      stepSeconds: 300,
      recordEverySteps: 12,
      scenarioPreset: 'leak',
      initialState: { soil_moisture_percent: 30, water_level_percent: 80 }
    },
    durationSeconds: 12 * 3600,
    expectations: {
      max_safety_violations: 0,
      require_alert_types: ['LOW_WATER_LEVEL']
    }
  },
  low_water_safety_2h: {
    description: 'Dry soil and low tank level must never activate the pump',
    runner: {
      startTime: '2026-07-28T06:00:00.000Z',
      stepSeconds: 300,
      recordEverySteps: 6,
      scenarioPreset: 'normal',
      initialState: { soil_moisture_percent: 20, water_level_percent: 10 }
    },
    durationSeconds: 2 * 3600,
    expectations: {
      max_safety_violations: 0,
      max_pump_runtime_seconds: 0,
      require_alert_types: ['LOW_WATER_LEVEL']
    }
  },
  pump_failure_2h: {
    description: 'Pump failure must be reported and must not change physical state',
    runner: {
      startTime: '2026-07-28T06:00:00.000Z',
      stepSeconds: 300,
      recordEverySteps: 6,
      scenarioPreset: 'normal',
      initialState: { soil_moisture_percent: 25, water_level_percent: 80 },
      faults: { pump_failure: true }
    },
    durationSeconds: 2 * 3600,
    expectations: {
      max_safety_violations: 0,
      min_failed_commands: 1,
      max_pump_runtime_seconds: 0
    }
  },
  weak_ventilation_24h: {
    description: 'Reduced ventilation effectiveness must remain deterministic and safe',
    runner: {
      startTime: '2026-07-28T06:00:00.000Z',
      stepSeconds: 300,
      recordEverySteps: 12,
      scenarioPreset: 'weak_ventilation'
    },
    durationSeconds: 24 * 3600,
    expectations: {
      max_safety_violations: 0,
      max_failed_commands: 0
    }
  }
};

export function scenarioDefinition(name) {
  const definition = SCENARIO_CATALOG[name];
  if (!definition) throw new Error(`Unknown scenario: ${name}`);
  return structuredClone(definition);
}
