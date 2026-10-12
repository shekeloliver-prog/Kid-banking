// Vercel serverless entry: vercel.json rewrites every /api/* request to this one function. Static files in
// public/ are served by Vercel itself. Requires a hosted database (Turso): a local file would not survive
// between invocations.
import { createApp } from '../server/app.js';
import { databaseFromEnv, trustProxyFromEnv } from '../server/config.js';
import { restoreApiUrl } from '../server/lib/http.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbConfig = databaseFromEnv(process.env, { root });

// Created once per warm instance and reused across requests.
const app = dbConfig
  ? createApp({
      dbUrl: dbConfig.url,
      authToken: dbConfig.authToken,
      trustProxy: trustProxyFromEnv(process.env) || 1, // Vercel always sits in front of the function
      cronSecret: process.env.CRON_SECRET,
      lazyAllowances: true,
    })
  : null;

export default async function handler(req, res) {
  if (!app) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        error: {
          code: 'not_configured',
          message: 'Nestly needs a database. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the Vercel project settings, then redeploy.',
        },
      }),
    );
    return;
  }
  restoreApiUrl(req);
  await app.handle(req, res);
}
