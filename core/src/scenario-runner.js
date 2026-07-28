import defaultContracts from '../contracts/device-contracts.json' with { type: 'json' };
import defaultRules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from './engine.js';
import { GreenCoreRuntime } from './runtime.js';
import { GreenhouseDigitalTwin } from './digital-twin.js';

function positive(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export class SimulationClock {
  constructor(startTime = '2026-07-28T06:00:00.000Z') {
    const parsed = new Date(startTime);
    if (Number.isNaN(parsed.getTime())) throw new Error('Invalid simulation start time');
    this.current = parsed;
    this.now = () => new Date(this.current);
  }

  advance(seconds) {
    positive(seconds, 'seconds');
    this.current = new Date(this.current.getTime() + seconds * 1000);
    return this.now();
  }
}

export class ScenarioRunner {
  constructor({
    contracts = defaultContracts,
    rules = defaultRules,
    startTime = '2026-07-28T06:00:00.000Z',
    stepSeconds = 300,
    recordEverySteps = 12,
    controllerId = 'controller_primary',
    mode = 'AUTO',
    scenarioPreset = 'normal',
    scenario = {},
    initialState = {},
    faults = {},
    localWaterMinimumPercent = rules.water_level.minimum_for_pump_percent
  } = {}) {
    this.stepSeconds = positive(stepSeconds, 'stepSeconds');
    this.recordEverySteps = Math.max(1, Math.floor(positive(recordEverySteps, 'recordEverySteps')));
    this.controllerId = controllerId;
    this.clock = new SimulationClock(startTime);
    this.engine = new GreenCoreEngine({ contracts, rules, now: this.clock.now });
    this.runtime = new GreenCoreRuntime({ engine: this.engine, now: this.clock.now });
    this.twin = new GreenhouseDigitalTwin({ startTime, state: initialState, scenario });
    if (scenarioPreset) this.twin.applyPreset(scenarioPreset);
    this.rules = rules;
    this.localWaterMinimumPercent = localWaterMinimumPercent;
    this.faults = {
      pump_failure: false,
      fan_failure: false,
      vent_failure: false,
      relay_stuck: false,
      ...structuredClone(faults)
    };
    this.runtime.setMode(mode);
    this.elapsedSeconds = 0;
    this.stepNumber = 0;
    this.timeline = [];
    this.commandResults = [];
    this.actuatorRuntimeSeconds = { pump_01: 0, fan_01: 0, vent_01: 0 };
    this.safetyViolations = [];
    this.extrema = {};
    this.captureExtrema();
    this.record('INITIAL');
  }

  telemetrySamples() {
    const values = this.twin.telemetry();
    const timestamp = this.clock.now().toISOString();
    const simulationTime = this.twin.simulationTime.toISOString();
    return [
      { device_id: 'air_01', metric: 'air_temperature', value: values.air_temperature, unit: '°C' },
      { device_id: 'soil_01', metric: 'soil_moisture', value: values.soil_moisture, unit: '%' },
      { device_id: 'water_01', metric: 'water_level', value: values.water_level, unit: '%' }
    ].map(sample => ({
      ...sample,
      timestamp,
      quality: 'GOOD',
      simulation_time: simulationTime
    }));
  }

  actuatorStates() {
    return Object.fromEntries(
      [...this.engine.actuators.entries()].map(([id, actuator]) => [id, actuator.state])
    );
  }

  actuatorFailure(command) {
    if (this.faults.relay_stuck) return 'RELAY_STUCK';
    if (command.actuator_id === 'pump_01' && this.faults.pump_failure) return 'PUMP_FAILURE';
    if (command.actuator_id === 'fan_01' && this.faults.fan_failure) return 'FAN_FAILURE';
    if (command.actuator_id === 'vent_01' && this.faults.vent_failure) return 'VENT_FAILURE';
    return null;
  }

  executeCommand(command) {
    let status = 'EXECUTED';
    let details = 'scenario runner applied virtual actuator command';
    const waterLevel = this.twin.state.water_level_percent;

    if (
      command.actuator_id === 'pump_01'
      && command.action === 'ON'
      && waterLevel < this.localWaterMinimumPercent
    ) {
      status = 'REJECTED';
      details = 'LOW_WATER_LOCAL_INTERLOCK';
    } else {
      const failure = this.actuatorFailure(command);
      if (failure) {
        status = 'FAILED';
        details = failure;
      }
    }

    if (status === 'EXECUTED' && command.actuator_id === 'pump_01' && command.action === 'ON') {
      if (waterLevel < this.rules.water_level.minimum_for_pump_percent) {
        this.safetyViolations.push({
          type: 'PUMP_EXECUTED_BELOW_CORE_WATER_LIMIT',
          timestamp: this.clock.now().toISOString(),
          water_level_percent: waterLevel
        });
      }
    }

    this.runtime.acknowledge({
      controller_id: command.controller_id,
      command_id: command.command_id,
      actuator_id: command.actuator_id,
      status,
      timestamp: this.clock.now().toISOString(),
      details
    });
    const result = {
      actuator_id: command.actuator_id,
      action: command.action,
      status,
      details,
      timestamp: this.clock.now().toISOString()
    };
    this.commandResults.push(result);
    return result;
  }

  captureExtrema() {
    const metrics = {
      air_temperature_c: this.twin.state.air_temperature_c,
      air_humidity_percent: this.twin.state.air_humidity_percent,
      soil_moisture_percent: this.twin.state.soil_moisture_percent,
      water_level_percent: this.twin.state.water_level_percent,
      plant_health_percent: this.twin.state.plant_health_percent
    };
    for (const [metric, value] of Object.entries(metrics)) {
      const current = this.extrema[metric] ?? { min: value, max: value };
      current.min = Math.min(current.min, value);
      current.max = Math.max(current.max, value);
      this.extrema[metric] = current;
    }
  }

  record(reason = 'STEP') {
    this.timeline.push({
      reason,
      step: this.stepNumber,
      elapsed_seconds: this.elapsedSeconds,
      timestamp: this.clock.now().toISOString(),
      simulation_time: this.twin.simulationTime.toISOString(),
      state: structuredClone(this.twin.state),
      actuators: this.actuatorStates(),
      active_alert_types: [...new Set(this.engine.alerts.map(alert => alert.type))]
    });
  }

  runStep(seconds = this.stepSeconds) {
    positive(seconds, 'seconds');
    this.runtime.heartbeat(this.controllerId, {
      uptime_seconds: this.elapsedSeconds,
      queue_size: this.engine.pendingCommands.size,
      timestamp: this.clock.now().toISOString()
    });
    this.runtime.ingestControllerTelemetry(this.controllerId, this.telemetrySamples());
    const commands = this.runtime.evaluate();
    const commandResults = commands.map(command => this.executeCommand(command));
    const states = this.actuatorStates();

    if (states.pump_01 === 'ON') this.actuatorRuntimeSeconds.pump_01 += seconds;
    if (states.fan_01 === 'ON') this.actuatorRuntimeSeconds.fan_01 += seconds;
    if (states.vent_01 === 'OPEN') this.actuatorRuntimeSeconds.vent_01 += seconds;

    this.twin.step(seconds, states);
    this.clock.advance(seconds);
    this.elapsedSeconds += seconds;
    this.stepNumber += 1;
    this.captureExtrema();
    if (this.stepNumber % this.recordEverySteps === 0) this.record();
    return { commands, commandResults, state: this.twin.snapshot() };
  }

  summary() {
    const alertTypes = this.engine.alerts.map(alert => alert.type);
    return {
      start_time: this.timeline[0].timestamp,
      end_time: this.clock.now().toISOString(),
      elapsed_seconds: this.elapsedSeconds,
      steps: this.stepNumber,
      final_state: structuredClone(this.twin.state),
      scenario: structuredClone(this.twin.scenario),
      extrema: structuredClone(this.extrema),
      actuator_runtime_seconds: structuredClone(this.actuatorRuntimeSeconds),
      commands: {
        total: this.commandResults.length,
        by_status: countBy(this.commandResults, result => result.status),
        by_actuator_action: countBy(this.commandResults, result => `${result.actuator_id}:${result.action}`)
      },
      alerts: {
        total: this.engine.alerts.length,
        by_type: countBy(this.engine.alerts, alert => alert.type),
        types: [...new Set(alertTypes)]
      },
      safety_violations: structuredClone(this.safetyViolations)
    };
  }

  evaluateExpectations(expectations, summary = this.summary()) {
    const checks = [];
    const add = (name, actual, operator, expected, passed) => {
      checks.push({ name, actual, operator, expected, passed });
    };

    if (expectations.max_air_temperature_c !== undefined) {
      const actual = summary.extrema.air_temperature_c.max;
      add('max_air_temperature_c', actual, '<=', expectations.max_air_temperature_c, actual <= expectations.max_air_temperature_c);
    }
    if (expectations.min_soil_moisture_percent !== undefined) {
      const actual = summary.extrema.soil_moisture_percent.min;
      add('min_soil_moisture_percent', actual, '>=', expectations.min_soil_moisture_percent, actual >= expectations.min_soil_moisture_percent);
    }
    if (expectations.min_water_level_percent !== undefined) {
      const actual = summary.extrema.water_level_percent.min;
      add('min_water_level_percent', actual, '>=', expectations.min_water_level_percent, actual >= expectations.min_water_level_percent);
    }
    if (expectations.min_plant_health_percent !== undefined) {
      const actual = summary.extrema.plant_health_percent.min;
      add('min_plant_health_percent', actual, '>=', expectations.min_plant_health_percent, actual >= expectations.min_plant_health_percent);
    }
    if (expectations.max_safety_violations !== undefined) {
      const actual = summary.safety_violations.length;
      add('max_safety_violations', actual, '<=', expectations.max_safety_violations, actual <= expectations.max_safety_violations);
    }
    if (expectations.max_failed_commands !== undefined) {
      const actual = summary.commands.by_status.FAILED ?? 0;
      add('max_failed_commands', actual, '<=', expectations.max_failed_commands, actual <= expectations.max_failed_commands);
    }
    if (expectations.min_failed_commands !== undefined) {
      const actual = summary.commands.by_status.FAILED ?? 0;
      add('min_failed_commands', actual, '>=', expectations.min_failed_commands, actual >= expectations.min_failed_commands);
    }
    if (expectations.max_rejected_commands !== undefined) {
      const actual = summary.commands.by_status.REJECTED ?? 0;
      add('max_rejected_commands', actual, '<=', expectations.max_rejected_commands, actual <= expectations.max_rejected_commands);
    }
    if (expectations.max_pump_runtime_seconds !== undefined) {
      const actual = summary.actuator_runtime_seconds.pump_01;
      add('max_pump_runtime_seconds', actual, '<=', expectations.max_pump_runtime_seconds, actual <= expectations.max_pump_runtime_seconds);
    }
    for (const type of expectations.require_alert_types ?? []) {
      const actual = summary.alerts.types.includes(type);
      add(`require_alert:${type}`, actual, '===', true, actual === true);
    }
    for (const type of expectations.forbid_alert_types ?? []) {
      const actual = summary.alerts.types.includes(type);
      add(`forbid_alert:${type}`, actual, '===', false, actual === false);
    }

    return { passed: checks.every(check => check.passed), checks };
  }

  run({ durationSeconds, expectations = {} }) {
    positive(durationSeconds, 'durationSeconds');
    let remaining = durationSeconds;
    while (remaining > 0) {
      const step = Math.min(this.stepSeconds, remaining);
      this.runStep(step);
      remaining -= step;
    }
    if (this.timeline.at(-1)?.elapsed_seconds !== this.elapsedSeconds) this.record('FINAL');
    const summary = this.summary();
    const evaluation = this.evaluateExpectations(expectations, summary);
    return {
      passed: evaluation.passed,
      checks: evaluation.checks,
      summary,
      timeline: structuredClone(this.timeline)
    };
  }
}
