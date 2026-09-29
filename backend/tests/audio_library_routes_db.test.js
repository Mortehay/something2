// backend/tests/audio_library_routes_db.test.js
//
// Real-HTTP, real-DB coverage for the clip library routes (SOMET-591, game
// audio slice 2 §1): GET/admin/clips, DELETE /admin/clips/:id,
// POST /admin/clips/delete-unbound, POST /admin/bindings (bind-from-library).
// A fake asset client records removeObject calls so a delete's object-store
// side effect is verifiable without a live MinIO.
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
  const username = `audio-lib-${role}-${tag}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', role]);
  return { id: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion })}`;

test('audio clip library routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  // AUDIO_CLIPS_LOCK_KEY: see advisoryLock.js -- delete-unbound deletes every
  // unbound clip in the database, so clip-creating bodies are serialized with it.
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    const removed = [];
    assetStore.__setAssetClient({
      bucketExists: async () => true,
      putObject: async () => {},
      removeObject: async (bucket, key) => { removed.push({ bucket, key }); },
    });
    const tag = `${process.pid}-${Date.now()}`;
    const worldA = `audio-lib-world-a-${tag}`;
    const worldB = `audio-lib-world-b-${tag}`;
    const made = { users: [], worlds: [] };
    const clipIds = [];

    t.after(async () => {
      try {
        if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
        if (made.worlds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [made.worlds]);
        if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
      } finally { await pool.end(); }
    });

    const admin = await makeUser(pool, 'admin', tag);
    made.users.push(admin.id);
    const player = await makeUser(pool, 'player', tag);
    made.users.push(player.id);
    const worldAId = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [worldA])).rows[0].id;
    made.worlds.push(worldAId);
    const worldBId = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [worldB])).rows[0].id;
    made.worlds.push(worldBId);

    const store = async (kind, label) => {
      const c = await lib.storeClip(pool, {
        buffer: OGG, kind, label: `${label} ${tag}`, source: 'uploaded', durationMs: 2000,
      });
      clipIds.push(c.id);
      return c;
    };

    await t.test('every new admin route rejects a player (403)', async () => {
      assert.equal((await request(app).get('/api/audio/admin/clips').set('Authorization', bearer(player))).status, 403);
      assert.equal((await request(app).delete(`/api/audio/admin/clips/${NIL_UUID}`).set('Authorization', bearer(player))).status, 403);
      assert.equal((await request(app).post('/api/audio/admin/clips/delete-unbound').set('Authorization', bearer(player))).status, 403);
      assert.equal((await request(app).post('/api/audio/admin/bindings').set('Authorization', bearer(player))
        .send({
          subject_kind: 'world', subject_key: worldA, slot: 'music', clip_id: NIL_UUID,
        })).status, 403);
    });

    await t.test('GET /admin/clips filters by kind and unbound, and reports binding_count', async () => {
      const bound = await store('music', 'bound');
      const unboundMusic = await store('music', 'unbound-music');
      const unboundAmbience = await store('ambience', 'unbound-ambience');
      await lib.bindClip(pool, {
        subjectKind: 'world', subjectKey: worldA, slot: 'music', clipId: bound.id,
      });

      const byKind = await request(app).get('/api/audio/admin/clips?kind=music').set('Authorization', bearer(admin));
      assert.equal(byKind.status, 200, JSON.stringify(byKind.body));
      const byKindIds = byKind.body.rows.map((r) => r.id);
      assert.ok(byKindIds.includes(bound.id), 'bound music clip present');
      assert.ok(byKindIds.includes(unboundMusic.id), 'unbound music clip present');
      assert.ok(!byKindIds.includes(unboundAmbience.id), 'ambience clip excluded by kind filter');
      const boundRow = byKind.body.rows.find((r) => r.id === bound.id);
      assert.equal(boundRow.binding_count, 1);
      const unboundRow = byKind.body.rows.find((r) => r.id === unboundMusic.id);
      assert.equal(unboundRow.binding_count, 0);

      const unboundOnly = await request(app).get('/api/audio/admin/clips?unbound=1').set('Authorization', bearer(admin));
      assert.equal(unboundOnly.status, 200);
      const unboundIds = unboundOnly.body.rows.map((r) => r.id);
      assert.ok(!unboundIds.includes(bound.id), 'bound clip excluded when unbound=1');
      assert.ok(unboundIds.includes(unboundMusic.id));
      assert.ok(unboundIds.includes(unboundAmbience.id));
      assert.ok(Number.isInteger(unboundOnly.body.total) && unboundOnly.body.total >= 2);
    });

    await t.test('DELETE /admin/clips/:id removes the object and reports the binding count', async () => {
      const clip = await store('ambience', 'to-delete-2');
      await lib.bindClip(pool, {
        subjectKind: 'world', subjectKey: worldA, slot: 'ambience', clipId: clip.id,
      });
      await lib.bindClip(pool, {
        subjectKind: 'world', subjectKey: worldB, slot: 'ambience', clipId: clip.id,
      });
      const before = removed.length;
      const res = await request(app).delete(`/api/audio/admin/clips/${clip.id}`).set('Authorization', bearer(admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { deleted: true, bindings: 2 });
      assert.equal(removed.length, before + 1);
      assert.equal(removed[removed.length - 1].key, clip.storage_key);
      const row = await pool.query('SELECT 1 FROM audio_clips WHERE id = $1', [clip.id]);
      assert.equal(row.rowCount, 0, 'clip row gone');
      const bindings = await pool.query('SELECT 1 FROM audio_bindings WHERE clip_id = $1', [clip.id]);
      assert.equal(bindings.rowCount, 0, 'bindings cascade-deleted');
      clipIds.splice(clipIds.indexOf(clip.id), 1);
    });

    await t.test('DELETE /admin/clips/:id is 404 for an id that does not exist', async () => {
      const res = await request(app).delete(`/api/audio/admin/clips/${NIL_UUID}`).set('Authorization', bearer(admin));
      assert.equal(res.status, 404);
    });

    await t.test('POST /admin/clips/delete-unbound never touches a bound clip', async () => {
      const bound = await store('music', 'bulk-bound');
      const unbound1 = await store('music', 'bulk-unbound-1');
      const unbound2 = await store('ambience', 'bulk-unbound-2');
      await lib.bindClip(pool, {
        subjectKind: 'world', subjectKey: worldB, slot: 'music', clipId: bound.id,
      });
      const before = removed.length;
      const res = await request(app).post('/api/audio/admin/clips/delete-unbound').set('Authorization', bearer(admin)).send({});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.deleted >= 2, `expected at least the 2 unbound clips just made, got ${res.body.deleted}`);
      const boundStillThere = await pool.query('SELECT 1 FROM audio_clips WHERE id = $1', [bound.id]);
      assert.equal(boundStillThere.rowCount, 1, 'bound clip survives delete-unbound');
      const unbound1Gone = await pool.query('SELECT 1 FROM audio_clips WHERE id = $1', [unbound1.id]);
      assert.equal(unbound1Gone.rowCount, 0);
      const unbound2Gone = await pool.query('SELECT 1 FROM audio_clips WHERE id = $1', [unbound2.id]);
      assert.equal(unbound2Gone.rowCount, 0);
      assert.ok(removed.length > before, 'removeObject called for the deleted clips');
      assert.ok(removed.slice(before).some((r) => r.key === unbound1.storage_key));
      assert.ok(removed.slice(before).some((r) => r.key === unbound2.storage_key));
      assert.ok(!removed.slice(before).some((r) => r.key === bound.storage_key));
      clipIds.splice(clipIds.indexOf(unbound1.id), 1);
      clipIds.splice(clipIds.indexOf(unbound2.id), 1);
    });

    await t.test('POST /admin/bindings binds an existing clip to a second subject and rejects a kind mismatch', async () => {
      const clip = await store('music', 'reusable');
      const first = await request(app).post('/api/audio/admin/bindings').set('Authorization', bearer(admin))
        .send({
          subject_kind: 'world', subject_key: worldA, slot: 'music', clip_id: clip.id,
        });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.clip_id, clip.id);

      const second = await request(app).post('/api/audio/admin/bindings').set('Authorization', bearer(admin))
        .send({
          subject_kind: 'world', subject_key: worldB, slot: 'music', clip_id: clip.id,
        });
      assert.equal(second.status, 201, JSON.stringify(second.body));
      const bindings = await pool.query('SELECT 1 FROM audio_bindings WHERE clip_id = $1', [clip.id]);
      assert.equal(bindings.rowCount, 2, 'the same clip is now bound to two subjects');

      const unknownSubject = await request(app).post('/api/audio/admin/bindings').set('Authorization', bearer(admin))
        .send({
          subject_kind: 'biome', subject_key: 'nonexistent-biome', slot: 'ambience', clip_id: clip.id,
        });
      assert.equal(unknownSubject.status, 400);

      const kindMismatch = await request(app).post('/api/audio/admin/bindings').set('Authorization', bearer(admin))
        .send({
          subject_kind: 'world', subject_key: worldA, slot: 'ambience', clip_id: clip.id,
        });
      assert.equal(kindMismatch.status, 400, 'a music clip cannot bind to the ambience slot');
    });
  });
});
