import fs from 'node:fs';
import path from 'node:path';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from './engine.js';
import { GreenCoreRuntime } from './runtime.js';
import { AutomationLoop } from './automation-loop.js';
import { SimulationService } from './simulation-service.js';
import { close, createApiServer, listen } from './api.js';
import { JsonStateStore } from './storage.js';
import { SqliteHistoryStore } from './history-store.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
const stateFile = path.resolve(process.env.STATE_FILE ?? 'data/state.json');
const historyDatabase = path.resolve(process.env.HISTORY_DATABASE ?? 'data/history.sqlite');
const legacySimulationStateFile = path.resolve(process.env.SIMULATION_STATE_FILE ?? 'data/simulations.json');
const allowedOrigin = process.env.CORS_ORIGIN ?? '*';
const automationEnabled = process.env.AUTOMATION_ENABLED !== 'false';
const evaluationIntervalMs = Number(process.env.EVALUATION_INTERVAL_MS ?? 5000);
const maxSimulationReports = Number(process.env.MAX_SIMULATION_REPORTS ?? 50);

const store = new JsonStateStore({ filePath: stateFile });
const history = new SqliteHistoryStore({
  filePath: historyDatabase,
  limits: {
    telemetry: Number(process.env.MAX_TELEMETRY_HISTORY ?? 250000),
    events: Number(process.env.MAX_EVENT_HISTORY ?? 100000),
    alerts: Number(process.env.MAX_ALERT_HISTORY ?? 50000),
    commands: Number(process.env.MAX_COMMAND_HISTORY ?? 100000),
    simulations: Number(process.env.MAX_SIMULATION_HISTORY ?? 1000)
  }
});
const engine = new GreenCoreEngine({ contracts, rules });
const runtime = new GreenCoreRuntime({ engine });
const simulations = new SimulationService({ maxReports: maxSimulationReports });

const persist = async snapshot => {
  await store.save(snapshot);
  if (!history.captureRuntimeSnapshot(snapshot)) {
    console.error(`GreenCore history capture failed: ${history.stats().last_error}`);
  }
};
const persistSimulations = async snapshot => history.saveSimulationSnapshot(snapshot);
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

const databaseSimulationSnapshot = history.loadSimulationSnapshot({ maxReports: maxSimulationReports });
if (databaseSimulationSnapshot.reports.length > 0) {
  simulations.restore(databaseSimulationSnapshot);
  console.log(`Simulation reports restored from ${historyDatabase}`);
} else {
  const legacySimulationStore = new JsonStateStore({ filePath: legacySimulationStateFile });
  const legacy = await legacySimulationStore.load();
  if (legacy.status === 'loaded') {
    try {
      simulations.restore(legacy.state);
      await persistSimulations(simulations.snapshot());
      await legacySimulationStore.flush();
      const migratedPath = `${legacySimulationStateFile}.migrated-${Date.now()}`;
      await fs.promises.rename(legacySimulationStateFile, migratedPath);
      console.log(`Legacy simulation reports migrated to SQLite; source moved to ${migratedPath}`);
    } catch (error) {
      console.error(`Legacy simulation migration failed: ${error.message}`);
    }
  } else if (legacy.status === 'corrupt') {
    console.error(`Corrupt legacy simulation state quarantined at ${legacy.quarantinePath}: ${legacy.error}`);
  }
}

await persist(runtime.snapshot());
await persistSimulations(simulations.snapshot());

const server = createApiServer({
  engine: runtime,
  simulations,
  history,
  persist,
  persistSimulations,
  allowedOrigin
});
const address = await listen(server, { host, port });
console.log(`GreenCore API listening on http://${address.address}:${address.port}`);
console.log(`GreenCore recovery state file: ${stateFile}`);
console.log(`GreenCore history database: ${historyDatabase}`);
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
    await store.flush();
    history.close();
    console.log(`GreenCore stopped after ${signal}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void shutdown(signal));
}
