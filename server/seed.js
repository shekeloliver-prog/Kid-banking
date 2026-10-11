// Builds a demo family with five weeks of history by replaying real operations
// against a moving clock, so balances and ledgers are internally consistent.
//   npm run demo
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './lib/db.js';
import { createBank } from './lib/bank.js';
import { hashPassword } from './lib/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = join(root, 'data', 'demo.db');
for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);

const db = openDb(dbPath);
const realNow = Date.now();
let clockMs = realNow - 36 * 86400000;
const bank = createBank(db, () => new Date(clockMs));

// Small deterministic PRNG so the demo looks the same every time.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const parentInfo = db
  .prepare("INSERT INTO users (role, name, email, password_hash, avatar, color, timezone, created_at) VALUES ('parent', 'Sam Rivera', 'demo@nestly.app', ?, '🧑', 'violet', ?, ?)")
  .run(await hashPassword('nestly-demo'), zone, new Date(clockMs).toISOString());
const parent = bank.getUser(Number(parentInfo.lastInsertRowid));
const kidHash = await hashPassword('1234');

const mia = bank.createKid(parent, { name: 'Mia', username: 'mia', passwordHash: kidHash, avatar: '🦄', color: 'pink' });
const leo = bank.createKid(parent, { name: 'Leo', username: 'leo', passwordHash: kidHash, avatar: '🐼', color: 'teal' });

bank.addFunds(parent.id, 50000);
bank.updateControls(parent.id, mia, { weeklyLimitCents: 3000, allowance: { cents: 1000, freq: 'weekly', day: 5, active: true } });
bank.updateControls(parent.id, leo, { maxRequestCents: 2500, allowance: { cents: 1500, freq: 'monthly', day: 1, active: true } });

const miaGoal = bank.createGoal(mia, { name: 'New scooter', emoji: '🛹', targetCents: 6000 });
const miaGoal2 = bank.createGoal(mia, { name: 'Art supplies', emoji: '🎨', targetCents: 2500 });
const leoGoal = bank.createGoal(leo, { name: 'Soccer cleats', emoji: '⚽', targetCents: 4500 });

const tick = (ms) => (clockMs += ms);
const attempt = (fn) => {
  try {
    fn();
  } catch {
    /* limits and low balances are part of real life */
  }
};

for (let day = 0; day < 36; day++) {
  tick(9 * 3600000);
  bank.runAllowances();
  if (day === 12) attempt(() => bank.addFunds(parent.id, 30000));
  if (day === 3) attempt(() => bank.sendMoney(parent.id, mia, 2000, 'Birthday money from Grandma'));
  if (day === 9) attempt(() => bank.sendMoney(parent.id, leo, 2000, 'Gift from Grandpa'));
  if (day === 15) attempt(() => bank.sendMoney(parent.id, leo, 1500, 'Helped wash the car'));
  if (day === 28) attempt(() => bank.sendMoney(parent.id, leo, 1000, 'Cleaned the garage'));
  if (day === 22) attempt(() => bank.sendMoney(parent.id, mia, 1000, 'Reading challenge reward'));

  tick(4 * 3600000);
  if (rand() < 0.3) attempt(() => bank.spend(mia, pick([150, 225, 349, 400, 650, 799]), pick(['food', 'toys', 'books', 'fun', 'games']), pick([null, 'With friends', 'After school', null])));
  if (rand() < 0.22) attempt(() => bank.spend(leo, pick([200, 300, 450, 600, 900]), pick(['food', 'games', 'fun', 'toys']), pick([null, 'Arcade', 'Snack', null])));
  if (day % 9 === 5) {
    attempt(() => bank.saveToGoal(mia, miaGoal, 500));
    attempt(() => bank.saveToGoal(leo, leoGoal, 700));
  }
  if (day === 18) attempt(() => bank.saveToGoal(mia, miaGoal2, 1000));
  tick(11 * 3600000);
}

// A few things waiting for the parent today.
clockMs = realNow - 3 * 3600000;
bank.createRequest(mia, 1200, 'Movie with Priya on Saturday');
clockMs = realNow - 45 * 60000;
bank.createRequest(leo, 800, 'New pack of trading cards');

console.log('Demo family ready → data/demo.db');
db.close();
