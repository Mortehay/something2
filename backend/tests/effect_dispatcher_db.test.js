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
