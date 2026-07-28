export type AssetType = 'greenhouse' | 'warehouse' | 'boiler-room' | 'cold-storage' | 'custom';

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  timezone: string;
}

export type DeviceProtocol = 'virtual' | 'mqtt' | 'modbus' | 'opc-ua' | 'lorawan';
export type DeviceStatus = 'online' | 'offline' | 'degraded';

export interface Device {
  id: string;
  assetId: string;
  name: string;
  type: string;
  protocol: DeviceProtocol;
  status: DeviceStatus;
  lastSeenAt: string;
}

export interface TelemetryPoint {
  deviceId: string;
  parameter: string;
  value: number;
  unit: string;
  timestamp: string;
  quality: 'good' | 'uncertain' | 'bad';
}

export interface Command {
  deviceId: string;
  action: string;
  parameter?: string;
  value?: number | string | boolean;
  requestedAt: string;
}

export interface GreenhouseState {
  simulatedMinutes: number;
  insideTemperatureC: number;
  outsideTemperatureC: number;
  airHumidityPct: number;
  soilMoisturePct: number;
  plantHealthPct: number;
  accumulatedStress: number;
  growthKg: number;
  predictedYieldKg: number;
  irreversibleYieldLossKg: number;
  waterUsedLiters: number;
  electricityUsedKwh: number;
  pumpOn: boolean;
  fanOn: boolean;
}
