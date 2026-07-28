import type { GreenhouseState } from '@greencore/domain-model';

export type ControlMode = 'manual' | 'automatic';

export interface SimulationConfig {
  controlMode: ControlMode;
  cropPriceRubPerKg: number;
  waterPriceRubPerLiter: number;
  electricityPriceRubPerKwh: number;
  nominalYieldKg: number;
}

export const defaultConfig: SimulationConfig = {
  controlMode: 'automatic',
  cropPriceRubPerKg: 180,
  waterPriceRubPerLiter: 0.08,
  electricityPriceRubPerKwh: 8,
  nominalYieldKg: 100,
};

export function createInitialState(): GreenhouseState {
  return {
    simulatedMinutes: 0,
    insideTemperatureC: 23,
    outsideTemperatureC: 18,
    airHumidityPct: 65,
    soilMoisturePct: 55,
    plantHealthPct: 100,
    accumulatedStress: 0,
    growthKg: 0,
    predictedYieldKg: 100,
    irreversibleYieldLossKg: 0,
    waterUsedLiters: 0,
    electricityUsedKwh: 0,
    pumpOn: false,
    fanOn: false,
  };
}

export function stepSimulation(
  previous: GreenhouseState,
  config: SimulationConfig = defaultConfig,
  stepMinutes = 1,
): GreenhouseState {
  const minute = previous.simulatedMinutes + stepMinutes;
  const dayPhase = (minute % 1440) / 1440;
  const solar = Math.max(0, Math.sin((dayPhase - 0.25) * Math.PI * 2));
  const outsideTemperatureC = 15 + solar * 17;

  let pumpOn = previous.pumpOn;
  let fanOn = previous.fanOn;

  if (config.controlMode === 'automatic') {
    if (previous.soilMoisturePct < 43) pumpOn = true;
    if (previous.soilMoisturePct > 58) pumpOn = false;
    if (previous.insideTemperatureC > 28) fanOn = true;
    if (previous.insideTemperatureC < 24.5) fanOn = false;
  } else {
    pumpOn = minute % 360 < 25;
    fanOn = false;
  }

  const heatGain = solar * 0.14 * stepMinutes;
  const exchange = (outsideTemperatureC - previous.insideTemperatureC) * 0.012 * stepMinutes;
  const fanCooling = fanOn ? 0.12 * stepMinutes : 0;
  const insideTemperatureC = previous.insideTemperatureC + heatGain + exchange - fanCooling;

  const irrigationGain = pumpOn ? 0.42 * stepMinutes : 0;
  const moistureLoss = (0.035 + solar * 0.055 + Math.max(0, insideTemperatureC - 25) * 0.008) * stepMinutes;
  const soilMoisturePct = Math.max(0, Math.min(100, previous.soilMoisturePct + irrigationGain - moistureLoss));

  const temperatureStress = Math.max(0, insideTemperatureC - 30) + Math.max(0, 15 - insideTemperatureC) * 0.5;
  const waterStress = Math.max(0, 38 - soilMoisturePct) * 0.35;
  const stressRate = (temperatureStress + waterStress) * stepMinutes / 60;
  const accumulatedStress = Math.max(0, previous.accumulatedStress + stressRate - 0.025 * stepMinutes);
  const irreversibleLossDelta = accumulatedStress > 12 ? (accumulatedStress - 12) * 0.00045 * stepMinutes : 0;
  const irreversibleYieldLossKg = Math.min(
    config.nominalYieldKg,
    previous.irreversibleYieldLossKg + irreversibleLossDelta,
  );
  const plantHealthPct = Math.max(0, 100 - accumulatedStress * 1.4 - irreversibleYieldLossKg * 0.7);
  const growthFactor = Math.max(0, 1 - stressRate * 0.06) * (0.25 + solar * 0.75);
  const growthKg = previous.growthKg + growthFactor * 0.0025 * stepMinutes;
  const predictedYieldKg = Math.max(0, config.nominalYieldKg - irreversibleYieldLossKg);

  return {
    simulatedMinutes: minute,
    outsideTemperatureC,
    insideTemperatureC,
    airHumidityPct: Math.max(25, Math.min(95, previous.airHumidityPct + (pumpOn ? 0.08 : -0.02) * stepMinutes)),
    soilMoisturePct,
    plantHealthPct,
    accumulatedStress,
    growthKg,
    predictedYieldKg,
    irreversibleYieldLossKg,
    waterUsedLiters: previous.waterUsedLiters + (pumpOn ? 3.2 * stepMinutes : 0),
    electricityUsedKwh:
      previous.electricityUsedKwh + ((pumpOn ? 0.75 : 0) + (fanOn ? 1.2 : 0)) * (stepMinutes / 60),
    pumpOn,
    fanOn,
  };
}

export function calculateEconomy(state: GreenhouseState, config: SimulationConfig = defaultConfig) {
  const revenueRub = state.predictedYieldKg * config.cropPriceRubPerKg;
  const operatingCostRub =
    state.waterUsedLiters * config.waterPriceRubPerLiter +
    state.electricityUsedKwh * config.electricityPriceRubPerKwh;

  return {
    revenueRub,
    operatingCostRub,
    projectedProfitRub: revenueRub - operatingCostRub,
  };
}
