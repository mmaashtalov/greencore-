import { ControllerEmulator } from './controller-emulator.js';

const emulator = new ControllerEmulator({
  baseUrl: process.env.GREENCORE_URL ?? 'http://127.0.0.1:3000',
  controllerId: process.env.CONTROLLER_ID ?? 'controller_primary',
  firmware: process.env.CONTROLLER_FIRMWARE ?? 'emulator-1.0.0'
});

await emulator.start();
console.log(`Controller emulator ${emulator.controllerId} connected to ${emulator.baseUrl}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    emulator.stop();
    console.log(`Controller emulator stopped after ${signal}`);
  });
}
