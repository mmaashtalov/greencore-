import { DigitalTwinControllerEmulator } from './digital-twin-controller.js';

const simulationSpeed = Number(process.env.SIMULATION_SPEED ?? 1);
const scenarioPreset = process.env.DIGITAL_TWIN_PRESET ?? 'normal';

const emulator = new DigitalTwinControllerEmulator({
  baseUrl: process.env.GREENCORE_URL ?? 'http://127.0.0.1:3000',
  controllerId: process.env.CONTROLLER_ID ?? 'controller_primary',
  firmware: process.env.CONTROLLER_FIRMWARE ?? 'emulator-2.0.0',
  apiKey: process.env.CONTROLLER_API_KEY ?? null,
  simulationSpeed,
  scenarioPreset
});

await emulator.start();
console.log(`Controller emulator ${emulator.controllerId} connected to ${emulator.baseUrl}`);
console.log(`Digital twin preset=${scenarioPreset}, simulation speed=x${simulationSpeed}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    emulator.stop();
    console.log(`Controller emulator stopped after ${signal}`);
  });
}
