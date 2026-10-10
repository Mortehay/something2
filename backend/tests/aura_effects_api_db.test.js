// backend/tests/aura_effects_api_db.test.js
// Modelled on passive_nodes_admin_routes.test.js: real pg Pool via __setPool,
// disposable users, gated on TEST_DATABASE_URL. Creates only zz-prefixed auras
// and one zz-prefixed entity type, all deleted in t.after.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const tag = `${process.pid}${Date.now()}`;
const A = `zzAura${tag}`;
const B = `zzAuraRenamed${tag}`;
const E = `zzAuraEntity${tag}`;
const body = (over = {}) => ({ name: A, target_side: 'allies', radius: 120, damage_mult: 1.3, ...over });

async function makeUser(pool, role) {
  const r = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, token_version',
    [`aura-${role}-${tag}-${Math.random().toString(36).slice(2)}`, 'x', role]);
  return { id: r.rows[0].id, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: 'x', role: u.role, tokenVersion: u.tokenVersion })}`;

test('aura effects admin API', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const admin = await makeUser(pool, 'admin');
  const player = await makeUser(pool, 'player');
  t.after(async () => {
    await pool.query('DELETE FROM entity_types WHERE name = $1', [E]).catch(() => {});
    // Prefix, not [A, B]: the dot_element case uses `${A}x`, which a regression would leak.
    await pool.query("DELETE FROM aura_effects WHERE name LIKE $1 || '%' OR name LIKE $2 || '%'", [A, B]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[admin.id, player.id]]).catch(() => {});
    await pool.end();
  });
  const as = (u) => ['Authorization', bearer(u)];
  let id;

  await t.test('GET is open and lists pack_leader with its Champion users', async () => {
    const r = await request(app).get('/api/aura-effects');
    assert.strictEqual(r.status, 200);
    const pl = r.body.find((a) => a.name === 'pack_leader');
    assert.ok(pl, 'pack_leader missing');
    assert.ok(pl.used_by.length >= 32, `expected the 32 Champions, got ${pl.used_by.length}`);
    assert.ok(pl.used_by.some((e) => e.name === 'Beast Champion'));
  });
  await t.test('writes are admin-only', async () => {
    assert.strictEqual((await request(app).post('/api/aura-effects').send(body())).status, 401);
    assert.strictEqual((await request(app).post('/api/aura-effects').set(...as(player)).send(body())).status, 403);
  });
  await t.test('validation runs before the DB (400 with a readable message)', async () => {
    for (const [over, re] of [[{ radius: 0 }, /radius/], [{ radius: -3 }, /radius/], [{ radius: 26000 }, /radius/],
      [{ damage_mult: 0 }, /damage_mult/], [{ tick_ms: 50 }, /tick_ms/], [{ dot_dps: 5 }, /enemies/]]) {
      const r = await request(app).post('/api/aura-effects').set(...as(admin)).send(body(over));
      assert.strictEqual(r.status, 400, JSON.stringify(over));
      assert.match(r.body.error, re);
    }
  });
  await t.test('create, then duplicate name is 409', async () => {
    const r = await request(app).post('/api/aura-effects').set(...as(admin)).send(body());
    assert.strictEqual(r.status, 201);
    id = r.body.id;
    assert.strictEqual(r.body.radius, 120);
    assert.strictEqual((await request(app).post('/api/aura-effects').set(...as(admin)).send(body())).status, 409);
  });
  await t.test('an unknown dot_element is a 400, not a raw FK 500', async () => {
    const r = await request(app).post('/api/aura-effects').set(...as(admin))
      .send(body({ name: `${A}x`, target_side: 'enemies', dot_dps: 2, dot_element: 'plasma' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /dot_element/);
  });
  await t.test('delete while bound is 409 with the entity list', async () => {
    await pool.query(`INSERT INTO entity_types (name, color, is_creature, auras) VALUES ($1, '#123456', false, $2::jsonb)`,
      [E, JSON.stringify([A])]);
    const r = await request(app).delete(`/api/aura-effects/${id}`).set(...as(admin));
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual(r.body.referencing_entity_types.map((e) => e.name), [E]);
    const still = await pool.query('SELECT 1 FROM aura_effects WHERE id = $1', [id]);
    assert.strictEqual(still.rowCount, 1, 'a refused delete must not delete');
  });
  await t.test('rename rewrites every binding in the same transaction', async () => {
    const r = await request(app).put(`/api/aura-effects/${id}`).set(...as(admin)).send(body({ name: B }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.renamedBindings, 1);
    const e = await pool.query('SELECT auras FROM entity_types WHERE name = $1', [E]);
    assert.deepStrictEqual(e.rows[0].auras, [B]);
  });
  await t.test('a retune (no rename) touches no binding', async () => {
    const r = await request(app).put(`/api/aura-effects/${id}`).set(...as(admin)).send(body({ name: B, radius: 150 }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.radius, 150);
    assert.strictEqual(r.body.renamedBindings, 0);
  });
  await t.test('PUT and DELETE reject non-admins and bad input', async () => {
    assert.strictEqual((await request(app).put(`/api/aura-effects/${id}`).set(...as(player)).send(body())).status, 403);
    assert.strictEqual((await request(app).delete(`/api/aura-effects/${id}`).set(...as(player))).status, 403);
    assert.strictEqual((await request(app).put(`/api/aura-effects/${id}`).set(...as(admin)).send(body({ name: B, radius: 0 }))).status, 400);
    assert.strictEqual((await request(app).put('/api/aura-effects/2147483000').set(...as(admin)).send(body())).status, 404);
    assert.strictEqual((await request(app).put('/api/aura-effects/abc').set(...as(admin)).send(body())).status, 400);
  });
  await t.test('once unbound, delete succeeds', async () => {
    await pool.query("UPDATE entity_types SET auras = '[]'::jsonb WHERE name = $1", [E]);
    assert.strictEqual((await request(app).delete(`/api/aura-effects/${id}`).set(...as(admin))).status, 204);
    assert.strictEqual((await request(app).delete(`/api/aura-effects/${id}`).set(...as(admin))).status, 404);
  });
});
