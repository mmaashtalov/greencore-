import path from 'node:path';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from './engine.js';
import { GreenCoreRuntime } from './runtime.js';
import { AutomationLoop } from './automation-loop.js';
import { SimulationService } from './simulation-service.js';
import { close, createApiServer, listen } from './api.js';
import { JsonStateStore } from './storage.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
const stateFile = path.resolve(process.env.STATE_FILE ?? 'data/state.json');
const simulationStateFile = path.resolve(process.env.SIMULATION_STATE_FILE ?? 'data/simulations.json');
const allowedOrigin = process.env.CORS_ORIGIN ?? '*';
const automationEnabled = process.env.AUTOMATION_ENABLED !== 'false';
const evaluationIntervalMs = Number(process.env.EVALUATION_INTERVAL_MS ?? 5000);
const maxSimulationReports = Number(process.env.MAX_SIMULATION_REPORTS ?? 50);

const store = new JsonStateStore({ filePath: stateFile });
const simulationStore = new JsonStateStore({ filePath: simulationStateFile });
const engine = new GreenCoreEngine({ contracts, rules });
const runtime = new GreenCoreRuntime({ engine });
const simulations = new SimulationService({ maxReports: maxSimulationReports });
const persist = snapshot => store.save(snapshot);
const persistSimulations = snapshot => simulationStore.save(snapshot);
const automation = new AutomationLoop({
  runtime,
  persist,
  intervalMs: evaluationIntervalMs
});

const loaded = await store.load();
if (loaded.status === 'loaded') {
  try {
    runtime.restore(loaded.state);
    console.log(`GreenCore state restored from ${stateFile}`);
  } catch (error) {
    const quarantinePath = await store.quarantine();
    console.error(`Invalid GreenCore state quarantined at ${quarantinePath}: ${error.message}`);
  }
} else if (loaded.status === 'corrupt') {
  console.error(`Corrupt GreenCore state quarantined at ${loaded.quarantinePath}: ${loaded.error}`);
}

const simulationsLoaded = await simulationStore.load();
if (simulationsLoaded.status === 'loaded') {
  try {
    simulations.restore(simulationsLoaded.state);
    console.log(`Simulation reports restored from ${simulationStateFile}`);
  } catch (error) {
    const quarantinePath = await simulationStore.quarantine();
    console.error(`Invalid simulation state quarantined at ${quarantinePath}: ${error.message}`);
  }
} else if (simulationsLoaded.status === 'corrupt') {
  console.error(`Corrupt simulation state quarantined at ${simulationsLoaded.quarantinePath}: ${simulationsLoaded.error}`);
}

await persist(runtime.snapshot());
await persistSimulations(simulations.snapshot());

const server = createApiServer({
  engine: runtime,
  simulations,
  persist,
  persistSimulations,
  allowedOrigin
});
const address = await listen(server, { host, port });
console.log(`GreenCore API listening on http://${address.address}:${address.port}`);
console.log(`GreenCore state file: ${stateFile}`);
console.log(`Simulation report file: ${simulationStateFile}`);
if (automationEnabled) {
  automation.start();
  console.log(`GreenCore automation loop enabled: ${evaluationIntervalMs} ms`);
} else {
  console.log('GreenCore automation loop disabled');
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await automation.stop();
    await close(server);
    await persist(runtime.snapshot());
    await persistSimulations(simulations.snapshot());
    await Promise.all([store.flush(), simulationStore.flush()]);
    console.log(`GreenCore stopped after ${signal}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void shutdown(signal));
}
