import { createApp } from './app.js';
import { databaseFromEnv, trustProxyFromEnv } from './config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.argv.includes('--demo');
const db = databaseFromEnv(process.env, { root, demo });
if (!db) {
  console.error(
    '\nNestly needs a database. This host has no persistent disk, so set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN\n' +
      '(a free hosted database from https://turso.tech), or set DB_PATH to a file on a mounted disk.\n',
  );
  process.exit(1);
}
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const app = createApp({ dbUrl: db.url, authToken: db.authToken, trustProxy: trustProxyFromEnv(process.env) });
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
