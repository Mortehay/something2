const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const fx = require('../src/services/effectSprites.js');
const jobs = require('../src/services/effectSpriteJobs.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const LOCK = 8472001; // both effect test files share one queue table; take turns

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
const clean = () => pool.query('DELETE FROM effect_sprite_jobs');
const T = (name, subject_kind = 'vfx') => ({ subject_kind, name, prompt: `${name}, red` });

test('enqueue fills kind/frames/blend from the batch-1 list and the box-measured warm predicted_seconds (35 for every kind)', { skip }, async () => {
  await clean();
  const r = await jobs.enqueue(pool, [T('bolt_fire'), T('curse_blast'), T('shade_veil', 'aura')], { seed: () => 5 });
  assert.equal(r.skipped.length, 0);
  const by = Object.fromEntries(r.queued.map((j) => [j.subject_name, j]));
  assert.equal(by.bolt_fire.kind, 'projectile');
  assert.equal(by.bolt_fire.frames, 8);
  assert.equal(by.bolt_fire.size, 96);
  assert.equal(by.bolt_fire.loop, true);
  assert.equal(by.bolt_fire.blend, 'additive');
  assert.equal(by.curse_blast.kind, 'burst');
  assert.equal(by.curse_blast.blend, 'alpha');
  assert.equal(by.shade_veil.kind, 'aura');
  assert.equal(by.shade_veil.frames, 8);
  assert.equal(by.bolt_fire.predicted_seconds, 35);
  assert.equal(by.curse_blast.predicted_seconds, 35);
  assert.equal(by.shade_veil.predicted_seconds, 35);
  assert.equal(by.bolt_fire.status, 'queued');
  assert.equal(String(by.bolt_fire.seed), '5');
});

test('enqueue twice for one subject: the second is skipped already queued', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_ice')]);
  const r = await jobs.enqueue(pool, [T('bolt_ice'), T('bolt_storm')]);
  assert.deepEqual(r.skipped, [{ subject_kind: 'vfx', name: 'bolt_ice', reason: 'already queued' }]);
  assert.deepEqual(r.queued.map((j) => j.subject_name), ['bolt_storm']);
});

test('measuredSeconds ignores failed rows and returns null under 3 samples', { skip }, async () => {
  await clean();
  const add = (status, secs, i) => pool.query(
    `INSERT INTO effect_sprite_jobs (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed, status, sheet_seconds, finished_at)
     VALUES ('vfx', $1, 'p', 'burst', 6, 128, false, 'additive', 1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    [`s${i}`, status, secs, String(i)]);
  await add('done', 40, 1); await add('approved', 60, 2); await add('failed', 999, 3); await add('done', null, 4);
  assert.equal(await jobs.measuredSeconds(pool, 'burst'), null);
  await add('done', 50, 5);
  assert.equal(await jobs.measuredSeconds(pool, 'burst'), 50);
  assert.equal(await jobs.measuredSeconds(pool, 'beam'), null);
  const r = await jobs.enqueue(pool, [T('spark_hit')]);
  assert.equal(r.queued[0].predicted_seconds, 50);
});

test('claimNext takes the oldest queued row once; markDone keeps NULL sheet_seconds when never seen running', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_ice'), T('bolt_storm')]);
  const a = await jobs.claimNext(pool);
  const b = await jobs.claimNext(pool);
  assert.equal(a.subject_name, 'bolt_ice');
  assert.equal(a.status, 'running');
  assert.equal(b.subject_name, 'bolt_storm');
  assert.equal(await jobs.claimNext(pool), null);
  await jobs.markDone(pool, a.id, { imageKey: 'vfx/x.png', atlas: { frames: 4 } });
  const { rows: [r] } = await pool.query('SELECT * FROM effect_sprite_jobs WHERE id = $1', [a.id]);
  assert.equal(r.status, 'done');
  assert.equal(r.sheet_seconds, null);
  assert.ok(r.finished_at);
});

test('requeue keeps the box job id; latestBySubject returns the newest per subject', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_ice')]);
  const a = await jobs.claimNext(pool);
  await jobs.setBoxJob(pool, a.id, 'box-1');
  await jobs.requeue(pool, a.id);
  const { rows: [r] } = await pool.query('SELECT status, box_job_id FROM effect_sprite_jobs WHERE id = $1', [a.id]);
  assert.deepEqual(r, { status: 'queued', box_job_id: 'box-1' });
  await jobs.fail(pool, a.id, 'nope');
  await jobs.enqueue(pool, [T('bolt_ice')]);
  const m = await jobs.latestBySubject(pool);
  assert.equal(m.get('vfx|bolt_ice').status, 'queued');
  assert.equal(m.size, 1);
});

// --- approve ---
async function beamJob(name, status, atlas, imageKey = 'vfx/a.png') {
  const { rows: [j] } = await pool.query(
    `INSERT INTO effect_sprite_jobs (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed, status, image_key, atlas)
     VALUES ('vfx', $1, 'p', 'beam', 4, 96, true, 'additive', 1, $2, $3, $4) RETURNING *`,
    [name, status, imageKey, JSON.stringify(atlas)]);
  return j;
}
async function vfxRow(name) {
  await pool.query(`DELETE FROM vfx_effects WHERE name = $1`, [name]);
  await pool.query(`INSERT INTO vfx_effects (name, shape, color) VALUES ($1, 'bolt', '#ffffff')`, [name]);
}

test('approve copies the atlas facts into vfx_effects and marks the job approved', { skip }, async () => {
  await clean(); await vfxRow('sx_fx_beam');
  const j = await beamJob('sx_fx_beam', 'done', { frames: 4, fps_hint: 14, loop: true, blend: 'additive', pivot: [0, 48], cell: [96, 96] });
  const r = await jobs.approve(pool, j.id);
  assert.equal(r.name, 'sx_fx_beam');
  const { rows: [v] } = await pool.query('SELECT * FROM vfx_effects WHERE name = $1', ['sx_fx_beam']);
  assert.equal(v.sprite_stretch, true);
  assert.equal(v.sprite_loop, true);
  assert.equal(v.sprite_fps, 14);
  assert.equal(v.sprite_image, 'vfx/a.png');
  assert.equal(v.sprite_frames, 4);
  assert.equal(v.sprite_additive, true);
  const { rows: [jr] } = await pool.query('SELECT status FROM effect_sprite_jobs WHERE id = $1', [j.id]);
  assert.equal(jr.status, 'approved');
  await pool.query(`DELETE FROM vfx_effects WHERE name = 'sx_fx_beam'`);
});

test('approve refuses a projectile whose atlas pivot is the centre (409) and changes nothing', { skip }, async () => {
  await clean(); await vfxRow('sx_fx_beam');
  const j = await beamJob('sx_fx_beam', 'done', { frames: 4, pivot: [48, 48], cell: [96, 96] });
  await pool.query(`UPDATE effect_sprite_jobs SET kind = 'projectile' WHERE id = $1`, [j.id]);
  await assert.rejects(() => jobs.approve(pool, j.id), (e) => e.status === 409 && /tail/.test(e.message));
  const { rows: [v] } = await pool.query(`SELECT sprite_image FROM vfx_effects WHERE name = 'sx_fx_beam'`);
  assert.equal(v.sprite_image, null);
  const { rows: [jr] } = await pool.query('SELECT status FROM effect_sprite_jobs WHERE id = $1', [j.id]);
  assert.equal(jr.status, 'done');
  await pool.query(`DELETE FROM vfx_effects WHERE name = 'sx_fx_beam'`);
});

test('approve 409s on a job that is not done, 404s when the subject row is gone', { skip }, async () => {
  await clean(); await pool.query(`DELETE FROM vfx_effects WHERE name = 'sx_fx_gone'`);
  const q = await beamJob('sx_fx_gone', 'failed', { frames: 4 });
  await assert.rejects(() => jobs.approve(pool, q.id), (e) => e.status === 409);
  await pool.query(`UPDATE effect_sprite_jobs SET status = 'done' WHERE id = $1`, [q.id]);
  await assert.rejects(() => jobs.approve(pool, q.id), (e) => e.status === 404);
});

test('approving a second job sets the first back to done', { skip }, async () => {
  await clean(); await vfxRow('sx_fx_beam');
  const atlas = { frames: 4, pivot: [0, 48], cell: [96, 96] };
  const a = await beamJob('sx_fx_beam', 'done', atlas, 'vfx/a.png');
  const b = await beamJob('sx_fx_beam', 'done', atlas, 'vfx/b.png');
  await jobs.approve(pool, a.id);
  await jobs.approve(pool, b.id);
  const { rows } = await pool.query('SELECT id, status FROM effect_sprite_jobs ORDER BY id');
  assert.deepEqual(rows.map((r) => r.status), ['done', 'approved']);
  const { rows: [v] } = await pool.query(`SELECT sprite_image FROM vfx_effects WHERE name = 'sx_fx_beam'`);
  assert.equal(v.sprite_image, 'vfx/b.png');
  await pool.query(`DELETE FROM vfx_effects WHERE name = 'sx_fx_beam'`);
});

test('approve accepts the deployed box beam atlas verbatim ({w,h} cell, normalised tail pivot)', { skip }, async () => {
  await clean(); await vfxRow('sx_fx_beam');
  const atlas = JSON.parse(require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'fixtures', 'box-vfx-atlas', 'beam_arcane_beam.json'), 'utf8'));
  const j = await beamJob('sx_fx_beam', 'done', atlas);
  await jobs.approve(pool, j.id);
  const { rows: [v] } = await pool.query(
    'SELECT sprite_frames, sprite_fps, sprite_loop, sprite_stretch, sprite_additive FROM vfx_effects WHERE name = $1', ['sx_fx_beam']);
  assert.deepEqual(v, { sprite_frames: 8, sprite_fps: 12, sprite_loop: true, sprite_stretch: true, sprite_additive: true });
  await pool.query(`DELETE FROM vfx_effects WHERE name = 'sx_fx_beam'`);
});

test('enqueue stores frames/loop overrides and needs_prompt; boxRequestFor sends the stored values', { skip }, async () => {
  await clean();
  const r = await jobs.enqueue(pool, [
    { ...T('bolt_fire'), frames: 12, loop: false, needsPrompt: true },
    { ...T('shade_veil', 'aura'), frames: 5, loop: false },
    { ...T('spark_hit'), loop: true },
  ], { seed: () => 7 });
  const by = Object.fromEntries(r.queued.map((j) => [j.subject_name, j]));
  assert.equal(by.bolt_fire.frames, 12);
  assert.equal(by.bolt_fire.loop, false);
  assert.equal(by.bolt_fire.needs_prompt, true);
  assert.equal(by.shade_veil.frames, 5);
  assert.equal(by.shade_veil.loop, true, 'an aura always loops');
  assert.equal(by.spark_hit.loop, false, 'a burst never loops');
  assert.equal(by.spark_hit.needs_prompt, false);
  const req = fx.boxRequestFor(by.bolt_fire);
  assert.equal(req.frames, 12);
  assert.equal(req.loop, false);
});

test('claimNext skips a job whose prompt is pending; promptWritten releases it', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [{ ...T('bolt_ice'), needsPrompt: true }, T('bolt_storm')]);
  assert.equal((await jobs.claimNext(pool)).subject_name, 'bolt_storm');
  assert.equal(await jobs.claimNext(pool), null);
  const p = await jobs.nextPromptJob(pool);
  assert.equal(p.subject_name, 'bolt_ice');
  const w = await jobs.promptWritten(pool, p.id, 'fresh');
  assert.equal(w.prompt, 'fresh');
  assert.equal(w.needs_prompt, false);
  assert.equal(await jobs.promptWritten(pool, p.id, 'again'), null);
  assert.equal((await jobs.claimNext(pool)).subject_name, 'bolt_ice');
});

test('re-queue of a QUEUED job updates it in place; a running job is skipped', { skip }, async () => {
  await clean();
  const first = (await jobs.enqueue(pool, [T('bolt_fire')])).queued[0];
  const regen = await jobs.enqueue(pool, [{ subject_kind: 'vfx', name: 'bolt_fire', prompt: null, needsPrompt: true }]);
  assert.equal(regen.queued.length, 1);
  assert.equal(regen.queued[0].id, first.id);
  assert.equal(regen.queued[0].needs_prompt, true);
  assert.equal(regen.queued[0].prompt, first.prompt, 'prompt kept until the phase writes one');
  // pending regeneration survives a re-queue with no explicit prompt; frames update
  const f = await jobs.enqueue(pool, [{ subject_kind: 'vfx', name: 'bolt_fire', prompt: null, frames: 12 }]);
  assert.equal(f.queued[0].id, first.id);
  assert.equal(f.queued[0].frames, 12);
  assert.equal(f.queued[0].needs_prompt, true);
  // an explicit prompt replaces it and clears the pending regeneration
  const e = await jobs.enqueue(pool, [{ ...T('bolt_fire'), prompt: 'mine' }]);
  assert.equal(e.queued[0].prompt, 'mine');
  assert.equal(e.queued[0].needs_prompt, false);
  // unchanged re-queue is skipped
  assert.equal((await jobs.enqueue(pool, [{ ...T('bolt_fire'), prompt: 'mine' }])).skipped.length, 1);
  await jobs.claimNext(pool);
  const r = await jobs.enqueue(pool, [{ ...T('bolt_fire'), frames: 5 }]);
  assert.equal(r.queued.length, 0);
  assert.equal(r.skipped[0].reason, 'already queued');
});

test('re-queue that changes the drawing drops the kept box job; an unchanged one keeps it', { skip }, async () => {
  await clean();
  const first = (await jobs.enqueue(pool, [T('bolt_fire')])).queued[0];
  await pool.query(`UPDATE effect_sprite_jobs SET box_job_id = 'box-old', running_since = now() WHERE id = $1`, [first.id]);
  const same = await jobs.enqueue(pool, [T('bolt_fire')]);
  assert.equal(same.skipped.length, 1);
  assert.equal((await pool.query('SELECT box_job_id FROM effect_sprite_jobs WHERE id=$1', [first.id])).rows[0].box_job_id, 'box-old');
  const r = await jobs.enqueue(pool, [{ ...T('bolt_fire'), frames: 12 }]);
  assert.equal(r.queued[0].id, first.id);
  assert.equal(r.queued[0].box_job_id, null);
  assert.equal(r.queued[0].running_since, null);
  assert.equal(r.queued[0].dropped_box_job_id, 'box-old');
});
