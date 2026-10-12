import { HttpError, text, cents, oneOf, password, email, username, id, timezone, AVATARS, COLORS, CATEGORIES } from './lib/util.js';
import { hashPassword, verifyPassword, burnPasswordCheck, createSession, destroySession, destroyUserSessions } from './lib/auth.js';

const KID_PIN_MIN = 6;

// Auth levels: null = public, 'parent' | 'kid' = that role only, 'user' = any signed-in account.
export function registerRoutes(router, { db, bank, limiters, clock }) {
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

  /** Checks a password the user typed to confirm a sensitive action, with brute-force protection. */
  async function confirmPassword(ctx, plain) {
    const key = `confirm:${ctx.user.id}`;
    limiters.login.reserve(key);
    const ok = typeof plain === 'string' && (await verifyPassword(plain, ctx.user.password_hash));
    if (!ok) throw new HttpError(403, 'wrong_password', "That password isn't right.");
    limiters.login.reset(key);
  }

  async function startSession(ctx, user) {
    const { token, expires } = createSession(db, user.id, clock());
    ctx.setSession(token, expires);
  }

  // ───────────── health ─────────────
  get('/api/health', null, () => ({ ok: true }));

  // ───────────── auth ─────────────
  post('/api/auth/register', null, async (ctx) => {
    limiters.register.assertAllowed(ctx.ip);
    limiters.register.fail(ctx.ip); // every attempt counts toward the hourly cap
    const name = text(ctx.body.name, { field: 'Name', max: 60 });
    const mail = email(ctx.body.email);
    const pw = password(ctx.body.password, { min: 8 });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) {
      throw new HttpError(409, 'email_taken', 'An account with that email already exists. Try logging in.');
    }
    const hash = await hashPassword(pw);
    let info;
    try {
      info = db
        .prepare(
          `INSERT INTO users (role, name, email, password_hash, avatar, color, timezone, created_at)
           VALUES ('parent', ?, ?, ?, '🧑', 'violet', ?, ?)`,
        )
        .run(name, mail, hash, timezone(ctx.body.timezone), clock().toISOString());
    } catch (err) {
      // Two sign-ups for the same email can both pass the check above while hashing; the UNIQUE index catches the loser.
      if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, 'email_taken', 'An account with that email already exists. Try logging in.');
      throw err;
    }
    const user = bank.getUser(Number(info.lastInsertRowid));
    await startSession(ctx, user);
    return { user: userDto(user), unread: 0 };
  });

  post('/api/auth/login', null, async (ctx) => {
    const role = oneOf(ctx.body.role, ['parent', 'kid'], { field: 'Account type' });
    const identifier = text(ctx.body.identifier, { field: role === 'parent' ? 'Email' : 'Username', max: 254 }).toLowerCase();
    if (typeof ctx.body.password !== 'string' || !ctx.body.password) {
      throw new HttpError(400, 'invalid', role === 'parent' ? 'Enter your password.' : 'Enter your PIN.');
    }
    const key = `login:${ctx.ip}:${role}:${identifier}`;
    const ipKey = `login-ip:${ctx.ip}`;
    const acctKey = `login-acct:${role}:${identifier}`;
    // Reserve a slot on all three limiters synchronously, before the slow hash, so parallel guesses can't race past the limit.
    limiters.login.reserve(key);
    limiters.loginAccount.reserve(acctKey);
    limiters.loginIp.reserve(ipKey);

    const user =
      role === 'parent'
        ? db.prepare("SELECT * FROM users WHERE role = 'parent' AND email = ?").get(identifier)
        : db.prepare("SELECT * FROM users WHERE role = 'kid' AND username = ?").get(identifier);
    let ok = false;
    if (user) ok = await verifyPassword(ctx.body.password, user.password_hash);
    else await burnPasswordCheck(ctx.body.password);
    if (!ok) {
      throw new HttpError(401, 'bad_credentials', role === 'parent' ? 'Incorrect email or password.' : 'Incorrect username or PIN.');
    }
    limiters.login.reset(key);
    limiters.loginAccount.reset(acctKey);
    limiters.loginIp.release(ipKey);
    await startSession(ctx, user);
    return { user: userDto(user), unread: bank.unreadCount(user.id) };
  });

  post('/api/auth/logout', 'user', (ctx) => {
    destroySession(db, ctx.token);
    ctx.clearSession();
    return { ok: true };
  });

  // Public: lets a signed-out visitor's first page load succeed quietly instead of logging a 401.
  get('/api/session', null, (ctx) =>
    ctx.user
      ? {
          user: userDto(ctx.user),
          unread: bank.unreadCount(ctx.user.id),
          pending: ctx.user.role === 'parent' ? bank.pendingRequestCount(ctx.user.id) : 0,
        }
      : { user: null },
  );

  get('/api/me', 'user', (ctx) => ({
    user: userDto(ctx.user),
    unread: bank.unreadCount(ctx.user.id),
    pending: ctx.user.role === 'parent' ? bank.pendingRequestCount(ctx.user.id) : 0,
  }));

  patch('/api/me', 'parent', (ctx) => {
    const name = text(ctx.body.name, { field: 'Name', max: 60 });
    const tz = timezone(ctx.body.timezone);
    db.prepare('UPDATE users SET name = ?, timezone = ? WHERE id = ?').run(name, tz, ctx.user.id);
    return { user: userDto(bank.getUser(ctx.user.id)) };
  });

  post('/api/auth/password', 'user', async (ctx) => {
    await confirmPassword(ctx, ctx.body.current);
    const next = password(ctx.body.next, { min: ctx.user.role === 'parent' ? 8 : KID_PIN_MIN, field: ctx.user.role === 'parent' ? 'New password' : 'New PIN' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), ctx.user.id);
    destroyUserSessions(db, ctx.user.id, ctx.token);
    return { ok: true };
  });

  // ───────────── notifications ─────────────
  get('/api/notifications', 'user', (ctx) => bank.listNotifications(ctx.user.id));
  post('/api/notifications/read', 'user', (ctx) => {
    bank.markNotificationsRead(ctx.user.id);
    return { ok: true };
  });

  // ───────────── parent: overview, funds ─────────────
  get('/api/parent/overview', 'parent', (ctx) => bank.parentOverview(ctx.user.id));

  post('/api/parent/funds', 'parent', (ctx) => ({
    balanceCents: bank.addFunds(ctx.user.id, positive(ctx.body.amountCents)),
  }));

  // ───────────── parent: kids ─────────────
  post('/api/kids', 'parent', async (ctx) => {
    const name = text(ctx.body.name, { field: 'Name', max: 40 });
    const uname = username(ctx.body.username);
    const pin = password(ctx.body.password, { min: KID_PIN_MIN, field: 'PIN' });
    const avatar = oneOf(ctx.body.avatar ?? AVATARS[0], AVATARS, { field: 'Avatar' });
    const color = oneOf(ctx.body.color ?? COLORS[0], COLORS, { field: 'Color' });
    const hash = await hashPassword(pin);
    const kidId = bank.createKid(ctx.user, { name, username: uname, passwordHash: hash, avatar, color });
    return { id: kidId };
  });

  get('/api/kids/:id', 'parent', (ctx) => bank.kidDetail(ctx.user.id, id(ctx.params.id)));

  patch('/api/kids/:id', 'parent', (ctx) => {
    bank.updateKid(ctx.user.id, id(ctx.params.id), {
      name: text(ctx.body.name, { field: 'Name', max: 40 }),
      avatar: oneOf(ctx.body.avatar, AVATARS, { field: 'Avatar' }),
      color: oneOf(ctx.body.color, COLORS, { field: 'Color' }),
    });
    return { ok: true };
  });

  post('/api/kids/:id/password', 'parent', async (ctx) => {
    const kidId = id(ctx.params.id);
    bank.ownKid(ctx.user.id, kidId);
    const pin = password(ctx.body.password, { min: KID_PIN_MIN, field: 'PIN' });
    const kid = bank.getUser(kidId);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(pin), kidId);
    destroyUserSessions(db, kidId);
    // A parent resetting the PIN is the recovery path if someone locked the kid out.
    limiters.loginAccount.reset(`login-acct:kid:${kid.username}`);
    return { ok: true };
  });

  del('/api/kids/:id', 'parent', async (ctx) => {
    const kidId = id(ctx.params.id);
    bank.ownKid(ctx.user.id, kidId);
    await confirmPassword(ctx, ctx.body.password);
    return bank.removeKid(ctx.user.id, kidId);
  });

  put('/api/kids/:id/controls', 'parent', (ctx) => {
    const input = {};
    for (const key of ['frozen', 'weeklyLimitCents', 'maxRequestCents', 'allowance']) if (key in ctx.body) input[key] = ctx.body[key];
    return bank.updateControls(ctx.user.id, id(ctx.params.id), input);
  });

  post('/api/kids/:id/send', 'parent', (ctx) =>
    bank.sendMoney(ctx.user.id, id(ctx.params.id), positive(ctx.body.amountCents), note(ctx.body.note)),
  );

  post('/api/kids/:id/take', 'parent', (ctx) =>
    bank.takeBack(ctx.user.id, id(ctx.params.id), positive(ctx.body.amountCents), note(ctx.body.note)),
  );

  // ───────────── parent: requests + activity ─────────────
  get('/api/requests', 'parent', (ctx) => ({ items: bank.requestsForParent(ctx.user.id, { limit: 60 }) }));

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

  get('/api/activity', 'parent', (ctx) => {
    const kidParam = ctx.query.get('kid');
    const kidId = kidParam ? id(kidParam) : null;
    if (kidId) bank.ownKid(ctx.user.id, kidId);
    return bank.familyActivity(ctx.user.id, { kidId, ...pageParams(ctx) });
  });

  // ───────────── kid ─────────────
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

  post('/api/kid/requests', 'kid', (ctx) => ({
    id: bank.createRequest(ctx.user.id, positive(ctx.body.amountCents), text(ctx.body.reason, { field: 'Reason', max: 140 })),
  }));
  del('/api/kid/requests/:id', 'kid', (ctx) => {
    bank.cancelRequest(ctx.user.id, id(ctx.params.id));
    return { ok: true };
  });

  const GOAL_EMOJI = ['🎯', '🚲', '🎮', '🧸', '📱', '🎧', '👟', '🎸', '⚽', '🎨', '🚀', '📚', '🎁', '🏕️', '🛹', '🐶'];
  post('/api/kid/goals', 'kid', (ctx) => ({
    id: bank.createGoal(ctx.user.id, {
      name: text(ctx.body.name, { field: 'Goal name', max: 40 }),
      emoji: oneOf(ctx.body.emoji ?? GOAL_EMOJI[0], GOAL_EMOJI, { field: 'Emoji' }),
      targetCents: cents(ctx.body.targetCents, { field: 'Goal amount', min: 100 }),
    }),
  }));
  post('/api/kid/goals/:id/save', 'kid', (ctx) => bank.saveToGoal(ctx.user.id, id(ctx.params.id), positive(ctx.body.amountCents)));
  post('/api/kid/goals/:id/withdraw', 'kid', (ctx) => {
    bank.withdrawFromGoal(ctx.user.id, id(ctx.params.id), positive(ctx.body.amountCents));
    return { ok: true };
  });
  post('/api/kid/goals/:id/purchase', 'kid', (ctx) => {
    bank.purchaseGoal(ctx.user.id, id(ctx.params.id));
    return { ok: true };
  });
  del('/api/kid/goals/:id', 'kid', (ctx) => {
    bank.cancelGoal(ctx.user.id, id(ctx.params.id));
    return { ok: true };
  });
}
