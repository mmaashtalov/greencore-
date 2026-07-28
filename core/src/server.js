import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from './engine.js';
import { createApiServer, listen } from './api.js';

const engine = new GreenCoreEngine({ contracts, rules });
const server = createApiServer({ engine });
const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

const address = await listen(server, { host, port });
console.log(`GreenCore API listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(error => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  });
}
