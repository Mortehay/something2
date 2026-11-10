// backend/tests/vfx_effects_sprite_write_db.test.js
// The omit-key rule for attack-effect sprites (same rule as aura_effects_api_db.test.js "PUT keeps an
// approved aura sprite"): a PUT/POST body WITHOUT a sprite_image key writes none of the seven sprite
// columns, so an Attack Effects form snapshot taken before an effect sprite was approved cannot revert
// it. Real pg Pool via __setPool, gated on TEST_DATABASE_URL; creates only zz-prefixed rows.
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
const N = `zzVfxSprite${tag}`;
const KEY = 'vfx/11111111-1111-1111-1111-111111111111.png';
const body = (over = {}) => ({ name: N, shape: 'arc', color: '#aabbcc', width: 3, duration_ms: 200, ...over });
const COLS = 'sprite_image, sprite_frames, sprite_size, sprite_additive, sprite_loop, sprite_fps, sprite_stretch';

test('vfx effects: sprite columns are written only when sprite_image is in the body', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const u = (await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, token_version',
    [`vfx-admin-${tag}`, 'x', 'admin'])).rows[0];
  const auth = ['Authorization', `Bearer ${signToken({ userId: u.id, username: 'x', role: 'admin', tokenVersion: u.token_version })}`];
  t.after(async () => {
    await pool.query("DELETE FROM vfx_effects WHERE name LIKE $1 || '%'", [N]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [u.id]).catch(() => {});
    await pool.end();
  });
  const row = async (id) => (await pool.query(`SELECT width, ${COLS} FROM vfx_effects WHERE id=$1`, [id])).rows[0];
  const put = (id, b) => request(app).put(`/api/vfx-effects/${id}`).set(...auth).send(b);

  const created = await request(app).post('/api/vfx-effects').set(...auth).send(body({ sprite_frames: 9, sprite_loop: true }));
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;

  await t.test('POST without the key gets the column defaults (stale sprite fields ignored)', async () => {
    assert.deepStrictEqual(await row(id), { width: 3, sprite_image: null, sprite_frames: 1, sprite_size: 0,
      sprite_additive: false, sprite_loop: false, sprite_fps: null, sprite_stretch: false });
  });

  // What an approved effect sprite looks like (effectSprites.approveColumns sets loop/fps/stretch too).
  const approved = { sprite_image: KEY, sprite_frames: 8, sprite_size: 240, sprite_additive: true,
    sprite_loop: true, sprite_fps: 12, sprite_stretch: true };

  await t.test('PUT without the key keeps all seven approved columns, even with conflicting stale values', async () => {
    await pool.query(`UPDATE vfx_effects SET sprite_image=$2, sprite_frames=8, sprite_size=240, sprite_additive=true,
      sprite_loop=true, sprite_fps=12, sprite_stretch=true WHERE id=$1`, [id, KEY]);
    // A stale form snapshot: sprite_frames 0 would even be invalid -- it must not 400 a no-key save.
    const r = await put(id, body({ width: 5, sprite_frames: 0, sprite_size: 1, sprite_additive: false, sprite_fps: 999 }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(await row(id), { width: 5, ...approved });
  });

  await t.test('PUT with the key still writes and validates the sprite fields', async () => {
    const r = await put(id, body({ sprite_image: KEY, sprite_frames: 4, sprite_size: 100 }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(await row(id), { width: 3, sprite_image: KEY, sprite_frames: 4, sprite_size: 100,
      sprite_additive: false, sprite_loop: false, sprite_fps: null, sprite_stretch: false });
    assert.strictEqual((await put(id, body({ sprite_image: KEY, sprite_frames: 0 }))).status, 400);
    assert.strictEqual((await put(id, body({ sprite_image: 'not a key' }))).status, 400);
  });

  await t.test("sprite_image '' clears the sprite", async () => {
    const r = await put(id, body({ sprite_image: '' }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(await row(id), { width: 3, sprite_image: null, sprite_frames: 1, sprite_size: 0,
      sprite_additive: false, sprite_loop: false, sprite_fps: null, sprite_stretch: false });
  });
});
