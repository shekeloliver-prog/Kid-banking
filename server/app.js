import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './lib/db.js';
import { createBank } from './lib/bank.js';
import { Router, readJson, sendJson, parseCookies, serveStatic, SECURITY_HEADERS } from './lib/http.js';
import { HttpError } from './lib/util.js';
import { AttemptLimiter, lookupSession, purgeExpiredSessions, ipKey, SESSION_COOKIE, SESSION_TTL_MS } from './lib/auth.js';
import { registerRoutes } from './routes.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Builds the whole app (database, banking engine, HTTP server) without listening,
 * so tests can drive it on a random port with a fake clock.
 */
export function createApp({ dbUrl, authToken, clock = () => new Date(), trustProxy = false, cronSecret, lazyAllowances = false } = {}) {
  const db = openDb({ url: dbUrl, authToken });
  const bank = createBank(db, clock);
  const router = new Router();
  const limiters = {
    login: new AttemptLimiter(db, { name: 'login', max: 5, lockMs: 5 * 60 * 1000 }),
    loginIp: new AttemptLimiter(db, { name: 'login-ip', max: 40, lockMs: 5 * 60 * 1000 }),
    // Not keyed by IP: behind a proxy the client IP comes from a header an attacker can rotate.
    loginAccount: new AttemptLimiter(db, { name: 'login-acct', max: 10, lockMs: 10 * 60 * 1000 }),
    register: new AttemptLimiter(db, { name: 'register', max: 15, lockMs: 60 * 60 * 1000 }),
    confirm: new AttemptLimiter(db, { name: 'confirm', max: 5, lockMs: 5 * 60 * 1000 }),
  };
  registerRoutes(router, { db, bank, limiters, clock, cronSecret, dbScheme: String(dbUrl).split(':')[0] });

  // Serverless hosts have no background timer, so allowances are also paid opportunistically as people use the app.
  let lastLazyRun = 0;
  let lastPurge = 0;
  async function maybePayAllowances() {
    if (!lazyAllowances || Date.now() - lastLazyRun < 60_000) return;
    lastLazyRun = Date.now();
    try {
      await bank.runAllowances();
      if (Date.now() - lastPurge > 60 * 60 * 1000) {
        lastPurge = Date.now();
        await purgeExpiredSessions(db, clock());
      }
    } catch (err) {
      console.error('Opportunistic allowance run failed', err);
    }
  }

  // trustProxy is the number of proxies in front of us that we trust (true = 1). Each proxy appends the address
  // it received the request from to X-Forwarded-For, so the trustworthy entry is `hops` from the RIGHT. Anything
  // further left was supplied by the client and is ignored. If the count is too low, users merely share a
  // rate-limit bucket (safe); too high would trust client-supplied values, so err low.
  const hops = trustProxy === true ? 1 : Math.max(0, Math.floor(Number(trustProxy) || 0));
  let loggedForwarded = false;
  const clientIp = (req) => {
    if (hops > 0) {
      const raw = String(req.headers['x-forwarded-for'] || '');
      if (!loggedForwarded) {
        loggedForwarded = true;
        console.log(`[proxy] first request: x-forwarded-for="${raw}" (TRUST_PROXY=${hops}); if every visitor shares one IP, raise TRUST_PROXY`);
      }
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length >= hops) return parts[parts.length - hops];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const isSecure = (req) =>
    !!req.socket.encrypted || (hops > 0 && String(req.headers['x-forwarded-proto'] || '').split(',').pop().trim() === 'https');

  async function handleApi(req, res, url) {
    const { route, params, pathMatched } = router.match(req.method, url.pathname);
    if (!route) {
      throw pathMatched ? new HttpError(405, 'method', 'Method not allowed.') : new HttpError(404, 'not_found', 'Not found.');
    }

    // Cross-site request forgery: browsers always send Origin / Sec-Fetch-Site on cross-site writes.
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let host;
        try {
          host = new URL(origin).host;
        } catch {
          host = null;
        }
        if (host !== req.headers.host) throw new HttpError(403, 'forbidden', 'Cross-site requests are not allowed.');
      }
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'forbidden', 'Cross-site requests are not allowed.');
    }

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const user = await lookupSession(db, token, clock());
    if (user) await maybePayAllowances();
    const need = route.options.auth;
    if (need) {
      if (!user) throw new HttpError(401, 'unauthenticated', 'Please log in.');
      if (need !== 'user' && user.role !== need) throw new HttpError(403, 'forbidden', "You don't have access to that.");
    }

    const secure = isSecure(req) ? '; Secure' : '';
    const ctx = {
      req,
      url,
      params,
      query: url.searchParams,
      body: MUTATING.has(req.method) ? await readJson(req) : {},
      user,
      token,
      ip: ipKey(clientIp(req)),
      cookieHeaders: [],
      setSession(value, expires) {
        const maxAge = Math.floor(SESSION_TTL_MS / 1000);
        this.cookieHeaders.push(`${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
      },
      clearSession() {
        this.cookieHeaders.push(`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
      },
    };

    const result = await route.handler(ctx);
    sendJson(res, 200, result ?? { ok: true }, ctx.cookieHeaders.length ? { 'Set-Cookie': ctx.cookieHeaders } : {});
  }

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        try {
          await db.ensureReady();
        } catch (err) {
          console.error('Database is not available', err);
          throw new HttpError(503, 'db_unavailable', "Nestly can't reach its database right now. Please try again in a moment.");
        }
        await handleApi(req, res, url);
      } else serveStatic(PUBLIC_DIR, req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
      } else {
        console.error(err);
        // The error's class/code (never its message) helps whoever runs the deployment find the cause quickly.
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.', detail: String(err?.code ?? err?.name ?? 'Error').slice(0, 60) } });
      }
    }
  }

  const server = createServer(handle);

  let timer = null;
  function startJobs() {
    const tick = async () => {
      try {
        await db.ensureReady();
        await bank.runAllowances();
        await purgeExpiredSessions(db, clock());
      } catch (err) {
        console.error('Background job failed', err);
      }
    };
    tick();
    timer = setInterval(tick, 30_000);
    timer.unref();
  }

  async function close() {
    if (timer) clearInterval(timer);
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await db.close();
  }

  return { handle, server, db, bank, limiters, startJobs, close };
}
