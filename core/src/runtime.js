import { ControllerRegistry } from './controller-registry.js';

const DEFAULT_CONTROLLER = {
  controller_id: 'controller_primary',
  name: 'Primary greenhouse controller',
  firmware: 'virtual-0.1.0',
  protocol_version: '1.0',
  capabilities: ['telemetry', 'commands', 'heartbeat'],
  devices: ['soil_01', 'air_01', 'water_01', 'pump_01', 'fan_01', 'vent_01'],
  metadata: { bootstrap: true }
};

export class GreenCoreRuntime {
  constructor({ engine, registry, now = () => new Date() }) {
    if (!engine) throw new Error('engine is required');
    this.engine = engine;
    this.now = now;
    this.registry = registry ?? new ControllerRegistry({ now });
    if (this.registry.controllers.size === 0) this.registry.register(DEFAULT_CONTROLLER);
  }

  get alerts() { return this.engine.alerts; }
  get events() { return this.engine.events; }
  get mode() { return this.engine.mode; }
  get connected() { return this.engine.connected; }
  get telemetry() { return this.engine.telemetry; }
  get pendingCommands() { return this.engine.pendingCommands; }

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

  acknowledge(ack) {
    if (!ack?.controller_id) throw new Error('Acknowledgement controller_id is required');
    const command = this.engine.pendingCommands.get(ack.command_id);
    if (!command) throw new Error(`Unknown or completed command: ${ack.command_id}`);
    if (!command.controller_id) this.assignCommand(command);
    if (command.controller_id !== ack.controller_id) {
      throw new Error(`Acknowledgement controller mismatch: ${ack.controller_id}`);
    }
    this.registry.assertOwnership(ack.controller_id, command.actuator_id);
    command.delivery_status = ack.status;
    if (ack.status === 'ACCEPTED') command.accepted_at = ack.timestamp ?? this.now().toISOString();
    return this.engine.acknowledge(ack);
  }

  snapshot() {
    const controllerState = this.registry.snapshot();
    return {
      ...this.engine.snapshot(),
      state_version: 2,
      controllers: controllerState.controllers,
      device_owners: controllerState.device_owners,
      controller_contract: {
        heartbeat_timeout_seconds: controllerState.heartbeat_timeout_seconds,
        heartbeat_interval_seconds: controllerState.heartbeat_interval_seconds,
        command_poll_interval_seconds: controllerState.command_poll_interval_seconds
      }
    };
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
    for (const command of this.engine.pendingCommands.values()) {
      if (!command.controller_id) this.assignCommand(command);
      this.registry.assertOwnership(command.controller_id, command.actuator_id);
      command.delivery_status ??= 'QUEUED';
    }
    return this.snapshot();
  }
}
