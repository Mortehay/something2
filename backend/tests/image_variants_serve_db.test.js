// Image shrink Task 4: game-facing payloads serve web copies. Real private
// database (TEST_DATABASE_URL only) and an in-memory fake object store that is
// swapped into the assetStore module for the run. Rows are named with PREFIX
// and removed before and after.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Pool } = require('pg');

require('./helpers/auth.js');
const request = require('supertest');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

const { app } = require('../src/index.js');
const assetStore = require('../src/services/assetStore.js');
const imageVariants = require('../src/services/imageVariants.js');
const { signToken } = require('../src/auth/tokens.js');

const { shrinkSubject, invalidateServeMap } = imageVariants;

const PREFIX = 'imgshrink-t4-';
const ENT = `${PREFIX}ent`;
const CLS = `${PREFIX}cls`;
const SKILL = `${PREFIX}skill`;
const VFX = `${PREFIX}vfx`;
const KEY = 't4/img.png';

function fakeStore(objects) {
  const store = {
    objects: new Map(objects),
    async statObject(key) {
      const b = store.objects.get(key);
      return b ? { size: b.length, etag: crypto.createHash('md5').update(b).digest('hex') } : null;
    },
    async readObject(key) {
      if (!store.objects.has(key)) { const e = new Error('no key'); e.code = 'NoSuchKey'; throw e; }
      return store.objects.get(key);
    },
    async putObject(key, buffer) { store.objects.set(key, buffer); return key; },
    async objectExists(key) { return store.objects.has(key); },
  };
  return store;
}

const noisePng = (w, h) => sharp(crypto.randomBytes(w * h * 4), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

test('web copies in game-facing payloads (db)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const store = fakeStore([[KEY, await noisePng(600, 400)]]);
  const saved = {};
  for (const m of ['statObject', 'readObject', 'putObject', 'objectExists']) {
    saved[m] = assetStore[m];
    assetStore[m] = store[m];
  }
  const origGetServeMap = imageVariants.getServeMap;
  let userId = null;
  let statusBefore = null;

  async function cleanup() {
    await pool.query('DELETE FROM image_operations WHERE subject_key LIKE $1', [`${PREFIX}%`]);
    await pool.query('DELETE FROM image_variants WHERE subject_key LIKE $1', [`${PREFIX}%`]);
    await pool.query('DELETE FROM character_appearances WHERE entity_type_id IN (SELECT id FROM entity_types WHERE name LIKE $1)', [`${PREFIX}%`]);
    await pool.query('DELETE FROM entity_types WHERE name LIKE $1', [`${PREFIX}%`]);
    await pool.query('DELETE FROM catalog_art WHERE subject_key LIKE $1', [`${PREFIX}%`]);
    await pool.query('DELETE FROM vfx_effects WHERE name LIKE $1', [`${PREFIX}%`]);
    await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
  }

  t.after(async () => {
    imageVariants.getServeMap = origGetServeMap;
    for (const m of Object.keys(saved)) assetStore[m] = saved[m];
    if (statusBefore) {
      await pool.query('UPDATE status_visuals SET sprite_image = $1 WHERE status_key = $2 AND variant = $3',
        [statusBefore.sprite_image, statusBefore.status_key, statusBefore.variant]).catch(() => {});
    }
    await cleanup().catch(() => {});
    await pool.end();
  });

  await cleanup();
  invalidateServeMap();
  // Every row below points at the same original key, so one real variant (made
  // for the entity) is the web copy all of them are served.
  await pool.query(`INSERT INTO entity_types (name, color, image) VALUES ($1, '#000000', $2)`, [ENT, KEY]);
  const cls = (await pool.query(
    `INSERT INTO entity_types (name, color, image, is_playable) VALUES ($1, '#000000', $2, true) RETURNING id`, [CLS, KEY])).rows[0];
  await pool.query(`INSERT INTO character_appearances (entity_type_id, variant, label, image) VALUES ($1, 1, 'one', $2)`, [cls.id, KEY]);
  await pool.query(`INSERT INTO catalog_art (subject_kind, subject_key, image) VALUES ('skill', $1, $2)`, [SKILL, KEY]);
  await pool.query(`INSERT INTO vfx_effects (name, shape, sprite_image) VALUES ($1, 'arc', $2)`, [VFX, KEY]);
  const st = (await pool.query(
    `SELECT status_key, variant, sprite_image FROM status_visuals ORDER BY status_key, variant LIMIT 1`)).rows[0];
  statusBefore = st;
  await pool.query('UPDATE status_visuals SET sprite_image = $1 WHERE status_key = $2 AND variant = $3', [KEY, st.status_key, st.variant]);
  const u = (await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id, token_version`, [`${PREFIX}user`])).rows[0];
  userId = u.id;
  const auth = { Authorization: `Bearer ${signToken({ userId, username: `${PREFIX}user`, role: 'player', tokenVersion: u.token_version })}` };

  const op = await shrinkSubject(pool, store, { table: 'entity_types', key: ENT, column: 'image' }, null, {});
  assert.equal(op.status, 'ok', op.error);
  const WEB = op.web_key;
  assert.ok(WEB && WEB !== KEY);
  invalidateServeMap();

  await t.test('/api/map/config and /api/map/tiles swap entity images', async () => {
    const res = await request(app).get('/api/map/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.entityTypes[ENT].image, WEB);
    assert.equal(res.body.entityTypes[ENT].color, '#000000');
    const tiles = await request(app).get('/api/map/tiles');
    assert.equal(tiles.status, 200);
    assert.ok(tiles.body && typeof tiles.body === 'object');
  });

  await t.test('/api/vfx-effects serves the original unless ?art=web', async () => {
    const plain = await request(app).get('/api/vfx-effects');
    assert.equal(plain.body.find((r) => r.name === VFX).sprite_image, KEY);
    const web = await request(app).get('/api/vfx-effects?art=web');
    assert.equal(web.body.find((r) => r.name === VFX).sprite_image, WEB);
  });

  await t.test('/api/status-visuals serves the original unless ?art=web', async () => {
    const plain = await request(app).get('/api/status-visuals');
    assert.equal(plain.body.find((r) => r.key && r.sprite_image).sprite_image, KEY);
    const web = await request(app).get('/api/status-visuals?art=web');
    assert.equal(web.body.find((r) => r.key && r.sprite_image).sprite_image, WEB);
  });

  await t.test('/api/characters/classes swaps class and appearance keys', async () => {
    const res = await request(app).get('/api/characters/classes').set(auth);
    assert.equal(res.status, 200);
    const c = res.body.classes.find((x) => x.name === CLS);
    assert.equal(c.image, WEB);
    assert.equal(c.appearances[0].image, WEB);
  });

  await t.test('/api/game-art swaps skill images', async () => {
    const res = await request(app).get('/api/game-art').set(auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.skill[SKILL].image, WEB);
  });

  await t.test('a failing serve map serves originals, never an error', async () => {
    imageVariants.getServeMap = async () => { throw new Error('boom'); };
    const realError = console.error;
    console.error = () => {};
    try {
      const cfg = await request(app).get('/api/map/config');
      assert.equal(cfg.status, 200);
      assert.equal(cfg.body.entityTypes[ENT].image, KEY);
      const vfx = await request(app).get('/api/vfx-effects?art=web');
      assert.equal(vfx.status, 200);
      assert.equal(vfx.body.find((r) => r.name === VFX).sprite_image, KEY);
      const art = await request(app).get('/api/game-art').set(auth);
      assert.equal(art.status, 200);
      assert.equal(art.body.skill[SKILL].image, KEY);
    } finally {
      console.error = realError;
      imageVariants.getServeMap = origGetServeMap;
    }
  });
});
