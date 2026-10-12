import { createApp } from './app.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.argv.includes('--demo');
const dbPath = demo ? join(root, 'data', 'demo.db') : process.env.DB_PATH || join(root, 'data', 'nestly.db');
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const app = createApp({ dbPath, trustProxy: Number.parseInt(process.env.TRUST_PROXY, 10) || 0 });
app.startJobs();
app.server.listen(port, host, () => {
  console.log(`\n  Nestly is running${demo ? ' (demo data)' : ''}\n  → http://localhost:${port}\n`);
  if (demo) console.log('  Demo parent:  demo@nestly.app / nestly-demo\n  Demo kid:     mia / 123456   (also leo / 123456)\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
