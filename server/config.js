import { join } from 'node:path';

/**
 * Where the database lives, from the environment:
 *   TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)  a hosted libSQL/Turso database — what serverless/free hosts use
 *   DB_PATH                                  a local file — your laptop, or a server with a persistent disk
 * Returns null when running on a platform whose disk is ephemeral (Vercel, Render) with neither set: a local file
 * there would silently vanish on the next restart, so we refuse to guess.
 */
export function databaseFromEnv(env, { root, demo = false } = {}) {
  if (demo) return { url: `file:${join(root, 'data', 'demo.db')}` };
  const turso = String(env.TURSO_DATABASE_URL ?? '').trim();
  if (turso) return { url: httpTransport(turso), authToken: String(env.TURSO_AUTH_TOKEN ?? '').trim() || undefined };
  const path = String(env.DB_PATH ?? '').trim();
  if (path) return { url: `file:${path}` };
  if (env.VERCEL || env.RENDER) return null;
  return { url: `file:${join(root, 'data', 'nestly.db')}` };
}

/**
 * libsql:// URLs make the client hold a WebSocket open, which goes stale while a serverless function is frozen
 * between requests. Turso recommends plain HTTPS for serverless and it behaves identically for us (including
 * transactions), so use it for every remote database.
 */
export function httpTransport(url) {
  return url.replace(/^(libsql|wss?):\/\//i, 'https://');
}

/** TRUST_PROXY = number of trusted proxies in front of the app (0 = none). */
export const trustProxyFromEnv = (env) => Number.parseInt(env.TRUST_PROXY, 10) || 0;
