// GET/PUT /api/buff-visuals against a real DB (TEST_DATABASE_URL only). Writes touch one seeded row
// (war_shield_wall) and the two opacity settings; all are restored in t.after.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const { setSetting } = require('../src/services/gameSettings.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const tag = `${process.pid}${Date.now()}`;
const ID = 'war_shield_wall';
const KEY = 'vfx/0123abcd-0000-4000-8000-0123456789ab.png';

async function makeUser(pool, role) {
  const r = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, token_version',
    [`buffvis-${role}-${tag}-${Math.random().toString(36).slice(2)}`, 'x', role]);
  return { id: r.rows[0].id, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: 'x', role: u.role, tokenVersion: u.tokenVersion })}`;

test('buff visuals API', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const admin = await makeUser(pool, 'admin');
  const player = await makeUser(pool, 'player');
  const saved = (await pool.query('SELECT * FROM buff_visuals WHERE skill_id = $1', [ID])).rows[0];
  const savedSettings = (await pool.query(
    "SELECT key, value FROM game_settings WHERE key LIKE 'buff_visual_%'")).rows;
  t.after(async () => {
    await pool.query(`UPDATE buff_visuals SET placement=$2, radius=$3, scale=$4, priority=$5, color=$6, sprite_image=$7,
      sprite_frames=$8, sprite_additive=$9, sprite_fps=$10 WHERE skill_id=$1`,
    [ID, saved.placement, saved.radius, saved.scale, saved.priority, saved.color, saved.sprite_image,
      saved.sprite_frames, saved.sprite_additive, saved.sprite_fps]).catch(() => {});
    await pool.query("DELETE FROM game_settings WHERE key LIKE 'buff_visual_%'").catch(() => {});
    for (const s of savedSettings) {
      await pool.query('INSERT INTO game_settings (key, value) VALUES ($1, $2::jsonb)', [s.key, JSON.stringify(s.value)]).catch(() => {});
    }
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[admin.id, player.id]]).catch(() => {});
    await pool.end();
  });
  const as = (u) => ['Authorization', bearer(u)];
  const put = (body, id = ID) => request(app).put(`/api/buff-visuals/${id}`).set(...as(admin)).send(body);
  const row = async () => (await pool.query('SELECT * FROM buff_visuals WHERE skill_id = $1', [ID])).rows[0];

  await t.test('GET is open: 55 visuals with defaults and catalog fields, plus the opacity settings', async () => {
    await pool.query("DELETE FROM game_settings WHERE key LIKE 'buff_visual_%'");
    const r = await request(app).get('/api/buff-visuals');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.visuals.length, 55);
    const imm = r.body.visuals.find((v) => v.skill_id === 'mag_immolation_aura');
    assert.strictEqual(imm.placement, 'ground');
    assert.strictEqual(imm.radius, 64);
    assert.strictEqual(imm.name_en, 'Immolation Aura');
    // The game draws a buff with its own effect radius at that radius (snapshot auraRadius).
    assert.strictEqual(imm.aura_radius, 150);
    assert.strictEqual(r.body.visuals.find((v) => v.skill_id === 'war_shield_wall').aura_radius, null);
    assert.strictEqual(typeof imm.tier, 'number');
    assert.strictEqual(typeof imm.req_lvl, 'number');
    assert.ok(!r.body.visuals.some((v) => v.skill_id === 'dru_bear_form'));
    assert.deepStrictEqual(r.body.settings, { main_opacity: 0.85, other_opacity: 0.45 });
  });

  await t.test('writes are admin-only', async () => {
    assert.strictEqual((await request(app).put(`/api/buff-visuals/${ID}`).send({ radius: 80 })).status, 401);
    assert.strictEqual((await request(app).put(`/api/buff-visuals/${ID}`).set(...as(player)).send({ radius: 80 })).status, 403);
  });

  await t.test('a PUT with sprite fields stores them', async () => {
    const r = await put({ placement: 'ground', radius: 90, scale: 1.5, priority: 2, color: '#112233',
      sprite_image: KEY, sprite_frames: 8, sprite_additive: false, sprite_fps: 12 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const s = await row();
    assert.strictEqual(s.placement, 'ground');
    assert.strictEqual(s.radius, 90);
    assert.strictEqual(s.scale, 1.5);
    assert.strictEqual(s.priority, 2);
    assert.strictEqual(s.color, '#112233');
    assert.strictEqual(s.sprite_image, KEY);
    assert.strictEqual(s.sprite_frames, 8);
    assert.strictEqual(s.sprite_additive, false);
    assert.strictEqual(s.sprite_fps, 12);
    assert.strictEqual(r.body.sprite_image, KEY);
  });

  await t.test('a PUT without the sprite_image key keeps all four sprite columns (stale frames ignored)', async () => {
    const r = await put({ radius: 120, sprite_frames: 3 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const s = await row();
    assert.strictEqual(s.radius, 120);
    assert.strictEqual(s.sprite_image, KEY);
    assert.strictEqual(s.sprite_frames, 8);
    assert.strictEqual(s.sprite_additive, false);
    assert.strictEqual(s.sprite_fps, 12);
    assert.strictEqual(s.placement, 'ground', 'an omitted field keeps its stored value');
  });

  await t.test("sprite_image '' clears the sprite", async () => {
    const r = await put({ sprite_image: '' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const s = await row();
    assert.strictEqual(s.sprite_image, null);
    assert.strictEqual(s.sprite_frames, 1);
    assert.strictEqual(s.sprite_fps, null);
    assert.strictEqual(s.sprite_additive, true);
  });

  await t.test('a form, a trap and an unknown id are 404', async () => {
    for (const id of ['dru_bear_form', 'arc_tar_trap', 'zz_nope']) {
      assert.strictEqual((await put({ radius: 80 }, id)).status, 404, id);
    }
  });

  await t.test('validation is a 400 with a readable message', async () => {
    for (const [body, re] of [[{ priority: 1.5 }, /priority/], [{ placement: 'head' }, /placement/],
      [{ radius: 0 }, /radius/], [{ radius: 2001 }, /radius/], [{ scale: 0 }, /scale/], [{ scale: 4.5 }, /scale/],
      [{ color: 'red' }, /color/], [{ sprite_image: 'http://x/y.png' }, /sprite_image/],
      [{ sprite_image: KEY, sprite_frames: 0 }, /sprite_frames/]]) {
      const r = await put(body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, re);
    }
  });

  await t.test('priority null is accepted', async () => {
    assert.strictEqual((await put({ priority: null })).status, 200);
    assert.strictEqual((await row()).priority, null);
  });

  await t.test('the opacity settings reject 1.2 and accept 0..1, and GET reflects them', async () => {
    for (const key of ['buff_visual_main_opacity', 'buff_visual_other_opacity']) {
      await assert.rejects(setSetting(pool, key, 1.2), (e) => e.status === 400);
      await assert.rejects(setSetting(pool, key, -0.1), (e) => e.status === 400);
      await assert.rejects(setSetting(pool, key, '0.5'), (e) => e.status === 400);
    }
    await setSetting(pool, 'buff_visual_main_opacity', 1);
    await setSetting(pool, 'buff_visual_other_opacity', 0);
    const r = await request(app).get('/api/buff-visuals');
    assert.deepStrictEqual(r.body.settings, { main_opacity: 1, other_opacity: 0 });
  });
});
