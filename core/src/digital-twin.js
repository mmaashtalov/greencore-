function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finite(value, field) {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
  return value;
}

export class GreenhouseDigitalTwin {
  constructor({
    startTime = '2026-07-28T06:00:00.000Z',
    state = {},
    scenario = {}
  } = {}) {
    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) throw new Error('Invalid digital twin start time');
    this.simulationTime = start;
    this.state = {
      outside_temperature_c: 18,
      solar_irradiance_w_m2: 0,
      air_temperature_c: 24,
      air_humidity_percent: 65,
      soil_moisture_percent: 50,
      water_level_percent: 80,
      plant_health_percent: 100,
      cumulative_water_used_percent: 0,
      ...structuredClone(state)
    };
    this.scenario = {
      outside_temperature_offset_c: 0,
      evaporation_multiplier: 1,
      irrigation_multiplier: 1,
      tank_leak_percent_per_hour: 0,
      fan_efficiency_multiplier: 1,
      vent_efficiency_multiplier: 1,
      ...structuredClone(scenario)
    };
    this.validate();
  }

  validate() {
    for (const [key, value] of Object.entries(this.state)) finite(value, key);
    for (const [key, value] of Object.entries(this.scenario)) finite(value, key);
  }

  setState(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('State patch must be an object');
    }
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in this.state)) throw new Error(`Unknown digital twin state field: ${key}`);
      this.state[key] = finite(value, key);
    }
    this.normalizeState();
    return this;
  }

  normalizeState() {
    this.state.air_temperature_c = clamp(this.state.air_temperature_c, -20, 70);
    this.state.air_humidity_percent = clamp(this.state.air_humidity_percent, 0, 100);
    this.state.soil_moisture_percent = clamp(this.state.soil_moisture_percent, 0, 100);
    this.state.water_level_percent = clamp(this.state.water_level_percent, 0, 100);
    this.state.plant_health_percent = clamp(this.state.plant_health_percent, 0, 100);
    this.state.cumulative_water_used_percent = Math.max(0, this.state.cumulative_water_used_percent);
  }

  setScenario(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Scenario patch must be an object');
    }
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in this.scenario)) throw new Error(`Unknown scenario field: ${key}`);
      this.scenario[key] = finite(value, key);
    }
    return this;
  }

  applyPreset(name) {
    const presets = {
      normal: {
        outside_temperature_offset_c: 0,
        evaporation_multiplier: 1,
        irrigation_multiplier: 1,
        tank_leak_percent_per_hour: 0,
        fan_efficiency_multiplier: 1,
        vent_efficiency_multiplier: 1
      },
      heatwave: {
        outside_temperature_offset_c: 12,
        evaporation_multiplier: 1.8
      },
      drought: {
        evaporation_multiplier: 2.2,
        irrigation_multiplier: 0.8
      },
      leak: {
        tank_leak_percent_per_hour: 8
      },
      weak_ventilation: {
        fan_efficiency_multiplier: 0.25,
        vent_efficiency_multiplier: 0.25
      }
    };
    const preset = presets[name];
    if (!preset) throw new Error(`Unknown scenario preset: ${name}`);
    if (name === 'normal') this.scenario = { ...this.scenario, ...preset };
    else this.setScenario(preset);
    return this;
  }

  environmentAt(time) {
    const hour = time.getUTCHours() + time.getUTCMinutes() / 60;
    const daylight = hour >= 6 && hour <= 18
      ? Math.sin(((hour - 6) / 12) * Math.PI)
      : 0;
    const outside = 18 + 7 * Math.sin(((hour - 8) / 24) * 2 * Math.PI)
      + this.scenario.outside_temperature_offset_c;
    return {
      outside_temperature_c: outside,
      solar_irradiance_w_m2: Math.max(0, 850 * daylight)
    };
  }

  step(seconds, actuators = {}) {
    finite(seconds, 'seconds');
    if (seconds <= 0) throw new Error('seconds must be positive');
    const chunks = Math.ceil(seconds / 60);
    const chunkSeconds = seconds / chunks;
    for (let index = 0; index < chunks; index += 1) {
      this.stepChunk(chunkSeconds, actuators);
      this.simulationTime = new Date(this.simulationTime.getTime() + chunkSeconds * 1000);
    }
    return this.snapshot();
  }

  stepChunk(seconds, actuators) {
    const hours = seconds / 3600;
    const environment = this.environmentAt(this.simulationTime);
    this.state.outside_temperature_c = environment.outside_temperature_c;
    this.state.solar_irradiance_w_m2 = environment.solar_irradiance_w_m2;

    const fanOn = actuators.fan_01 === 'ON';
    const ventOpen = actuators.vent_01 === 'OPEN';
    const pumpOn = actuators.pump_01 === 'ON';

    const solarHeatingPerHour = environment.solar_irradiance_w_m2 / 850 * 5.5;
    const passiveExchangePerHour = (environment.outside_temperature_c - this.state.air_temperature_c) * 0.35;
    const fanCoolingPerHour = fanOn
      ? (this.state.air_temperature_c - environment.outside_temperature_c) * 1.2 * this.scenario.fan_efficiency_multiplier
      : 0;
    const ventCoolingPerHour = ventOpen
      ? (this.state.air_temperature_c - environment.outside_temperature_c) * 0.8 * this.scenario.vent_efficiency_multiplier
      : 0;
    this.state.air_temperature_c += (
      solarHeatingPerHour + passiveExchangePerHour - fanCoolingPerHour - ventCoolingPerHour
    ) * hours;
    this.state.air_temperature_c = clamp(this.state.air_temperature_c, -20, 70);

    const targetHumidity = clamp(78 - (this.state.air_temperature_c - 20) * 1.4, 25, 95);
    const ventilationDrying = (fanOn ? 5 : 0) + (ventOpen ? 3 : 0);
    this.state.air_humidity_percent += (
      (targetHumidity - this.state.air_humidity_percent) * 0.45 - ventilationDrying
    ) * hours;
    this.state.air_humidity_percent = clamp(this.state.air_humidity_percent, 0, 100);

    const evaporationPerHour = (
      0.35
      + Math.max(0, this.state.air_temperature_c - 20) * 0.045
      + environment.solar_irradiance_w_m2 / 850 * 0.55
    ) * this.scenario.evaporation_multiplier;
    const availableWaterFactor = clamp(this.state.water_level_percent / 15, 0, 1);
    const irrigationPerHour = pumpOn
      ? 11 * this.scenario.irrigation_multiplier * availableWaterFactor
      : 0;
    this.state.soil_moisture_percent += (irrigationPerHour - evaporationPerHour) * hours;
    this.state.soil_moisture_percent = clamp(this.state.soil_moisture_percent, 0, 100);

    const pumpUsePerHour = pumpOn ? 5.5 * availableWaterFactor : 0;
    const leakPerHour = this.scenario.tank_leak_percent_per_hour;
    const waterDrop = (pumpUsePerHour + leakPerHour) * hours;
    this.state.water_level_percent = clamp(this.state.water_level_percent - waterDrop, 0, 100);
    this.state.cumulative_water_used_percent += pumpUsePerHour * hours;

    let stressPerHour = 0;
    if (this.state.soil_moisture_percent < 35) stressPerHour += (35 - this.state.soil_moisture_percent) * 0.08;
    if (this.state.soil_moisture_percent > 75) stressPerHour += (this.state.soil_moisture_percent - 75) * 0.04;
    if (this.state.air_temperature_c > 32) stressPerHour += (this.state.air_temperature_c - 32) * 0.12;
    if (this.state.air_temperature_c < 12) stressPerHour += (12 - this.state.air_temperature_c) * 0.1;
    const recoveryPerHour = stressPerHour === 0 ? 0.35 : 0;
    this.state.plant_health_percent = clamp(
      this.state.plant_health_percent + (recoveryPerHour - stressPerHour) * hours,
      0,
      100
    );
  }

  telemetry() {
    return {
      air_temperature: this.state.air_temperature_c,
      air_humidity: this.state.air_humidity_percent,
      soil_moisture: this.state.soil_moisture_percent,
      water_level: this.state.water_level_percent
    };
  }

  snapshot() {
    return {
      simulation_time: this.simulationTime.toISOString(),
      state: structuredClone(this.state),
      scenario: structuredClone(this.scenario)
    };
  }

  restore(snapshot) {
    const time = new Date(snapshot?.simulation_time);
    if (Number.isNaN(time.getTime()) || !snapshot?.state || !snapshot?.scenario) {
      throw new Error('Invalid digital twin snapshot');
    }
    this.simulationTime = time;
    this.state = structuredClone(snapshot.state);
    this.scenario = structuredClone(snapshot.scenario);
    this.validate();
    this.normalizeState();
    return this.snapshot();
  }
}
