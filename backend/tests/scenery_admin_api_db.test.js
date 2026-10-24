require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;
const E = `zzScenery${process.pid}${Date.now()}`;

test('scenery admin fields', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const u = (await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1,'x','admin') RETURNING id, token_version",
    [`scenadm-${E}`])).rows[0];
  const auth = ['Authorization', `Bearer ${signToken({ userId: u.id, username: 'x', role: 'admin', tokenVersion: u.token_version })}`];
  t.after(async () => {
    await pool.query("DELETE FROM entity_types WHERE name LIKE $1 || '%'", [E]).catch(() => {});
    await pool.query("DELETE FROM biomes WHERE name LIKE $1 || '%'", [E]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [u.id]).catch(() => {});
    await pool.end();
  });
  const base = {
    name: E, color: '#112233', walkable: false, spawn_tiles: ['grass'], chance: 0.1,
    strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0,
    is_creature: false, hp: 0, max_hp: 0, hp_regen_rate: 0, mana: 0, max_mana: 0, mana_regen_rate: 0,
    render_mode: 'rect',
  };
  let id;

  await t.test('entity type: defaults when the fields are not sent', async () => {
    const r = await request(app).post('/api/entity-types').set(...auth).send(base);
    assert.strictEqual(r.status, 201);
    id = r.body.id;
    assert.strictEqual(r.body.scenery_layer, 'feature');
    assert.strictEqual(r.body.block_radius, null);
    assert.strictEqual(r.body.max_per_tile, 2);
  });
  await t.test('entity type: round-trip, coerced to numbers', async () => {
    const r = await request(app).put(`/api/entity-types/${id}`).set(...auth)
      .send({ ...base, scenery_layer: 'cover', block_radius: '12', max_per_tile: '4' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.scenery_layer, 'cover');
    assert.strictEqual(r.body.block_radius, 12);
    assert.strictEqual(r.body.max_per_tile, 4);
  });
  await t.test('entity type: editing another field keeps them; null block_radius clears', async () => {
    let r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, chance: 0.3 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.scenery_layer, 'cover');
    assert.strictEqual(r.body.block_radius, 12);
    assert.strictEqual(r.body.max_per_tile, 4);
    const g = (await request(app).get('/api/entity-types')).body.find((x) => x.id === id);
    assert.strictEqual(g.block_radius, 12);
    r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, block_radius: null });
    assert.strictEqual(r.body.block_radius, null);
    assert.strictEqual(r.body.max_per_tile, 4);
  });
  await t.test('entity type: bad values are 400s', async () => {
    for (const bad of [{ scenery_layer: 'sky' }, { scenery_layer: null }, { block_radius: 21 }, { block_radius: -1 },
      { block_radius: 1.5 }, { block_radius: 'abc' }, { max_per_tile: 0 }, { max_per_tile: 7 }, { max_per_tile: null }]) {
      const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, ...bad });
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
      const p = await request(app).post('/api/entity-types').set(...auth).send({ ...base, name: `${E}x`, ...bad });
      assert.strictEqual(p.status, 400, `POST ${JSON.stringify(bad)}`);
    }
    assert.strictEqual((await pool.query('SELECT 1 FROM entity_types WHERE name = $1', [`${E}x`])).rowCount, 0);
  });

  const bbase = { name: `${E}b`, terrain_tiles: ['grass'], flora_types: [], creature_types: [], palette: [], color: '#445566' };
  let bid;
  await t.test('biome: POST without densities stores NULL (unset)', async () => {
    const r = await request(app).post('/api/biomes').set(...auth).send(bbase);
    assert.strictEqual(r.status, 201);
    bid = r.body.id;
    assert.strictEqual(r.body.feature_density, null);
    assert.strictEqual(r.body.cover_density, null);
  });
  await t.test('biome: round-trip, clamping and coercion return numbers', async () => {
    const put = (b) => request(app).put(`/api/biomes/${bid}`).set(...auth).send({ ...bbase, ...b });
    let r = await put({ feature_density: '0.25', cover_density: 1.5 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.feature_density, 0.25);
    assert.strictEqual(r.body.cover_density, 1.5);
    r = await put({ cover_density: 9, feature_density: 9 });
    assert.strictEqual(r.body.cover_density, 3);
    assert.strictEqual(r.body.feature_density, 1);
    r = await put({ cover_density: 'abc' });
    assert.strictEqual(r.body.cover_density, 0);
    r = await put({ cover_density: -4, feature_density: -1 });
    assert.strictEqual(r.body.cover_density, 0);
    assert.strictEqual(r.body.feature_density, 0);
    r = await put({ cover_density: 0, feature_density: null });
    assert.strictEqual(r.body.cover_density, 0, 'a deliberate 0 is stored as 0, not unset');
    assert.strictEqual(r.body.feature_density, null);
  });
  await t.test('biome: set, reopen, edit another field, save keeps both densities', async () => {
    await request(app).put(`/api/biomes/${bid}`).set(...auth).send({ ...bbase, feature_density: 0.4, cover_density: 2 });
    const open = (await request(app).get('/api/biomes')).body.find((b) => b.id === bid);
    assert.strictEqual(open.feature_density, 0.4);
    assert.strictEqual(open.cover_density, 2);
    // the form echoes what it loaded and changes only the colour
    let r = await request(app).put(`/api/biomes/${bid}`).set(...auth).send({ ...open, color: '#778899' });
    assert.strictEqual(r.body.color, '#778899');
    assert.strictEqual(r.body.feature_density, 0.4);
    assert.strictEqual(r.body.cover_density, 2);
    // a client that never heard of the fields must not wipe them
    r = await request(app).put(`/api/biomes/${bid}`).set(...auth).send({ ...bbase, color: '#112233' });
    assert.strictEqual(r.body.feature_density, 0.4);
    assert.strictEqual(r.body.cover_density, 2);
  });
});
