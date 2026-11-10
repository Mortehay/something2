const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const jobs = require('../src/services/effectSpriteJobs.js');
const { createEffectDispatcher } = require('../src/services/effectDispatcher.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const LOCK = 8472001;

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

const PROVIDER = { id: 1, base_url: 'http://box.test:8001/' };
function png(w, h, pad = 0) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

// A scripted box: statuses[id] is consumed one poll at a time; the last entry repeats.
function fakeBox({ script = ['done'], sheet = png(384, 96), atlas = { frames: 4, pivot: [0, 48], cell: [96, 96] }, submit } = {}) {
  const box = { created: [], active: new Set(), maxActive: 0, polls: [], n: 0 };
  const left = new Map();
  box.createVfxJob = async (_p, body) => {
    if (submit) { const r = submit(body); if (r) return r; }
    box.created.push(body);
    const id = `box-${++box.n}`;
    box.active.add(id); box.maxActive = Math.max(box.maxActive, box.active.size);
    left.set(id, [...script]);
    return { ok: true, boxJobId: id };
  };
  box.getSheetJob = async (_p, id) => {
    const q = left.get(id);
    const s = q.length > 1 ? q.shift() : q[0];
    box.polls.push(s);
    if (s === 'unreachable') return { ok: false, error: 'could not reach box', retryable: true, unreachable: true };
    if (s === 'missing') { box.active.delete(id); return { ok: true, job: { status: 'missing' } }; }
    if (s === 'done' || s === 'failed') box.active.delete(id);
    return { ok: true, job: { status: s, error: s === 'failed' ? 'box oom' : null } };
  };
  box.fetchSheet = async () => ({ ok: true, png: sheet });
  box.fetchAtlas = async () => ({ ok: true, atlas });
  return box;
}
function fakeStore() {
  const objects = new Map();
  return { objects, putObject: async (k, b, t) => { objects.set(k, { b, t }); } };
}
function make(box, store, over = {}) {
  return createEffectDispatcher({ db: pool, box, loadProvider: async () => PROVIDER, store, pollMs: 1, sleep: async () => {}, ...over });
}
const rows = async () => (await pool.query('SELECT * FROM effect_sprite_jobs ORDER BY id')).rows;
const T = (name) => ({ subject_kind: 'vfx', name, prompt: `${name}, red` });

test('dispatcher happy path: one createVfxJob with kind and blend, row done, PNG stored', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  const box = fakeBox({ script: ['queued', 'running', 'done'] });
  const store = fakeStore();
  await make(box, store).kick();
  assert.equal(box.created.length, 1);
  assert.equal(box.created[0].kind, 'projectile');
  assert.equal(box.created[0].blend, 'additive');
  const [r] = await rows();
  assert.equal(r.status, 'done');
  assert.match(r.image_key, /^vfx\/[0-9a-f-]{36}\.png$/);
  assert.equal(r.box_job_id, 'box-1');
  const o = store.objects.get(r.image_key);
  assert.ok(o.b.equals(png(384, 96)));
  assert.equal(o.t, 'image/png');
  assert.deepEqual(r.atlas.pivot, [0, 48]);
});

test('sheet_seconds counts from first-seen running, not from submit', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  const box = fakeBox({ script: ['queued', 'queued', 'queued', 'running', 'done'] });
  // The clock is the real one (running_since is stamped by the database), scaled down:
  // 3 queued polls take 0.4 s each, the running poll 1.5 s.
  let polls = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, (polls++ < 3 ? 400 : 1500)));
  await make(box, fakeStore(), { sleep }).kick();
  const [r] = await rows();
  assert.equal(r.status, 'done');
  assert.equal(r.sheet_seconds, 2, 'running->done is ~1.5 s; submit->done would be ~2.7 s');
});

test('dispatcher sends one job at a time', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire'), T('bolt_ice'), T('bolt_storm')]);
  const box = fakeBox({ script: ['queued', 'running', 'done'] });
  await make(box, fakeStore()).kick();
  assert.equal(box.created.length, 3);
  assert.equal(box.maxActive, 1);
  assert.deepEqual((await rows()).map((r) => r.status), ['done', 'done', 'done']);
});

test('box 422 -> failed with the box detail', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  const box = fakeBox({ submit: () => ({ ok: false, refused: true, error: 'frames: must be <= 16' }) });
  await make(box, fakeStore()).kick();
  const [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'frames: must be <= 16');
});

test('box job vanishes (404) -> failed GPU box lost the job', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  await make(fakeBox({ script: ['running', 'missing'] }), fakeStore()).kick();
  const [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'GPU box lost the job');
});

test('box failed -> failed with the box text; timeout message uses the configured timeoutMs', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  await make(fakeBox({ script: ['failed'] }), fakeStore()).kick();
  assert.equal((await rows())[0].error, 'box oom');
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  let t = 0;
  await make(fakeBox({ script: ['running'] }), fakeStore(), { timeoutMs: 120000, now: () => (t += 70000) }).kick();
  const [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'timed out after 2 min');
});

test('queued on the box past the drawing timeout, then running, then done -> succeeds', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  let t = 0;
  const box = fakeBox({ script: ['queued', 'queued', 'queued', 'running', 'done'] });
  await make(box, fakeStore(), { timeoutMs: 120000, queueCapMs: 10 * 3600000, now: () => (t += 70000) }).kick();
  const [r] = await rows();
  assert.equal(r.status, 'done', r.error);
});

test('running past the drawing timeout after a queue wait -> timed out after the real minutes', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  let t = 0;
  await make(fakeBox({ script: ['queued', 'queued', 'running'] }), fakeStore(), { timeoutMs: 120000, queueCapMs: 10 * 3600000, now: () => (t += 70000) }).kick();
  const [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'timed out after 2 min');
});

test('queued past the queue cap -> failed with the queue message', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  let t = 0;
  await make(fakeBox({ script: ['queued'] }), fakeStore(), { timeoutMs: 120000, queueCapMs: 300000, now: () => (t += 70000) }).kick();
  const [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'waited 5 min in the box queue');
});

test('oversize PNG (700 KB) -> failed with the 600 KB message', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  const store = fakeStore();
  await make(fakeBox({ sheet: png(384, 96, 700 * 1024) }), store).kick();
  const [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.match(r.error, /600 KB or smaller/);
  assert.equal(store.objects.size, 0);
});

test('frame count that does not divide the width -> failed, nothing stored', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  const store = fakeStore();
  await make(fakeBox({ sheet: png(385, 96) }), store).kick();
  assert.equal((await rows())[0].status, 'failed');
  assert.equal(store.objects.size, 0);
});

test('box unreachable -> row back to queued, draining stops, nothing failed', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire'), T('bolt_ice')]);
  const box = fakeBox({ script: ['running', 'unreachable'] });
  await make(box, fakeStore()).kick();
  const rs = await rows();
  assert.deepEqual(rs.map((r) => r.status), ['queued', 'queued']);
  assert.equal(rs[0].box_job_id, 'box-1', 'the box job is kept so a later kick resumes it');
  assert.equal(box.created.length, 1, 'second row was never submitted');
  // box back: the same box job is resumed, not resubmitted
  const box2 = fakeBox({ script: ['done'] });
  box2.n = 1; // box-1 is the job the first box already holds
  box2.getSheetJob = ((orig) => async (p, id) => (id === 'box-1' ? { ok: true, job: { status: 'done' } } : orig(p, id)))(box2.getSheetJob);
  await make(box2, fakeStore()).kick();
  const after = await rows();
  assert.deepEqual(after.map((r) => r.status), ['done', 'done']);
  assert.equal(box2.created.length, 1, 'only the second row was submitted');
});

test('a restart leaves a running row; kick re-attaches it without a second job', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  const a = await jobs.claimNext(pool);
  await jobs.setBoxJob(pool, a.id, 'box-prev');
  const box = fakeBox({ script: ['done'] });
  const d = make(box, fakeStore());
  assert.equal(await d.resumeInterrupted(), 1);
  box.getSheetJob = async (p, id) => { assert.equal(id, 'box-prev'); return { ok: true, job: { status: 'done' } }; };
  await d.kick();
  assert.equal(box.created.length, 0);
  assert.equal((await rows())[0].status, 'done');
});

test('kick leaves another instance\'s running row alone; resumeEffectsOnBoot is opt-in', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  await jobs.claimNext(pool);
  const box = fakeBox();
  const d = make(box, fakeStore());
  await d.kick();
  assert.equal(box.created.length, 0);
  assert.equal((await rows())[0].status, 'running');
  const { resumeEffectsOnBoot } = require('../src/services/effectDispatcher.js');
  assert.equal(await resumeEffectsOnBoot({ dispatcher: d, env: {} }), 0);
  assert.equal((await rows())[0].status, 'running');
  assert.equal(await resumeEffectsOnBoot({ dispatcher: d, env: { EFFECT_RESUME_ON_BOOT: 'true' } }), 1);
  assert.equal((await rows())[0].status, 'queued');
});

test('retryable submit error requeues and stops; non-retryable submit error fails', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire'), T('bolt_ice')]);
  const box = fakeBox({ submit: () => ({ ok: false, retryable: true, status: 503, error: 'vram_busy' }) });
  await make(box, fakeStore()).kick();
  assert.deepEqual((await rows()).map((r) => r.status), ['queued', 'queued']);
  assert.equal(box.created.length, 0);
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  await make(fakeBox({ submit: () => ({ ok: false, retryable: false, status: 400, error: 'bad request' }) }), fakeStore()).kick();
  const [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'bad request');
});

test('no provider: rows stay queued and kick resolves', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  const box = fakeBox();
  await make(box, fakeStore(), { loadProvider: async () => null }).kick();
  assert.equal((await rows())[0].status, 'queued');
  assert.equal(box.created.length, 0);
});

test('the creature queue is untouched', { skip }, async () => {
  await clean();
  // Whole-table, all-column snapshot of what is already there; no row is inserted, so a parallel
  // creature test can neither claim ours nor change ours.
  const snap = async () => (await pool.query('SELECT * FROM sprite_sets ORDER BY id')).rows;
  const before = await snap();
  await jobs.enqueue(pool, [T('bolt_fire'), T('bolt_ice')]);
  await make(fakeBox({ script: ['running', 'done'] }), fakeStore()).kick();
  assert.equal((await rows()).filter((r) => r.status === 'done').length, 2);
  assert.deepEqual(await snap(), before);
});

test('a strip that is not one row of frames -> failed with the size in the message, nothing stored', { skip }, async () => {
  // atlas cell 96x96 but the PNG is two rows tall (2 x 2 sheet laid out as 192x192)
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  let store = fakeStore();
  await make(fakeBox({ sheet: png(384, 192) }), store).kick();
  let [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.match(r.error, /384x192.*atlas cell is 96x96.*one row/);
  assert.equal(store.objects.size, 0);

  // no cell in the atlas: 4 frames of 96 px, 4 rows of 96 px would still pass the 4x guard, so 5 rows does not
  await clean();
  await jobs.enqueue(pool, [T('bolt_fire')]);
  store = fakeStore();
  await make(fakeBox({ sheet: png(384, 480), atlas: { frames: 4, pivot: { x: 0, y: 0.5 } } }), store).kick();
  [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.match(r.error, /384x480 for 4 frames.*taller than one row/);
  assert.equal(store.objects.size, 0);
});

test('verbatim deployed beam atlas ({w,h} cell 192x48) with a 1536x48 strip is done', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [T('arcane_beam')]);
  const atlas = JSON.parse(require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'fixtures', 'box-vfx-atlas', 'beam_arcane_beam.json'), 'utf8'));
  const store = fakeStore();
  await make(fakeBox({ sheet: png(1536, 48), atlas }), store).kick();
  const [r] = await rows();
  assert.equal(r.status, 'done', r.error);
  assert.equal(store.objects.size, 1);
});

// spritePrompts fake: regeneratePrompt answers from `answer`; records subject loads and calls.
function fakePrompts({ answer = (key) => ({ text: `new ${key}` }), events = null } = {}) {
  const calls = { regenerate: [], subjects: [] };
  return {
    calls,
    describerSubjects: async (_db, kind) => { calls.subjects.push(kind); return new Map([['bolt_fire', { kind, key: 'bolt_fire' }], ['bolt_ice', { kind, key: 'bolt_ice' }]]); },
    regeneratePrompt: async (_db, kind, key, opts) => {
      calls.regenerate.push({ kind, key, opts });
      if (events) events.push(`regenerate:${key}`);
      const a = answer(key);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

test('prompt phase writes every pending effect prompt before the first box job', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [{ ...T('bolt_fire'), needsPrompt: true }, T('bolt_storm'), { ...T('bolt_ice'), needsPrompt: true }]);
  const events = [];
  const box = fakeBox({ script: ['done'] });
  const created = box.createVfxJob;
  box.createVfxJob = async (p, b) => { events.push(`box:${b.prompt}`); return created(p, b); };
  const prompts = fakePrompts({ events });
  await make(box, fakeStore(), { prompts, describer: {} }).kick();
  assert.deepEqual(events.slice(0, 2), ['regenerate:bolt_fire', 'regenerate:bolt_ice']);
  assert.equal(events.length, 5);
  assert.deepEqual(prompts.calls.subjects, ['vfx'], 'subjects loaded once per kind');
  assert.equal(prompts.calls.regenerate[0].opts.subject.key, 'bolt_fire');
  assert.deepEqual((await rows()).map((r) => r.status), ['done', 'done', 'done']);
});

test('a written prompt is what the box receives', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [{ ...T('bolt_fire'), needsPrompt: true }]);
  const box = fakeBox({ script: ['done'] });
  await make(box, fakeStore(), { prompts: fakePrompts({ answer: () => ({ text: 'new vfx' }) }), describer: {} }).kick();
  assert.equal(box.created[0].prompt, 'new vfx');
  assert.equal((await rows())[0].prompt, 'new vfx');
});

test('text model busy past the limit fails the job "text model busy" and creates no box job; the rest fail without fresh waits', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [{ ...T('bolt_fire'), needsPrompt: true }, { ...T('bolt_ice'), needsPrompt: true }]);
  const old = process.env.ART_MAX_HELD_WAITS;
  process.env.ART_MAX_HELD_WAITS = '1';
  try {
    const box = fakeBox({ script: ['done'] });
    const prompts = fakePrompts({ answer: () => Object.assign(new Error('gpu busy'), { busy: true }) });
    let t = 0;
    await make(box, fakeStore(), { prompts, describer: {}, now: () => t, sleep: async (ms) => { t += ms; }, queueCapMs: 10 * 60 * 1000 }).kick();
    assert.equal(box.created.length, 0);
    const rs = await rows();
    assert.deepEqual(rs.map((r) => r.status), ['failed', 'failed']);
    assert.match(rs[0].error, /text model busy/);
    assert.equal(rs[1].error, rs[0].error);
    assert.ok(prompts.calls.regenerate.length > 2, 'the first job waits out the whole cap, past ART_MAX_HELD_WAITS');
    assert.equal(prompts.calls.regenerate.filter((c) => c.key === 'bolt_ice').length, 0, 'the second job fails with the same reason, no fresh waits');
  } finally {
    if (old === undefined) delete process.env.ART_MAX_HELD_WAITS; else process.env.ART_MAX_HELD_WAITS = old;
  }
});

// 2026-11-10 live: two buff prompt rewrites failed "text model busy after 3 waits" while the box
// drew a ~37 min creature sheet. The wait is now bounded by the queue cap, so the rewrite
// outlasts the sheet (the creature batch pauses for queued effects between sheets).
test('a prompt rewrite outlasts a long busy spell (more busy answers than ART_MAX_HELD_WAITS) and is then drawn', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [{ ...T('bolt_fire'), needsPrompt: true }]);
  const old = process.env.ART_MAX_HELD_WAITS;
  process.env.ART_MAX_HELD_WAITS = '1';
  try {
    const box = fakeBox({ script: ['done'] });
    let n = 0;
    const prompts = fakePrompts({ answer: () => (n++ < 6 ? Object.assign(new Error('a sheet job has been running'), { busy: true }) : { text: 'rewritten' }) });
    let t = 0;
    await make(box, fakeStore(), { prompts, describer: {}, now: () => t, sleep: async (ms) => { t += ms; } }).kick();
    const [r] = await rows();
    assert.equal(r.status, 'done', r.error);
    assert.equal(box.created[0].prompt, 'rewritten');
    assert.equal(prompts.calls.regenerate.length, 7);
  } finally {
    if (old === undefined) delete process.env.ART_MAX_HELD_WAITS; else process.env.ART_MAX_HELD_WAITS = old;
  }
});

test('a prompt job already queued longer than the cap fails at its first busy answer, without waiting', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [{ ...T('bolt_fire'), needsPrompt: true }]);
  await pool.query("UPDATE effect_sprite_jobs SET created_at = now() - interval '5 hours'");
  const box = fakeBox({ script: ['done'] });
  const prompts = fakePrompts({ answer: () => Object.assign(new Error('a sheet job has been running'), { busy: true }) });
  const sleeps = [];
  let t = 0;
  await make(box, fakeStore(), { prompts, describer: {}, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } }).kick();
  const [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.match(r.error, /text model busy/);
  assert.equal(box.created.length, 0);
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 0, 'no waiting past the cap');
});

// Final review M2: a job re-queued in place with an explicit prompt during the
// phase's busy wait no longer waits for its prompt and must not be failed.
test('a job re-queued with an explicit prompt during a busy wait is drawn with it, not failed', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [{ ...T('bolt_fire'), needsPrompt: true }]);
  const old = process.env.ART_MAX_HELD_WAITS;
  process.env.ART_MAX_HELD_WAITS = '1';
  try {
    const box = fakeBox({ script: ['done'] });
    const prompts = fakePrompts({ answer: () => Object.assign(new Error('gpu busy'), { busy: true }) });
    let t = 0;
    const sleep = async (ms) => { t += ms; await jobs.enqueue(pool, [{ ...T('bolt_fire'), prompt: 'typed by hand' }]); };
    await make(box, fakeStore(), { prompts, describer: {}, sleep, now: () => t, queueCapMs: 10 * 60 * 1000 }).kick();
    const [r] = await rows();
    assert.equal(r.status, 'done', r.error);
    assert.equal(box.created[0].prompt, 'typed by hand');
  } finally {
    if (old === undefined) delete process.env.ART_MAX_HELD_WAITS; else process.env.ART_MAX_HELD_WAITS = old;
  }
});

// Final review M3: a unique violation from the description write (a per-row
// Regenerate at the same moment) fails the job readably.
test('a unique violation from the prompt write fails the job "prompt changed concurrently — queue again"', { skip }, async () => {
  await clean();
  await jobs.enqueue(pool, [{ ...T('bolt_fire'), needsPrompt: true }]);
  const box = fakeBox({ script: ['done'] });
  const dup = Object.assign(new Error('duplicate key value violates unique constraint "art_prompt_descriptions_one_active"'), { code: '23505' });
  await make(box, fakeStore(), { prompts: fakePrompts({ answer: () => dup }), describer: {} }).kick();
  const [r] = await rows();
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'prompt changed concurrently — queue again');
  assert.equal(box.created.length, 0);
});
