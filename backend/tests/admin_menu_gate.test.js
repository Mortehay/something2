// backend/tests/admin_menu_gate.test.js
// The code that unlocks the in-game admin menu: the gate itself (offline, with an injected clock)
// and source guards that both admin handlers sit behind it and that the lock is never a way to
// obtain the admin role.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createAdminMenuGate, MAX_FAILS, LOCK_MS, UNLOCK_MS } = require('../src/authority/adminMenuGate.js');

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}
const quiet = () => {};

test('with no code set the gate is off: always unlocked, any attempt succeeds', () => {
  for (const code of [undefined, '', null]) {
    const g = createAdminMenuGate({ code, warn: quiet });
    assert.equal(g.required, false);
    assert.equal(g.isUnlocked('1'), true);
    assert.deepEqual(g.unlock('1', 'whatever'), { ok: true });
  }
});

test('with a code set, an account is locked until it enters the right one', () => {
  const g = createAdminMenuGate({ code: 'correct-horse', warn: quiet });
  assert.equal(g.required, true);
  assert.equal(g.isUnlocked('7'), false);
  assert.deepEqual(g.unlock('7', 'nope'), { ok: false, error: 'wrong code' });
  assert.equal(g.isUnlocked('7'), false);
  assert.deepEqual(g.unlock('7', 'correct-horse'), { ok: true });
  assert.equal(g.isUnlocked('7'), true);
  assert.equal(g.isUnlocked(7), true, 'ids compare as text, like the rest of the server');
  assert.equal(g.isUnlocked('8'), false, 'per account');
});

test('junk attempts are wrong codes, never a crash or a pass', () => {
  const g = createAdminMenuGate({ code: 'secret-code', warn: quiet });
  for (const bad of [undefined, null, 5, {}, [], '', ' ', 'secret-code ', 'SECRET-CODE', 'x'.repeat(10_000)]) {
    assert.equal(g.unlock('1', bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(g.isUnlocked('1'), false);
});

test('an over-long attempt is cut, not compared whole to something that could match', () => {
  const code = 'a'.repeat(200);
  const g = createAdminMenuGate({ code, warn: quiet });
  assert.equal(g.unlock('1', code + 'b').ok, true, 'only the first 200 characters are read');
});

test(`${MAX_FAILS} wrong codes in a row lock the account's attempts, then it recovers`, () => {
  const now = clock();
  const g = createAdminMenuGate({ code: 'right-code', now, warn: quiet });
  for (let i = 0; i < MAX_FAILS; i++) assert.equal(g.unlock('1', 'bad').error, 'wrong code');
  const locked = g.unlock('1', 'right-code');
  assert.equal(locked.ok, false, 'even the right code is refused while locked out');
  assert.equal(locked.error, 'too many attempts');
  assert.ok(locked.retryMs > 0 && locked.retryMs <= LOCK_MS);
  assert.equal(g.unlock('2', 'right-code').ok, true, 'another account is unaffected');
  now.advance(LOCK_MS + 1);
  assert.equal(g.unlock('1', 'right-code').ok, true);
});

test('a right code resets the failure count', () => {
  const g = createAdminMenuGate({ code: 'right-code', warn: quiet });
  for (let i = 0; i < MAX_FAILS - 1; i++) g.unlock('1', 'bad');
  assert.equal(g.unlock('1', 'right-code').ok, true);
  g.lock('1');
  for (let i = 0; i < MAX_FAILS - 1; i++) assert.equal(g.unlock('1', 'bad').error, 'wrong code');
});

test('an unlock expires, and lock() takes it back at once', () => {
  const now = clock();
  const g = createAdminMenuGate({ code: 'right-code', now, warn: quiet });
  g.unlock('1', 'right-code');
  now.advance(UNLOCK_MS - 1);
  assert.equal(g.isUnlocked('1'), true);
  now.advance(2);
  assert.equal(g.isUnlocked('1'), false, 'expired');
  g.unlock('1', 'right-code');
  g.lock('1');
  assert.equal(g.isUnlocked('1'), false);
});

test('a short code is accepted but warned about', () => {
  const warnings = [];
  createAdminMenuGate({ code: 'abc', warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ADMIN_MENU_CODE/);
  createAdminMenuGate({ code: 'long-enough-code', warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1, 'no warning for a long one');
});

test('the code never appears in what the gate hands out', () => {
  const g = createAdminMenuGate({ code: 'super-secret-value', warn: quiet });
  assert.ok(!JSON.stringify({ ...g, required: g.required }).includes('super-secret-value'));
});

// ---- source guards ---------------------------------------------------------------------------

const src = fs.readFileSync(path.resolve(__dirname, '../src/authority/server.js'), 'utf8');
const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));

test('both admin handlers ask the one rule, before anything else', () => {
  const adminAction = slice('async debugAdmin(ws, msg)', 'const action = typeof msg.action');
  assert.match(adminAction, /if \(!adminMenuAllowed\(ws\)\) return;/);
  const boss = slice('async debugWorldBoss(ws, msg)', 'const action = msg.action');
  assert.match(boss, /if \(!adminMenuAllowed\(ws\)\) return;/);
});

test('the rule: with a code, whoever entered it; with none, role-admin accounts only', () => {
  const rule = src.slice(src.indexOf('const adminMenuAllowed'), src.indexOf('const worldBossManager = new'));
  assert.match(rule, /adminMenuGate\.required \? adminMenuGate\.isUnlocked\(ws\.userId\) : ws\.role === 'admin'/);
});

test('the code gives the menu and nothing else: no role, no token, nothing taken from the message', () => {
  const h = slice('async adminGate(ws, msg)', 'async debugAdmin(ws, msg)');
  assert.doesNotMatch(h, /ws\.role\s*=[^=]/, 'never grants the role');
  assert.doesNotMatch(h, /msg\.role|msg\.isAdmin|UPDATE users/);
  // with no code set, a non-admin is answered "no" before any code is looked at
  const beforeUnlock = h.slice(0, h.indexOf('adminMenuGate.unlock'));
  assert.match(beforeUnlock, /!isAdmin && !required/);
  assert.match(beforeUnlock, /allowed: false/);
});

test('the gate is created once per server from the environment', () => {
  assert.match(src, /const adminMenuGate = createAdminMenuGate\(\);/);
  assert.equal((src.match(/createAdminMenuGate\(/g) || []).length, 1);
});
