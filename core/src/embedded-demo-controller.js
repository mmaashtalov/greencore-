import { DigitalTwinControllerEmulator } from './digital-twin-controller.js';

function positiveNumber(value, field, fallback) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be a positive number`);
  return parsed;
}

function nonEmpty(value, fallback = null) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export class EmbeddedDemoController {
  constructor({
    enabled = false,
    apiKey = null,
    controllerId = 'controller_primary',
    firmware = 'embedded-demo-1.0.0',
    simulationSpeed = 60,
    scenarioPreset = 'normal',
    mode = 'AUTO',
    createEmulator = options => new DigitalTwinControllerEmulator(options)
  } = {}) {
    this.enabled = Boolean(enabled);
    this.apiKey = nonEmpty(apiKey);
    this.controllerId = nonEmpty(controllerId, 'controller_primary');
    this.firmware = nonEmpty(firmware, 'embedded-demo-1.0.0');
    this.simulationSpeed = positiveNumber(simulationSpeed, 'simulationSpeed', 60);
    this.scenarioPreset = nonEmpty(scenarioPreset, 'normal');
    this.mode = nonEmpty(mode, 'AUTO');
    this.createEmulator = createEmulator;
    this.emulator = null;
    this.startedAt = null;
    this.lastError = null;
  }

  static fromEnv(env = process.env) {
    return new EmbeddedDemoController({
      enabled: env.EMBEDDED_DEMO_ENABLED === 'true',
      apiKey: env.EMBEDDED_CONTROLLER_API_KEY,
      controllerId: env.EMBEDDED_CONTROLLER_ID ?? 'controller_primary',
      firmware: env.EMBEDDED_CONTROLLER_FIRMWARE ?? 'embedded-demo-1.0.0',
      simulationSpeed: env.EMBEDDED_DEMO_SPEED ?? 60,
      scenarioPreset: env.EMBEDDED_DEMO_PRESET ?? 'normal',
      mode: env.EMBEDDED_DEMO_MODE ?? 'AUTO'
    });
  }

  status() {
    return {
      enabled: this.enabled,
      running: Boolean(this.emulator?.running),
      controller_id: this.controllerId,
      firmware: this.firmware,
      simulation_speed: this.simulationSpeed,
      scenario_preset: this.scenarioPreset,
      mode: this.mode,
      started_at: this.startedAt,
      last_error: this.lastError
    };
  }

  async start({ baseUrl, runtime, persist = async () => {} }) {
    if (!this.enabled) return this.status();
    if (this.emulator?.running) return this.status();
    if (!this.apiKey) throw new Error('EMBEDDED_CONTROLLER_API_KEY is required when embedded demo is enabled');
    if (!runtime || typeof runtime.setMode !== 'function' || typeof runtime.snapshot !== 'function') {
      throw new Error('runtime with setMode() and snapshot() is required');
    }
    if (typeof persist !== 'function') throw new Error('persist must be a function');

    try {
      runtime.setMode(this.mode);
      await persist(runtime.snapshot());
      const emulator = this.createEmulator({
        baseUrl,
        controllerId: this.controllerId,
        firmware: this.firmware,
        apiKey: this.apiKey,
        simulationSpeed: this.simulationSpeed,
        scenarioPreset: this.scenarioPreset
      });
      await emulator.start();
      this.emulator = emulator;
      this.startedAt = new Date().toISOString();
      this.lastError = null;
      return this.status();
    } catch (error) {
      this.emulator?.stop?.();
      this.emulator = null;
      this.lastError = error.message;
      throw error;
    }
  }

  stop() {
    this.emulator?.stop?.();
    this.emulator = null;
    return this.status();
  }
}
