import { ControllerRegistry } from './controller-registry.js';

const TERMINAL_ACK_STATUSES = new Set(['EXECUTED', 'REJECTED', 'EXPIRED', 'FAILED']);

const DEFAULT_CONTROLLER = {
  controller_id: 'controller_primary',
  name: 'Primary greenhouse controller',
  firmware: 'virtual-0.1.0',
  protocol_version: '1.0',
  capabilities: ['telemetry', 'commands', 'heartbeat'],
  devices: ['soil_01', 'air_01', 'water_01', 'pump_01', 'fan_01', 'vent_01'],
  metadata: { bootstrap: true }
};

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class GreenCoreRuntime {
  constructor({ engine, registry, now = () => new Date(), completedAckLimit = 1000 }) {
    if (!engine) throw new Error('engine is required');
    this.engine = engine;
    this.now = now;
    this.completedAckLimit = positiveInteger(completedAckLimit, 'completedAckLimit');
    this.completedAcks = new Map();
    this.registry = registry ?? new ControllerRegistry({ now });
    if (this.registry.controllers.size === 0) this.registry.register(DEFAULT_CONTROLLER);
  }

  get alerts() { return this.engine.alerts; }
  get events() { return this.engine.events; }
  get mode() { return this.engine.mode; }
  get connected() { return this.engine.connected; }
  get telemetry() { return this.engine.telemetry; }
  get pendingCommands() { return this.engine.pendingCommands; }

  policyCatalog() { return this.engine.policyCatalog(); }
  policyDecisionHistory(limit = 100) { return this.engine.policyDecisionHistory(limit); }

  setMode(mode) { return this.engine.setMode(mode); }
  setConnectivity(connected) { return this.engine.setConnectivity(connected); }
  requestManual(...args) { return this.engine.requestManual(...args); }
  validateTelemetry(sample) { return this.engine.validateTelemetry(sample); }
  ingest(sample) { return this.engine.ingest(sample); }

  registerController(payload) {
    const controller = this.registry.register(payload);
    this.engine.log?.('CONTROLLER_REGISTERED', {
      controller_id: controller.controller_id,
      devices: controller.devices,
      configuration_version: controller.configuration_version
    });
    return controller;
  }

  heartbeat(controllerId, payload) {
    const controller = this.registry.heartbeat(controllerId, payload);
    this.engine.log?.('CONTROLLER_HEARTBEAT', {
      controller_id: controllerId,
      status: controller.status
    });
    return controller;
  }

  listControllers() {
    return this.registry.list();
  }

  controllerConfiguration(controllerId) {
    return this.registry.configuration(controllerId);
  }

  ingestControllerTelemetry(controllerId, samples) {
    const list = Array.isArray(samples) ? samples : [samples];
    if (list.length === 0) throw new Error('At least one telemetry sample is required');
    const checked = list.map(sample => {
      this.registry.assertOwnership(controllerId, sample?.device_id);
      return this.engine.validateTelemetry(sample);
    });
    return checked.map(sample => this.engine.ingest(sample));
  }

  evaluate() {
    this.registry.refreshHealth();
    const commands = this.engine.evaluate();
    for (const command of commands) this.assignCommand(command);
    return commands;
  }

  assignCommand(command) {
    const controllerId = this.registry.ownerOf(command.actuator_id);
    if (!controllerId) throw new Error(`No controller owns actuator ${command.actuator_id}`);
    command.controller_id = controllerId;
    command.delivery_status ??= 'QUEUED';
    this.engine.log?.('COMMAND_QUEUED_FOR_CONTROLLER', {
      command_id: command.command_id,
      controller_id: controllerId,
      actuator_id: command.actuator_id
    });
    return command;
  }

  controllerCommands(controllerId) {
    this.registry.require(controllerId);
    this.engine.expireCommands?.();
    const deliveredAt = this.now().toISOString();
    const commands = [];
    for (const command of this.engine.pendingCommands.values()) {
      if (!command.controller_id) this.assignCommand(command);
      if (command.controller_id !== controllerId) continue;
      if (!command.delivered_at) command.delivered_at = deliveredAt;
      command.delivery_status = command.delivery_status === 'ACCEPTED' ? 'ACCEPTED' : 'DELIVERED';
      commands.push(structuredClone(command));
    }
    if (commands.length > 0) {
      this.engine.log?.('COMMANDS_DELIVERED', {
        controller_id: controllerId,
        command_ids: commands.map(command => command.command_id)
      });
    }
    return commands;
  }

  validateDuplicateAck(ack, completed) {
    if (completed.controller_id !== ack.controller_id) {
      throw new Error(`Acknowledgement controller mismatch: ${ack.controller_id}`);
    }
    if (completed.actuator_id !== ack.actuator_id) {
      throw new Error(`Acknowledgement actuator mismatch: ${ack.actuator_id}`);
    }
    if (completed.status !== ack.status) {
      throw new Error(`Acknowledgement terminal status mismatch: ${ack.status}`);
    }
    this.registry.assertOwnership(ack.controller_id, completed.actuator_id);
  }

  rememberCompletedAck(command, ack, acknowledgedCommand) {
    const record = {
      command_id: command.command_id,
      controller_id: command.controller_id,
      actuator_id: command.actuator_id,
      status: ack.status,
      acknowledged_at: ack.timestamp ?? this.now().toISOString(),
      details: ack.details ?? null,
      command: structuredClone(acknowledgedCommand)
    };
    this.completedAcks.delete(record.command_id);
    this.completedAcks.set(record.command_id, record);
    while (this.completedAcks.size > this.completedAckLimit) {
      this.completedAcks.delete(this.completedAcks.keys().next().value);
    }
    return record;
  }

  acknowledge(ack) {
    if (!ack?.controller_id) throw new Error('Acknowledgement controller_id is required');
    if (!ack?.command_id) throw new Error('Acknowledgement command_id is required');
    const command = this.engine.pendingCommands.get(ack.command_id);
    if (!command) {
      const completed = this.completedAcks.get(ack.command_id);
      if (!completed) throw new Error(`Unknown command: ${ack.command_id}`);
      this.validateDuplicateAck(ack, completed);
      this.engine.log?.('DUPLICATE_TERMINAL_ACK_IGNORED', {
        command_id: ack.command_id,
        controller_id: ack.controller_id,
        actuator_id: ack.actuator_id,
        status: ack.status
      });
      return { ...structuredClone(completed.command), duplicate_ack: true };
    }
    if (!command.controller_id) this.assignCommand(command);
    if (command.controller_id !== ack.controller_id) {
      throw new Error(`Acknowledgement controller mismatch: ${ack.controller_id}`);
    }
    this.registry.assertOwnership(ack.controller_id, command.actuator_id);
    command.delivery_status = ack.status;
    if (ack.status === 'ACCEPTED') command.accepted_at = ack.timestamp ?? this.now().toISOString();
    const acknowledgedCommand = this.engine.acknowledge(ack);
    if (TERMINAL_ACK_STATUSES.has(ack.status)) {
      this.rememberCompletedAck(command, ack, acknowledgedCommand);
    }
    return acknowledgedCommand;
  }

  snapshot() {
    const controllerState = this.registry.snapshot();
    const engineState = this.engine.snapshot();
    return {
      ...engineState,
      state_version: 3,
      mode: engineState.effective_mode,
      controllers: controllerState.controllers,
      device_owners: controllerState.device_owners,
      controller_contract: {
        heartbeat_timeout_seconds: controllerState.heartbeat_timeout_seconds,
        heartbeat_interval_seconds: controllerState.heartbeat_interval_seconds,
        command_poll_interval_seconds: controllerState.command_poll_interval_seconds,
        completed_ack_limit: this.completedAckLimit
      },
      completed_command_acks: [...this.completedAcks.values()].map(record => structuredClone(record))
    };
  }

  restoreCompletedAcks(records) {
    if (records === undefined) {
      this.completedAcks = new Map();
      return;
    }
    if (!Array.isArray(records)) throw new Error('Invalid persisted completed command ACKs');
    const restored = new Map();
    for (const record of records) {
      if (!isObject(record)
        || typeof record.command_id !== 'string'
        || typeof record.controller_id !== 'string'
        || typeof record.actuator_id !== 'string'
        || !TERMINAL_ACK_STATUSES.has(record.status)
        || Number.isNaN(new Date(record.acknowledged_at).getTime())
        || !isObject(record.command)) {
        throw new Error('Invalid persisted completed command ACK');
      }
      if (record.command.command_id !== record.command_id
        || record.command.actuator_id !== record.actuator_id
        || record.command.controller_id !== record.controller_id) {
        throw new Error(`Persisted completed ACK command mismatch: ${record.command_id}`);
      }
      this.registry.assertOwnership(record.controller_id, record.actuator_id);
      restored.delete(record.command_id);
      restored.set(record.command_id, structuredClone(record));
    }
    this.completedAcks = restored;
    while (this.completedAcks.size > this.completedAckLimit) {
      this.completedAcks.delete(this.completedAcks.keys().next().value);
    }
  }

  restore(snapshot, options) {
    this.engine.restore(snapshot, options);
    if (snapshot?.controllers && snapshot?.device_owners) {
      this.registry.restore({
        controllers: snapshot.controllers,
        device_owners: snapshot.device_owners,
        heartbeat_timeout_seconds: snapshot.controller_contract?.heartbeat_timeout_seconds,
        heartbeat_interval_seconds: snapshot.controller_contract?.heartbeat_interval_seconds,
        command_poll_interval_seconds: snapshot.controller_contract?.command_poll_interval_seconds
      });
    }
    if (snapshot?.controller_contract?.completed_ack_limit !== undefined) {
      this.completedAckLimit = positiveInteger(
        snapshot.controller_contract.completed_ack_limit,
        'completed_ack_limit'
      );
    }
    for (const command of this.engine.pendingCommands.values()) {
      if (!command.controller_id) this.assignCommand(command);
      this.registry.assertOwnership(command.controller_id, command.actuator_id);
      command.delivery_status ??= 'QUEUED';
    }
    this.restoreCompletedAcks(snapshot?.completed_command_acks);
    return this.snapshot();
  }
}
