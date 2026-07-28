import test from 'node:test';
import assert from 'node:assert/strict';
import { GreenhouseDigitalTwin } from '../src/digital-twin.js';

test('pump raises soil moisture and consumes tank water', () => {
  const twin = new GreenhouseDigitalTwin();
  const before = twin.snapshot().state;
  twin.step(3600, { pump_01: 'ON', fan_01: 'OFF', vent_01: 'CLOSED' });
  const after = twin.snapshot().state;
  assert.equal(after.soil_moisture_percent > before.soil_moisture_percent, true);
  assert.equal(after.water_level_percent < before.water_level_percent, true);
});

test('fan limits greenhouse temperature compared with passive case', () => {
  const passive = new GreenhouseDigitalTwin({ startTime: '2026-07-28T12:00:00.000Z' });
  const cooled = new GreenhouseDigitalTwin({ startTime: '2026-07-28T12:00:00.000Z' });
  passive.step(7200, { fan_01: 'OFF', vent_01: 'CLOSED', pump_01: 'OFF' });
  cooled.step(7200, { fan_01: 'ON', vent_01: 'CLOSED', pump_01: 'OFF' });
  assert.equal(cooled.state.air_temperature_c < passive.state.air_temperature_c, true);
});

test('leak scenario depletes water without pump operation', () => {
  const twin = new GreenhouseDigitalTwin();
  twin.applyPreset('leak');
  const before = twin.state.water_level_percent;
  twin.step(3600, { pump_01: 'OFF' });
  assert.equal(twin.state.water_level_percent <= before - 7.9, true);
});

test('heatwave increases evaporation and plant stress', () => {
  const normal = new GreenhouseDigitalTwin({
    startTime: '2026-07-28T12:00:00.000Z',
    state: { soil_moisture_percent: 34 }
  });
  const heatwave = new GreenhouseDigitalTwin({
    startTime: '2026-07-28T12:00:00.000Z',
    state: { soil_moisture_percent: 34 }
  });
  heatwave.applyPreset('heatwave');
  normal.step(6 * 3600, {});
  heatwave.step(6 * 3600, {});
  assert.equal(heatwave.state.soil_moisture_percent < normal.state.soil_moisture_percent, true);
  assert.equal(heatwave.state.plant_health_percent < normal.state.plant_health_percent, true);
});

test('state patches are bounded and unknown fields are rejected', () => {
  const twin = new GreenhouseDigitalTwin();
  twin.setState({ soil_moisture_percent: 120, water_level_percent: -10 });
  assert.equal(twin.state.soil_moisture_percent, 100);
  assert.equal(twin.state.water_level_percent, 0);
  assert.throws(() => twin.setState({ unknown: 1 }), /Unknown digital twin state field/);
});

test('snapshot restore is deterministic', () => {
  const source = new GreenhouseDigitalTwin();
  source.step(1800, { pump_01: 'ON' });
  const restored = new GreenhouseDigitalTwin();
  restored.restore(source.snapshot());
  assert.deepEqual(restored.snapshot(), source.snapshot());
});
