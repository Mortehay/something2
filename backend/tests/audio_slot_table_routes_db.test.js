// backend/tests/audio_slot_table_routes_db.test.js
//
// SOMET-596: the three backend pieces behind the Audio tab's slot table.
//   1. GET /api/audio/admin/subjects carries per-slot clip counts
//      (`filledSlots`) beside the unchanged `filled` badge count;
//   2. GET /api/audio/admin/jobs/slots lists the latest live-or-failed job per
//      (kind, key, slot);
//   3. POST /api/audio/admin/jobs/retry-failed takes an optional { ids } that
//      scopes the retry to those failed jobs' slots.
// Real HTTP, real (scratch) DB. Every row this file creates is keyed by `tag`
// and deleted in t.after; the database-wide no-ids retry puts foreign rows
// back via restoringForeignJobs.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const assetStore = require('../src/services/assetStore');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { restoringForeignJobs } = require('./helpers/foreignAudioJobs.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

async function makeUser(pool, role, tag) {
  const username = `audio-tbl-${role}-${tag}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', role]);
  return { id: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion })}`;

test('audio slot table routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
  const tag = `tbl-${process.pid}-${Date.now()}`;
  const own = `audio-tbl%${tag}%`;
  const worldName = `audio-tbl-world-${tag}`;
  const made = { users: [], worlds: [], jobs: [] };

  t.after(async () => {
    try {
      await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [own]);
      if (made.jobs.length) await pool.query('DELETE FROM audio_jobs WHERE id = ANY($1)', [made.jobs]);
      await pool.query(
        'DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key = $1)', [worldName]);
      if (made.worlds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [made.worlds]);
      if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
    } finally { await pool.end(); }
  });

  const admin = await makeUser(pool, 'admin', tag); made.users.push(admin.id);
  const player = await makeUser(pool, 'player', tag); made.users.push(player.id);
  const worldId = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [worldName])).rows[0].id;
  made.worlds.push(worldId);

  // One job row, inserted directly (no drain is ever started in this file).
  async function job(key, slot, state, error = null) {
    const clipKind = slot === 'music' ? 'music' : 'ambience';
    const id = (await pool.query(
      `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state, attempts, last_error)
       VALUES (gen_random_uuid(), 'world', $1, $2, $3, $3, $4, 3, $5) RETURNING id`,
      [key, slot, clipKind, state, error],
    )).rows[0].id;
    made.jobs.push(id);
    return id;
  }
  const stateOf = async (id) => {
    const r = (await pool.query('SELECT state, attempts, last_error FROM audio_jobs WHERE id = $1', [id])).rows[0];
    return r || null;
  };

  await t.test('the new routes reject a player (403) and anonymous (401)', async () => {
    const calls = [
      ['get', '/api/audio/admin/jobs/slots'],
      ['post', '/api/audio/admin/jobs/retry-failed'],
    ];
    for (const [method, p] of calls) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await request(app)[method](p).set('Authorization', bearer(player)).send({ ids: [] })).status, 403, `${method} ${p}`);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await request(app)[method](p).send({})).status, 401, `${method} ${p} anon`);
    }
  });

  await t.test('admin/subjects: filledSlots counts clips per slot; filled is unchanged', async () => {
    await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
      const up = (slot, label) => request(app)
        .post(`/api/audio/admin/upload?subject_kind=world&subject_key=${encodeURIComponent(worldName)}&slot=${slot}&label=${label}`)
        .set('Authorization', bearer(admin)).set('Content-Type', 'audio/ogg').send(OGG);
      for (const [slot, label] of [['music', 'a'], ['music', 'b'], ['ambience', 'c']]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await up(slot, label);
        assert.equal(r.status, 201, JSON.stringify(r.body));
      }
    });
    const res = await request(app).get('/api/audio/admin/subjects').set('Authorization', bearer(admin));
    assert.equal(res.status, 200);
    const world = res.body.find((g) => g.kind === 'world');
    assert.deepEqual(world.filledSlots[worldName], { music: 2, ambience: 1 });
    assert.equal(world.filled[worldName], 2, 'filled stays the DISTINCT slot count');
    const denied = await request(app).get('/api/audio/admin/subjects').set('Authorization', bearer(player));
    assert.equal(denied.status, 403);
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    await t.test('jobs/slots: the latest job per slot, live or failed only', async () => {
      const kA = `audio-tbl-a-${tag}`;
      const kB = `audio-tbl-b-${tag}`;
      // A/music: failed, then a later success -- the slot is fine now and
      // must NOT show the stale failure.
      await job(kA, 'music', 'failed', 'old failure');
      await job(kA, 'music', 'done');
      // A/ambience: two failures -- only the newer one is reported.
      await job(kA, 'ambience', 'failed', 'first failure');
      const newer = await job(kA, 'ambience', 'failed', 'second failure');
      // B/music: queued.
      const queued = await job(kB, 'music', 'queued');

      const res = await request(app).get('/api/audio/admin/jobs/slots').set('Authorization', bearer(admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const mine = res.body.filter((r) => r.subject_key === kA || r.subject_key === kB)
        .sort((x, y) => `${x.subject_key}/${x.slot}`.localeCompare(`${y.subject_key}/${y.slot}`));
      assert.deepEqual(mine.map((r) => [r.subject_key, r.slot, r.status, r.error]), [
        [kA, 'ambience', 'failed', 'second failure'],
        [kB, 'music', 'queued', null],
      ]);
      assert.equal(String(mine[0].id), String(newer));
      assert.equal(String(mine[1].id), String(queued));
      assert.equal(mine[0].subject_kind, 'world');
      assert.equal(mine[0].attempts, 3);
      assert.ok(mine[0].updated_at, 'updated_at is returned');
    });

    await t.test('jobs/slots: "latest" is by updated_at, so a re-failed old row beats a newer-id done row', async () => {
      const kR = `audio-tbl-r-${tag}`;
      const old = await job(kR, 'music', 'failed', 'failed again after a retry');
      await job(kR, 'music', 'done');
      // The old row was retried and failed again AFTER the done row: same id,
      // later updated_at.
      await pool.query("UPDATE audio_jobs SET updated_at = now() + interval '1 minute' WHERE id = $1", [old]);
      const res = await request(app).get('/api/audio/admin/jobs/slots').set('Authorization', bearer(admin));
      const mine = res.body.filter((r) => r.subject_key === kR);
      assert.deepEqual(mine.map((r) => [String(r.id), r.status, r.error]), [[String(old), 'failed', 'failed again after a retry']]);
    });

    await t.test('retry-failed { ids } re-queues only those slots; bad ids are a 400', async () => {
      const kC = `audio-tbl-c-${tag}`;
      const kD = `audio-tbl-d-${tag}`;
      const olderC = await job(kC, 'music', 'failed', 'x');
      const newestC = await job(kC, 'music', 'failed', 'y');
      const failedD = await job(kD, 'music', 'failed', 'z');
      const doneD = await job(kD, 'ambience', 'done');
      const foreignFailed = await job(`foreign-tbl-${tag}`, 'music', 'failed', 'foreign');

      const bad = await request(app).post('/api/audio/admin/jobs/retry-failed')
        .set('Authorization', bearer(admin)).send({ ids: ['abc'] });
      assert.equal(bad.status, 400);
      assert.equal((await stateOf(newestC)).state, 'failed', 'a rejected request changed nothing');

      // A done id and an id that does not exist are ignored, not errors.
      const res = await request(app).post('/api/audio/admin/jobs/retry-failed')
        .set('Authorization', bearer(admin)).send({ ids: [String(newestC), Number(doneD), '999999999999'] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.requeued, 1);
      const c = await stateOf(newestC);
      assert.equal(c.state, 'queued');
      assert.equal(c.attempts, 0);
      assert.equal(await stateOf(olderC), null, "the slot's older failed duplicate is removed");
      assert.equal((await stateOf(failedD)).state, 'failed', 'an unnamed failed job is left alone');
      assert.equal((await stateOf(doneD)).state, 'done');
      assert.equal((await stateOf(foreignFailed)).state, 'failed', 'a foreign failed job is left alone');

      // Naming an OLDER duplicate still retries the slot once, via its newest row.
      const kE = `audio-tbl-e-${tag}`;
      const olderE = await job(kE, 'music', 'failed', 'x');
      const newestE = await job(kE, 'music', 'failed', 'y');
      const again = await request(app).post('/api/audio/admin/jobs/retry-failed')
        .set('Authorization', bearer(admin)).send({ ids: [String(olderE)] });
      assert.equal(again.body.requeued, 1);
      assert.equal((await stateOf(newestE)).state, 'queued');
      assert.equal(await stateOf(olderE), null);
      await pool.query('DELETE FROM audio_jobs WHERE id = $1', [foreignFailed]);
    });

    await t.test('retry-failed rejects an id above the bigint maximum with a 400', async () => {
      const over = await request(app).post('/api/audio/admin/jobs/retry-failed')
        .set('Authorization', bearer(admin)).send({ ids: ['9223372036854775808'] });
      assert.equal(over.status, 400, JSON.stringify(over.body));
      const max = await request(app).post('/api/audio/admin/jobs/retry-failed')
        .set('Authorization', bearer(admin)).send({ ids: ['9223372036854775807'] });
      assert.equal(max.status, 200, JSON.stringify(max.body));
      assert.equal(max.body.requeued, 0);
    });

    await t.test('retry-failed with no ids retries each slot whose latest job failed, once', async () => {
      // Self-contained: this file's own earlier rows are removed first, so
      // the expected count below is exactly the rows made here.
      await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [own]);
      const kF = `audio-tbl-f-${tag}`;
      const f1 = await job(kF, 'music', 'failed', 'a');
      const f2 = await job(kF, 'ambience', 'failed', 'b');
      // G: a stale failure behind a later success -- the slot has sound now.
      const kG = `audio-tbl-g-${tag}`;
      const staleG = await job(kG, 'music', 'failed', 'old');
      const doneG = await job(kG, 'music', 'done');
      // H: two failed rows on one slot -- one queued row, no constraint error.
      const kH = `audio-tbl-h-${tag}`;
      const olderH = await job(kH, 'music', 'failed', 'x');
      const newerH = await job(kH, 'music', 'failed', 'y');

      const { result: res, foreignTouched } = await restoringForeignJobs(pool, own, ['failed'], () => (
        request(app).post('/api/audio/admin/jobs/retry-failed').set('Authorization', bearer(admin)).send({})));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.requeued - foreignTouched, 3, 'F/music, F/ambience and H/music');
      assert.equal((await stateOf(f1)).state, 'queued');
      assert.equal((await stateOf(f2)).state, 'queued');
      assert.equal((await stateOf(staleG)).state, 'failed', 'a stale failure behind a done row is not re-queued');
      assert.equal((await stateOf(doneG)).state, 'done');
      assert.equal(await stateOf(olderH), null, 'the older failed duplicate is deleted');
      assert.equal((await stateOf(newerH)).state, 'queued');
      const live = (await pool.query(
        "SELECT count(*)::int AS n FROM audio_jobs WHERE subject_key = $1 AND state IN ('queued','running')", [kH])).rows[0].n;
      assert.equal(live, 1);
    });
  });
});
