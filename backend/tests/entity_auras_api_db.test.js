require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;
const E = `zzAuraBind${process.pid}${Date.now()}`;

test('entity_types.auras binding', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const u = (await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1,'x','admin') RETURNING id, token_version",
    [`auraadm-${E}`])).rows[0];
  const auth = ['Authorization', `Bearer ${signToken({ userId: u.id, username: 'x', role: 'admin', tokenVersion: u.token_version })}`];
  t.after(async () => {
    await pool.query('DELETE FROM entity_types WHERE name = $1', [E]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [u.id]).catch(() => {});
    await pool.end();
  });
  // PUT is a full replace of the non-optional columns, so the fixture sends them all.
  const base = {
    name: E, color: '#112233', walkable: false, spawn_tiles: [], chance: 0.1,
    strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0,
    is_creature: true, hp: 10, max_hp: 10, hp_regen_rate: 0, mana: 0, max_mana: 0, mana_regen_rate: 0,
    render_mode: 'rect',
  };
  let id;

  await t.test('POST stores a known aura', async () => {
    const r = await request(app).post('/api/entity-types').set(...auth).send({ ...base, auras: ['pack_leader'] });
    assert.strictEqual(r.status, 201);
    id = r.body.id;
    assert.deepStrictEqual(r.body.auras, ['pack_leader']);
  });
  await t.test('an unknown name is a 400 naming it', async () => {
    const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, auras: ['ghost_aura'] });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown aura "ghost_aura"/);
  });
  await t.test('POST with an unknown name is a 400 and creates no row', async () => {
    const n = `${E}b`;
    const r = await request(app).post('/api/entity-types').set(...auth).send({ ...base, name: n, auras: ['ghost_aura'] });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown aura "ghost_aura"/);
    const c = await pool.query('SELECT 1 FROM entity_types WHERE name = $1', [n]);
    assert.strictEqual(c.rows.length, 0);
  });
  await t.test('bad shapes are 400s', async () => {
    for (const bad of ['pack_leader', [''], [3], ['pack_leader', 'pack_leader']]) {
      const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, auras: bad });
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
    }
  });
  await t.test('omitting auras leaves the binding alone', async () => {
    const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, hp: 12 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.auras, ['pack_leader']);
  });
  await t.test('[] is stored as [] (an explicit removal), not NULL', async () => {
    const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, auras: [] });
    assert.deepStrictEqual(r.body.auras, []);
  });
  await t.test('null clears to NULL (never authored)', async () => {
    const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, auras: null });
    assert.strictEqual(r.body.auras, null);
  });
});
