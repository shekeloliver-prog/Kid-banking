import { timingSafeEqual } from 'node:crypto';
import { HttpError, text, cents, oneOf, password, email, username, id, timezone, AVATARS, COLORS, CATEGORIES } from './lib/util.js';
import { CHORE_EMOJI, REPEATS, MIN_REWARD_CENTS, MAX_REWARD_CENTS } from './lib/chores.js';
import { INSIGHT_RANGES, activityCsv } from './lib/insights.js';
import { RawResponse } from './lib/http.js';
import { hashPassword, verifyPassword, burnPasswordCheck, createSession, destroySession, destroyUserSessions, purgeExpiredSessions, AttemptLimiter } from './lib/auth.js';

const KID_PIN_MIN = 6;

// Auth levels: null = public, 'parent' | 'kid' = that role only, 'user' = any signed-in account.
export function registerRoutes(router, { db, bank, limiters, clock, cronSecret, dbScheme }) {
  const get = (path, auth, fn) => router.add('GET', path, { auth }, fn);
  const post = (path, auth, fn) => router.add('POST', path, { auth }, fn);
  const put = (path, auth, fn) => router.add('PUT', path, { auth }, fn);
  const patch = (path, auth, fn) => router.add('PATCH', path, { auth }, fn);
  const del = (path, auth, fn) => router.add('DELETE', path, { auth }, fn);

  const userDto = (u) => ({
    id: u.id,
    role: u.role,
    name: u.name,
    email: u.email ?? null,
    username: u.username ?? null,
    avatar: u.avatar,
    color: u.color,
    timezone: u.timezone,
  });

  const note = (v) => text(v, { field: 'Note', max: 140, optional: true });
  const positive = (v, field = 'Amount') => cents(v, { field });

  /** Counts an attempt on several limiters in one transaction, before any slow work (see AttemptLimiter). */
  const reserveAll = (pairs) => AttemptLimiter.reserveMany(db, pairs);

  /** Checks a password the user typed to confirm a sensitive action, with brute-force protection. */
  async function confirmPassword(ctx, plain) {
    const key = `${ctx.user.id}`;
    await limiters.confirm.reserve(key);
    const ok = typeof plain === 'string' && (await verifyPassword(plain, ctx.user.password_hash));
    if (!ok) throw new HttpError(403, 'wrong_password', "That password isn't right.");
    await limiters.confirm.reset(key);
  }

  async function startSession(ctx, user) {
    const { token, expires } = await createSession(db, user.id, clock());
    ctx.setSession(token, expires);
  }

  const counts = async (user) => {
    const [unread, pending] = await Promise.all([bank.unreadCount(user.id), user.role === 'parent' ? bank.pendingRequestCount(user.id) : 0]);
    return { unread, pending };
  };

  // ───────────── health ─────────────
  get('/api/health', null, () => ({ ok: true }));

  // ───────────── self-check ─────────────
  // Runs the same kinds of steps a sign-in does and reports which one fails, so a broken deployment can be
  // diagnosed without log access. Reports only booleans and sanitised error text — never secrets or data.
  const clean = (err) =>
    `${err?.code ?? err?.name ?? 'Error'}: ${String(err?.message ?? err)
      .replace(/\b(?:libsql|https?|wss?|file):\/\/\S+/gi, '<url>')
      .replace(/[A-Za-z0-9_\-.]{36,}/g, '<redacted>')
      .slice(0, 220)}`;
  let lastDiagnose = 0;
  get('/api/diagnose', null, async () => {
    if (Date.now() - lastDiagnose < 3000) throw new HttpError(429, 'slow_down', 'Try again in a few seconds.');
    lastDiagnose = Date.now();
    const out = {
      ok: true,
      node: process.version,
      platform: process.env.VERCEL ? 'vercel' : process.env.RENDER ? 'render' : 'other',
      region: process.env.VERCEL_REGION ?? null,
      database: dbScheme,
      env: { TURSO_DATABASE_URL: !!process.env.TURSO_DATABASE_URL, TURSO_AUTH_TOKEN: !!process.env.TURSO_AUTH_TOKEN, CRON_SECRET: !!process.env.CRON_SECRET },
      steps: [],
    };
    const step = async (name, fn) => {
      const started = Date.now();
      try {
        await fn();
        out.steps.push({ name, ok: true, ms: Date.now() - started });
      } catch (err) {
        out.ok = false;
        out.steps.push({ name, ok: false, ms: Date.now() - started, error: clean(err) });
      }
    };
    await step('database setup', () => db.ensureReady());
    await step('read', () => db.get('SELECT COUNT(*) AS n FROM users'));
    await step('write transaction (rolled back)', async () => {
      const undo = new Error('rollback');
      try {
        await db.atomic(async () => {
          await db.run("INSERT INTO rate_limits (key, count, locked_until, updated_at) VALUES ('diagnose', 0, 0, 0)");
          throw undo;
        });
      } catch (err) {
        if (err !== undo) throw err;
      }
    });
    await step('password hashing', () => hashPassword('diagnostic'));
    return out;
  });

  // ───────────── scheduled jobs ─────────────
  // Hosts without a long-running process (e.g. Vercel) call this on a schedule. It also runs opportunistically
  // while people use the app, so allowances still land on time if the schedule is coarse.
  get('/api/cron/allowances', null, async (ctx) => {
    const header = String(ctx.req.headers.authorization ?? '');
    const expected = `Bearer ${cronSecret ?? ''}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (!cronSecret || a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'unauthenticated', 'Not allowed.');
    const ran = await bank.runScheduled();
    await purgeExpiredSessions(db, clock());
    return { paid: ran.allowances.length, interest: ran.interest.length };
  });

  // ───────────── auth ─────────────
  post('/api/auth/register', null, async (ctx) => {
    await limiters.register.reserve(ctx.ip); // every attempt counts toward the hourly cap
    const name = text(ctx.body.name, { field: 'Name', max: 60 });
    const mail = email(ctx.body.email);
    const pw = password(ctx.body.password, { min: 8 });
    const taken = new HttpError(409, 'email_taken', 'An account with that email already exists. Try logging in.');
    if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', [mail])) throw taken;
    const hash = await hashPassword(pw);
    let info;
    try {
      info = await db.run(
        `INSERT INTO users (role, name, email, password_hash, avatar, color, timezone, created_at)
         VALUES ('parent', ?, ?, ?, '🧑', 'violet', ?, ?)`,
        [name, mail, hash, timezone(ctx.body.timezone), clock().toISOString()],
      );
    } catch (err) {
      // Two sign-ups for the same email can both pass the check above while hashing; the UNIQUE index catches the loser.
      if (/UNIQUE/i.test(String(err?.message))) throw taken;
      throw err;
    }
    const user = await bank.getUser(info.lastInsertRowid);
    await startSession(ctx, user);
    return { user: userDto(user), unread: 0 };
  });

  post('/api/auth/login', null, async (ctx) => {
    const role = oneOf(ctx.body.role, ['parent', 'kid'], { field: 'Account type' });
    const identifier = text(ctx.body.identifier, { field: role === 'parent' ? 'Email' : 'Username', max: 254 }).toLowerCase();
    if (typeof ctx.body.password !== 'string' || !ctx.body.password) {
      throw new HttpError(400, 'invalid', role === 'parent' ? 'Enter your password.' : 'Enter your PIN.');
    }
    const key = `${ctx.ip}:${role}:${identifier}`;
    const ipKey = ctx.ip;
    const acctKey = `${role}:${identifier}`;
    // Count the attempt on all three limiters up front, before the slow hash, so parallel guesses can't race past the limit.
    await reserveAll([
      [limiters.login, key],
      [limiters.loginAccount, acctKey],
      [limiters.loginIp, ipKey],
    ]);

    const user = await db.get(
      role === 'parent' ? "SELECT * FROM users WHERE role = 'parent' AND email = ?" : "SELECT * FROM users WHERE role = 'kid' AND username = ?",
      [identifier],
    );
    let ok = false;
    if (user) ok = await verifyPassword(ctx.body.password, user.password_hash);
    else await burnPasswordCheck(ctx.body.password);
    if (!ok) {
      throw new HttpError(401, 'bad_credentials', role === 'parent' ? 'Incorrect email or password.' : 'Incorrect username or PIN.');
    }
    await Promise.all([limiters.login.reset(key), limiters.loginAccount.reset(acctKey), limiters.loginIp.release(ipKey)]);
    await startSession(ctx, user);
    return { user: userDto(user), unread: await bank.unreadCount(user.id) };
  });

  post('/api/auth/logout', 'user', async (ctx) => {
    await destroySession(db, ctx.token);
    ctx.clearSession();
    return { ok: true };
  });

  // Public: lets a signed-out visitor's first page load succeed quietly instead of logging a 401.
  get('/api/session', null, async (ctx) => (ctx.user ? { user: userDto(ctx.user), ...(await counts(ctx.user)) } : { user: null }));

  get('/api/me', 'user', async (ctx) => ({ user: userDto(ctx.user), ...(await counts(ctx.user)) }));

  patch('/api/me', 'parent', async (ctx) => {
    const name = text(ctx.body.name, { field: 'Name', max: 60 });
    const tz = timezone(ctx.body.timezone);
    await db.run('UPDATE users SET name = ?, timezone = ? WHERE id = ?', [name, tz, ctx.user.id]);
    return { user: userDto(await bank.getUser(ctx.user.id)) };
  });

  post('/api/auth/password', 'user', async (ctx) => {
    await confirmPassword(ctx, ctx.body.current);
    const next = password(ctx.body.next, { min: ctx.user.role === 'parent' ? 8 : KID_PIN_MIN, field: ctx.user.role === 'parent' ? 'New password' : 'New PIN' });
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), ctx.user.id]);
    await destroyUserSessions(db, ctx.user.id, ctx.token);
    return { ok: true };
  });

  // ───────────── notifications ─────────────
  get('/api/notifications', 'user', (ctx) => bank.listNotifications(ctx.user.id));
  post('/api/notifications/read', 'user', async (ctx) => {
    await bank.markNotificationsRead(ctx.user.id);
    return { ok: true };
  });

  // ───────────── parent: overview, funds ─────────────
  get('/api/parent/overview', 'parent', (ctx) => bank.parentOverview(ctx.user.id));

  post('/api/parent/funds', 'parent', async (ctx) => ({
    balanceCents: await bank.addFunds(ctx.user.id, positive(ctx.body.amountCents)),
  }));

  // ───────────── parent: kids ─────────────
  post('/api/kids', 'parent', async (ctx) => {
    const name = text(ctx.body.name, { field: 'Name', max: 40 });
    const uname = username(ctx.body.username);
    const pin = password(ctx.body.password, { min: KID_PIN_MIN, field: 'PIN' });
    const avatar = oneOf(ctx.body.avatar ?? AVATARS[0], AVATARS, { field: 'Avatar' });
    const color = oneOf(ctx.body.color ?? COLORS[0], COLORS, { field: 'Color' });
    const hash = await hashPassword(pin);
    const kidId = await bank.createKid(ctx.user, { name, username: uname, passwordHash: hash, avatar, color });
    return { id: kidId };
  });

  get('/api/kids/:id', 'parent', (ctx) => bank.kidDetail(ctx.user.id, id(ctx.params.id)));

  patch('/api/kids/:id', 'parent', async (ctx) => {
    await bank.updateKid(ctx.user.id, id(ctx.params.id), {
      name: text(ctx.body.name, { field: 'Name', max: 40 }),
      avatar: oneOf(ctx.body.avatar, AVATARS, { field: 'Avatar' }),
      color: oneOf(ctx.body.color, COLORS, { field: 'Color' }),
    });
    return { ok: true };
  });

  post('/api/kids/:id/password', 'parent', async (ctx) => {
    const kidId = id(ctx.params.id);
    const kid = await bank.ownKid(ctx.user.id, kidId);
    const pin = password(ctx.body.password, { min: KID_PIN_MIN, field: 'PIN' });
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(pin), kidId]);
    await destroyUserSessions(db, kidId);
    // A parent resetting the PIN is the recovery path if someone locked the kid out.
    await limiters.loginAccount.reset(`kid:${kid.username}`);
    return { ok: true };
  });

  del('/api/kids/:id', 'parent', async (ctx) => {
    const kidId = id(ctx.params.id);
    await bank.ownKid(ctx.user.id, kidId);
    await confirmPassword(ctx, ctx.body.password);
    return bank.removeKid(ctx.user.id, kidId);
  });

  put('/api/kids/:id/controls', 'parent', (ctx) => {
    const input = {};
    for (const key of ['frozen', 'weeklyLimitCents', 'maxRequestCents', 'allowance', 'interestBps']) if (key in ctx.body) input[key] = ctx.body[key];
    return bank.updateControls(ctx.user.id, id(ctx.params.id), input);
  });

  post('/api/kids/:id/send', 'parent', (ctx) =>
    bank.sendMoney(ctx.user.id, id(ctx.params.id), positive(ctx.body.amountCents), note(ctx.body.note)),
  );

  post('/api/kids/:id/take', 'parent', (ctx) =>
    bank.takeBack(ctx.user.id, id(ctx.params.id), positive(ctx.body.amountCents), note(ctx.body.note)),
  );

  // ───────────── parent: requests + activity ─────────────
  get('/api/requests', 'parent', async (ctx) => ({ items: await bank.requestsForParent(ctx.user.id, { limit: 60 }) }));

  post('/api/requests/:id/approve', 'parent', (ctx) =>
    bank.decideRequest(ctx.user.id, id(ctx.params.id), true, note(ctx.body.note)),
  );
  post('/api/requests/:id/decline', 'parent', (ctx) =>
    bank.decideRequest(ctx.user.id, id(ctx.params.id), false, note(ctx.body.note)),
  );

  const pageParams = (ctx) => ({
    before: ctx.query.get('before') ? id(ctx.query.get('before')) : null,
    limit: Math.min(Math.max(Number(ctx.query.get('limit')) || 30, 1), 100),
  });

  get('/api/activity', 'parent', async (ctx) => {
    const kidParam = ctx.query.get('kid');
    const kidId = kidParam ? id(kidParam) : null;
    if (kidId) await bank.ownKid(ctx.user.id, kidId);
    return bank.familyActivity(ctx.user.id, { kidId, ...pageParams(ctx) });
  });

  // ───────────── parent: chores ─────────────
  const choreInput = (body) => ({
    title: text(body.title, { field: 'Chore', max: 60 }),
    emoji: oneOf(body.emoji ?? CHORE_EMOJI[0], CHORE_EMOJI, { field: 'Emoji' }),
    rewardCents: cents(body.rewardCents, { field: 'Reward', min: MIN_REWARD_CENTS, max: MAX_REWARD_CENTS }),
    repeat: oneOf(body.repeat ?? 'once', REPEATS, { field: 'Repeat' }),
  });
  get('/api/chores', 'parent', (ctx) => bank.choresForParent(ctx.user.id));
  post('/api/chores', 'parent', async (ctx) => ({
    id: await bank.createChore(ctx.user.id, id(ctx.body.kidId), choreInput(ctx.body)),
  }));
  patch('/api/chores/:id', 'parent', async (ctx) => {
    await bank.updateChore(ctx.user.id, id(ctx.params.id), choreInput(ctx.body));
    return { ok: true };
  });
  del('/api/chores/:id', 'parent', async (ctx) => {
    await bank.archiveChore(ctx.user.id, id(ctx.params.id));
    return { ok: true };
  });
  post('/api/chore-claims/:id/approve', 'parent', (ctx) => bank.decideClaim(ctx.user.id, id(ctx.params.id), true, note(ctx.body.note)));
  post('/api/chore-claims/:id/reject', 'parent', (ctx) => bank.decideClaim(ctx.user.id, id(ctx.params.id), false, note(ctx.body.note)));

  // ───────────── parent: insights + export ─────────────
  get('/api/insights', 'parent', (ctx) => {
    const days = Number(ctx.query.get('days') ?? 30);
    if (!INSIGHT_RANGES.includes(days)) throw new HttpError(400, 'invalid', 'Pick 7, 30 or 90 days.');
    const kidParam = ctx.query.get('kid');
    return bank.insights(ctx.user.id, { days, kidId: kidParam ? id(kidParam) : null });
  });

  get('/api/export.csv', 'parent', async (ctx) => {
    const kidParam = ctx.query.get('kid');
    const kidId = kidParam ? id(kidParam) : null;
    if (kidId) await bank.ownKid(ctx.user.id, kidId);
    const { items } = await bank.familyActivity(ctx.user.id, { kidId, limit: 5000 });
    const stamp = clock().toISOString().slice(0, 10);
    return new RawResponse(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="nestly-activity-${stamp}.csv"` }, activityCsv(items.reverse()));
  });

  // ───────────── kid ─────────────
  get('/api/kid/chores', 'kid', (ctx) => bank.choresForKid(ctx.user.id));
  post('/api/kid/chores/:id/claim', 'kid', async (ctx) => ({ id: await bank.claimChore(ctx.user.id, id(ctx.params.id)) }));
  del('/api/kid/chore-claims/:id', 'kid', async (ctx) => {
    await bank.cancelClaim(ctx.user.id, id(ctx.params.id));
    return { ok: true };
  });

  get('/api/kid/overview', 'kid', (ctx) => bank.kidOverview(ctx.user.id));
  get('/api/kid/activity', 'kid', (ctx) => bank.kidActivity(ctx.user.id, pageParams(ctx)));

  post('/api/kid/spend', 'kid', (ctx) =>
    bank.spend(
      ctx.user.id,
      positive(ctx.body.amountCents),
      oneOf(ctx.body.category, CATEGORIES, { field: 'Category' }),
      note(ctx.body.note),
    ),
  );

  post('/api/kid/requests', 'kid', async (ctx) => ({
    id: await bank.createRequest(ctx.user.id, positive(ctx.body.amountCents), text(ctx.body.reason, { field: 'Reason', max: 140 })),
  }));
  del('/api/kid/requests/:id', 'kid', async (ctx) => {
    await bank.cancelRequest(ctx.user.id, id(ctx.params.id));
    return { ok: true };
  });

  const GOAL_EMOJI = ['🎯', '🚲', '🎮', '🧸', '📱', '🎧', '👟', '🎸', '⚽', '🎨', '🚀', '📚', '🎁', '🏕️', '🛹', '🐶'];
  post('/api/kid/goals', 'kid', async (ctx) => ({
    id: await bank.createGoal(ctx.user.id, {
      name: text(ctx.body.name, { field: 'Goal name', max: 40 }),
      emoji: oneOf(ctx.body.emoji ?? GOAL_EMOJI[0], GOAL_EMOJI, { field: 'Emoji' }),
      targetCents: cents(ctx.body.targetCents, { field: 'Goal amount', min: 100 }),
    }),
  }));
  post('/api/kid/goals/:id/save', 'kid', (ctx) => bank.saveToGoal(ctx.user.id, id(ctx.params.id), positive(ctx.body.amountCents)));
  post('/api/kid/goals/:id/withdraw', 'kid', async (ctx) => {
    await bank.withdrawFromGoal(ctx.user.id, id(ctx.params.id), positive(ctx.body.amountCents));
    return { ok: true };
  });
  post('/api/kid/goals/:id/purchase', 'kid', async (ctx) => {
    await bank.purchaseGoal(ctx.user.id, id(ctx.params.id));
    return { ok: true };
  });
  del('/api/kid/goals/:id', 'kid', async (ctx) => {
    await bank.cancelGoal(ctx.user.id, id(ctx.params.id));
    return { ok: true };
  });
}
