// SOMET-609 (S9, final review I-2). worlds.dungeon_boss names its boss entity
// BY NAME with no FK, like allowed_creature_types. A rename in the Entities
// tab must cascade into it (same transaction as the other cascades), and a
// delete must be refused with 409 naming the worlds, or the dungeon goes
// bossless silently and the next reseed re-inserts the old name.
//
// Real HTTP, real schema, gated on TEST_DATABASE_URL. Fixtures are zz-prefixed
// and torn down by id in `finally`.
require('./helpers/auth.js'); // sets JWT_SECRET before any token is signed
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;
let pool = null;

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
});
after(async () => { if (pool) await pool.end().catch(() => {}); });

async function withFixtures(tag, fn) {
  const sfx = `${process.pid}-${Date.now()}-${tag}`;
  const ids = {};
  try {
    const u = await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, token_version`,
      [`zz-s9-bossref-${sfx}`]);
    ids.user = u.rows[0];
    const oldName = `zzS9BossOld-${sfx}`;
    const e = await pool.query(
      `INSERT INTO entity_types (name, color, is_creature) VALUES ($1, '#fff', false) RETURNING id`, [oldName]);
    ids.entity = e.rows[0].id;
    const boss = { entity: oldName, x: 4950, y: 5450, respawn_s: 900 };
    const w = await pool.query(
      `INSERT INTO worlds (name, seed, dungeon_boss) VALUES ($1, 1, $2::jsonb) RETURNING id, name`,
      [`zz-s9-bossref-world-${sfx}`, JSON.stringify(boss)]);
    ids.world = w.rows[0];
    const token = signToken({ userId: ids.user.id, username: `admin-${ids.user.id}`, role: 'admin', tokenVersion: ids.user.token_version });
    await fn({ auth: { Authorization: `Bearer ${token}` }, oldName, boss, entityId: ids.entity, world: ids.world, sfx });
  } finally {
    if (ids.world) await pool.query('DELETE FROM worlds WHERE id = $1', [ids.world.id]).catch(() => {});
    if (ids.entity) await pool.query('DELETE FROM entity_types WHERE id = $1', [ids.entity]).catch(() => {});
    if (ids.user) await pool.query('DELETE FROM users WHERE id = $1', [ids.user.id]).catch(() => {});
  }
}

test('renaming a dungeon boss entity cascades into worlds.dungeon_boss', { skip }, async () => {
  await withFixtures('rename', async ({ auth, boss, entityId, world, sfx }) => {
    const NEW = `zzS9BossNew-${sfx}`;
    const res = await request(app).put(`/api/entity-types/${entityId}`).set(auth)
      .send({ name: NEW, color: '#fff', is_creature: false, walkable: false, spawn_tiles: [], chance: 0.1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.renamedReferences?.dungeonBosses, 1, JSON.stringify(res.body.renamedReferences));
    const row = (await pool.query('SELECT dungeon_boss FROM worlds WHERE id = $1', [world.id])).rows[0];
    assert.deepEqual(row.dungeon_boss, { ...boss, entity: NEW }, 'only the entity field changes');
  });
});

test('deleting an entity a world names as its dungeon boss is refused with 409 naming the world', { skip }, async () => {
  await withFixtures('delete', async ({ auth, entityId, world }) => {
    const res = await request(app).delete(`/api/entity-types/${entityId}`).set(auth);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body.dungeon_boss_worlds, [{ id: world.id, name: world.name }]);
    assert.match(res.body.error, new RegExp(world.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const still = await pool.query('SELECT 1 FROM entity_types WHERE id = $1', [entityId]);
    assert.equal(still.rows.length, 1, 'entity must not be deleted');
  });
});
