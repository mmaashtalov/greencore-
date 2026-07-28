export class DeviceEmulator {
  constructor({ now = () => new Date(), initial = {} } = {}) {
    this.now = now;
    this.values = {
      air_temperature: 24,
      air_humidity: 65,
      soil_moisture: 50,
      water_temperature: 20,
      water_level: 80,
      ...initial
    };
    this.quality = new Map();
  }

  set(metric, value) {
    if (!(metric in this.values)) throw new Error(`Unsupported emulator metric: ${metric}`);
    this.values[metric] = value;
    return this;
  }

  setQuality(metric, quality) {
    this.quality.set(metric, quality);
    return this;
  }

  sample(metric, overrides = {}) {
    if (!(metric in this.values)) throw new Error(`Unsupported emulator metric: ${metric}`);
    const units = {
      air_temperature: '°C',
      air_humidity: '%',
      soil_moisture: '%',
      water_temperature: '°C',
      water_level: '%'
    };
    return {
      device_id: `${metric}_emulator_01`,
      metric,
      value: this.values[metric],
      unit: units[metric],
      timestamp: this.now().toISOString(),
      quality: this.quality.get(metric) ?? 'GOOD',
      ...overrides
    };
  }

  requiredTelemetry(overrides = {}) {
    return ['air_temperature', 'soil_moisture', 'water_level'].map(metric => this.sample(metric, overrides[metric] ?? {}));
  }
}

export function executeCommands(engine, commands, now = () => new Date()) {
  for (const command of commands) {
    engine.acknowledge({
      command_id: command.command_id,
      actuator_id: command.actuator_id,
      status: 'EXECUTED',
      timestamp: now().toISOString(),
      details: 'virtual actuator applied command'
    });
  }
}
