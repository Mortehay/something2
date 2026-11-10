const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const effectSpriteRoutes = require('../src/api/effectSpriteRoutes.js');
const { VISUAL_BUFF_IDS } = require('../src/services/buffVisuals.js');
const { snapshotRows, snapshotAll } = require('./helpers/rowSnapshot.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const LOCK = 8472001; // shared with the other effect test files

let pool; let lockClient;
test.before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [LOCK]);
});
test.after(async () => {
  if (skip) return;
  await pool.query('DELETE FROM effect_sprite_jobs');
  await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK]);
  lockClient.release();
  await pool.end();
});

const allow = (_req, _res, next) => next();
function appWith(guard = allow) {
  const d = { kicks: 0, kick() { this.kicks += 1; return Promise.resolve(); }, status: () => ({ running: false, currentId: null }) };
  const cancels = [];
  const app = express();
  // A fake box and cancel recorder: no box traffic.
  app.use('/fx', effectSpriteRoutes(pool, guard, d, {
    box: { cancelSheetJob: async () => ({ ok: true }) },
    loadProvider: async () => ({ id: 'p' }),
    boxCancels: { request: async (_db, _p, item) => { cancels.push(item); return { ok: true }; } },
  }));
  return { app, d, cancels };
}
const clean = () => pool.query('DELETE FROM effect_sprite_jobs');

test('GET / lists every vfx_effects / aura_effects row with default prompts and the box-measured eta', { skip }, async () => {
  await clean();
  const { app } = appWith();
  const r = await request(app).get('/fx');
  assert.equal(r.status, 200);
  const { rows: [n] } = await pool.query('SELECT (SELECT count(*) FROM vfx_effects)::int + (SELECT count(*) FROM aura_effects)::int AS n');
  // plus every visual buff (Buff auras) and the ten amber status rows (Status visuals)
  assert.equal(r.body.subjects.length, n.n + VISUAL_BUFF_IDS.length + 10);
  const pl = r.body.subjects.find((s) => s.name === 'pack_leader');
  assert.equal(pl.default_prompt, 'pack leader, gold');
  assert.equal(pl.group, 'Auras');
  assert.equal(pl.retired, false);
  assert.equal(pl.missing, false);
  assert.equal(r.body.subjects.find((s) => s.name === 'spark_fire').retired, true);
  // A ring is drawn top-down; its default prompt says so.
  const ring = r.body.subjects.find((s) => s.name === 'frost_nova');
  assert.equal(ring.kind, 'burst');
  assert.match(ring.default_prompt, /, seen from above$/);
  assert.deepEqual(r.body.eta.aura, { low: 35.2, typical: 35.2, high: 140.2 });
  assert.deepEqual(r.body.eta.burst, { low: 35.2, typical: 35.2, high: 140.2 });
  assert.deepEqual(r.body.dispatcher, { running: false, currentId: null });
});

test('POST /jobs queues one row per target and kicks the dispatcher once', { skip }, async () => {
  await clean();
  const { app, d } = appWith();
  const r = await request(app).post('/fx/jobs').send({ targets: [
    { subject_kind: 'aura', name: 'pack_leader' }, { subject_kind: 'vfx', name: 'bolt_fire', prompt: '  a fire bolt \n' }] });
  assert.equal(r.status, 202);
  assert.equal(r.body.queued.length, 2);
  assert.equal(d.kicks, 1);
  const { rows } = await pool.query('SELECT subject_name, prompt FROM effect_sprite_jobs ORDER BY subject_name');
  assert.deepEqual(rows, [{ subject_name: 'bolt_fire', prompt: 'a fire bolt' }, { subject_name: 'pack_leader', prompt: 'pack leader, gold' }]);
});

test('POST /jobs twice for one subject: the second answers skipped already queued and no second row exists', { skip }, async () => {
  await clean();
  const { app } = appWith();
  const body = { targets: [{ subject_kind: 'vfx', name: 'bolt_ice' }] };
  await request(app).post('/fx/jobs').send(body);
  const r = await request(app).post('/fx/jobs').send(body);
  assert.equal(r.status, 202);
  assert.equal(r.body.queued.length, 0);
  assert.equal(r.body.skipped[0].reason, 'already queued');
  assert.equal((await pool.query('SELECT 1 FROM effect_sprite_jobs')).rowCount, 1);
});

test('POST /jobs rejects an unknown effect name (400) and a 1001-char prompt (400)', { skip }, async () => {
  await clean();
  const { app, d } = appWith();
  const a = await request(app).post('/fx').send({});
  assert.equal(a.status, 404);
  const empty = await request(app).post('/fx/jobs').send({ targets: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'targets must be a non-empty list');
  const bad = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'nope' }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'nope is not an effect');
  const long = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'bolt_fire', prompt: 'x'.repeat(1001) }] });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'prompt must be 1-1000 characters');
  for (const blank of ['', '   ', '\n\t ']) {
    const ws = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'bolt_fire', prompt: blank }] });
    assert.equal(ws.status, 400, `prompt ${JSON.stringify(blank)} is rejected`);
    assert.equal(ws.body.error, 'prompt must be 1-1000 characters');
  }
  assert.equal((await pool.query('SELECT 1 FROM effect_sprite_jobs')).rowCount, 0);
  assert.equal(d.kicks, 0);
});

test('approve -> GET / shows the sprite on the subject', { skip }, async () => {
  await clean();
  const restore = await snapshotRows(pool, 'aura_effects', "name = 'shade_veil'");
  try {
    const { app } = appWith();
    const q = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'aura', name: 'shade_veil' }] });
    const id = q.body.queued[0].id;
    assert.equal((await request(app).post('/fx/jobs/abc/approve')).status, 400);
    // beyond int4: a 404 like any missing job, never a pg "out of range" 500
    for (const big of ['2147483648', '99999999999999999999']) {
      const r = await request(app).post(`/fx/jobs/${big}/approve`);
      assert.equal(r.status, 404, big);
      assert.equal(r.body.error, 'job not found');
    }
    assert.equal((await request(app).post('/fx/jobs/2147483647/approve')).status, 404); // in range, absent
    assert.equal((await request(app).post(`/fx/jobs/${id}/approve`)).status, 409); // still queued
    await pool.query(`UPDATE effect_sprite_jobs SET status='done', image_key='fx/shade_veil.png',
      atlas='{"frames":8,"fps_hint":10}'::jsonb WHERE id=$1`, [id]);
    const ok = await request(app).post(`/fx/jobs/${id}/approve`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.sprite.image, 'fx/shade_veil.png');
    const g = await request(app).get('/fx');
    const s = g.body.subjects.find((x) => x.name === 'shade_veil');
    assert.equal(s.sprite.image, 'fx/shade_veil.png');
    assert.equal(s.sprite.frames, 8);
    assert.equal(s.job.status, 'approved');
  } finally {
    await restore();
  }
});

test('GET / gives a done candidate the play settings approve will write, from the box atlas', { skip }, async () => {
  await clean();
  const { app } = appWith();
  const atlas = JSON.parse(require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'fixtures', 'box-vfx-atlas', 'burst_fireball_blast.json'), 'utf8'));
  const q = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'fireball_blast' }] });
  const id = q.body.queued[0].id;
  const before = (await request(app).get('/fx')).body.subjects.find((x) => x.name === 'fireball_blast');
  assert.equal(before.job.play, null); // queued: no image yet
  await pool.query(`UPDATE effect_sprite_jobs SET status='done', image_key='fx/fb.png', atlas=$2::jsonb WHERE id=$1`,
    [id, JSON.stringify(atlas)]);
  const s = (await request(app).get('/fx')).body.subjects.find((x) => x.name === 'fireball_blast');
  // the job row asked for 6 frames; the atlas says 10, plays once, no fps (burst)
  assert.equal(s.job.frames, 6);
  assert.deepEqual(s.job.play, { frames: 10, loop: false, fps: null });
  const aura = JSON.parse(require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'fixtures', 'box-vfx-atlas', 'aura_ignis_inferno.json'), 'utf8'));
  const qa = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'aura', name: 'ignis_inferno' }] });
  await pool.query(`UPDATE effect_sprite_jobs SET status='done', image_key='fx/ii.png', atlas=$2::jsonb WHERE id=$1`,
    [qa.body.queued[0].id, JSON.stringify(aura)]);
  const a = (await request(app).get('/fx')).body.subjects.find((x) => x.name === 'ignis_inferno');
  assert.deepEqual(a.job.play, { frames: 12, loop: true, fps: 10 });
});

test('POST /dispatch kicks; routes are admin-only', { skip }, async () => {
  const { app, d } = appWith();
  assert.deepEqual((await request(app).post('/fx/dispatch')).body, { running: true });
  assert.equal(d.kicks, 1);
  const deny = appWith((_req, res) => res.status(403).json({ error: 'admin only' }));
  for (const [m, p] of [['get', '/fx'], ['post', '/fx/jobs'], ['post', '/fx/jobs/1/approve'], ['post', '/fx/dispatch']]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await request(deny.app)[m](p)).status, 403, `${m} ${p}`);
  }
  assert.equal(deny.d.kicks, 0);
});

const desc = require('../src/services/artPromptDescriptions.js');
const wipeFxDesc = async () => {
  await pool.query("DELETE FROM art_prompt_descriptions WHERE subject_kind IN ('vfx','aura') AND subject_key IN ('bolt_fire','spark_hit','pack_leader')");
  await pool.query("DELETE FROM sprite_prompt_optins WHERE subject_kind IN ('vfx','aura') AND subject_key IN ('bolt_fire','spark_hit','pack_leader')");
};

test('GET / gives default frames/loop (bolt_fire 8 loop, spark_hit 6 one-shot) and the active prompt with its source', { skip }, async () => {
  await clean();
  await wipeFxDesc();
  try {
    await desc.replace(pool, 'vfx', 'bolt_fire', { text: 'spiralling orange flame lance', model: 'm', origin: 'sprite' });
    await pool.query("INSERT INTO effect_sprite_jobs (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed, needs_prompt) VALUES ('vfx','spark_hit','spark hit','burst',6,128,false,'additive',1,true)");
    const r = await request(appWith().app).get('/fx');
    assert.equal(r.status, 200);
    const bolt = r.body.subjects.find((x) => x.name === 'bolt_fire');
    assert.equal(bolt.default_frames, 8);
    assert.equal(bolt.default_loop, true);
    assert.equal(bolt.prompt, 'spiralling orange flame lance');
    assert.equal(bolt.prompt_source, 'description');
    assert.equal(bolt.prompt_origin, 'sprite');
    assert.equal(bolt.max_frames, 64);
    assert.equal(bolt.prompt_kind, 'vfx');
    assert.equal(bolt.prompt_key, 'bolt_fire');
    const spark = r.body.subjects.find((x) => x.name === 'spark_hit');
    assert.equal(spark.default_frames, 6);
    assert.equal(spark.default_loop, false);
    assert.equal(spark.prompt, spark.default_prompt);
    assert.equal(spark.prompt_source, 'template');
    assert.equal(spark.prompt_origin, null);
    assert.equal(r.body.subjects.find((x) => x.name === 'arcane_beam').max_frames, 21, 'a beam cell is 4x wide');
    assert.equal(spark.job.loop, false);
    assert.equal(spark.job.needs_prompt, true);
    assert.ok(spark.job.updated_at);
    const pl = r.body.subjects.find((x) => x.name === 'pack_leader');
    assert.equal(pl.prompt_kind, 'aura');
  } finally {
    await wipeFxDesc();
  }
});

test('POST /jobs stores frames/loop overrides; a burst with loop:true is 400; an aura with loop:false is stored looping', { skip }, async () => {
  await clean();
  const { app, d } = appWith();
  const burst = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'spark_hit', loop: true }] });
  assert.equal(burst.status, 400);
  assert.equal(burst.body.error, 'spark_hit is a burst and always plays once');
  const tooMany = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'arcane_beam', frames: 22 }] });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error, 'frames must be an integer from 1 to 21');
  const badLoop = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'bolt_ice', loop: 'yes' }] });
  assert.equal(badLoop.status, 400);
  assert.equal(badLoop.body.error, 'loop must be true or false');
  assert.equal((await pool.query('SELECT 1 FROM effect_sprite_jobs')).rowCount, 0, 'a refused body queues nothing');
  assert.equal(d.kicks, 0);
  const ok = await request(app).post('/fx/jobs').send({ targets: [
    { subject_kind: 'vfx', name: 'bolt_fire', frames: 12, loop: false },
    { subject_kind: 'aura', name: 'pack_leader', loop: false },
    { subject_kind: 'vfx', name: 'spark_hit', frames: 4, loop: false },
  ] });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  const { rows } = await pool.query('SELECT subject_name, frames, loop FROM effect_sprite_jobs ORDER BY subject_name');
  assert.deepEqual(rows, [
    { subject_name: 'bolt_fire', frames: 12, loop: false },
    { subject_name: 'pack_leader', frames: 8, loop: true },
    { subject_name: 'spark_hit', frames: 4, loop: false },
  ]);
});

test('POST /jobs with regenerate:true queues needs_prompt jobs and kicks once', { skip }, async () => {
  await clean();
  await wipeFxDesc();
  const { app, d } = appWith();
  const bad = await request(app).post('/fx/jobs').send({ regenerate: 'yes', targets: [{ subject_kind: 'vfx', name: 'bolt_fire' }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'regenerate must be true or false');
  const both = await request(app).post('/fx/jobs').send({ regenerate: true, targets: [{ subject_kind: 'vfx', name: 'bolt_fire', prompt: 'an edited bolt' }] });
  assert.equal(both.status, 400);
  assert.equal(both.body.error, 'choose either an edited prompt or Regenerate');
  assert.equal((await pool.query('SELECT 1 FROM effect_sprite_jobs')).rowCount, 0);
  const r = await request(app).post('/fx/jobs').send({ regenerate: true, targets: [
    { subject_kind: 'vfx', name: 'bolt_fire' }, { subject_kind: 'aura', name: 'pack_leader' }] });
  assert.equal(r.status, 202);
  assert.equal(r.body.queued.length, 2);
  assert.equal(d.kicks, 1);
  const { rows } = await pool.query('SELECT subject_name, needs_prompt FROM effect_sprite_jobs ORDER BY subject_name');
  assert.deepEqual(rows, [{ subject_name: 'bolt_fire', needs_prompt: true }, { subject_name: 'pack_leader', needs_prompt: true }]);
});

test('POST /jobs with no prompt uses the active description; never sends the template as explicit', { skip }, async () => {
  await clean();
  await wipeFxDesc();
  try {
    await desc.replace(pool, 'vfx', 'bolt_fire', { text: 'spiralling orange flame lance', model: 'm', origin: 'sprite' });
    const { app } = appWith();
    await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'bolt_fire' }, { subject_kind: 'vfx', name: 'bolt_ice' }] });
    const { rows } = await pool.query('SELECT subject_name, prompt FROM effect_sprite_jobs ORDER BY subject_name');
    assert.equal(rows[0].prompt, 'spiralling orange flame lance');
    assert.equal(rows[1].subject_name, 'bolt_ice');
    // A queued job re-queued with regenerate keeps its prompt pending, not overwritten by a template.
    const again = await request(app).post('/fx/jobs').send({ regenerate: true, targets: [{ subject_kind: 'vfx', name: 'bolt_fire' }] });
    assert.equal(again.body.queued.length, 1);
    const { rows: [j] } = await pool.query("SELECT prompt, needs_prompt FROM effect_sprite_jobs WHERE subject_name = 'bolt_fire'");
    assert.deepEqual(j, { prompt: 'spiralling orange flame lance', needs_prompt: true });
  } finally {
    await wipeFxDesc();
  }
});

test('a re-queue that drops a kept box job cancels it on the box', { skip }, async () => {
  await clean();
  const { app, cancels } = appWith();
  await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'bolt_storm' }] });
  await pool.query("UPDATE effect_sprite_jobs SET box_job_id = 'box-old' WHERE subject_name = 'bolt_storm'");
  const r = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'bolt_storm', frames: 10 }] });
  assert.equal(r.status, 202);
  for (let i = 0; i < 100 && cancels.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].boxJobId, 'box-old');
  assert.equal(cancels[0].source, 'options-changed');
  const { rows: [j] } = await pool.query("SELECT box_job_id, frames FROM effect_sprite_jobs WHERE subject_name = 'bolt_storm'");
  assert.deepEqual(j, { box_job_id: null, frames: 10 });
});

// Review Focus 3: an effect renamed or deleted in the Attack tab while it has a job.
test('GET / still lists a job whose effect row is gone, as missing', { skip }, async () => {
  await clean();
  await pool.query(`DELETE FROM vfx_effects WHERE name = 'sx_fx_gone_row'`);
  await pool.query(`INSERT INTO vfx_effects (name, shape, color) VALUES ('sx_fx_gone_row', 'arc', '#ffffff')`);
  const { app } = appWith();
  try {
    const q = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'sx_fx_gone_row' }] });
    assert.equal(q.status, 202);
    assert.equal(q.body.queued.length, 1);
    const queued = (await request(app).get('/fx')).body.subjects.find((s) => s.name === 'sx_fx_gone_row');
    assert.deepEqual({ kind: queued.kind, default_frames: queued.default_frames, default_loop: queued.default_loop, group: queued.group, missing: queued.missing },
      { kind: 'beam', default_frames: 6, default_loop: false, group: 'Not used yet', missing: false });
    await pool.query(`DELETE FROM vfx_effects WHERE name = 'sx_fx_gone_row'`);
    const r = await request(app).get('/fx');
    assert.equal(r.status, 200);
    const gone = r.body.subjects.filter((s) => s.name === 'sx_fx_gone_row');
    assert.equal(gone.length, 1);
    assert.equal(gone[0].missing, true);
    assert.equal(gone[0].sprite, null);
    assert.equal(gone[0].job.status, 'queued');
    assert.equal(gone[0].kind, 'beam');
    // Re-queueing it is refused: the effect no longer exists.
    const again = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'sx_fx_gone_row' }] });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'sx_fx_gone_row is not an effect');
  } finally {
    await pool.query(`DELETE FROM vfx_effects WHERE name = 'sx_fx_gone_row'`);
  }
});

async function withoutBuffRow(skillId, fn) {
  const { rows: [before] } = await pool.query('SELECT * FROM buff_visuals WHERE skill_id = $1', [skillId]);
  await pool.query('DELETE FROM buff_visuals WHERE skill_id = $1', [skillId]);
  try {
    return await fn();
  } finally {
    await pool.query('DELETE FROM buff_visuals WHERE skill_id = $1', [skillId]);
    if (before) {
      const cols = Object.keys(before);
      await pool.query(`INSERT INTO buff_visuals (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map((c) => before[c]));
    }
  }
}

test('GET / lists the visual buffs with their default prompts; approving a buff job shows its sprite', { skip }, async () => {
  await clean();
  const restore = await snapshotAll(pool, [
    ['buff_visuals', "skill_id = 'war_shield_wall'"],
    ['art_prompt_descriptions', "subject_kind = 'buff' AND subject_key IN ('war_shield_wall','mag_immolation_aura')"],
  ]);
  try {
    // Start from a sprite-less Shield Wall with template prompts (both restored in finally).
    await pool.query("DELETE FROM art_prompt_descriptions WHERE subject_kind = 'buff' AND subject_key IN ('war_shield_wall','mag_immolation_aura')");
    await pool.query("UPDATE buff_visuals SET sprite_image = NULL, sprite_frames = 1, sprite_fps = NULL WHERE skill_id = 'war_shield_wall'");
    const { app } = appWith();
    const g = await request(app).get('/fx');
    const buffs = g.body.subjects.filter((s) => s.subject_kind === 'buff');
    assert.equal(buffs.length, VISUAL_BUFF_IDS.length);
    const sw = buffs.find((s) => s.name === 'war_shield_wall');
    assert.deepEqual(
      { group: sw.group, kind: sw.kind, color: sw.color, default_prompt: sw.default_prompt, prompt: sw.prompt, prompt_source: sw.prompt_source,
        prompt_kind: sw.prompt_kind, prompt_key: sw.prompt_key, default_frames: sw.default_frames, default_loop: sw.default_loop,
        missing: sw.missing, sprite: sw.sprite },
      { group: 'Buff auras', kind: 'aura', color: '#3b82f6', default_prompt: 'Shield Wall, blue, shell around a figure',
        prompt: 'Shield Wall, blue, shell around a figure', prompt_source: 'template',
        prompt_kind: 'buff', prompt_key: 'war_shield_wall', default_frames: 8, default_loop: true, missing: false, sprite: null });
    assert.equal(buffs.find((s) => s.name === 'mag_immolation_aura').default_prompt, 'Immolation Aura, orange, seen from above');
    // The Sprite tab reads placement off the subject (effectRows); vfx/aura subjects carry null.
    assert.equal(sw.placement, 'body');
    assert.equal(buffs.find((s) => s.name === 'mag_immolation_aura').placement, 'ground');
    assert.equal(g.body.subjects.find((s) => s.name === 'shade_veil').placement, null);
    assert.equal(g.body.subjects.find((s) => s.name === 'bolt_fire').placement, null);

    const q = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'buff', name: 'war_shield_wall' }] });
    assert.equal(q.status, 202);
    const id = q.body.queued[0].id;
    await pool.query(`UPDATE effect_sprite_jobs SET status='done', image_key='fx/sw.png', atlas='{"frames":8,"fps_hint":12}'::jsonb WHERE id=$1`, [id]);
    const cand = (await request(app).get('/fx')).body.subjects.find((x) => x.subject_kind === 'buff' && x.name === 'war_shield_wall');
    assert.deepEqual(cand.job.play, { frames: 8, loop: true, fps: 12 });
    const ok = await request(app).post(`/fx/jobs/${id}/approve`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { subject_kind: 'buff', name: 'war_shield_wall',
      sprite: { image: 'fx/sw.png', frames: 8, additive: true, loop: null, fps: 12, stretch: null } });
    const after = (await request(app).get('/fx')).body.subjects.find((x) => x.subject_kind === 'buff' && x.name === 'war_shield_wall');
    assert.equal(after.sprite.image, 'fx/sw.png');
    assert.equal(after.job.status, 'approved');
  } finally {
    await restore();
  }
});

test('a visual buff with no buff_visuals row is listed (not missing) and POST /jobs takes it; a form is not an effect', { skip }, async () => {
  await clean();
  await withoutBuffRow('mag_haste', async () => {
    const { app } = appWith();
    const h = (await request(app).get('/fx')).body.subjects.find((x) => x.subject_kind === 'buff' && x.name === 'mag_haste');
    assert.equal(h.missing, false);
    assert.equal(h.color, '#facc15');
    assert.equal((await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'buff', name: 'mag_haste' }] })).status, 202);
    assert.equal((await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'buff', name: 'dru_bear_form' }] })).status, 400);
  });
});
