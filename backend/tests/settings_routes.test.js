const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Sets JWT_SECRET before the app or any token is created.
require('./helpers/auth.js');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

// --- Part 1: route protection, no database ---------------------------------
// Walks the REAL Express stack for the isAdminGuard marker rather than
// trusting that the routes were declared with adminGuard. /api/settings is a
// write surface for live game balance; an unguarded PUT lets any logged-in
// player set their own passive points per level.
function settingsLayers() {
  const stack = app._router && app._router.stack;
  assert.ok(stack, 'could not locate the app router stack');
  return stack.filter((l) => l.route && String(l.route.path).startsWith('/api/settings'));
}

test('both settings routes exist and both are behind the ADMIN guard', () => {
  const layers = settingsLayers();
  const found = layers
    .map((l) => `${Object.keys(l.route.methods).join('/').toUpperCase()} ${l.route.path}`)
    .sort();
  assert.deepStrictEqual(found, ['GET /api/settings', 'PUT /api/settings/:key']);
  for (const l of layers) {
    assert.ok(
      l.route.stack.some((h) => h.handle && h.handle.isAdminGuard),
      `${l.route.path} is not behind requireAdmin`,
    );
  }
});

// --- Part 2: behaviour against a real database -----------------------------
const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';
let dbPool = null;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await p.query('SELECT 1'); dbPool = p; __setPool(p); } catch { await p.end().catch(() => {}); }
});
after(async () => { if (dbPool) await dbPool.end().catch(() => {}); });

function dbReady(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg); return false;
  }
  if (!dbPool) { t.skip(`NO DATABASE at ${DB_URL} -- ${why} is UNVERIFIED`); return false; }
  return true;
}

async function createUser(pool, role) {
  const username = `settings-routes-${role}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', $2) RETURNING id",
    [username, role],
  );
  return r.rows[0].id;
}
const authed = (id, role) => ({
  Authorization: `Bearer ${signToken({ userId: id, username: `settings-${id}`, role, tokenVersion: 1 })}`,
});

test('GET returns every known key with its value and its default', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway admin and reads the settings bundle')) return;
  let admin;
  try {
    admin = await createUser(dbPool, 'admin');
    const res = await request(app).get('/api/settings').set(authed(admin, 'admin'));
    assert.equal(res.status, 200);
    const by = new Map(res.body.map((r) => [r.key, r]));
    assert.deepStrictEqual([...by.keys()].sort(), [
      'ground_item_ttl_seconds', 'passive_points_per_level', 'rarity_weights', 'respec_base_gold',
    ]);
    assert.strictEqual(by.get('passive_points_per_level').value, 1);
    assert.strictEqual(by.get('passive_points_per_level').default_value, 1);
    assert.strictEqual(by.get('ground_item_ttl_seconds').default_value, 180);
  } finally {
    if (admin != null) await dbPool.query('DELETE FROM users WHERE id = $1', [admin]);
  }
});

test('a non-admin is refused on both verbs and changes nothing', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway player and attempts to read/write settings')) return;
  let player;
  try {
    player = await createUser(dbPool, 'player');
    const get = await request(app).get('/api/settings').set(authed(player, 'player'));
    assert.equal(get.status, 403);
    const put = await request(app).put('/api/settings/ground_item_ttl_seconds')
      .set(authed(player, 'player')).send({ value: 9 });
    assert.equal(put.status, 403);
    const { rows } = await dbPool.query(
      "SELECT value FROM game_settings WHERE key = 'ground_item_ttl_seconds'");
    assert.strictEqual(rows[0].value, 180, 'a refused PUT must not have written');
  } finally {
    if (player != null) await dbPool.query('DELETE FROM users WHERE id = $1', [player]);
  }
});

test('PUT writes a valid value and refuses an invalid one with 400', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway admin and updates a setting')) return;
  let admin;
  try {
    admin = await createUser(dbPool, 'admin');
    const ok = await request(app).put('/api/settings/ground_item_ttl_seconds')
      .set(authed(admin, 'admin')).send({ value: 240 });
    assert.equal(ok.status, 200);
    assert.strictEqual(ok.body.value, 240);
    const { rows } = await dbPool.query(
      "SELECT value FROM game_settings WHERE key = 'ground_item_ttl_seconds'");
    assert.strictEqual(rows[0].value, 240);

    const negative = await request(app).put('/api/settings/ground_item_ttl_seconds')
      .set(authed(admin, 'admin')).send({ value: -5 });
    assert.equal(negative.status, 400);
    assert.match(negative.body.error, /ground_item_ttl_seconds/);

    const unknown = await request(app).put('/api/settings/passive_points_per_lvl')
      .set(authed(admin, 'admin')).send({ value: 2 });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /unknown setting/);
    const { rows: after } = await dbPool.query(
      "SELECT count(*)::int AS n FROM game_settings WHERE key = 'passive_points_per_lvl'");
    assert.strictEqual(after[0].n, 0, 'a typo\'d key must never create a row');
  } finally {
    // Restore the seeded value so the scratch database stays reusable.
    await dbPool.query("UPDATE game_settings SET value = '180'::jsonb WHERE key = 'ground_item_ttl_seconds'");
    if (admin != null) await dbPool.query('DELETE FROM users WHERE id = $1', [admin]);
  }
});

// The admin page's whole job: load the list, edit a value, save it, reload and
// see the saved value. This exercises that loop through the real routes for
// EVERY key, not just the one the test above happens to use -- a key whose
// validator rejects its own default, or whose jsonb round trip loses shape,
// would otherwise only be found by an admin.
test('every default key round-trips through GET -> PUT -> GET', async (t) => {
  if (!dbReady(t, 'this test rewrites every game_settings row and restores it')) return;
  let admin;
  // Hand-written edits, one per key -- deliberately NOT derived from DEFAULTS,
  // so a corrupted default cannot make this test agree with itself.
  const edits = {
    passive_points_per_level: 2,
    ground_item_ttl_seconds: 300,
    respec_base_gold: 75,
    rarity_weights: [
      { item_level: 1, white: 80, blue: 15, yellow: 4, foxy: 1 },
      { item_level: 60, white: 50, blue: 30, yellow: 15, foxy: 5 },
    ],
  };
  const originals = {};
  try {
    admin = await createUser(dbPool, 'admin');
    const auth = authed(admin, 'admin');

    const load = await request(app).get('/api/settings').set(auth);
    assert.equal(load.status, 200);
    for (const row of load.body) originals[row.key] = row.value;
    assert.deepStrictEqual(Object.keys(originals).sort(), Object.keys(edits).sort());

    for (const [key, value] of Object.entries(edits)) {
      const put = await request(app).put(`/api/settings/${key}`).set(auth).send({ value });
      assert.equal(put.status, 200, `PUT ${key} -> ${put.status} ${JSON.stringify(put.body)}`);
      assert.deepStrictEqual(put.body.value, value, `PUT ${key} echoed the wrong value`);
    }

    const reload = await request(app).get('/api/settings').set(auth);
    assert.equal(reload.status, 200);
    const after = new Map(reload.body.map((r) => [r.key, r.value]));
    for (const [key, value] of Object.entries(edits)) {
      assert.deepStrictEqual(after.get(key), value, `${key} did not survive the reload`);
    }
    // The defaults column is unaffected by an edit -- it is the coded fallback,
    // not a copy of the stored row.
    const defaults = new Map(reload.body.map((r) => [r.key, r.default_value]));
    assert.strictEqual(defaults.get('ground_item_ttl_seconds'), 180);
    assert.strictEqual(defaults.get('passive_points_per_level'), 1);
  } finally {
    // Put the scratch database back the way it was found.
    for (const [key, value] of Object.entries(originals)) {
      await dbPool.query(
        'UPDATE game_settings SET value = $2::jsonb WHERE key = $1', [key, JSON.stringify(value)]);
    }
    if (admin != null) await dbPool.query('DELETE FROM users WHERE id = $1', [admin]);
  }
});
