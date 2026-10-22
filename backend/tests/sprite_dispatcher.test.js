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
function fakeQueue(rows, spc = null) {
  const pending = [...rows];
  const log = { claims: 0, attached: [], completed: [], failed: [], requeued: [], redrawTasks: [], redrawSheets: [] };
  return {
    log,
    claim: async () => { log.claims += 1; return pending.shift() || null; },
    queuedCells: async () => pending.reduce((n, r) => n + (r.redraw_of ? r.redraw_frames.length : r.generation_kind === 'object' ? 1
      : r.actions.length * r.directions.length * r.frames_per_action), 0),
    lastSecondsPerCell: async () => spc,
    attachBox: async (_db, id, info) => { log.attached.push({ id, ...info }); },
    complete: async (_db, id, result) => { log.completed.push({ id, result }); },
    fail: async (_db, id, err) => { log.failed.push({ id, message: err.message }); },
    requeueHalted: async (_db, id) => { log.requeued.push(id); },
    attachRedrawTask: async (_db, id, taskId) => { log.redrawTasks.push({ id, taskId }); return { id }; },
    recordRedrawSheet: async (_db, id, keys) => { log.redrawSheets.push({ id, ...keys }); return { id }; },
  };
}

// `objects` are what getObjectStream can read; any other key throws the way
// MinIO does for a missing object.
function fakeStore(objects = {}) {
  const puts = [];
  return {
    puts,
    BUCKET: () => 'sprites',
    putObject: async (key, buf, type) => { puts.push({ key, buf, type }); },
    getObjectStream: async (key) => {
      if (!objects[key]) throw Object.assign(new Error('The specified key does not exist.'), { code: 'NoSuchKey' });
      return [objects[key]];
    },
  };
}

// entity_types.image by id; anything else has no image.
function fakeDb(images = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      const image = images[params[0]];
      return { rows: image ? [{ image }] : [] };
    },
  };
}

// A box fake. `statuses` is the sequence getSheetJob walks through (the last
// one repeats); everything else answers like the captured Wolf job.
function fakeBox({ statuses = [{ status: 'done' }], ...over } = {}) {
  const calls = { concept: [], create: [], redraw: [], get: [], sheet: 0, atlas: 0 };
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
    redrawFrames: async (provider, boxJobId, frames) => {
      calls.redraw.push({ provider, boxJobId, frames });
      return { ok: true, taskId: 'task-1' };
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

function dispatcherFor({ rows, box = fakeBox(), store = fakeStore(), provider = PROVIDER, spc = null, ...opts }) {
  const queue = fakeQueue(rows, spc);
  const d = createDispatcher({
    db: fakeDb(), queue, box, store, loadProvider: async () => provider, pollMs: 0, ...opts,
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

// Props v2 (SOMET-657): an 'object' row is ONE txt2img cutout (no concept, no
// edit, no sheet job); the sway is procedural in the game renderer.
const { encodeRGBA } = require('../src/services/pngTrim.js');
const { decodeRGBA } = require('../src/services/pngAlpha.js');

// 100x160 frame with an opaque block at cols x0..x1, rows y0..y1.
function cutoutPng({ x0 = 35, x1 = 64, y0 = 20, y1 = 69, fill = false } = {}) {
  const W = 100, H = 160;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (fill || (y >= y0 && y <= y1 && x >= x0 && x <= x1)) px.set([40, 120, 40, 255], (y * W + x) * 4);
    }
  }
  return encodeRGBA(W, H, px);
}
const GOOD_PNG = cutoutPng();

function treeRow(over = {}) {
  return wolfRow({
    id: 'row-t', entity_type_id: 12, creature: 'Pine Tree', generation_kind: 'object',
    base_prompt: 'a pine tree', actions: ['idle', 'sway'], directions: ['s'], frames_per_action: 4, ...over,
  });
}
function propBox(over = {}) {
  const t2i = [];
  const box = fakeBox({
    txt2imgProp: async (provider, args) => { t2i.push({ provider, args }); return { ok: true, png: GOOD_PNG, info: {} }; },
    editImage: async () => { throw new Error('editImage must not be called'); },
    ...over,
  });
  box.calls.t2i = t2i;
  return box;
}

test('prop row: one txt2img -> concept.png (raw) + image.png (trimmed), no concept/edit/sheet job', async () => {
  const box = propBox();
  const { d, queue, store } = dispatcherFor({ rows: [treeRow()], box });
  await d.start();

  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.concept.length, 0, 'no generate_core for a prop');
  assert.equal(box.calls.create.length, 0, 'no sheet job for a prop');
  assert.equal(box.calls.get.length, 0);
  assert.equal(box.calls.sheet + box.calls.atlas, 0);
  assert.equal(box.calls.t2i.length, 1);
  assert.equal(box.calls.t2i[0].provider, PROVIDER);
  assert.deepEqual(box.calls.t2i[0].args, { prompt: 'pixel art, a pine tree, single object, centered', seed: 7 });
  const prefix = 'sprites/Pine_Tree/row-t/';
  assert.deepEqual(store.puts.map((p) => [p.key, p.type]), [
    [`${prefix}concept.png`, 'image/png'],
    [`${prefix}image.png`, 'image/png'],
  ]);
  assert.deepEqual(store.puts[0].buf, GOOD_PNG, 'concept.png is the raw cutout');
  const img = decodeRGBA(store.puts[1].buf);
  assert.ok(img.width < 100 && img.height < 160, `trimmed: ${img.width}x${img.height}`);
  assert.ok(img.height >= 50 && img.height <= 56, `content kept with a small margin: ${img.height}`);
  assert.deepEqual(queue.log.attached, []);
  assert.deepEqual(queue.log.completed, [{
    id: 'row-t',
    result: { image_key: `${prefix}image.png`, concept_key: `${prefix}concept.png`, atlas_key: null, manifest_key: null, sheet_seconds: null },
  }]);
});

test('prop row: the prompt keeps an existing "pixel art" / "single object, centered"', async () => {
  const box = propBox();
  const { d } = dispatcherFor({ rows: [treeRow({ base_prompt: 'Pixel Art oak, single object, centered' })], box });
  await d.start();
  assert.equal(box.calls.t2i[0].args.prompt, 'Pixel Art oak, single object, centered');
});

test('prop row: a txt2img failure fails the row with the box words and stores nothing', async () => {
  const box = propBox({ txt2imgProp: async () => ({ ok: false, error: 'GPU box answered 422 for POST /sdapi/v1/txt2img: cutout refused' }) });
  const { d, queue, store } = dispatcherFor({ rows: [treeRow()], box });
  await d.start();
  assert.equal(queue.log.completed.length, 0);
  assert.deepEqual(queue.log.failed, [{ id: 'row-t', message: 'GPU box answered 422 for POST /sdapi/v1/txt2img: cutout refused' }]);
  assert.equal(store.puts.length, 0);
});

test('prop row with a stale box_job_id still takes the txt2img path', async () => {
  const box = propBox();
  const { d, queue } = dispatcherFor({ rows: [treeRow({ box_job_id: 'old-sheet' })], box });
  await d.start();
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.get.length + box.calls.create.length, 0);
  assert.equal(box.calls.t2i.length, 1);
});

test('creature rows never call txt2imgProp', async () => {
  const box = propBox();
  const { d, queue } = dispatcherFor({ rows: [wolfRow()], box });
  await d.start();
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.t2i.length, 0);
  assert.equal(box.calls.create.length, 1);
});

test('prop row: a mostly-opaque cutout fails before anything is stored', async () => {
  const opaque = cutoutPng({ fill: true });
  const box = propBox({ txt2imgProp: async () => ({ ok: true, png: opaque, info: {} }) });
  const { d, queue, store } = dispatcherFor({ rows: [treeRow()], box });
  await d.start();
  assert.equal(queue.log.completed.length, 0);
  assert.deepEqual(queue.log.failed, [{ id: 'row-t', message: 'cutout came back mostly opaque (0% transparent)' }]);
  assert.equal(store.puts.length, 0);
});

test('prop row: a speck of a subject fails as too small', async () => {
  const speck = cutoutPng({ x0: 10, x1: 14, y0: 10, y1: 14 });
  const box = propBox({ txt2imgProp: async () => ({ ok: true, png: speck, info: {} }) });
  const { d, queue, store } = dispatcherFor({ rows: [treeRow()], box });
  await d.start();
  assert.deepEqual(queue.log.failed, [{ id: 'row-t', message: 'subject too small' }]);
  assert.equal(store.puts.length, 0);
});

test('prop row: an undecodable png gets no opinion from the gate and is stored as-is', async () => {
  const odd = Buffer.from('not-a-png');
  const box = propBox({ txt2imgProp: async () => ({ ok: true, png: odd, info: {} }) });
  const { d, queue, store } = dispatcherFor({ rows: [treeRow()], box });
  await d.start();
  assert.deepEqual(queue.log.failed, []);
  assert.deepEqual(store.puts[1].buf, odd);
});

// The entity's current image is the latest approved art. A prop is one static
// image, so when that image exists it IS the sprite: no fresh txt2img, which
// would draw something unrelated to what was approved in Art Generation.
test('prop row: reuses the entity\'s current image instead of a fresh txt2img', async () => {
  const box = propBox();
  const db = fakeDb({ 12: 'sprites/objects/pine_tree/rmt_last/static.png' });
  const store = fakeStore({ 'sprites/objects/pine_tree/rmt_last/static.png': GOOD_PNG });
  const { d, queue } = dispatcherFor({ rows: [treeRow()], box, db, store });
  await d.start();

  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.t2i.length, 0, 'no box call when the entity has an image');
  assert.equal(db.queries.length, 1);
  assert.deepEqual(db.queries[0].params, [12]);
  const prefix = 'sprites/Pine_Tree/row-t/';
  assert.deepEqual(store.puts.map((p) => p.key), [`${prefix}concept.png`, `${prefix}image.png`]);
  assert.deepEqual(store.puts[0].buf, GOOD_PNG, 'concept.png is the entity image as stored');
  const img = decodeRGBA(store.puts[1].buf);
  assert.ok(img.width < 100 && img.height < 160, `trimmed: ${img.width}x${img.height}`);
  assert.deepEqual(queue.log.completed, [{
    id: 'row-t',
    result: { image_key: `${prefix}image.png`, concept_key: `${prefix}concept.png`, atlas_key: null, manifest_key: null, sheet_seconds: null },
  }]);
});

test('prop row: an image key whose object is gone falls back to txt2img', async () => {
  const box = propBox();
  const db = fakeDb({ 12: 'sprites/objects/pine_tree/deleted/static.png' });
  const { d, queue, store } = dispatcherFor({ rows: [treeRow()], box, db });
  await d.start();

  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.t2i.length, 1);
  assert.deepEqual(store.puts[0].buf, GOOD_PNG);
});

test('prop row: an entity with no image takes the txt2img path', async () => {
  const box = propBox();
  const { d, queue } = dispatcherFor({ rows: [treeRow()], box });
  await d.start();

  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.t2i.length, 1);
});

// --- SOMET-662: progress on run.current and cell-weighted batch totals ---

test('progress: run.current carries phase, pct, message and cells while polling', async () => {
  const snaps = [];
  let dRef;
  const inner = fakeBox({ statuses: [
    { status: 'queued', progress: { pct: 0, message: 'queued, 16 cells' } },
    { status: 'running', progress: { pct: 31, message: 'cell 5/16' } },
    { status: 'running', progress: { pct: 62, message: 'running turnaround-encode' } },
    { status: 'done' },
  ] });
  const box = {
    ...inner,
    generateConcept: async (...a) => { snaps.push({ ...dRef.status().current }); return inner.generateConcept(...a); },
    getSheetJob: async (...a) => { snaps.push({ ...dRef.status().current }); return inner.getSheetJob(...a); },
  };
  const { d } = dispatcherFor({ rows: [wolfRow()], box });
  dRef = d;
  await d.start();

  assert.deepEqual(snaps.map((x) => x.phase), ['concept', 'queued', 'queued', 'running', 'running']);
  assert.deepEqual(snaps.map((x) => x.pct), [0, 0, 0, 31, 62]);
  assert.equal(snaps[3].message, 'cell 5/16');
  assert.equal(snaps[0].cells, 16);
  assert.equal(snaps[0].id, 'row-1');
  assert.equal(d.status().current, null);
});

test('progress: batch totals are cell-weighted; failed and prop rows count', async () => {
  let dRef;
  const mid = [];
  const inner = propBox({ statuses: [{ status: 'running', progress: { pct: 50 } }, { status: 'done' }] });
  const box = {
    ...inner,
    getSheetJob: async (...a) => {
      const r = dRef.status();
      mid.push({ done: r.doneCells, total: r.totalCells, cur: r.current && r.current.cells });
      if (r.current && r.current.id === 'row-2') return { ok: false, error: 'box exploded' };
      return inner.getSheetJob(...a);
    },
    txt2imgProp: inner.txt2imgProp,
  };
  const rows = [wolfRow(), wolfRow({ id: 'row-2', frames_per_action: 1 }), treeRow()];
  const { d, queue } = dispatcherFor({ rows, box, spc: 12.5 });
  dRef = d;
  assert.equal(d.status(), null);
  await d.start();

  // 16 + 8 + 1 cells, all counted up front.
  assert.ok(mid.every((m) => m.total === 25));
  assert.equal(mid[0].done, 0);
  assert.equal(mid.find((m) => m.cur === 8).done, 16);
  assert.equal(queue.log.failed.length, 1);
  const r = d.status();
  assert.equal(r.totalCells, 25);
  assert.equal(r.doneCells, 25, 'completed, failed and prop all counted');
  assert.equal(r.completed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.secondsPerCell, 12.5);
});

test('progress: secondsPerCell defaults to 57 and rows queued mid-run grow the total', async () => {
  const late = wolfRow({ id: 'row-late', frames_per_action: 1 });
  const queue = fakeQueue([wolfRow()]);
  const baseComplete = queue.complete;
  let lateWaiting = false;
  const baseClaim = queue.claim;
  queue.claim = async () => (lateWaiting ? (lateWaiting = false, late) : baseClaim());
  queue.queuedCells = async () => 0;
  queue.complete = async (...a) => { await baseComplete(...a); lateWaiting = true; };
  const d = createDispatcher({
    db: fakeDb(), queue, box: fakeBox(), store: fakeStore(), loadProvider: async () => PROVIDER, pollMs: 0,
  });
  await d.start();
  const r = d.status();
  assert.equal(r.secondsPerCell, 57);
  assert.equal(r.completed + r.failed, 2, 'the late row was claimed (its sheet may not match the wolf fixture)');
  assert.equal(r.doneCells, 24);
  assert.equal(r.totalCells, 24, 'total grew to include the late row');
});

// Halt: the sheet on the box is cancelled, its row goes back to the queue
// (not failed, not completed), and nothing after it is claimed.
test('halt mid-sheet cancels the box job and requeues the row', async () => {
  let d;
  const cancelled = [];
  const box = fakeBox({
    getSheetJob: async () => { d.halt(); return { ok: true, job: { status: 'running', progress: { pct: 40 } } }; },
    cancelSheetJob: async (_p, id) => { cancelled.push(id); return { ok: true }; },
  });
  const made = dispatcherFor({ rows: [wolfRow(), wolfRow({ id: 'row-2' })], box });
  d = made.d;
  await d.start();
  assert.deepEqual(cancelled, ['box-1']);
  assert.deepEqual(made.queue.log.requeued, ['row-1']);
  assert.deepEqual(made.queue.log.failed, []);
  assert.deepEqual(made.queue.log.completed, []);
  assert.equal(made.queue.log.claims, 1, 'row-2 is never claimed');
  assert.equal(d.status().halted, 1);
  assert.equal(d.status().running, false);
});

test('halt during the concept never creates a sheet job', async () => {
  let d;
  const box = fakeBox({
    generateConcept: async () => { d.halt(); return { ok: true, conceptPath: 'images/c.png', png: CONCEPT_PNG }; },
    cancelSheetJob: async () => { throw new Error('nothing to cancel'); },
  });
  const made = dispatcherFor({ rows: [wolfRow()], box });
  d = made.d;
  await d.start();
  assert.equal(box.calls.create.length, 0);
  assert.deepEqual(made.queue.log.requeued, ['row-1']);
});

test('a failed cancel still requeues the halted row', async () => {
  let d;
  const box = fakeBox({
    getSheetJob: async () => { d.halt(); return { ok: true, job: { status: 'running', progress: {} } }; },
    cancelSheetJob: async () => ({ ok: false, error: 'box unreachable' }),
  });
  const made = dispatcherFor({ rows: [wolfRow()], box });
  d = made.d;
  await d.start();
  assert.deepEqual(made.queue.log.requeued, ['row-1']);
  assert.deepEqual(made.queue.log.failed, []);
});

test('halt with no batch running reports false', () => {
  const { d } = dispatcherFor({ rows: [] });
  assert.equal(d.halt(), false);
});

// --- Frame redraw rows ---

const QUEUE_AGAIN = "The GPU box no longer has this sheet's job. Queue the whole sheet again.";
const REDRAW_FRAMES = [{ action: 'idle', direction: 's', frame: 1 }, { action: 'idle', direction: 'e', frame: 0 }];
const OLD_CONCEPT = 'sprites/Grey_Wolf/row-0/concept.png';

function redrawRow(over = {}) {
  return wolfRow({
    id: 'row-2', redraw_of: 'row-0', redraw_frames: REDRAW_FRAMES, box_job_id: 'box-old',
    box_task_id: null, concept_key: OLD_CONCEPT, ...over,
  });
}
const conceptStore = () => fakeStore({ [OLD_CONCEPT]: CONCEPT_PNG });

test('redraw row calls redrawFrames with the marked frames and stores under its own prefix', async () => {
  const { d, queue, box, store } = dispatcherFor({
    rows: [redrawRow()], store: conceptStore(),
    box: fakeBox({ statuses: [{ status: 'running' }, { status: 'done' }] }),
  });
  await d.start();

  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.redraw.length, 1);
  assert.equal(box.calls.redraw[0].provider, PROVIDER);
  assert.equal(box.calls.redraw[0].boxJobId, 'box-old');
  assert.deepEqual(box.calls.redraw[0].frames, REDRAW_FRAMES);
  assert.deepEqual(queue.log.redrawTasks, [{ id: 'row-2', taskId: 'task-1' }]);
  assert.ok(box.calls.get.every((id) => id === 'task-1'), 'polls the task, not the sheet job');
  const prefix = 'sprites/Grey_Wolf/row-2/';
  assert.deepEqual(store.puts.map((p) => p.key), [`${prefix}concept.png`, `${prefix}sheet.png`, `${prefix}sheet.json`]);
  assert.deepEqual(store.puts[0].buf, CONCEPT_PNG);
  assert.deepEqual(store.puts[1].buf, WOLF_SHEET);
  assert.equal(JSON.parse(store.puts[2].buf.toString('utf8')).box_job_id, 'box-old');
  assert.deepEqual(queue.log.completed, [{ id: 'row-2', result: {
    atlas_key: `${prefix}sheet.png`, manifest_key: `${prefix}sheet.json`,
    concept_key: `${prefix}concept.png`, sheet_seconds: null,
  } }]);
  assert.equal(box.calls.create.length, 0);
  assert.equal(box.calls.concept.length, 0);
});

test('redraw row never takes the resume-a-done-sheet path', async () => {
  const { d, queue, box } = dispatcherFor({
    rows: [redrawRow()], store: conceptStore(), box: fakeBox({ statuses: [{ status: 'done' }] }),
  });
  await d.start();
  assert.equal(box.calls.redraw.length, 1);
  assert.equal(queue.log.completed.length, 1);
});

test('redraw row with box_task_id resumes polling and does not resubmit', async () => {
  const { d, queue, box } = dispatcherFor({
    rows: [redrawRow({ box_task_id: 'task-9' })], store: conceptStore(),
    box: fakeBox({ statuses: [{ status: 'running' }, { status: 'done' }] }),
  });
  await d.start();
  assert.equal(box.calls.redraw.length, 0);
  assert.deepEqual(queue.log.redrawTasks, []);
  assert.ok(box.calls.get.length >= 2 && box.calls.get.every((id) => id === 'task-9'));
  assert.equal(queue.log.completed.length, 1);
});

test('redraw with no box_job_id fails with the queue-again message', async () => {
  const { d, queue, box } = dispatcherFor({ rows: [redrawRow({ box_job_id: null })], store: conceptStore() });
  await d.start();
  assert.deepEqual(queue.log.failed, [{ id: 'row-2', message: QUEUE_AGAIN }]);
  assert.equal(box.calls.redraw.length, 0);
});

test('redraw task missing on the box fails with the same message', async () => {
  const { d, queue } = dispatcherFor({
    rows: [redrawRow({ box_task_id: 'task-9' })], store: conceptStore(),
    box: fakeBox({ statuses: [{ status: 'missing' }] }),
  });
  await d.start();
  assert.deepEqual(queue.log.failed, [{ id: 'row-2', message: QUEUE_AGAIN }]);
});

test('failed redraw stores the box\'s current sheet and rethrows', async () => {
  const { d, queue, store } = dispatcherFor({
    rows: [redrawRow()], store: conceptStore(),
    box: fakeBox({ statuses: [{ status: 'failed', error: 'cell 3 oom' }] }),
  });
  await d.start();
  const prefix = 'sprites/Grey_Wolf/row-2/';
  assert.deepEqual(queue.log.redrawSheets, [{ id: 'row-2', atlas_key: `${prefix}sheet.png`, manifest_key: `${prefix}sheet.json` }]);
  assert.ok(store.puts.some((p) => p.key === `${prefix}sheet.png`));
  assert.equal(queue.log.failed.length, 1);
  assert.match(queue.log.failed[0].message, /cell 3 oom/);
  assert.deepEqual(queue.log.completed, []);
});

test('failed redraw still fails the row when capturing the sheet also fails', async () => {
  const { d, queue } = dispatcherFor({
    rows: [redrawRow()], store: conceptStore(),
    box: fakeBox({
      statuses: [{ status: 'failed', error: 'cell 3 oom' }],
      fetchSheet: async () => ({ ok: false, error: 'gone' }),
    }),
  });
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try { await d.start(); } finally { console.error = orig; }
  assert.deepEqual(queue.log.redrawSheets, []);
  assert.match(queue.log.failed[0].message, /cell 3 oom/);
  assert.ok(errs.some((e) => /gone/.test(e)));
});

test('halt mid-redraw cancels the task id and requeues the row', async () => {
  let d;
  const cancelled = [];
  const box = fakeBox({
    getSheetJob: async () => { d.halt(); return { ok: true, job: { status: 'running', progress: {} } }; },
    cancelSheetJob: async (_p, id) => { cancelled.push(id); return { ok: true }; },
  });
  const made = dispatcherFor({ rows: [redrawRow()], box, store: conceptStore() });
  d = made.d;
  await d.start();
  assert.deepEqual(cancelled, ['task-1']);
  assert.deepEqual(made.queue.log.requeued, ['row-2']);
  assert.deepEqual(made.queue.log.failed, []);
  assert.deepEqual(made.queue.log.redrawSheets, [], 'a halt does not capture a partial sheet');
});

test('progress counts a redraw row as its marked frames', async () => {
  let dRef;
  const seen = [];
  const inner = fakeBox({ statuses: [{ status: 'running', progress: { pct: 50, message: 'frame 1/2' } }, { status: 'done' }] });
  const box = {
    ...inner,
    getSheetJob: async (...a) => { seen.push({ ...dRef.status().current }); return inner.getSheetJob(...a); },
  };
  const { d } = dispatcherFor({ rows: [redrawRow()], box, store: conceptStore() });
  dRef = d;
  await d.start();
  assert.equal(seen[0].cells, 2);
  assert.equal(seen[1].phase, 'running');
  assert.equal(seen[1].pct, 50);
  assert.equal(seen[1].message, 'frame 1/2');
  assert.equal(d.status().doneCells, 2);
  assert.equal(d.status().totalCells, 2);
});
