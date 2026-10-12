import { join } from 'node:path';

/**
 * Where the database lives, from the environment:
 *   TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)  a hosted libSQL/Turso database — what serverless/free hosts use
 *   DB_PATH                                  a local file (default data/nestly.db) — for your laptop or a server with a disk
 * Returns null when running on a serverless platform with no database configured (a local file there would
 * silently vanish, so we refuse instead).
 */
export function databaseFromEnv(env, { root, demo = false } = {}) {
  if (demo) return { url: `file:${join(root, 'data', 'demo.db')}` };
  if (env.TURSO_DATABASE_URL) return { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN };
  if (env.VERCEL) return null;
  return { url: `file:${env.DB_PATH || join(root, 'data', 'nestly.db')}` };
}

/** TRUST_PROXY = number of trusted proxies in front of the app (0 = none). */
export const trustProxyFromEnv = (env) => Number.parseInt(env.TRUST_PROXY, 10) || 0;
