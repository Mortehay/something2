const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Set the secret before requiring the app / signing any token.
require('./helpers/auth.js');
const request = require('supertest');
const { Pool } = require('pg');

const http = require('node:http');
const WebSocket = require('ws');

const { app, __setPool, __setAuthorityHandle } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const { loadProgression } = require('../src/services/progressionStore.js');
const { World } = require('../src/authority/world.js');
const { attachAuthority } = require('../src/authority/server.js');
const C = require('../src/services/progressionConstants.js');

// ---------------------------------------------------------------------------
// Part 1: route-protection -- no database needed. Walks the REAL Express
// route stack for the isAuthGuard marker, the same idiom
// tests/auth_protection.test.js uses for the app's direct routes. Unlike
// that file, progressionRoutes is a MOUNTED SUB-ROUTER (app.use('/api/
// progression', progressionRoutes(pool)), same shape as authRouter), so the
// three routes live one level down: app._router.stack holds a single
// 'router' layer for the mount, and THAT router's own .stack holds the
// individual GET '/' / POST '/allocate' / POST '/respec' layers.
// ---------------------------------------------------------------------------

function progressionRouteLayers() {
  const appStack = app._router && app._router.stack;
  assert.ok(appStack, 'could not locate the app router stack');
  const mountLayer = appStack.find((l) => l.name === 'router'
    && l.handle && Array.isArray(l.handle.stack)
    && l.handle.stack.some((rl) => rl.route && ['/', '/allocate', '/respec'].includes(rl.route.path)));
  assert.ok(mountLayer, 'could not locate the mounted progression router');
  return mountLayer.handle.stack.filter((rl) => rl.route);
}

test('every progression route is behind an auth guard', () => {
  const layers = progressionRouteLayers();
  // A walk that matches zero routes would pass vacuously -- assert the real
  // surface first (GET /, POST /allocate, POST /respec).
  assert.equal(layers.length, 3, `expected exactly 3 progression routes, found ${layers.length}`);
  const unguarded = layers
    .filter((l) => !l.route.stack.some((h) => h.handle && h.handle.isAuthGuard))
    .map((l) => `${Object.keys(l.route.methods).join('/').toUpperCase()} ${l.route.path}`);
  assert.deepEqual(unguarded, [], `unguarded progression routes: ${unguarded.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Part 2: functional/security tests against a REAL database, through the
// real HTTP app. Same skip-if-unreachable idiom as progression_store.test.js
// (gated on TEST_DATABASE_URL alone -- no DATABASE_URL fallback -- so a bare
// `npm test` on a machine with a working dev database can never reach this
// file) and the same disposable-user fixture: one throwaway user per test,
// tagged and unique, deleted unconditionally in a `finally`. Nothing outlives
// a test and no real account is ever touched.
//
// The real pg Pool is installed ONCE via __setPool inside `before()`, not
// per-test: index.js's `guardPool` proxy forwards every call to whatever the
// module-level `pool` binding currently is, so one swap is visible to every
// request made through `app` for the rest of this file -- repeating the
// swap per test would just churn connections for no added isolation, since
// node:test runs a file's top-level tests sequentially.
// ---------------------------------------------------------------------------

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

function skipMsg(what) {
  return `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED on this run`;
}

let dbPool = null;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return; // no DB configured -- every test below self-skips
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try {
    await p.query('SELECT 1');
    dbPool = p;
    __setPool(p);
  } catch (err) {
    await p.end().catch(() => {});
  }
});

after(async () => {
  if (dbPool) await dbPool.end().catch(() => {});
});

// True only once both the env var is set AND the connection actually opened.
function dbReady(t, what) {
  if (!requireTestDb(t, what)) return false;
  if (!dbPool) {
    const m = skipMsg(what);
    if (process.env.CI) assert.fail(m);
    t.skip(m);
    return false;
  }
  return true;
}

async function createTestUser(pool, tag) {
  const username = `progression-routes-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
    [username],
  );
  return r.rows[0].id;
}

async function dropUser(pool, userId) {
  if (userId != null) await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

// SOMET-257 made progression per-character, so every throwaway user in this
// file needs a character to hang progression off. Created here rather than in
// createTestUser's INSERT so the name stays unique per user and the character
// cascades away with dropUser.
async function createTestCharacter(pool, userId) {
  const r = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior'
     RETURNING id`,
    [userId, `progression-routes-char-${userId}-${process.pid}`],
  );
  return r.rows[0].id;
}

// The character id for a throwaway user, resolved on demand so the existing
// tests keep reading as "do this for `user`" rather than threading a second
// variable through every one of them.
async function charOf(pool, userId) {
  const r = await pool.query('SELECT id FROM characters WHERE user_id = $1', [userId]);
  return r.rows.length ? r.rows[0].id : await createTestCharacter(pool, userId);
}

// token_version defaults to 1 (migrations/1714440025000_users.js) and
// createTestUser never overrides it, so every token here is signed to match.
function tokenFor(userId) {
  return signToken({
    userId, username: `route-test-${userId}`, role: 'player', tokenVersion: 1,
  });
}

function authed(userId) {
  return { Authorization: `Bearer ${tokenFor(userId)}` };
}

test('GET returns the derived bundle alongside the raw row', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway user and reads its progression bundle')) return;
  let user;
  try {
    user = await createTestUser(dbPool, 'get');

    const res = await request(app).get('/api/progression').query({ character_id: await charOf(dbPool, user) }).set(authed(user));

    assert.equal(res.status, 200);
    // The raw row: a fresh character at level 1 / 0 xp / every stat at base.
    assert.equal(res.body.progression.character_id, await charOf(dbPool, user));
    assert.equal(res.body.progression.level, 1);
    assert.equal(res.body.progression.experience, 0);
    assert.equal(res.body.progression.stat_points, 0);
    for (const k of C.STAT_KEYS) assert.equal(res.body.progression[k], C.BASE_STAT, `${k} must start at base`);
    // The derived bundle alongside it, all literal expected values for a
    // fresh (all-base-stat) level-1 character.
    assert.equal(res.body.xpFloor, 0);
    assert.equal(res.body.xpToNext, 100); // XP_BASE(100) * level(1)
    assert.equal(res.body.respecCost, 50); // RESPEC_BASE(50) * level(1)
    assert.equal(res.body.stats.maxHp, 100);
    assert.equal(res.body.stats.maxMana, 100);
    assert.equal(res.body.stats.priceMult, 0.5);
  } finally {
    await dropUser(dbPool, user);
  }
});

// The security-critical test. Seeds a spendable pool of points on userA and
// a distinct, independently-verifiable baseline on userB, then asks the API
// -- AS userA -- to allocate points onto userB by slipping a userId into the
// body. The only thing that should move is userA's row; userB's must come
// back byte-for-byte identical to its pre-request snapshot. This is the test
// mutation check #1 targets: swap the route to read
// `req.body.userId || req.user.id` and this must fail.
test('allocate acts on the authenticated user, not a body-supplied id', async (t) => {
  if (!dbReady(t, 'this test creates two throwaway users and attempts a cross-account allocation')) return;
  let userA;
  let userB;
  try {
    userA = await createTestUser(dbPool, 'alloc-self');
    userB = await createTestUser(dbPool, 'alloc-other');
    await loadProgression(dbPool, await charOf(dbPool, userA));
    await loadProgression(dbPool, await charOf(dbPool, userA)); // idempotent; keeps the sequence obvious
    await dbPool.query('UPDATE player_progression SET stat_points = 5 WHERE character_id = (SELECT id FROM characters WHERE user_id = $1)', [userA]);
    const before = await loadProgression(dbPool, await charOf(dbPool, userB)); // userB's untouched baseline

    const res = await request(app).post('/api/progression/allocate').set(authed(userA))
      .send({ character_id: await charOf(dbPool, userA), stat: 'strength', count: 1, userId: userB });

    assert.equal(res.status, 200);
    // The caller's (userA's) own row is the one that must have moved.
    assert.equal(res.body.progression.character_id, await charOf(dbPool, userA));
    assert.equal(res.body.progression.strength, C.BASE_STAT + 1);
    assert.equal(res.body.progression.stat_points, 4);

    const after = await loadProgression(dbPool, await charOf(dbPool, userB));
    assert.deepEqual(after, before, "the OTHER user's (body-supplied) progression must be completely untouched");

    // SOMET-257 made the route take a character_id from the request, which is
    // a new way to try to reach someone else's progression -- and therefore a
    // new thing to prove is closed. Naming userB's character explicitly must
    // be refused outright, not quietly redirected to the caller's own.
    const cross = await request(app).post('/api/progression/allocate').set(authed(userA))
      .send({ character_id: await charOf(dbPool, userB), stat: 'strength', count: 1 });
    assert.equal(cross.status, 403);
    const stillUntouched = await loadProgression(dbPool, await charOf(dbPool, userB));
    assert.deepEqual(stillUntouched, before, "userB's progression must survive a cross-account allocate");
  } finally {
    await dropUser(dbPool, userA);
    await dropUser(dbPool, userB);
  }
});

test('allocate rejects an unknown stat with 400', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway user and posts a bogus stat key')) return;
  let user;
  try {
    user = await createTestUser(dbPool, 'alloc-badstat');
    await loadProgression(dbPool, await charOf(dbPool, user));
    await dbPool.query('UPDATE player_progression SET stat_points = 5 WHERE character_id = (SELECT id FROM characters WHERE user_id = $1)', [user]);
    const before = await loadProgression(dbPool, await charOf(dbPool, user));

    const res = await request(app).post('/api/progression/allocate').set(authed(user))
      .send({ character_id: await charOf(dbPool, user), stat: 'luck', count: 1 });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'unknown stat');
    const after = await loadProgression(dbPool, await charOf(dbPool, user));
    assert.deepEqual(after, before, 'a rejected allocation must change nothing');
  } finally {
    await dropUser(dbPool, user);
  }
});

test('allocate with more points than held returns 400 and changes nothing', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway user and over-spends its stat points')) return;
  let user;
  try {
    user = await createTestUser(dbPool, 'alloc-overspend');
    await loadProgression(dbPool, await charOf(dbPool, user));
    await dbPool.query('UPDATE player_progression SET stat_points = 2 WHERE character_id = (SELECT id FROM characters WHERE user_id = $1)', [user]);
    const before = await loadProgression(dbPool, await charOf(dbPool, user));

    const res = await request(app).post('/api/progression/allocate').set(authed(user))
      .send({ character_id: await charOf(dbPool, user), stat: 'strength', count: 5 });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not enough points');
    const after = await loadProgression(dbPool, await charOf(dbPool, user));
    assert.deepEqual(after, before, 'an over-budget allocation must change nothing, including the unspent points');
  } finally {
    await dropUser(dbPool, user);
  }
});

test('respec without the gold returns 402 and changes nothing', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway user, seeds a level-4 character short on gold and attempts a respec')) return;
  let user;
  try {
    user = await createTestUser(dbPool, 'respec-poor');
    await loadProgression(dbPool, await charOf(dbPool, user));
    // Level 4 (9 points granted by leveling), 5 of them already spent into
    // strength, 199 gold against a cost of RESPEC_BASE(50) * 4 = 200.
    await dbPool.query(
      'UPDATE player_progression SET level = 4, strength = 10, stat_points = 4 WHERE character_id = (SELECT id FROM characters WHERE user_id = $1)',
      [user],
    );
    await dbPool.query('UPDATE users SET gold = 199 WHERE id = $1', [user]);
    const beforeProgression = await loadProgression(dbPool, await charOf(dbPool, user));

    const res = await request(app).post('/api/progression/respec').set(authed(user)).send({ character_id: await charOf(dbPool, user) });

    assert.equal(res.status, 402);
    assert.equal(res.body.error, 'not enough gold');
    assert.equal(res.body.cost, 200);

    const afterProgression = await loadProgression(dbPool, await charOf(dbPool, user));
    assert.deepEqual(afterProgression, beforeProgression, 'stats and unspent points must be unchanged');
    const g = await dbPool.query('SELECT gold FROM users WHERE id = $1', [user]);
    assert.equal(Number(g.rows[0].gold), 199, 'gold must not move');
  } finally {
    await dropUser(dbPool, user);
  }
});

// ---------------------------------------------------------------------------
// Part 3: the live-authority follow-up. Allocate/respec must reach the LIVE
// authority session (SOMET-242 review round 2, Task 10's character-sheet
// build found this gap): a point spent into CON or DEX mid-session must move
// the HUD without a reload, not just the database row. index.js wires a
// `refreshLivePlayerStats` forwarder into progressionRoutes(); these tests
// use __setAuthorityHandle -- index.js's existing test seam for injecting a
// fake authority (see evictAuthorityWorld/isWorldLive's own tests) -- with a
// fake handle whose refreshPlayerStats method does not merely RECORD that it
// was called: it forwards straight into a REAL World instance's real
// applyDerivedStats, so "the live player's maxHp actually moved" is a
// genuine assertion about a real object mutated by real production code, not
// a spy echoing its own input back (the mock-input-blindness shape Task 6's
// review found and this repo now explicitly guards against).
// authority_server.test.js separately proves the REAL attachAuthority
// -produced refreshPlayerStats end-to-end (session lookup via
// sessionsByUser, the hp<=0 guard, the pushed 'progression' message).
// ---------------------------------------------------------------------------

function fakeAuthorityHandle(userId) {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, new Map(), null, 8);
  world.addPlayer(userId, { x: 0, y: 0 }); // joins at BASE_STATS -> maxHp 100
  const calls = [];
  return {
    world,
    calls,
    refreshPlayerStats(uid, progression, stats) {
      calls.push({ uid, progression, stats });
      return world.applyDerivedStats(uid, stats);
    },
  };
}

// SOMET-242 review round 3: the fake-handle "successful allocation" test that
// used to live here PASSED while the real path did NOTHING -- browser
// verification against a genuinely-rebuilt process found the HUD's max hp
// frozen after a real allocate. Root cause: refreshPlayerStats's Map lookups
// (sessionsByUser, entry.sockets, World#players) are keyed by the STRING the
// WS upgrade handler mints (`userId = String(payload.user_id)`), but
// req.user.id arriving from the HTTP side is the RAW, un-stringified JWT
// payload value -- a NUMBER. Every lookup silently missed on that type
// mismatch and returned false, swallowed by index.js's `?? false`. The old
// test's fake handle bypassed sessionsByUser/entry.sockets entirely (it
// forwarded straight to a bare World#applyDerivedStats using whatever type
// was handed to it), so it could not have caught this -- a stub standing in
// for the exact lookup that was broken. This version performs the REAL
// lookup: boots a genuine attachAuthority authority (a scripted pool, not
// the real DB -- the authority's own reads/writes are irrelevant to what's
// under test here), joins a real WS session for the SAME throwaway user the
// HTTP call authenticates as, then fires the real HTTP allocate and asserts
// against the player object the authority itself holds -- fetched by the
// same string key the WS boundary uses, exactly the fact the bug violated.
function fakeAuthorityPool() {
  return {
    query: async (sql) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      // token_version lookup on every WS connect/upgrade -- must match the
      // tokenVersion the join token below is signed with.
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      // SOMET-260: the join resolves the character first; falling through to
      // rows:[] refuses the join and HANGS the test on nextMsg('joined').
      if (/FROM characters/i.test(sql)) return { rows: [{ id: 1, entity_type_id: 1 }] };
      return { rows: [] }; // world_players, player_binds, item_types, player_items/equipment, gold, player_progression
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  };
}

function bootAuthority(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, { jwtSecret: process.env.JWT_SECRET, tickMs: 20 });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}

function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('a successful allocation reaches the live authority session (real lookup, not a stub)', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway user, joins a real authority session for it and allocates a point into constitution')) return;
  let user;
  let ws;
  let handle;
  let server;
  try {
    user = await createTestUser(dbPool, 'live-allocate-e2e');
    await loadProgression(dbPool, await charOf(dbPool, user));
    await dbPool.query('UPDATE player_progression SET stat_points = 1 WHERE character_id = (SELECT id FROM characters WHERE user_id = $1)', [user]);

    let url;
    ({ url, handle, server } = await bootAuthority(fakeAuthorityPool()));
    const joinToken = signToken({
      userId: user, username: 'x', role: 'player', tokenVersion: 1,
    });
    ws = new WebSocket(`${url}?token=${encodeURIComponent(joinToken)}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');

    // The player joined via loadProgression's DEFAULT_PROGRESSION fallback
    // (the scripted pool answers no player_progression row), i.e. BASE_STAT
    // constitution -> maxHp 100. Force current hp below that so the delta
    // (not a snap-to-full) is the thing actually observed.
    const player = handle.worlds.get('w1').world.getPlayer(String(user));
    assert.ok(player, 'sanity: the real join must have added a real player, string-keyed');
    assert.equal(player.maxHp, 100);
    player.hp = 60;

    __setAuthorityHandle(handle);
    const progressionMsgP = nextMsg(ws, 'progression');

    const res = await request(app).post('/api/progression/allocate').set(authed(user))
      .send({ character_id: await charOf(dbPool, user), stat: 'constitution', count: 1 });
    const msg = await progressionMsgP;

    assert.equal(res.status, 200);
    // CON 5 -> 6 (one above BASE_STAT) -> maxHp 100 + HP_PER_CON(10)*1 = 110.
    assert.equal(player.maxHp, 110, 'the player object the authority ACTUALLY holds must show the new max hp');
    assert.equal(player.hp, 70, 'hp must move by the +10 delta, not snap to the new max');
    assert.equal(msg.stats.maxHp, 110, 'the socket push must carry the same number');
  } finally {
    __setAuthorityHandle(null);
    if (ws) ws.terminate();
    if (handle) handle.close();
    if (server && server.listening) server.close();
    await dropUser(dbPool, user);
  }
});

test('a failed allocation does not touch the live authority session', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway user and posts an over-budget allocation')) return;
  let user;
  try {
    user = await createTestUser(dbPool, 'live-allocate-fail');
    await loadProgression(dbPool, await charOf(dbPool, user)); // stat_points stays 0

    const handle = fakeAuthorityHandle(user);
    const player = handle.world.getPlayer(user);
    player.maxHp = 100;
    player.hp = 60;
    __setAuthorityHandle(handle);

    const res = await request(app).post('/api/progression/allocate').set(authed(user))
      .send({ character_id: await charOf(dbPool, user), stat: 'constitution', count: 1 });

    assert.equal(res.status, 400);
    assert.equal(handle.calls.length, 0, 'refreshPlayerStats must not be called on a rejected allocation');
    assert.equal(player.maxHp, 100, 'the live player must be completely untouched');
    assert.equal(player.hp, 60);
  } finally {
    __setAuthorityHandle(null);
    await dropUser(dbPool, user);
  }
});

test('a refused respec does not touch the live authority session', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway user, seeds a level-4 character short on gold and attempts a respec')) return;
  let user;
  try {
    user = await createTestUser(dbPool, 'live-respec-fail');
    await loadProgression(dbPool, await charOf(dbPool, user));
    await dbPool.query(
      'UPDATE player_progression SET level = 4, strength = 10, stat_points = 4 WHERE character_id = (SELECT id FROM characters WHERE user_id = $1)',
      [user],
    );
    await dbPool.query('UPDATE users SET gold = 199 WHERE id = $1', [user]); // cost is 200

    const handle = fakeAuthorityHandle(user);
    const player = handle.world.getPlayer(user);
    player.maxHp = 100;
    player.hp = 60;
    __setAuthorityHandle(handle);

    const res = await request(app).post('/api/progression/respec').set(authed(user)).send({ character_id: await charOf(dbPool, user) });

    assert.equal(res.status, 402);
    assert.equal(handle.calls.length, 0, 'refreshPlayerStats must not be called on a refused respec');
    assert.equal(player.maxHp, 100, 'the live player must be completely untouched');
    assert.equal(player.hp, 60);
  } finally {
    __setAuthorityHandle(null);
    await dropUser(dbPool, user);
  }
});

// SOMET-242 whole-branch review, finding F3 seam 2: mutation (remove
// refreshLivePlayerStats from the SUCCESS branch of the respec route)
// leaves 43 tests green. There is coverage that a REFUSED respec does not
// call it (above) and that a successful ALLOCATE does (the real-lookup test
// above) -- a successful respec fell in the gap between the two. This
// matters more than it used to: eaafb14 renamed the frontend's
// applyProgressionResult to applyGoldResult(gold), which no longer writes
// `progression` at all -- the WS 'progression' push this route sends is now
// the client's ONLY writer for progression state, so a silent miss here is
// not cosmetic.
//
// Same real-lookup harness as the successful-allocation test above (real
// attachAuthority, real WS join, real HTTP call) rather than the
// call-recording fakeAuthorityHandle -- a spy cannot catch a broken lookup,
// only an outcome check on the object the authority actually holds can.
test('a successful respec reaches the live authority session (real lookup, not a stub)', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway user, seeds a level-4 character with enough gold and respecs it')) return;
  let user;
  let ws;
  let handle;
  let server;
  try {
    user = await createTestUser(dbPool, 'live-respec-e2e');
    await loadProgression(dbPool, await charOf(dbPool, user));
    await dbPool.query(
      'UPDATE player_progression SET level = 4, strength = 10, stat_points = 4 WHERE character_id = (SELECT id FROM characters WHERE user_id = $1)',
      [user],
    );
    await dbPool.query('UPDATE users SET gold = 250 WHERE id = $1', [user]); // cost is RESPEC_BASE(50)*4 = 200

    let url;
    ({ url, handle, server } = await bootAuthority(fakeAuthorityPool()));
    const joinToken = signToken({
      userId: user, username: 'x', role: 'player', tokenVersion: 1,
    });
    ws = new WebSocket(`${url}?token=${encodeURIComponent(joinToken)}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');

    const player = handle.worlds.get('w1').world.getPlayer(String(user));
    assert.ok(player, 'sanity: the real join must have added a real player, string-keyed');
    // Force the live pools to a value the post-respec (every stat back to
    // BASE_STAT) bundle clearly differs from, so a real move is what the
    // assertion below observes -- respec resets to a FIXED bundle
    // regardless of what was in the database beforehand, so without this
    // the live object could already happen to sit at the post-respec values
    // and a broken push would look identical to a working one.
    player.maxHp = 200;
    player.hp = 150;

    __setAuthorityHandle(handle);
    const progressionMsgP = nextMsg(ws, 'progression');

    const res = await request(app).post('/api/progression/respec').set(authed(user)).send({ character_id: await charOf(dbPool, user) });
    const msg = await progressionMsgP;

    assert.equal(res.status, 200);
    assert.equal(player.maxHp, 100, 'respec resets every stat to BASE_STAT -> maxHp back to 100');
    assert.equal(player.hp, 50, 'hp must move by the (now negative) delta: 150 + (100-200) = 50');
    assert.equal(msg.stats.maxHp, 100, 'the socket push must carry the same number');
  } finally {
    __setAuthorityHandle(null);
    if (ws) ws.terminate();
    if (handle) handle.close();
    if (server && server.listening) server.close();
    await dropUser(dbPool, user);
  }
});
