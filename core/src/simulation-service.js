import crypto from 'node:crypto';
import { ScenarioRunner } from './scenario-runner.js';
import { SCENARIO_CATALOG, scenarioDefinition } from './scenario-catalog.js';
import { FaultCampaignRunner } from './fault-campaign-runner.js';
import { FAULT_CAMPAIGN_CATALOG, faultCampaignDefinition } from './fault-campaign-catalog.js';

const KINDS = new Set(['scenario', 'fault']);

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function publicCatalog(catalog) {
  return Object.fromEntries(Object.entries(catalog).map(([name, definition]) => [name, {
    name,
    description: definition.description,
    duration_seconds: definition.durationSeconds,
    step_seconds: definition.runner.stepSeconds,
    scenario_preset: definition.runner.scenarioPreset ?? null,
    fault_event_count: definition.runner.faultSchedule?.length ?? 0
  }]));
}

function metrics(summary) {
  return {
    final_plant_health_percent: summary.final_state.plant_health_percent,
    min_plant_health_percent: summary.extrema.plant_health_percent.min,
    min_soil_moisture_percent: summary.extrema.soil_moisture_percent.min,
    max_air_temperature_c: summary.extrema.air_temperature_c.max,
    min_water_level_percent: summary.extrema.water_level_percent.min,
    cumulative_water_used_percent: summary.final_state.cumulative_water_used_percent,
    pump_runtime_seconds: summary.actuator_runtime_seconds.pump_01,
    fan_runtime_seconds: summary.actuator_runtime_seconds.fan_01,
    command_count: summary.commands.total,
    alert_count: summary.alerts.total,
    safety_violation_count: summary.safety_violations.length
  };
}

export class SimulationService {
  constructor({ now = () => new Date(), maxReports = 50 } = {}) {
    this.now = now;
    this.maxReports = positiveInteger(maxReports, 'maxReports');
    this.reports = new Map();
  }

  catalog() {
    return {
      scenarios: publicCatalog(SCENARIO_CATALOG),
      fault_campaigns: publicCatalog(FAULT_CAMPAIGN_CATALOG),
      comparison_modes: {
        automatic: 'AUTO',
        manual_baseline: 'MANUAL_WITHOUT_OPERATOR_INTERVENTIONS'
      },
      model_notice: 'Results are deterministic software simulations using test-only control thresholds. They are not agronomic yield forecasts.'
    };
  }

  definition(kind, name) {
    if (!KINDS.has(kind)) throw new Error(`Unsupported simulation kind: ${kind}`);
    if (typeof name !== 'string' || name.length === 0) throw new Error('Simulation name is required');
    return kind === 'scenario' ? scenarioDefinition(name) : faultCampaignDefinition(name);
  }

  createReport(payload) {
    const report = {
      report_id: `sim_${crypto.randomUUID()}`,
      created_at: this.now().toISOString(),
      ...structuredClone(payload)
    };
    this.reports.set(report.report_id, report);
    while (this.reports.size > this.maxReports) this.reports.delete(this.reports.keys().next().value);
    return structuredClone(report);
  }

  run({ kind = 'scenario', name, include_timeline = false } = {}) {
    const definition = this.definition(kind, name);
    const runner = kind === 'scenario'
      ? new ScenarioRunner(definition.runner)
      : new FaultCampaignRunner(definition.runner);
    const result = runner.run({
      durationSeconds: definition.durationSeconds,
      expectations: definition.expectations
    });
    return this.createReport({
      type: 'simulation',
      kind,
      name,
      description: definition.description,
      passed: result.passed,
      checks: result.checks,
      summary: result.summary,
      timeline: include_timeline ? result.timeline : undefined,
      model_notice: 'Simulation result only; physical equipment and agronomic outcomes are not validated.'
    });
  }

  compare({ name, include_timeline = false } = {}) {
    const definition = this.definition('scenario', name);
    const automatic = new ScenarioRunner({ ...definition.runner, mode: 'AUTO' }).run({
      durationSeconds: definition.durationSeconds
    });
    const manual = new ScenarioRunner({ ...definition.runner, mode: 'MANUAL' }).run({
      durationSeconds: definition.durationSeconds
    });
    const automaticMetrics = metrics(automatic.summary);
    const manualMetrics = metrics(manual.summary);
    const deltas = Object.fromEntries(
      Object.keys(automaticMetrics).map(key => [key, automaticMetrics[key] - manualMetrics[key]])
    );

    return this.createReport({
      type: 'comparison',
      kind: 'scenario',
      name,
      description: definition.description,
      strategies: {
        automatic: {
          label: 'AUTO',
          metrics: automaticMetrics,
          summary: automatic.summary,
          timeline: include_timeline ? automatic.timeline : undefined
        },
        manual_baseline: {
          label: 'MANUAL_WITHOUT_OPERATOR_INTERVENTIONS',
          metrics: manualMetrics,
          summary: manual.summary,
          timeline: include_timeline ? manual.timeline : undefined
        }
      },
      automatic_minus_manual: deltas,
      interpretation: {
        health_delta_percent_points: deltas.final_plant_health_percent,
        water_use_delta_percent_of_tank: deltas.cumulative_water_used_percent,
        note: 'The manual baseline intentionally contains no operator interventions. It is not a model of a skilled human operator.'
      },
      model_notice: 'Comparison is a deterministic demonstration, not a validated agronomic or economic forecast.'
    });
  }

  get(reportId) {
    const report = this.reports.get(reportId);
    if (!report) throw new Error(`Unknown simulation report: ${reportId}`);
    return structuredClone(report);
  }

  list({ limit = 20 } = {}) {
    positiveInteger(limit, 'limit');
    if (limit > 100) throw new Error('limit must not exceed 100');
    return [...this.reports.values()].slice(-limit).reverse().map(report => ({
      report_id: report.report_id,
      created_at: report.created_at,
      type: report.type,
      kind: report.kind,
      name: report.name,
      description: report.description,
      passed: report.passed ?? null
    }));
  }

  snapshot() {
    return {
      state_version: 1,
      max_reports: this.maxReports,
      reports: [...this.reports.values()].map(report => structuredClone(report))
    };
  }

  restore(snapshot) {
    if (!isObject(snapshot) || snapshot.state_version !== 1 || !Array.isArray(snapshot.reports)) {
      throw new Error('Invalid persisted simulation service state');
    }
    const maxReports = positiveInteger(snapshot.max_reports ?? this.maxReports, 'max_reports');
    const reports = new Map();
    for (const report of snapshot.reports) {
      if (!isObject(report)
        || typeof report.report_id !== 'string'
        || typeof report.type !== 'string'
        || typeof report.kind !== 'string'
        || typeof report.name !== 'string'
        || !validDate(report.created_at)) {
        throw new Error('Invalid persisted simulation report');
      }
      reports.delete(report.report_id);
      reports.set(report.report_id, structuredClone(report));
    }
    this.maxReports = maxReports;
    this.reports = reports;
    while (this.reports.size > this.maxReports) this.reports.delete(this.reports.keys().next().value);
    return this.snapshot();
  }
}
