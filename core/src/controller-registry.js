const CONTROLLER_STATUSES = new Set([
  'BOOTING',
  'ONLINE',
  'DEGRADED',
  'OFFLINE',
  'ERROR'
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function asOptionalString(value, field) {
  if (value === undefined || value === null) return null;
  return asNonEmptyString(value, field);
}

function asDevices(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('devices must be a non-empty array');
  }
  const devices = value.map((item, index) => {
    if (typeof item === 'string') return asNonEmptyString(item, `devices[${index}]`);
    if (isObject(item)) return asNonEmptyString(item.device_id, `devices[${index}].device_id`);
    throw new Error(`devices[${index}] must be a string or object`);
  });
  if (new Set(devices).size !== devices.length) throw new Error('devices must be unique');
  return devices;
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

export class ControllerRegistry {
  constructor({
    now = () => new Date(),
    heartbeatTimeoutSeconds = 30,
    heartbeatIntervalSeconds = 10,
    commandPollIntervalSeconds = 2
  } = {}) {
    if (!Number.isFinite(heartbeatTimeoutSeconds) || heartbeatTimeoutSeconds <= 0) {
      throw new Error('heartbeatTimeoutSeconds must be positive');
    }
    this.now = now;
    this.heartbeatTimeoutSeconds = heartbeatTimeoutSeconds;
    this.heartbeatIntervalSeconds = heartbeatIntervalSeconds;
    this.commandPollIntervalSeconds = commandPollIntervalSeconds;
    this.controllers = new Map();
    this.deviceOwners = new Map();
  }

  register(payload) {
    if (!isObject(payload)) throw new Error('Invalid controller registration payload');
    const controllerId = asNonEmptyString(payload.controller_id, 'controller_id');
    const devices = asDevices(payload.devices);
    const existing = this.controllers.get(controllerId);

    for (const deviceId of devices) {
      const owner = this.deviceOwners.get(deviceId);
      if (owner && owner !== controllerId) {
        throw new Error(`Device ${deviceId} already belongs to controller ${owner}`);
      }
    }

    if (existing) {
      for (const deviceId of existing.devices) {
        if (!devices.includes(deviceId) && this.deviceOwners.get(deviceId) === controllerId) {
          this.deviceOwners.delete(deviceId);
        }
      }
    }

    const timestamp = this.now().toISOString();
    const controller = {
      controller_id: controllerId,
      name: asOptionalString(payload.name, 'name') ?? existing?.name ?? controllerId,
      firmware: asOptionalString(payload.firmware, 'firmware') ?? existing?.firmware ?? 'unknown',
      protocol_version: asOptionalString(payload.protocol_version, 'protocol_version') ?? existing?.protocol_version ?? '1.0',
      status: 'BOOTING',
      registered_at: existing?.registered_at ?? timestamp,
      updated_at: timestamp,
      last_heartbeat: existing?.last_heartbeat ?? null,
      configuration_version: (existing?.configuration_version ?? 0) + 1,
      devices,
      capabilities: Array.isArray(payload.capabilities)
        ? payload.capabilities.filter(item => typeof item === 'string')
        : existing?.capabilities ?? [],
      health: existing?.health ?? null,
      metadata: isObject(payload.metadata) ? structuredClone(payload.metadata) : existing?.metadata ?? {}
    };

    this.controllers.set(controllerId, controller);
    for (const deviceId of devices) this.deviceOwners.set(deviceId, controllerId);
    return structuredClone(controller);
  }

  heartbeat(controllerId, payload = {}) {
    const controller = this.require(controllerId);
    if (!isObject(payload)) throw new Error('Invalid heartbeat payload');
    if (payload.uptime_seconds !== undefined && (
      !Number.isFinite(payload.uptime_seconds) || payload.uptime_seconds < 0
    )) {
      throw new Error('uptime_seconds must be a non-negative number');
    }

    const timestamp = this.now().toISOString();
    controller.status = payload.status === 'DEGRADED' ? 'DEGRADED' : 'ONLINE';
    controller.last_heartbeat = timestamp;
    controller.updated_at = timestamp;
    if (payload.firmware !== undefined) controller.firmware = asNonEmptyString(payload.firmware, 'firmware');
    controller.health = {
      uptime_seconds: payload.uptime_seconds ?? null,
      wifi_rssi: payload.wifi_rssi ?? null,
      free_memory_bytes: payload.free_memory_bytes ?? null,
      cpu_temperature_c: payload.cpu_temperature_c ?? null,
      queue_size: payload.queue_size ?? null,
      reported_at: payload.timestamp ?? timestamp
    };
    return structuredClone(controller);
  }

  refreshHealth() {
    const nowMs = this.now().getTime();
    for (const controller of this.controllers.values()) {
      const reference = controller.last_heartbeat ?? controller.registered_at;
      if (controller.status === 'ERROR' || !validDate(reference)) continue;
      const ageSeconds = (nowMs - new Date(reference).getTime()) / 1000;
      if (ageSeconds > this.heartbeatTimeoutSeconds) {
        controller.status = 'OFFLINE';
        controller.updated_at = this.now().toISOString();
      }
    }
  }

  require(controllerId) {
    const normalized = asNonEmptyString(controllerId, 'controller_id');
    const controller = this.controllers.get(normalized);
    if (!controller) throw new Error(`Unknown controller: ${normalized}`);
    return controller;
  }

  ownerOf(deviceId) {
    return this.deviceOwners.get(deviceId) ?? null;
  }

  assertOwnership(controllerId, deviceId) {
    this.require(controllerId);
    const owner = this.ownerOf(deviceId);
    if (owner !== controllerId) {
      throw new Error(`Device ${deviceId} is not owned by controller ${controllerId}`);
    }
  }

  configuration(controllerId) {
    const controller = this.require(controllerId);
    return {
      controller_id: controller.controller_id,
      configuration_version: controller.configuration_version,
      heartbeat_interval_seconds: this.heartbeatIntervalSeconds,
      heartbeat_timeout_seconds: this.heartbeatTimeoutSeconds,
      command_poll_interval_seconds: this.commandPollIntervalSeconds,
      devices: [...controller.devices]
    };
  }

  list() {
    this.refreshHealth();
    return [...this.controllers.values()].map(controller => structuredClone(controller));
  }

  snapshot() {
    return {
      heartbeat_timeout_seconds: this.heartbeatTimeoutSeconds,
      heartbeat_interval_seconds: this.heartbeatIntervalSeconds,
      command_poll_interval_seconds: this.commandPollIntervalSeconds,
      controllers: Object.fromEntries(
        [...this.controllers.entries()].map(([id, controller]) => [id, structuredClone(controller)])
      ),
      device_owners: Object.fromEntries(this.deviceOwners)
    };
  }

  restore(snapshot) {
    if (!isObject(snapshot) || !isObject(snapshot.controllers) || !isObject(snapshot.device_owners)) {
      throw new Error('Invalid persisted controller registry');
    }
    const controllers = new Map();
    for (const [id, controller] of Object.entries(snapshot.controllers)) {
      if (!isObject(controller) || controller.controller_id !== id) {
        throw new Error(`Invalid persisted controller: ${id}`);
      }
      if (!CONTROLLER_STATUSES.has(controller.status)) {
        throw new Error(`Invalid persisted controller status: ${id}`);
      }
      if (!validDate(controller.registered_at) || !validDate(controller.updated_at)) {
        throw new Error(`Invalid persisted controller timestamps: ${id}`);
      }
      if (controller.last_heartbeat !== null && !validDate(controller.last_heartbeat)) {
        throw new Error(`Invalid persisted controller heartbeat: ${id}`);
      }
      const devices = asDevices(controller.devices);
      controllers.set(id, { ...structuredClone(controller), devices });
    }

    const deviceOwners = new Map();
    for (const [deviceId, controllerId] of Object.entries(snapshot.device_owners)) {
      const controller = controllers.get(controllerId);
      if (!controller || !controller.devices.includes(deviceId)) {
        throw new Error(`Invalid persisted device ownership: ${deviceId}`);
      }
      deviceOwners.set(deviceId, controllerId);
    }
    for (const controller of controllers.values()) {
      for (const deviceId of controller.devices) {
        if (deviceOwners.get(deviceId) !== controller.controller_id) {
          throw new Error(`Missing persisted device ownership: ${deviceId}`);
        }
      }
    }

    this.heartbeatTimeoutSeconds = snapshot.heartbeat_timeout_seconds ?? this.heartbeatTimeoutSeconds;
    this.heartbeatIntervalSeconds = snapshot.heartbeat_interval_seconds ?? this.heartbeatIntervalSeconds;
    this.commandPollIntervalSeconds = snapshot.command_poll_interval_seconds ?? this.commandPollIntervalSeconds;
    this.controllers = controllers;
    this.deviceOwners = deviceOwners;
    this.refreshHealth();
    return this.snapshot();
  }
}
