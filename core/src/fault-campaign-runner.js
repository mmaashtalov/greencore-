import defaultContracts from '../contracts/device-contracts.json' with { type: 'json' };
import defaultRules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from './engine.js';
import { GreenCoreRuntime } from './runtime.js';
import { ScenarioRunner } from './scenario-runner.js';

const FAULT_TYPES = new Set([
  'CONTROLLER_OFFLINE',
  'CONTROLLER_ONLINE',
  'COMMAND_DELIVERY_OFF',
  'COMMAND_DELIVERY_ON',
  'CLOUD_CONNECTIVITY_OFF',
  'CLOUD_CONNECTIVITY_ON',
  'RUNTIME_RESTART',
  'DUPLICATE_LAST_ACK'
]);

function normalizeSchedule(schedule) {
  if (!Array.isArray(schedule)) throw new Error('faultSchedule must be an array');
  return schedule.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`Invalid fault event at index ${index}`);
    }
    if (!Number.isFinite(event.at_seconds) || event.at_seconds < 0) {
      throw new Error(`Invalid fault event time at index ${index}`);
    }
    if (!FAULT_TYPES.has(event.type)) throw new Error(`Unknown fault event type: ${event.type}`);
    return { ...structuredClone(event), applied: false };
  }).sort((left, right) => left.at_seconds - right.at_seconds);
}

export class FaultCampaignRunner extends ScenarioRunner {
  constructor({
    contracts = defaultContracts,
    rules = defaultRules,
    faultSchedule = [],
    ...options
  } = {}) {
    super({ contracts, rules, ...options });
    this.contracts = contracts;
    this.faultSchedule = normalizeSchedule(faultSchedule);
    this.controllerOnline = true;
    this.commandDeliveryEnabled = true;
    this.appliedFaultEvents = [];
    this.runtimeRestarts = 0;
    this.duplicateAcks = 0;
    this.duplicateAckFailures = [];
    this.lastTerminalAck = null;
  }

  executeCommand(command) {
    const result = super.executeCommand(command);
    this.lastTerminalAck = {
      controller_id: command.controller_id,
      command_id: command.command_id,
      actuator_id: command.actuator_id,
      status: result.status,
      timestamp: result.timestamp,
      details: result.details
    };
    return result;
  }

  restartRuntime() {
    const snapshot = this.runtime.snapshot();
    const engine = new GreenCoreEngine({
      contracts: this.contracts,
      rules: this.rules,
      now: this.clock.now
    });
    const runtime = new GreenCoreRuntime({ engine, now: this.clock.now });
    runtime.restore(snapshot);
    this.engine = engine;
    this.runtime = runtime;
    this.runtimeRestarts += 1;
  }

  duplicateLastAck() {
    if (!this.lastTerminalAck) {
      this.duplicateAckFailures.push({
        timestamp: this.clock.now().toISOString(),
        error: 'No terminal ACK available for replay'
      });
      return;
    }
    try {
      const result = this.runtime.acknowledge({
        ...this.lastTerminalAck,
        timestamp: this.clock.now().toISOString(),
        details: 'fault campaign duplicate ACK replay'
      });
      if (result.duplicate_ack) this.duplicateAcks += 1;
    } catch (error) {
      this.duplicateAckFailures.push({
        timestamp: this.clock.now().toISOString(),
        error: error.message
      });
    }
  }

  applyFaultEvent(event) {
    switch (event.type) {
      case 'CONTROLLER_OFFLINE':
        this.controllerOnline = false;
        break;
      case 'CONTROLLER_ONLINE':
        this.controllerOnline = true;
        break;
      case 'COMMAND_DELIVERY_OFF':
        this.commandDeliveryEnabled = false;
        break;
      case 'COMMAND_DELIVERY_ON':
        this.commandDeliveryEnabled = true;
        break;
      case 'CLOUD_CONNECTIVITY_OFF':
        this.runtime.setConnectivity(false);
        break;
      case 'CLOUD_CONNECTIVITY_ON':
        this.runtime.setConnectivity(true);
        break;
      case 'RUNTIME_RESTART':
        this.restartRuntime();
        break;
      case 'DUPLICATE_LAST_ACK':
        this.duplicateLastAck();
        break;
      default:
        throw new Error(`Unsupported fault event: ${event.type}`);
    }
    event.applied = true;
    this.appliedFaultEvents.push({
      type: event.type,
      scheduled_at_seconds: event.at_seconds,
      applied_at_seconds: this.elapsedSeconds,
      timestamp: this.clock.now().toISOString()
    });
    this.record(`FAULT:${event.type}`);
  }

  applyDueFaultEvents() {
    for (const event of this.faultSchedule) {
      if (!event.applied && event.at_seconds <= this.elapsedSeconds) this.applyFaultEvent(event);
    }
  }

  runStep(seconds = this.stepSeconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('seconds must be positive');
    this.applyDueFaultEvents();

    if (this.controllerOnline) {
      this.runtime.heartbeat(this.controllerId, {
        uptime_seconds: this.elapsedSeconds,
        queue_size: this.engine.pendingCommands.size,
        timestamp: this.clock.now().toISOString()
      });
      this.runtime.ingestControllerTelemetry(this.controllerId, this.telemetrySamples());
    }

    const commands = this.runtime.evaluate();
    let deliveredCommands = [];
    let commandResults = [];
    if (this.controllerOnline && this.commandDeliveryEnabled) {
      deliveredCommands = this.runtime.controllerCommands(this.controllerId);
      commandResults = deliveredCommands.map(command => this.executeCommand(command));
    }

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
    return {
      commands,
      deliveredCommands,
      commandResults,
      state: this.twin.snapshot()
    };
  }

  summary() {
    const base = super.summary();
    const controllers = this.runtime.listControllers();
    return {
      ...base,
      resilience: {
        runtime_restarts: this.runtimeRestarts,
        duplicate_acks_accepted: this.duplicateAcks,
        duplicate_ack_failures: structuredClone(this.duplicateAckFailures),
        fault_events_applied: structuredClone(this.appliedFaultEvents),
        controller_online_transport: this.controllerOnline,
        command_delivery_enabled: this.commandDeliveryEnabled,
        controller_status: controllers.find(item => item.controller_id === this.controllerId)?.status ?? null,
        pending_commands: this.engine.pendingCommands.size,
        completed_ack_cache_size: this.runtime.completedAcks.size
      }
    };
  }

  evaluateExpectations(expectations, summary = this.summary()) {
    const base = super.evaluateExpectations(expectations, summary);
    const checks = [...base.checks];
    const add = (name, actual, operator, expected, passed) => {
      checks.push({ name, actual, operator, expected, passed });
    };

    if (expectations.min_runtime_restarts !== undefined) {
      const actual = summary.resilience.runtime_restarts;
      add('min_runtime_restarts', actual, '>=', expectations.min_runtime_restarts, actual >= expectations.min_runtime_restarts);
    }
    if (expectations.min_duplicate_acks_accepted !== undefined) {
      const actual = summary.resilience.duplicate_acks_accepted;
      add('min_duplicate_acks_accepted', actual, '>=', expectations.min_duplicate_acks_accepted, actual >= expectations.min_duplicate_acks_accepted);
    }
    if (expectations.max_duplicate_ack_failures !== undefined) {
      const actual = summary.resilience.duplicate_ack_failures.length;
      add('max_duplicate_ack_failures', actual, '<=', expectations.max_duplicate_ack_failures, actual <= expectations.max_duplicate_ack_failures);
    }
    if (expectations.min_fault_events_applied !== undefined) {
      const actual = summary.resilience.fault_events_applied.length;
      add('min_fault_events_applied', actual, '>=', expectations.min_fault_events_applied, actual >= expectations.min_fault_events_applied);
    }
    if (expectations.final_controller_status !== undefined) {
      const actual = summary.resilience.controller_status;
      add('final_controller_status', actual, '===', expectations.final_controller_status, actual === expectations.final_controller_status);
    }
    if (expectations.max_pending_commands !== undefined) {
      const actual = summary.resilience.pending_commands;
      add('max_pending_commands', actual, '<=', expectations.max_pending_commands, actual <= expectations.max_pending_commands);
    }

    return { passed: checks.every(check => check.passed), checks };
  }
}
