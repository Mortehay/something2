// SOMET-644 Task 6. The local fallback for the Generated Worlds tab:
// POST /api/world-gen/local/preview and /save, which run the JS port of the
// box's rules generator on this PC when the GPU box is unreachable.
//
// Runs on the scratch DB (TEST_DATABASE_URL) for the live catalogs the save
// validates against, and against a temp SEED_MAPS_DIR: never the real
// backend/seeds/maps.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { signToken } = require('../src/auth/tokens.js');
const worldGenLocalRoutes = require('../src/api/worldGenLocalRoutes.js');
const { planRegion, toJson } = require('../src/services/worldGen/worldGen.js');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { mapSpecCatalogs } = require('../src/services/mapSpecCatalogs.js');

const DB_URL = process.env.TEST_DATABASE_URL;
const AUTHOR = 'rules (local fallback)';

async function makeUser(pool, role) {
  const username = `wgl-${role}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', role]);
  const u = { id: r.rows[0].id, role };
  u.auth = `Bearer ${signToken({ userId: u.id, username, role, tokenVersion: r.rows[0].token_version })}`;
  return u;
}

function dbTest(name, body, routeOpts = {}) {
  test(name, async (t) => {
    if (!DB_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (world-gen local)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgl-maps-'));
    const prevMaps = process.env.SEED_MAPS_DIR;
    process.env.SEED_MAPS_DIR = dir;
    const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
    const users = [];
    t.after(async () => {
      if (prevMaps === undefined) delete process.env.SEED_MAPS_DIR; else process.env.SEED_MAPS_DIR = prevMaps;
      fs.rmSync(dir, { recursive: true, force: true });
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]).catch(() => {});
      await pool.end().catch(() => {});
    });
    const app = express();
    app.use(express.json());
    app.use('/api/world-gen/local', worldGenLocalRoutes(pool, routeOpts));
    const admin = await makeUser(pool, 'admin'); users.push(admin.id);
    const player = await makeUser(pool, 'player'); users.push(player.id);
    await body({ app, pool, dir, admin, player });
  });
}

const PARAMS = { name: 'local-vale', worlds: 3, target_per_screen: 4, size: 64, chunk_size: 32, biome_cell: 32 };
const expectedSpecText = (p = PARAMS) => toJson(planRegion({
  name: p.name, world_count: p.worlds, target_per_screen: p.target_per_screen,
  size: p.size, chunk_size: p.chunk_size, biome_cell: p.biome_cell,
}));

dbTest('preview returns the port\'s spec and report, authored as the local fallback', async ({ app, admin }) => {
  const res = await request(app).post('/api/world-gen/local/preview').set('Authorization', admin.auth).send(PARAMS);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.author, AUTHOR);
  assert.strictEqual(res.body.name, 'local-vale');
  assert.deepStrictEqual(res.body.spec, JSON.parse(expectedSpecText()));
  assert.strictEqual(res.body.spec.name, 'local-vale');
  assert.strictEqual(res.body.spec.worlds.length, 3);
  // problems and caveats stay separate; ok counts problems only.
  assert.ok(Array.isArray(res.body.report.problems));
  assert.ok(Array.isArray(res.body.report.caveats));
  assert.strictEqual(res.body.report.ok, res.body.report.problems.length === 0);
  assert.strictEqual(res.body.report.totals.worlds, 3);
  assert.strictEqual(typeof res.body.valid, 'boolean');
  assert.deepStrictEqual(res.body.ignored, []);
});

dbTest('preview slugs the name (trim, lowercase, spaces to hyphens) and names ignored fields', async ({ app, admin }) => {
  const res = await request(app).post('/api/world-gen/local/preview').set('Authorization', admin.auth)
    .send({ ...PARAMS, name: '  Local Vale ', theme: 'a valley', author: 'llm', sfx_engine: 'x' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.name, 'local-vale');
  assert.deepStrictEqual(res.body.spec, JSON.parse(expectedSpecText()));
  assert.deepStrictEqual(res.body.ignored, ['theme', 'author', 'sfx_engine']);
  assert.match(res.body.note, /ignored/);
});

const BAD = [
  ['missing name', { ...PARAMS, name: undefined }, /name/],
  ['non-string name', { ...PARAMS, name: 42 }, /name/],
  ['name with a dot', { ...PARAMS, name: '../evil' }, /name/],
  ['non-ASCII name', { ...PARAMS, name: 'välley' }, /name/],
  ['one-character name', { ...PARAMS, name: 'a' }, /name/],
  ['name ending in a hyphen', { ...PARAMS, name: 'vale-' }, /name/],
  ['61-character name', { ...PARAMS, name: 'a'.repeat(61) }, /name/],
  ['non-integer worlds', { ...PARAMS, worlds: 2.5 }, /worlds/],
  ['string worlds', { ...PARAMS, worlds: '3' }, /worlds/],
  ['zero worlds', { ...PARAMS, worlds: 0 }, /worlds/],
  ['37 worlds', { ...PARAMS, worlds: 37 }, /worlds/],
  ['string target', { ...PARAMS, target_per_screen: '4' }, /target_per_screen/],
  ['target below range', { ...PARAMS, target_per_screen: 0.4 }, /target_per_screen/],
  ['target above range', { ...PARAMS, target_per_screen: 25.5 }, /target_per_screen/],
  ['boolean target', { ...PARAMS, target_per_screen: true }, /target_per_screen/],
  ['size out of range', { ...PARAMS, size: 300 }, /size/],
  ['size too small', { ...PARAMS, size: 16 }, /size/],
  ['non-integer chunk', { ...PARAMS, chunk_size: 31.5 }, /chunk_size/],
  ['biome cell out of range', { ...PARAMS, biome_cell: 65 }, /biome_cell/],
  ['null size', { ...PARAMS, size: null }, /size/],
];
dbTest('every type-invalid or out-of-range field is a 400 naming the field, on preview and save', async ({ app, admin, dir }) => {
  for (const [label, body, re] of BAD) {
    const p = await request(app).post('/api/world-gen/local/preview').set('Authorization', admin.auth).send(body);
    assert.strictEqual(p.status, 400, `${label}: preview ${p.status} ${JSON.stringify(p.body)}`);
    assert.match(p.body.error, re, label);
    assert.strictEqual(p.body.code, 'bad_params', label);
    const s = await request(app).post('/api/world-gen/local/save').set('Authorization', admin.auth)
      .send({ name: body.name, params: body });
    assert.strictEqual(s.status, 400, `${label}: save ${s.status}`);
  }
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

dbTest('defaults fill absent numeric fields', async ({ app, admin }) => {
  const res = await request(app).post('/api/world-gen/local/preview').set('Authorization', admin.auth).send({ name: 'tiny-defaults', worlds: 1 });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body.params, {
    name: 'tiny-defaults', worlds: 1, target_per_screen: 6, size: 128, chunk_size: 32, biome_cell: 32,
  });
  assert.deepStrictEqual(res.body.spec, JSON.parse(toJson(planRegion({ name: 'tiny-defaults', world_count: 1 }))));
});

dbTest('save writes <slug>.map.json, byte-equal to toJson, and the file validates', async ({ app, pool, admin, dir }) => {
  const res = await request(app).post('/api/world-gen/local/save').set('Authorization', admin.auth)
    .send({ name: 'Local Vale', params: { ...PARAMS, name: 'Local Vale' } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.author, AUTHOR);
  assert.strictEqual(res.body.file, 'local-vale.map.json');
  assert.strictEqual(res.body.overwrote, false);
  assert.match(res.body.next, /Seed \/ Export/);
  assert.deepStrictEqual(fs.readdirSync(dir), ['local-vale.map.json']);
  const text = fs.readFileSync(path.join(dir, 'local-vale.map.json'), 'utf8');
  assert.strictEqual(text, expectedSpecText());
  const spec = JSON.parse(text);
  assert.strictEqual(spec.name, 'local-vale', 'spec name must equal the file stem (the Maps group requires it)');
  assert.deepStrictEqual(validateMapSpec(spec, await mapSpecCatalogs(pool)), []);
});

dbTest('save never trusts a client spec body: a sent spec is ignored, params regenerate', async ({ app, admin, dir }) => {
  const res = await request(app).post('/api/world-gen/local/save').set('Authorization', admin.auth)
    .send({ name: 'local-vale', params: PARAMS, spec: { name: 'local-vale', worlds: [] } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'local-vale.map.json'), 'utf8'), expectedSpecText());
});

dbTest('save refuses a name that disagrees with params.name', async ({ app, admin, dir }) => {
  const res = await request(app).post('/api/world-gen/local/save').set('Authorization', admin.auth)
    .send({ name: 'other-name', params: PARAMS });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

dbTest('an existing file is a 409 unless overwrite: true', async ({ app, admin, dir }) => {
  const file = path.join(dir, 'local-vale.map.json');
  fs.writeFileSync(file, '{"hand":"written"}\n');
  const refused = await request(app).post('/api/world-gen/local/save').set('Authorization', admin.auth)
    .send({ name: 'local-vale', params: PARAMS });
  assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
  assert.strictEqual(refused.body.code, 'exists');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"hand":"written"}\n');

  const ok = await request(app).post('/api/world-gen/local/save').set('Authorization', admin.auth)
    .send({ name: 'local-vale', params: PARAMS, overwrite: true });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.overwrote, true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), expectedSpecText());
  // tmp-then-rename leaves nothing behind, and no .gen.json is ever written.
  assert.deepStrictEqual(fs.readdirSync(dir), ['local-vale.map.json']);
});

dbTest('a spec that fails validation is a 422 with the errors and writes nothing', async ({ app, admin, dir }) => {
  const res = await request(app).post('/api/world-gen/local/save').set('Authorization', admin.auth)
    .send({ name: 'local-vale', params: PARAMS });
  assert.strictEqual(res.status, 422, JSON.stringify(res.body));
  assert.strictEqual(res.body.code, 'invalid_spec');
  assert.deepStrictEqual(res.body.errors, ['stub: biome "Meadow" is not in this database']);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
}, { validate: () => ['stub: biome "Meadow" is not in this database'] });

dbTest('admin only: no token is 401, a player is 403, and nothing is written', async ({ app, player, dir }) => {
  for (const route of ['preview', 'save']) {
    const anon = await request(app).post(`/api/world-gen/local/${route}`).send({ name: 'local-vale', params: PARAMS, ...PARAMS });
    assert.strictEqual(anon.status, 401, route);
    const p = await request(app).post(`/api/world-gen/local/${route}`).set('Authorization', player.auth)
      .send({ name: 'local-vale', params: PARAMS, ...PARAMS });
    assert.strictEqual(p.status, 403, route);
  }
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});
