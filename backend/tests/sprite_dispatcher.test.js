const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createDispatcher } = require('../src/services/spriteDispatcher.js');

const FX = path.join(__dirname, 'fixtures', 'gpuBox');
const WOLF_SHEET = fs.readFileSync(path.join(FX, 'wolf-sheet.png'));
const WOLF_ATLAS = JSON.parse(fs.readFileSync(path.join(FX, 'atlas-wolf.json'), 'utf8'));
const CONCEPT_PNG = Buffer.from('concept-bytes');
const DIRS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const PROVIDER = { id: 9, base_url: 'http://box.test:8001/', modality: 'sprite' };

function wolfRow(over = {}) {
  return {
    id: 'row-1', entity_type_id: 4, creature: 'Grey Wolf', generation_kind: 'creature',
    base_prompt: 'a grey wolf', seed: '7', actions: ['idle'], directions: DIRS,
    frames_per_action: 2, box_job_id: null, concept_key: null, ...over,
  };
}

// A queue fake over a fixed list of rows; records every write.
function fakeQueue(rows) {
  const pending = [...rows];
  const log = { claims: 0, attached: [], completed: [], failed: [] };
  return {
    log,
    claim: async () => { log.claims += 1; return pending.shift() || null; },
    attachBox: async (_db, id, info) => { log.attached.push({ id, ...info }); },
    complete: async (_db, id, result) => { log.completed.push({ id, result }); },
    fail: async (_db, id, err) => { log.failed.push({ id, message: err.message }); },
  };
}

function fakeStore() {
  const puts = [];
  return { puts, BUCKET: () => 'sprites', putObject: async (key, buf, type) => { puts.push({ key, buf, type }); } };
}

// A box fake. `statuses` is the sequence getSheetJob walks through (the last
// one repeats); everything else answers like the captured Wolf job.
function fakeBox({ statuses = [{ status: 'done' }], ...over } = {}) {
  const calls = { concept: [], create: [], get: [], sheet: 0, atlas: 0 };
  let i = 0;
  const box = {
    calls,
    generateConcept: async (provider, args) => {
      calls.concept.push({ provider, args });
      return { ok: true, conceptPath: 'images/core_abc.png', png: CONCEPT_PNG };
    },
    createSheetJob: async (provider, spec) => {
      calls.create.push({ provider, spec });
      return { ok: true, boxJobId: `box-${calls.create.length}`, cells: 16, estimatedSeconds: 888 };
    },
    getSheetJob: async (_p, id) => {
      calls.get.push(id);
      const s = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      if (s.ok === false) return s;
      return { ok: true, job: { progress: {}, error: null, ...s } };
    },
    fetchSheet: async () => { calls.sheet += 1; return { ok: true, png: WOLF_SHEET }; },
    fetchAtlas: async () => { calls.atlas += 1; return { ok: true, atlas: WOLF_ATLAS }; },
    ...over,
  };
  return box;
}

function dispatcherFor({ rows, box = fakeBox(), store = fakeStore(), provider = PROVIDER, ...opts }) {
  const queue = fakeQueue(rows);
  const d = createDispatcher({
    db: {}, queue, box, store, loadProvider: async () => provider, pollMs: 0, ...opts,
  });
  return { d, queue, box, store };
}

test('box job: concept, sheet, manifest stored under the row prefix', async () => {
  const { d, queue, box, store } = dispatcherFor({ rows: [wolfRow()] });

  await d.start();

  assert.deepEqual(queue.log.failed, []);
  const prefix = 'sprites/Grey_Wolf/row-1/';
  assert.deepEqual(store.puts.map((p) => [p.key, p.type]), [
    [`${prefix}concept.png`, 'image/png'],
    [`${prefix}sheet.png`, 'image/png'],
    [`${prefix}sheet.json`, 'application/json'],
  ]);
  assert.deepEqual(store.puts[0].buf, CONCEPT_PNG);
  assert.deepEqual(store.puts[1].buf, WOLF_SHEET);
  const manifest = JSON.parse(store.puts[2].buf.toString('utf8'));
  assert.equal(manifest.box_job_id, 'box-1');
  assert.equal(manifest.engine, 'Qwen-Image-Edit-2511 (GGUF)');
  assert.deepEqual(manifest.frames['idle/sw/1'], [48, 448, 48, 64]);

  assert.deepEqual(box.calls.concept.map((c) => c.args), [{ prompt: 'a grey wolf' }]);
  assert.equal(box.calls.concept[0].provider, PROVIDER);
  assert.deepEqual(box.calls.create[0].spec, {
    prompt: 'a grey wolf', concept_image: 'images/core_abc.png', actions: ['idle'], directions: DIRS,
    frames: 2, cell: '48x64', colors: 24, seed: 7, style_profile: null, concept_check: false,
  });
  assert.deepEqual(queue.log.attached, [{ id: 'row-1', boxJobId: 'box-1', conceptKey: `${prefix}concept.png`, providerId: 9 }]);

  assert.equal(queue.log.completed.length, 1);
  const { id, result } = queue.log.completed[0];
  assert.equal(id, 'row-1');
  assert.equal(result.atlas_key, `${prefix}sheet.png`);
  assert.equal(result.manifest_key, `${prefix}sheet.json`);
  assert.equal(result.concept_key, `${prefix}concept.png`);
  assert.equal(typeof result.sheet_seconds, 'number');
  assert.ok(result.sheet_seconds >= 0);
  assert.equal(d.status().completed, 1);
  assert.equal(d.status().running, false);
});

test('resumes an attached box job instead of resubmitting', async () => {
  const box = fakeBox({ statuses: [
    { status: 'running', progress: { pct: 40, message: 'cell 6/16' } },
    { status: 'running', progress: { pct: 60, message: 'cell 10/16' } },
    { status: 'done' },
  ] });
  const row = wolfRow({ box_job_id: 'box-old', concept_key: 'sprites/Grey_Wolf/row-1/concept.png' });
  const { d, queue, store } = dispatcherFor({ rows: [row], box });

  await d.start();

  assert.equal(box.calls.concept.length, 0);
  assert.equal(box.calls.create.length, 0);
  assert.deepEqual(queue.log.attached, []);
  assert.ok(box.calls.get.every((id) => id === 'box-old'));
  assert.deepEqual(store.puts.map((p) => p.key), ['sprites/Grey_Wolf/row-1/sheet.png', 'sprites/Grey_Wolf/row-1/sheet.json']);
  assert.equal(queue.log.completed[0].result.concept_key, 'sprites/Grey_Wolf/row-1/concept.png');
  assert.equal(JSON.parse(store.puts[1].buf).box_job_id, 'box-old');
});

for (const gone of ['missing', 'failed', 'cancelled']) {
  test(`resubmits when the attached box job is ${gone}`, async () => {
    const box = fakeBox({ statuses: [{ status: gone }, { status: 'done' }] });
    const { d, queue } = dispatcherFor({ rows: [wolfRow({ box_job_id: 'box-old' })], box });

    await d.start();

    assert.equal(box.calls.concept.length, 1);
    assert.equal(box.calls.create.length, 1);
    assert.deepEqual(queue.log.attached.map((a) => a.boxJobId), ['box-1']);
    assert.deepEqual(queue.log.failed, []);
    assert.equal(queue.log.completed.length, 1);
  });
}

test('box unreachable fails the row and keeps draining', async () => {
  let n = 0;
  const box = fakeBox({
    generateConcept: async () => {
      n += 1;
      if (n === 1) return { ok: false, retryable: true, error: 'could not reach http://box.test:8001/api/generate_core: ECONNREFUSED' };
      return { ok: true, conceptPath: 'images/core_abc.png', png: CONCEPT_PNG };
    },
  });
  const { d, queue } = dispatcherFor({ rows: [wolfRow(), wolfRow({ id: 'row-2' })], box });

  await d.start();

  assert.deepEqual(queue.log.failed, [{ id: 'row-1', message: 'could not reach http://box.test:8001/api/generate_core: ECONNREFUSED' }]);
  assert.deepEqual(queue.log.completed.map((c) => c.id), ['row-2']);
  assert.equal(d.status().failed, 1);
  assert.equal(d.status().completed, 1);
});

test('no active sprite provider fails the row with the settings hint', async () => {
  const { d, queue, box } = dispatcherFor({ rows: [wolfRow()], provider: null });

  await d.start();

  assert.deepEqual(queue.log.failed, [{
    id: 'row-1', message: 'no sprite provider configured — add one in Settings → AI Providers (modality Sprite)',
  }]);
  assert.equal(box.calls.concept.length, 0);
});

test('stalled box job fails as stalled', async () => {
  const box = fakeBox({ statuses: [{ status: 'running', progress: { pct: 30, message: 'cell 5/16', stage: 'actions-denoise' } }] });
  const { d, queue, store } = dispatcherFor({ rows: [wolfRow()], box, stallMs: 30 });

  await d.start();

  assert.equal(queue.log.failed.length, 1);
  assert.match(queue.log.failed[0].message, /^box stalled: no progress for \d+ min/);
  assert.equal(queue.log.completed.length, 0);
  assert.deepEqual(store.puts.map((p) => p.key), ['sprites/Grey_Wolf/row-1/concept.png']);
});

test('a box job that keeps progressing is not failed as stalled', async () => {
  let pct = 0;
  const box = fakeBox({
    getSheetJob: async () => {
      pct += 1;
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((r) => setTimeout(r, 2));
      return { ok: true, job: pct > 30 ? { status: 'done' } : { status: 'running', progress: { pct, message: `cell ${pct}` } } };
    },
  });
  const { d, queue } = dispatcherFor({ rows: [wolfRow()], box, stallMs: 20 });

  await d.start();

  assert.deepEqual(queue.log.failed, []);
  assert.equal(queue.log.completed.length, 1);
});

test('a box job that fails on the box fails the row with its words', async () => {
  const box = fakeBox({ statuses: [{ status: 'running' }, { status: 'failed', error: 'CUDA out of memory' }] });
  const { d, queue } = dispatcherFor({ rows: [wolfRow()], box });

  await d.start();

  assert.deepEqual(queue.log.failed, [{ id: 'row-1', message: 'box job failed: CUDA out of memory' }]);
});

test('manifest mismatch fails the row and stores nothing as done', async () => {
  // The box answers with an atlas for a different job shape (1 frame per action).
  const box = fakeBox({ fetchAtlas: async () => ({ ok: true, atlas: { ...WOLF_ATLAS, frames_per_action: 1 } }) });
  const { d, queue, store } = dispatcherFor({ rows: [wolfRow()], box });

  await d.start();

  assert.equal(queue.log.completed.length, 0);
  assert.equal(queue.log.failed.length, 1);
  assert.match(queue.log.failed[0].message, /frames per action/);
  assert.deepEqual(store.puts.map((p) => p.key), ['sprites/Grey_Wolf/row-1/concept.png']);
});

test('stop lets the current box job finish and claims nothing more', async () => {
  let d;
  let stopped = false;
  const box = fakeBox({
    getSheetJob: async () => {
      if (!stopped) { stopped = d.stop(); return { ok: true, job: { status: 'running', progress: { pct: 1 } } }; }
      return { ok: true, job: { status: 'done' } };
    },
  });
  const made = dispatcherFor({ rows: [wolfRow(), wolfRow({ id: 'row-2' })], box });
  d = made.d;

  await d.start();

  assert.equal(stopped, true);
  assert.equal(made.queue.log.claims, 1);
  assert.deepEqual(made.queue.log.completed.map((c) => c.id), ['row-1']);
  assert.equal(d.status().running, false);
  assert.equal(d.stop(), false);
});

test('start while running is refused', async () => {
  let release;
  let entered;
  const gate = new Promise((r) => { release = r; });
  const inConcept = new Promise((r) => { entered = r; });
  const box = fakeBox({ generateConcept: async () => { entered(); await gate; return { ok: true, conceptPath: 'images/c.png', png: CONCEPT_PNG }; } });
  const { d } = dispatcherFor({ rows: [wolfRow()], box });

  const first = d.start();
  assert.throws(() => d.start(), (err) => err.code === 'ALREADY_RUNNING');
  await inConcept;
  assert.equal(d.status().current.id, 'row-1');
  release();
  await first;
  assert.equal(d.status().running, false);
});
