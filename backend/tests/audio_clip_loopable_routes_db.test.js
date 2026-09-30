// backend/tests/audio_clip_loopable_routes_db.test.js
//
// SOMET-592 (I2): a world point's `nearby` sound can loop only if a clip is
// loopable, and before this nothing could make an sfx clip loopable. Covers
// the upload "Loop" flag, PATCH /api/audio/admin/clips/:id {loopable}, and
// that the world bundle carries the flag to the client. Real HTTP, real
// scratch DB; subjects are existing catalog rows (read-only); every clip,
// binding, world and user is this file's own and removed in t.after.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

async function makeUser(pool, role, tag) {
  const username = `audio-loop-${role}-${tag}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', role]);
  return { id: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion })}`;

test('audio clip loopable (world point nearby)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
    const tag = `${process.pid}-${Date.now()}`;
    const made = { users: [], worlds: [], clips: [] };
    t.after(async () => {
      try {
        // Bindings cascade with their clips.
        if (made.clips.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [made.clips]);
        if (made.worlds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [made.worlds]);
        if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
      } finally { await pool.end(); }
    });

    const admin = await makeUser(pool, 'admin', tag);
    made.users.push(admin.id);
    const player = await makeUser(pool, 'player', tag);
    made.users.push(player.id);
    const worldId = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [`audio-loop-${tag}`])).rows[0].id;
    made.worlds.push(worldId);
    const point = (await pool.query('SELECT name FROM entity_types WHERE point_kind IS NOT NULL ORDER BY name LIMIT 1')).rows[0].name;
    const creature = (await pool.query('SELECT name FROM entity_types WHERE is_creature ORDER BY name LIMIT 1')).rows[0].name;

    const bound = async (kind, subjectKind, subjectKey, slot) => {
      const c = await lib.storeClip(pool, {
        buffer: OGG, kind, label: `loop-test ${tag}`, source: 'uploaded', durationMs: 2000,
      });
      made.clips.push(c.id);
      if (subjectKind) await lib.bindClip(pool, { subjectKind, subjectKey, slot, clipId: c.id });
      return c;
    };
    const patch = (id, body, who = admin) => request(app).patch(`/api/audio/admin/clips/${id}`)
      .set('Authorization', bearer(who)).send(body);

    await t.test('an sfx clip defaults to loopable=false, even on a world point', async () => {
      const c = await bound('sfx', 'world_point', point, 'nearby');
      assert.equal(c.loopable, false);
    });

    await t.test('PATCH sets loopable on a world point nearby clip, and the world bundle carries it', async () => {
      const c = await bound('sfx', 'world_point', point, 'nearby');
      const r = await patch(c.id, { loopable: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.loopable, true);
      const bundle = await request(app).get(`/api/audio/world/${worldId}`).set('Authorization', bearer(player));
      assert.equal(bundle.status, 200);
      const entry = (bundle.body.bindings[`world_point/${point}/nearby`] || []).find((x) => x.key === c.storage_key);
      assert.ok(entry, 'the clip is in the bundle');
      assert.equal(entry.loopable, true);
      const back = await patch(c.id, { loopable: false });
      assert.equal(back.status, 200);
      assert.equal(back.body.loopable, false);
    });

    await t.test('PATCH is admin-only (a player gets 403)', async () => {
      const c = await bound('sfx', 'world_point', point, 'nearby');
      const r = await patch(c.id, { loopable: true }, player);
      assert.equal(r.status, 403);
      const row = (await pool.query('SELECT loopable FROM audio_clips WHERE id = $1', [c.id])).rows[0];
      assert.equal(row.loopable, false);
    });

    await t.test('PATCH refuses an sfx clip bound to a creature slot, or bound nowhere (400)', async () => {
      const onCreature = await bound('sfx', 'creature', creature, 'hurt');
      const r = await patch(onCreature.id, { loopable: true });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /world point/);
      const unbound = await bound('sfx');
      assert.equal((await patch(unbound.id, { loopable: true })).status, 400);
      const rows = (await pool.query('SELECT loopable FROM audio_clips WHERE id = ANY($1)', [[onCreature.id, unbound.id]])).rows;
      assert.ok(rows.every((x) => x.loopable === false));
    });

    await t.test('PATCH accepts a non-sfx clip, validates the body, and 404s an unknown id', async () => {
      const music = await bound('music');
      const r = await patch(music.id, { loopable: false });
      assert.equal(r.status, 200);
      assert.equal(r.body.loopable, false);
      assert.equal((await patch(music.id, { loopable: 'yes' })).status, 400);
      assert.equal((await patch(music.id, {})).status, 400);
      assert.equal((await patch('not-a-uuid', { loopable: true })).status, 400);
      assert.equal((await patch(NIL_UUID, { loopable: true })).status, 404);
    });

    await t.test('upload with loopable=true on a world point nearby slot stores a loopable clip', async () => {
      const r = await request(app)
        .post(`/api/audio/admin/upload?subject_kind=world_point&subject_key=${encodeURIComponent(point)}&slot=nearby&loopable=true`)
        .set('Authorization', bearer(admin)).set('Content-Type', 'audio/ogg').send(OGG);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      made.clips.push(r.body.clip.id);
      assert.equal(r.body.clip.loopable, true);
      assert.equal(r.body.clip.sha1, lib.sha1Of(OGG), 'an upload records its sha1 (I1)');
    });

    await t.test('upload with loopable on any other sfx slot is refused (400); without the flag it is a one-shot', async () => {
      const refused = await request(app)
        .post(`/api/audio/admin/upload?subject_kind=creature&subject_key=${encodeURIComponent(creature)}&slot=hurt&loopable=true`)
        .set('Authorization', bearer(admin)).set('Content-Type', 'audio/ogg').send(OGG);
      assert.equal(refused.status, 400);
      if (refused.body.clip) made.clips.push(refused.body.clip.id);
      const plain = await request(app)
        .post(`/api/audio/admin/upload?subject_kind=world_point&subject_key=${encodeURIComponent(point)}&slot=nearby`)
        .set('Authorization', bearer(admin)).set('Content-Type', 'audio/ogg').send(OGG);
      assert.equal(plain.status, 201);
      made.clips.push(plain.body.clip.id);
      assert.equal(plain.body.clip.loopable, false);
    });
  });
});
