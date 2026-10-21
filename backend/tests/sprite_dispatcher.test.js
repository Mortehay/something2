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

// A box whose job sits `queued` for queuedMs of wall time, then `running` for
// runningMs, then done. estimatedSeconds 0 keeps the run deadline tiny so only
// the queue-aware logic can save a long wait.
function timedBox({ queuedMs, runningMs = 0, ...over }) {
  let t0 = null;
  return fakeBox({
    createSheetJob: async () => ({ ok: true, boxJobId: 'box-1', cells: 16, estimatedSeconds: 0 }),
    getSheetJob: async () => {
      if (t0 === null) t0 = Date.now();
      const el = Date.now() - t0;
      if (el < queuedMs) return { ok: true, job: { status: 'queued', progress: {} } };
      if (el < queuedMs + runningMs) return { ok: true, job: { status: 'running', progress: { pct: 1, message: `m${el}` } } };
      return { ok: true, job: { status: 'done' } };
    },
    ...over,
  });
}

function dispatcherFor({ rows, box = fakeBox(), store = fakeStore(), provider = PROVIDER, ...opts }) {
  const queue = fakeQueue(rows);
  const d = createDispatcher({
    db: {}, queue, box, store, loadProvider: async () => provider, pollMs: 0, ...opts,
  });
  return { d, queue, box, store };
}

test('box job: concept, sheet, manifest stored under the row prefix', async () => {
  const { d, queue, box, store } = dispatcherFor({
    rows: [wolfRow()], box: fakeBox({ statuses: [{ status: 'running' }, { status: 'done' }] }),
  });

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

test('queued behind other box jobs does not run the stall window or the run deadline', async () => {
  // queued 120 ms > stallMs (30) and > deadline (16 cells x 2 ms = 32 ms).
  const box = timedBox({ queuedMs: 120, runningMs: 10 });
  const { d, queue } = dispatcherFor({ rows: [wolfRow()], box, stallMs: 30, cellTimeoutMs: 2 });

  await d.start();

  assert.deepEqual(queue.log.failed, []);
  assert.equal(queue.log.completed.length, 1);
});

test('queue wait beyond the queue cap fails with a resumable message', async () => {
  const box = timedBox({ queuedMs: 100000 });
  const { d, queue } = dispatcherFor({ rows: [wolfRow()], box, queueCapMs: 40 });

  await d.start();

  assert.equal(queue.log.completed.length, 0);
  assert.equal(queue.log.failed.length, 1);
  assert.match(queue.log.failed[0].message,
    /^still waiting behind other box jobs after [\d.]+ h — the box job box-1 may still run; re-queue to resume it$/);
});

test('default queue cap is 6 hours', () => {
  assert.equal(require('../src/services/spriteDispatcher.js').QUEUE_CAP_MS, 6 * 3600 * 1000);
});

test('sheet_seconds counts from the first running poll, not the queue wait', async () => {
  const box = timedBox({ queuedMs: 150, runningMs: 5 });
  const { d, queue } = dispatcherFor({ rows: [wolfRow()], box, stallMs: 60000 });

  await d.start();

  const { sheet_seconds: secs } = queue.log.completed[0].result;
  assert.equal(typeof secs, 'number');
  assert.ok(secs < 0.1, `queue wait leaked into sheet_seconds: ${secs}`);
});

test('a resumed job already done or already running stores sheet_seconds null', async () => {
  for (const first of ['done', 'running']) {
    const box = fakeBox({ statuses: [{ status: first }, { status: first }, { status: 'done' }] });
    const { d, queue } = dispatcherFor({ rows: [wolfRow({ box_job_id: 'box-old' })], box });
    await d.start();
    assert.equal(queue.log.completed.length, 1, first);
    assert.equal(queue.log.completed[0].result.sheet_seconds, null, first);
  }
});

test('a resumed job still queued is timed from when it starts running', async () => {
  const box = timedBox({ queuedMs: 60, runningMs: 5 });
  const { d, queue } = dispatcherFor({ rows: [wolfRow({ box_job_id: 'box-old' })], box });
  await d.start();
  assert.equal(typeof queue.log.completed[0].result.sheet_seconds, 'number');
});

test('a legacy row with no actions fails before any box call', async () => {
  for (const actions of [null, []]) {
    const { d, queue, box } = dispatcherFor({ rows: [wolfRow({ actions })] });
    await d.start();
    assert.deepEqual(queue.log.failed, [{
      id: 'row-1', message: 'queued before GPU-box sheets — re-queue it from the Sprite Generation page',
    }]);
    assert.equal(box.calls.concept.length + box.calls.create.length + box.calls.get.length, 0);
  }
});

// Props v2: the box's sheet builder draws a person into every action, so an
// 'object' row is a concept -> edit (person removed) -> one static image; the
// sway is procedural in the game renderer. No sheet job is ever created.
const EDITED_PNG = Buffer.from('edited-bytes');
function treeRow(over = {}) {
  return wolfRow({
    id: 'row-t', entity_type_id: 12, creature: 'Pine Tree', generation_kind: 'object',
    base_prompt: 'a pine tree', actions: ['idle', 'sway'], directions: ['s'], frames_per_action: 4, ...over,
  });
}
function editBox(over = {}) {
  const edits = [];
  const box = fakeBox({
    editImage: async (provider, args) => { edits.push({ provider, args }); return { ok: true, path: 'images/edit_1.png', png: EDITED_PNG, transparent: 0.6 }; },
    ...over,
  });
  box.calls.edit = edits;
  return box;
}

test('prop row: concept -> edit -> concept.png + image.png, no sheet job', async () => {
  const box = editBox();
  const { d, queue, store } = dispatcherFor({ rows: [treeRow()], box });
  await d.start();

  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.create.length, 0, 'no sheet job for a prop');
  assert.equal(box.calls.get.length, 0);
  assert.equal(box.calls.sheet + box.calls.atlas, 0);
  assert.deepEqual(box.calls.concept.map((c) => c.args), [{ prompt: 'a pine tree' }]);
  assert.equal(box.calls.edit.length, 1);
  assert.equal(box.calls.edit[0].provider, PROVIDER);
  assert.deepEqual(box.calls.edit[0].args, {
    source: 'core_abc.png',
    instruction: 'Remove any person or character. Keep only the Pine Tree, unchanged, on the same plain background.',
  });
  const prefix = 'sprites/Pine_Tree/row-t/';
  assert.deepEqual(store.puts.map((p) => [p.key, p.type]), [
    [`${prefix}concept.png`, 'image/png'],
    [`${prefix}image.png`, 'image/png'],
  ]);
  assert.deepEqual(store.puts[0].buf, CONCEPT_PNG);
  assert.deepEqual(store.puts[1].buf, EDITED_PNG);
  assert.deepEqual(queue.log.attached, []);
  assert.deepEqual(queue.log.completed, [{
    id: 'row-t',
    result: { image_key: `${prefix}image.png`, concept_key: `${prefix}concept.png`, atlas_key: null, manifest_key: null, sheet_seconds: null },
  }]);
});

test('prop row: a snake_case catalog name is humanised in the edit instruction', async () => {
  const box = editBox();
  const { d } = dispatcherFor({ rows: [treeRow({ creature: 'pine_tree' })], box });
  await d.start();
  const { instruction } = box.calls.edit[0].args;
  assert.ok(instruction.includes('pine tree'), instruction);
  assert.ok(!instruction.includes('pine_tree'), instruction);
});

test('prop row: an edit failure fails the row with the box words', async () => {
  const box = editBox({
    editImage: async () => ({ ok: false, error: 'GPU box answered 503 for POST /api/edit: image editing is disabled' }),
  });
  const { d, queue, store } = dispatcherFor({ rows: [treeRow()], box });
  await d.start();
  assert.equal(queue.log.completed.length, 0);
  assert.deepEqual(queue.log.failed, [{ id: 'row-t', message: 'GPU box answered 503 for POST /api/edit: image editing is disabled' }]);
  assert.ok(!store.puts.some((p) => p.key.endsWith('image.png')));
});

test('prop row with a stale box_job_id still takes the edit path', async () => {
  const box = editBox();
  const { d, queue } = dispatcherFor({ rows: [treeRow({ box_job_id: 'old-sheet' })], box });
  await d.start();
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.get.length + box.calls.create.length, 0);
  assert.equal(box.calls.edit.length, 1);
});

test('creature rows never call editImage', async () => {
  const box = editBox();
  const { d, queue } = dispatcherFor({ rows: [wolfRow()], box });
  await d.start();
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.edit.length, 0);
  assert.equal(box.calls.create.length, 1);
});
