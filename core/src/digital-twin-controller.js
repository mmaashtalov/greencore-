import { ControllerEmulator } from './controller-emulator.js';
import { GreenhouseDigitalTwin } from './digital-twin.js';

const SENSOR_STATE_FIELDS = {
  soil_01: 'soil_moisture_percent',
  air_01: 'air_temperature_c',
  humidity_01: 'air_humidity_percent',
  water_01: 'water_level_percent'
};

export class DigitalTwinControllerEmulator extends ControllerEmulator {
  constructor({
    digitalTwin,
    twinOptions = {},
    scenarioPreset = null,
    simulationSpeed = 1,
    ...controllerOptions
  }) {
    const { initialSensors = {}, ...baseOptions } = controllerOptions;
    super({
      ...baseOptions,
      initialSensors: {
        humidity_01: { metric: 'air_humidity', value: 65, unit: '%', quality: 'GOOD' },
        ...initialSensors
      }
    });
    if (!Number.isFinite(simulationSpeed) || simulationSpeed <= 0) {
      throw new Error('simulationSpeed must be a positive number');
    }
    const defaultStartTime = typeof baseOptions.now === 'function'
      ? baseOptions.now().toISOString()
      : new Date().toISOString();
    this.digitalTwin = digitalTwin ?? new GreenhouseDigitalTwin({
      ...twinOptions,
      startTime: twinOptions.startTime ?? defaultStartTime
    });
    this.simulationSpeed = simulationSpeed;
    if (scenarioPreset) this.digitalTwin.applyPreset(scenarioPreset);
    this.syncSensorsFromTwin();
  }

  syncSensorsFromTwin() {
    const values = this.digitalTwin.telemetry();
    this.sensors.soil_01.value = values.soil_moisture;
    this.sensors.air_01.value = values.air_temperature;
    this.sensors.humidity_01.value = values.air_humidity;
    this.sensors.water_01.value = values.water_level;
    return this;
  }

  setSensor(deviceId, value, quality = undefined) {
    const stateField = SENSOR_STATE_FIELDS[deviceId];
    if (!stateField) return super.setSensor(deviceId, value, quality);
    this.digitalTwin.setState({ [stateField]: value });
    super.setSensor(deviceId, value, quality);
    return this;
  }

  setScenario(patch) {
    this.digitalTwin.setScenario(patch);
    return this;
  }

  applyScenarioPreset(name) {
    this.digitalTwin.applyPreset(name);
    return this;
  }

  telemetrySamples() {
    const simulationTime = this.digitalTwin.simulationTime.toISOString();
    return super.telemetrySamples().map(sample => ({ ...sample, simulation_time: simulationTime }));
  }

  tickPhysics(seconds = 1) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('seconds must be positive');
    this.digitalTwin.step(seconds * this.simulationSpeed, {
      pump_01: this.actuators.pump_01.state,
      fan_01: this.actuators.fan_01.state,
      vent_01: this.actuators.vent_01.state
    });
    this.syncSensorsFromTwin();
    return this.digitalTwin.snapshot();
  }

  digitalTwinSnapshot() {
    return {
      simulation_speed: this.simulationSpeed,
      twin: this.digitalTwin.snapshot(),
      actuators: structuredClone(this.actuators)
    };
  }

  restoreDigitalTwin(snapshot) {
    if (!snapshot?.twin || !Number.isFinite(snapshot.simulation_speed) || snapshot.simulation_speed <= 0) {
      throw new Error('Invalid digital twin controller snapshot');
    }
    this.simulationSpeed = snapshot.simulation_speed;
    this.digitalTwin.restore(snapshot.twin);
    if (snapshot.actuators && typeof snapshot.actuators === 'object') {
      for (const [deviceId, saved] of Object.entries(snapshot.actuators)) {
        const actuator = this.actuators[deviceId];
        if (!actuator || saved?.type !== actuator.type || typeof saved.state !== 'string') {
          throw new Error(`Invalid persisted digital twin actuator: ${deviceId}`);
        }
        this.actuators[deviceId] = structuredClone(saved);
      }
    }
    this.syncSensorsFromTwin();
    return this.digitalTwinSnapshot();
  }
}
