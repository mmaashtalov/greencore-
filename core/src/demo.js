import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from './engine.js';
import { DeviceEmulator, executeCommands } from './device-emulator.js';

const engine = new GreenCoreEngine({ contracts, rules });
const emulator = new DeviceEmulator({
  initial: {
    air_temperature: 34,
    soil_moisture: 28,
    water_level: 75
  }
});

for (const sample of emulator.requiredTelemetry()) engine.ingest(sample);
engine.setMode('AUTO');

const commands = engine.evaluate();
executeCommands(engine, commands);

console.log(JSON.stringify({
  scenario: 'dry soil and overheating',
  commands,
  snapshot: engine.snapshot()
}, null, 2));
