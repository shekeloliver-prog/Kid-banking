# Nestly — the family bank

A parent-and-kid banking website. Parents add their kids, fund the family balance, and
decide exactly how much each kid gets and what they can do with it. Kids get their own
login with a playful view of their money: balance, savings goals, spending, and a way to
ask for more.

> **Practice money.** Balances are play dollars. Nothing is connected to a real bank,
> card or payment processor. **Credit/debit card linking is intentionally not built yet** —
> the Funding page shows a "Coming soon" placeholder and the app never asks for card details.

## Run it

Requires **Node 22.13+**. There are no npm dependencies to install.

```bash
npm run demo     # seeds a demo family with 5 weeks of history, then starts the app
# or
npm start        # starts with an empty database (data/nestly.db)
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
  lib/db.js         schema (Node's built-in node:sqlite)
public/             the single-page app: vanilla ES modules + one stylesheet, no build step
test/api.test.js    API tests (npm test)
```

**Money safety**
- Amounts are integer cents end to end; the API rejects anything else.
- Transfers write both sides of the ledger inside one `BEGIN IMMEDIATE` transaction, and balances
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
job that runs every 30 seconds. After downtime it pays one allowance, not a backlog.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DB_PATH` | `data/nestly.db` | SQLite file |
| `TRUST_PROXY` | `0` | Number of trusted proxies in front of the app (see *Deploy*). Makes cookies `Secure` behind TLS and reads client IPs from `X-Forwarded-For` |

## Deploy to Render

Nestly is one always-on Node server with a SQLite file, so it needs a host with a **persistent disk**
(Render, Railway, Fly.io…). It will not work on serverless platforms such as Vercel: the filesystem there is
ephemeral and the allowance scheduler needs a process that stays up.

1. Push this repo to GitHub (the Blueprint deploys the `main` branch).
2. In Render: **New → Blueprint**, pick this repository, and approve the plan. `render.yaml` creates the
   web service, sets `TRUST_PROXY=1`, `DB_PATH=/var/data/nestly.db`, `NODE_VERSION`, a health check on
   `/api/health`, and a 1 GB disk mounted at `/var/data`.
3. Open the `onrender.com` URL and choose **Create an account**.

Notes:
- The disk needs a paid instance (the Blueprint uses `starter`). Without a disk, data is lost on every restart.
- Don't run `npm run demo` in production — it publishes known demo logins.
- Back up `/var/data/nestly.db` (Render disk snapshots, or `sqlite3 nestly.db ".backup out.db"`).
- `TRUST_PROXY` is the **number of proxies in front of the app** (`1` = trust one). The client IP is read that many
  entries from the *right* of `X-Forwarded-For`, because everything further left is client-supplied. The first
  request after each start logs the header it saw (`[proxy] first request: …`). If every visitor ends up sharing
  one IP — e.g. you see "Too many attempts" for different people at once — Render has more than one proxy hop in
  front of you, so raise it to `2`. Never set it higher than the real number of hops. Per-account login lockout
  doesn't depend on the client IP at all.

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
