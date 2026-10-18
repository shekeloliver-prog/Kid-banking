# Nestly — the family bank

A parent-and-kid banking website. Parents add their kids, fund the family balance, and
decide exactly how much each kid gets and what they can do with it. Kids get their own
login with a playful view of their money: balance, savings goals, spending, and a way to
ask for more.

> **Practice money.** Balances are play dollars. Nothing is connected to a real bank,
> card or payment processor. **Credit/debit card linking is intentionally not built yet** —
> the Funding page shows a "Coming soon" placeholder and the app never asks for card details.

## Run it

Requires **Node 20.10+**.

```bash
npm install
npm run demo     # seeds a demo family with 5 weeks of history, then starts the app
# or
npm start        # starts with an empty local database (data/nestly.db)
```

Open <http://localhost:3000>.

Demo logins (`npm run demo`):

| Who | Login | Password / PIN |
| --- | --- | --- |
| Parent (Sam) | `demo@nestly.app` | `nestly-demo` |
| Kid (Mia) | `mia` | `123456` |
| Kid (Leo) | `leo` | `123456` |

To start fresh instead, run `npm start`, choose **Create an account**, and follow the
three-step setup on the home page.

## What parents can do

- **Create kid accounts** with a username, PIN, avatar and colour; reset a PIN; edit or remove a kid
  (their money returns to you; removal needs your password).
- **Fund their balance** with practice money, then **send** money to a kid or **take it back**, with notes.
- **Allowance on autopilot** — weekly, biweekly or monthly, on the day you pick, paid in *your* time zone.
  If your balance is too low it waits, tells you once, and pays as soon as you add funds.
- **Spending controls** — a rolling 7-day spending limit, a cap on how much a kid can request at once,
  and a one-switch **pause spending** that still lets them save and ask.
- **Approve or decline requests** (with an optional note), see a 14-day spending chart, savings goals
  and a full activity feed per kid or for everyone.
- **Notifications** for requests, purchases, goals reached and missed allowances.

## What kids can do

- See their balance, upcoming allowance and how much they can still spend this week.
- **Spend** (record a purchase by category), **ask** a parent for money, and **save** toward goals
  with progress rings — hit the target and buy it, with confetti.
- Their own notifications and activity history.

## How it works

```
server/
  index.js          entry point (PORT, HOST, DB_PATH, TRUST_PROXY, --demo)
  app.js            HTTP pipeline: security headers, CSRF checks, auth, routing, background jobs
  routes.js         the JSON API
  seed.js           builds the demo family by replaying real operations on a moving clock
  lib/bank.js       the banking engine — every money movement is one SQLite transaction
  lib/auth.js       scrypt password hashing, sessions, login throttling
  config.js         picks the database from the environment
  lib/db.js         schema + one async interface over libSQL (local file or hosted Turso)
api/index.js        Vercel serverless entry (same app, no server process)
vercel.json         Vercel config: /api rewrite, security headers, daily allowance cron
render.yaml         Render blueprint (free plan + Turso)
public/             the single-page app: vanilla ES modules + one stylesheet, no build step
test/api.test.js    API tests (npm test)
```

**Money safety**
- Amounts are integer cents end to end; the API rejects anything else.
- Transfers write both sides of the ledger inside one write transaction, and balances
  can't go negative (a database `CHECK` plus explicit checks with friendly errors).
- The tests include a race: 12 simultaneous sends against a $100 balance produce exactly 5 successes.

**Security**
- Passwords hashed with scrypt; sessions are random tokens stored hashed, in `HttpOnly`, `SameSite=Lax` cookies
  (`Secure` automatically over HTTPS).
- Login lockout after repeated failures — attempts are counted *before* the slow password check, so a burst of
  parallel guesses can't slip past the limit — plus a per-account limit that ignores the client IP; generic error
  messages, and unknown accounts cost the same time as wrong passwords. Kid PINs are at least 6 characters, and
  resetting a kid's PIN clears any lockout. Password hashing is capped at 2 concurrent jobs so a flood of logins
  can't starve the server.
- Every kid/parent route is authorised by ownership — a parent can only ever reach their own kids.
- CSRF defence (Origin / `Sec-Fetch-Site` checks plus JSON-only bodies), a strict Content-Security-Policy
  (no inline script or style), and all user text is rendered with text nodes, never as HTML.

**Time:** allowances are scheduled as calendar dates in the parent's time zone and paid by a background
job (every 30 seconds on a normal server; see *Deploy* for serverless hosts). After downtime it pays one
allowance, not a backlog.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DB_PATH` | `data/nestly.db` | Local SQLite file (ignored when `TURSO_DATABASE_URL` is set) |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | _unset_ | Use a hosted Turso database instead of a local file |
| `CRON_SECRET` | _unset_ | Enables `/api/cron/allowances` (called daily by Vercel Cron) |
| `TRUST_PROXY` | `0` | Number of trusted proxies in front of the app (see *Deploy*). Makes cookies `Secure` behind TLS and reads client IPs from `X-Forwarded-For` |

## Deploy for free (Vercel or Render + Turso)

Free hosts don't keep files between runs, so Nestly stores its data in a **Turso** database (hosted SQLite,
free tier). The same code runs against a local file on your laptop and against Turso in the cloud — only the
environment variables differ.

### 1. Create the free database (2 minutes)
1. Sign up at <https://turso.tech> and create a database. Pick a region close to your host
   (for Vercel, a US East region such as AWS `us-east-1` / Virginia; the function runs in `iad1`).
2. Copy its **URL** (`libsql://…turso.io`) and create an **auth token**.
   (On Vercel you can instead add Turso from the **Marketplace** tab, which sets both variables for you.)

### 2a. Vercel
1. Import this repo in Vercel (no build settings to change — `vercel.json` handles it).
2. Add these **Environment Variables** (Production + Preview), then redeploy:

| Variable | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | the `libsql://…` URL |
| `TURSO_AUTH_TOKEN` | the Turso token |
| `CRON_SECRET` | any long random string (Vercel sends it to the daily allowance job automatically) |

Until the database variables are set, the site shows a "Nestly isn't set up yet" message instead of crashing.
Preview deployments (branches) use the **Preview** environment's variables, so add them there too if you want to test a branch.
`TRUST_PROXY` isn't needed: the Vercel entry already trusts exactly one proxy.

### 2b. Render (free plan)
1. **New → Blueprint**, pick this repo; `render.yaml` creates a free web service.
2. When asked, paste `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
3. Free services sleep after ~15 minutes idle and wake in a few seconds on the next visit.
   If the database variables are missing the service refuses to start (and says why in its logs) rather than quietly
   storing data on a disk that is wiped on every restart.

### If something doesn't work
Open `https://<your-site>/api/diagnose`. It runs the same steps a sign-in does against your real database
(setup, read, write, password hashing) and shows which one fails, with secrets redacted. Server errors also show a
short code in brackets, e.g. `(SERVER_ERROR)`. Remote database URLs are always used over HTTPS (`libsql://` is
rewritten to `https://`), which is what serverless hosts need.

### How allowances work without an always-on server
There's no background process on these hosts, so allowances are paid (a) by a daily cron on Vercel,
(b) whenever someone opens the app (checked at most once a minute), and (c) on every wake-up on Render.
A due allowance can therefore arrive when the family next opens the app rather than at an exact minute.
It's safe to run from many places at once: each payment re-checks inside its own transaction that it is
still due, so it can never pay twice.

### Notes
- Don't run `npm run demo` in production — it publishes known demo logins.
- Back up your data with the Turso dashboard/CLI (`turso db shell <name> .dump`).
- `TRUST_PROXY` (non-Vercel hosts) is the **number of proxies in front of the app**. The client IP is read that many
  entries from the *right* of `X-Forwarded-For`, because everything further left is client-supplied. The first
  request after each start logs the header it saw (`[proxy] first request: …`). If every visitor ends up sharing
  one IP — e.g. you see "Too many attempts" for different people at once — there is more than one proxy hop in
  front of you, so raise it. Never set it higher than the real number of hops. Per-account login lockout
  doesn't depend on the client IP at all.
- Prefer a server with a disk (Railway, Fly.io, a VPS)? Skip Turso: leave `TURSO_*` unset, mount a volume, and set
  `DB_PATH` to a file on it.

## Tests

```bash
npm test
```

## Before real money

This is a practice bank. Moving real money means a licensed banking/payments partner (cards,
KYC, custody, compliance) — none of which is in this codebase. The card-linking screen is a
placeholder precisely so it can be wired up to a provider later.

## Ideas for next

Chores that pay out, interest on savings, linking real cards, email/SMS alerts, and multiple parents per family.
