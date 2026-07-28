import path from 'node:path';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from './engine.js';
import { close, createApiServer, listen } from './api.js';
import { JsonStateStore } from './storage.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
const stateFile = path.resolve(process.env.STATE_FILE ?? 'data/state.json');
const store = new JsonStateStore({ filePath: stateFile });
const engine = new GreenCoreEngine({ contracts, rules });

const loaded = await store.load();
if (loaded.status === 'loaded') {
  try {
    engine.restore(loaded.state);
    console.log(`GreenCore state restored from ${stateFile}`);
  } catch (error) {
    const quarantinePath = await store.quarantine();
    console.error(`Invalid GreenCore state quarantined at ${quarantinePath}: ${error.message}`);
  }
} else if (loaded.status === 'corrupt') {
  console.error(`Corrupt GreenCore state quarantined at ${loaded.quarantinePath}: ${loaded.error}`);
}

await store.save(engine.snapshot());

const server = createApiServer({
  engine,
  persist: snapshot => store.save(snapshot)
});
const address = await listen(server, { host, port });
console.log(`GreenCore API listening on http://${address.address}:${address.port}`);
console.log(`GreenCore state file: ${stateFile}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await close(server);
    await store.save(engine.snapshot());
    await store.flush();
    console.log(`GreenCore stopped after ${signal}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void shutdown(signal));
}
