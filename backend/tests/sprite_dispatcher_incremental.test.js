// SOMET-702: the dispatcher keeps good frames of an earlier sheet drawn from
// the same concept and asks the box only for rows with missing cells.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDispatcher } = require('../src/services/spriteDispatcher.js');
const { encodeRGBA } = require('../src/services/pngTrim.js');
const { decodeRGBA } = require('../src/services/pngAlpha.js');

const CW = 48;
const CH = 64;
const PROVIDER = { id: 9, base_url: 'http://box.test:8001/', modality: 'sprite' };
const KEPT_BYTES = Buffer.from('kept-concept-bytes');
const KEPT = {
  entity_type_id: 4, appearance_variant: null, concept_key: 'sprites/Grey_Wolf/kept-row/concept.png',
  box_concept_path: 'images/core_kept.png', provider_id: 9, box_origin: 'http://box.test:8001',
};
const BASE_ID = '11111111-1111-1111-1111-111111111111';
const BASE_PREFIX = `sprites/Grey_Wolf/${BASE_ID}/`;
const PREFIX = 'sprites/Grey_Wolf/row-1/';

// A sheet whose every cell is filled with [tag, source row, source frame, 255],
// so the merged sheet tells where each cell came from.
function sheetPng(tag, nRows, frames) {
  const W = CW * frames;
  const H = CH * nRows;
  const px = Buffer.alloc(W * H * 4);
  for (let r = 0; r < nRows; r += 1) {
    for (let i = 0; i < frames; i += 1) {
      for (let y = 0; y < CH; y += 1) {
        for (let x = 0; x < CW; x += 1) px.set([tag, r, i, 255], ((r * CH + y) * W + i * CW + x) * 4);
      }
    }
  }
  return encodeRGBA(W, H, px);
}

// The base sheet: pairs [[action, direction], ...], `frames` per row.
function baseSheet(pairs, frames, quality) {
  const out = {};
  const rows = pairs.map(([action, direction], r) => {
    for (let i = 0; i < frames; i += 1) out[`${action}/${direction}/${i}`] = [i * CW, r * CH, CW, CH];
    return { row: r, action, direction, frames };
  });
  const manifest = {
    version: 1, sheet: 'sheet.png', concept: 'concept.png', engine: 'Qwen', box_job_id: 'box-base',
    cell: [CW, CH], actions: [...new Set(pairs.map((p) => p[0]))], frames_per_action: frames, rows, frames: out,
  };
  if (quality) manifest.quality = quality;
  return { png: sheetPng(1, pairs.length, frames), manifest };
}

// The box's partial atlas: every action x direction of the job spec.
function boxAtlas(actions, directions, frames) {
  const rows = [];
  for (const action of actions) for (const direction of directions) rows.push({ row: rows.length, action, direction });
  return { cell: { w: CW, h: CH }, grid: { columns: frames, rows: rows.length }, frames_per_action: frames, rows };
}

const q = (action, direction, frame, passed = true) => ({ action, direction, frame, passed, failed_checks: passed ? [] : ['cut'] });

function baseRow(over = {}) {
  return {
    id: BASE_ID, entity_type_id: 4, appearance_variant: null, status: 'done', backend: 'gpu-box', generation_kind: 'creature',
    atlas_key: `${BASE_PREFIX}sheet.png`, manifest_key: `${BASE_PREFIX}sheet.json`, concept_key: `${BASE_PREFIX}concept.png`,
    updated_at: new Date('2026-10-30T12:34:56Z'), ...over,
  };
}

function wolfRow(over = {}) {
  return {
    id: 'row-1', entity_type_id: 4, creature: 'Grey Wolf', generation_kind: 'creature',
    base_prompt: 'a grey wolf', seed: '7', actions: ['idle'], directions: ['s', 'e'],
    frames_per_action: 2, box_job_id: null, concept_key: null, real_western: false, ...over,
  };
}

function fakeQueue(rows, { candidates = [], byId = {} } = {}) {
  const pending = [...rows];
  const log = { attached: [], completed: [], failed: [], notes: [], candidateCalls: [], byIdCalls: [] };
  return {
    log,
    claim: async () => pending.shift() || null,
    attachBox: async (_db, id, info) => { log.attached.push({ id, ...info }); },
    complete: async (_db, id, result) => { log.completed.push({ id, result }); },
    fail: async (_db, id, err) => { log.failed.push({ id, message: err.message }); },
    requeueHalted: async () => {},
    setNote: async (_db, id, note) => { log.notes.push({ id, note }); },
    attachRedrawTask: async () => ({}),
    recordRedrawSheet: async () => ({}),
    reuseBaseCandidates: async (_db, args) => { log.candidateCalls.push(args); return candidates; },
    reuseBaseById: async (_db, id) => { log.byIdCalls.push(id); return byId[id] || null; },
  };
}

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

// The base's three files plus the kept concept.
function storeWith(base, { baseConcept = KEPT_BYTES, extra = {} } = {}) {
  return fakeStore({
    [KEPT.concept_key]: KEPT_BYTES,
    [`${BASE_PREFIX}concept.png`]: baseConcept,
    [`${BASE_PREFIX}sheet.png`]: base.png,
    [`${BASE_PREFIX}sheet.json`]: Buffer.from(JSON.stringify(base.manifest)),
    ...extra,
  });
}

// The box draws whatever the job spec asks: actions x directions x frames.
function fakeBox({ statuses = ['done'], ...over } = {}) {
  const calls = { concept: 0, create: [], get: [], cancel: [], redraw: [], prop: 0 };
  let spec = null;
  return {
    calls,
    generateConcept: async () => { calls.concept += 1; return { ok: true, conceptPath: 'images/new.png', png: Buffer.from('new-concept') }; },
    conceptAvailable: async () => true,
    createSheetJob: async (_p, s) => { spec = s; calls.create.push(s); return { ok: true, boxJobId: `box-${calls.create.length}`, cells: 4, estimatedSeconds: 10 }; },
    getSheetJob: async (_p, id) => { calls.get.push(id); return { ok: true, job: { status: statuses[Math.min(calls.get.length - 1, statuses.length - 1)], progress: {} } }; },
    fetchSheet: async () => {
      const s = spec || over.resumeSpec;
      return { ok: true, png: sheetPng(2, s.actions.length * s.directions.length, s.frames) };
    },
    fetchAtlas: async () => {
      const s = spec || over.resumeSpec;
      return { ok: true, atlas: boxAtlas(s.actions, s.directions, s.frames) };
    },
    cancelSheetJob: async (_p, id) => { calls.cancel.push(id); return { ok: true }; },
    redrawFrames: async () => { calls.redraw.push(1); return { ok: true, taskId: 'task-1' }; },
    txt2imgProp: async () => { calls.prop += 1; return { ok: false, error: 'no prop in this test' }; },
    ...over,
  };
}

const boxCancels = { request: async (_db, provider, { boxJobId }, { box }) => box.cancelSheetJob(provider, boxJobId) };

async function run({ rows, queueOpts, store, box = fakeBox(), kept = KEPT, provider = PROVIDER }) {
  const queue = fakeQueue(rows, queueOpts);
  const concepts = {
    getKept: async () => kept, upsertKept: async () => ({}), removeKept: async () => {},
  };
  const d = createDispatcher({
    db: { query: async () => ({ rows: [] }) }, queue, box, store, concepts, boxCancels,
    loadProvider: async () => provider, pollMs: 1, stallMs: 300,
  });
  await d.start();
  return { queue, box, store };
}

const stored = (store, name) => store.puts.find((p) => p.key === `${PREFIX}${name}`);
const storedManifest = (store) => JSON.parse(stored(store, 'sheet.json').buf.toString('utf8'));
// [tag, source row, source frame] at the centre of a cell of the stored sheet.
function cellSource(store, manifest, key) {
  const img = decodeRGBA(stored(store, 'sheet.png').buf);
  const [x, y] = manifest.frames[key];
  const o = ((y + CH / 2) * img.width + x + CW / 2) * 4;
  return [img.px[o], img.px[o + 1], img.px[o + 2]];
}

test('frame count 2 -> 6: rows drawn whole, frames 0-1 kept from base unless flagged, 2-5 from the new draw', async () => {
  const base = baseSheet([['idle', 's'], ['idle', 'e']], 2, [q('idle', 's', 0), q('idle', 's', 1), q('idle', 'e', 0), q('idle', 'e', 1, false)]);
  const { queue, box, store } = await run({
    rows: [wolfRow({ frames_per_action: 6 })],
    queueOpts: { candidates: [baseRow()] },
    store: storeWith(base),
  });
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.concept, 0);
  assert.equal(box.calls.create.length, 1);
  assert.deepEqual([box.calls.create[0].actions, box.calls.create[0].directions, box.calls.create[0].frames], [['idle'], ['s', 'e'], 6]);
  assert.equal(box.calls.create[0].concept_image, 'images/core_kept.png');
  assert.deepEqual(queue.log.attached, [{ id: 'row-1', boxJobId: 'box-1', conceptKey: `${PREFIX}concept.png`, providerId: 9, reuseBaseId: BASE_ID }]);

  const m = storedManifest(store);
  assert.equal(m.reused_from, BASE_ID);
  assert.equal(m.reused_cells, 3);
  assert.deepEqual(m.cell, [CW, CH]);
  assert.equal(Object.keys(m.frames).length, 12);
  assert.deepEqual(cellSource(store, m, 'idle/s/0'), [1, 0, 0]);
  assert.deepEqual(cellSource(store, m, 'idle/s/1'), [1, 0, 1]);
  assert.deepEqual(cellSource(store, m, 'idle/e/0'), [1, 1, 0]);
  assert.deepEqual(cellSource(store, m, 'idle/e/1'), [2, 1, 1], 'flagged base cell taken from the new draw');
  for (let i = 2; i < 6; i += 1) {
    assert.deepEqual(cellSource(store, m, `idle/s/${i}`), [2, 0, i]);
    assert.deepEqual(cellSource(store, m, `idle/e/${i}`), [2, 1, i]);
  }
  assert.deepEqual(queue.log.notes, [{ id: 'row-1', note: 'reused 3 of 12 cells from sheet 2026-10-30 12:34' }]);
  assert.equal(queue.log.completed.length, 1);
  assert.equal(queue.log.completed[0].result.concept_key, `${PREFIX}concept.png`);
  assert.equal(queue.log.completed[0].result.atlas_key, `${PREFIX}sheet.png`);
});

test('a partial job: extra cartesian rows the box draws are ignored, the merge is exact', async () => {
  // Missing: idle/e and walk/s -> the box draws idle+walk x s+e, i.e. also idle/s and walk/e.
  const base = baseSheet([['idle', 's'], ['walk', 'e']], 2);
  const { queue, box, store } = await run({
    rows: [wolfRow({ actions: ['idle', 'walk'] })],
    queueOpts: { candidates: [baseRow()] },
    store: storeWith(base),
  });
  assert.deepEqual(queue.log.failed, []);
  assert.deepEqual([box.calls.create[0].actions, box.calls.create[0].directions], [['idle', 'walk'], ['s', 'e']]);
  const m = storedManifest(store);
  assert.deepEqual(m.rows.map((r) => `${r.action}/${r.direction}`), ['idle/s', 'idle/e', 'walk/s', 'walk/e']);
  assert.deepEqual(Object.keys(m.frames).sort(), ['idle/e/0', 'idle/e/1', 'idle/s/0', 'idle/s/1', 'walk/e/0', 'walk/e/1', 'walk/s/0', 'walk/s/1']);
  assert.deepEqual(cellSource(store, m, 'idle/s/0'), [1, 0, 0], 'extra drawn row ignored');
  assert.deepEqual(cellSource(store, m, 'walk/e/1'), [1, 1, 1], 'extra drawn row ignored');
  // Box rows: idle/s=0, idle/e=1, walk/s=2, walk/e=3.
  assert.deepEqual(cellSource(store, m, 'idle/e/0'), [2, 1, 0]);
  assert.deepEqual(cellSource(store, m, 'walk/s/1'), [2, 2, 1]);
  assert.equal(m.reused_cells, 4);
});

test('nothing to draw (all cells present and good, patched ones included): no box call at all', async () => {
  const base = baseSheet([['idle', 's'], ['idle', 'e']], 2,
    [q('idle', 's', 0), q('idle', 's', 1), q('idle', 'e', 0), { ...q('idle', 'e', 1), replaced_from: 'idle/e/0' }]);
  const { queue, box, store } = await run({
    rows: [wolfRow()],
    queueOpts: { candidates: [baseRow()] },
    store: storeWith(base),
  });
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.concept, 0);
  assert.equal(box.calls.create.length, 0);
  assert.equal(box.calls.get.length, 0);
  assert.deepEqual(queue.log.attached, []);
  assert.deepEqual(store.puts.map((p) => p.key), [`${PREFIX}concept.png`, `${PREFIX}sheet.png`, `${PREFIX}sheet.json`]);
  assert.deepEqual(stored(store, 'concept.png').buf, KEPT_BYTES);

  const m = storedManifest(store);
  assert.equal(m.reused_from, BASE_ID);
  assert.equal(m.reused_cells, 4);
  assert.deepEqual(cellSource(store, m, 'idle/e/1'), [1, 1, 1]);
  assert.deepEqual(queue.log.notes, [{ id: 'row-1', note: 'reused 4 of 4 cells from sheet 2026-10-30 12:34' }]);
  const { result } = queue.log.completed[0];
  assert.equal(result.concept_key, `${PREFIX}concept.png`);
  assert.equal(result.sheet_seconds, null);
});

test('flagged rows are drawn by the box: unflagged cells of them kept, a row with no good frame redrawn whole (I1)', async () => {
  const base = baseSheet([['idle', 's'], ['idle', 'e'], ['idle', 'n']], 2,
    [q('idle', 's', 0), q('idle', 's', 1, false), q('idle', 'e', 0, false), q('idle', 'e', 1, false), q('idle', 'n', 0), q('idle', 'n', 1)]);
  const { queue, box, store } = await run({
    rows: [wolfRow({ directions: ['s', 'e', 'n'] })],
    queueOpts: { candidates: [baseRow()] },
    store: storeWith(base),
  });
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.create.length, 1);
  assert.deepEqual([box.calls.create[0].actions, box.calls.create[0].directions], [['idle'], ['s', 'e']]);
  const m = storedManifest(store);
  assert.deepEqual(cellSource(store, m, 'idle/s/0'), [1, 0, 0], 'good cell of a drawn row kept');
  assert.deepEqual(cellSource(store, m, 'idle/s/1'), [2, 0, 1], 'flagged cell from the new draw');
  assert.deepEqual(cellSource(store, m, 'idle/e/0'), [2, 1, 0]);
  assert.deepEqual(cellSource(store, m, 'idle/e/1'), [2, 1, 1]);
  assert.deepEqual(cellSource(store, m, 'idle/n/1'), [1, 2, 1], 'untouched row kept whole');
  assert.equal(m.reused_cells, 3);
  assert.equal(m.replace_skipped, undefined);
});

test('a base drawn from a different concept is never reused: full draw', async () => {
  const base = baseSheet([['idle', 's'], ['idle', 'e']], 2);
  const { queue, box, store } = await run({
    rows: [wolfRow()],
    queueOpts: { candidates: [baseRow()] },
    store: storeWith(base, { baseConcept: Buffer.from('another-concept') }),
  });
  assert.deepEqual(queue.log.failed, []);
  assert.deepEqual([box.calls.create[0].actions, box.calls.create[0].directions], [['idle'], ['s', 'e']]);
  assert.equal('reuseBaseId' in queue.log.attached[0], false);
  const m = storedManifest(store);
  assert.equal(m.reused_from, undefined);
  assert.deepEqual(cellSource(store, m, 'idle/s/0'), [2, 0, 0]);
  assert.deepEqual(queue.log.notes, []);
});

test('an older base with the same concept is used when the newest has another concept', async () => {
  const base = baseSheet([['idle', 's'], ['idle', 'e']], 2);
  const other = 'sprites/Grey_Wolf/newer/';
  const { queue, box } = await run({
    rows: [wolfRow()],
    queueOpts: { candidates: [baseRow({ id: 'newer', concept_key: `${other}concept.png`, atlas_key: `${other}sheet.png`, manifest_key: `${other}sheet.json` }), baseRow()] },
    store: storeWith(base, { extra: { [`${other}concept.png`]: Buffer.from('x'), [`${other}sheet.png`]: base.png, [`${other}sheet.json`]: Buffer.from(JSON.stringify(base.manifest)) } }),
  });
  assert.equal(box.calls.create.length, 0);
  assert.deepEqual(queue.log.notes.map((n) => n.note), ['reused 4 of 4 cells from sheet 2026-10-30 12:34']);
});

test('a base whose cell is not 48x64 is not reused', async () => {
  const base = baseSheet([['idle', 's'], ['idle', 'e']], 2);
  base.manifest.cell = [64, 64];
  const { box } = await run({ rows: [wolfRow()], queueOpts: { candidates: [baseRow()] }, store: storeWith(base) });
  assert.equal(box.calls.create.length, 1);
  assert.deepEqual(box.calls.create[0].directions, ['s', 'e']);
});

test('no base: unchanged full draw', async () => {
  const { queue, box, store } = await run({ rows: [wolfRow()], queueOpts: { candidates: [] }, store: fakeStore({ [KEPT.concept_key]: KEPT_BYTES }) });
  assert.deepEqual(queue.log.failed, []);
  assert.deepEqual(queue.log.candidateCalls, [{ entityTypeId: 4, variant: undefined, excludeId: 'row-1' }]);
  assert.equal(box.calls.create.length, 1);
  assert.equal(storedManifest(store).reused_from, undefined);
  assert.deepEqual(queue.log.notes, []);
});

test('no kept concept (freshly drawn): no base lookup, full draw', async () => {
  const { queue, box } = await run({ rows: [wolfRow()], queueOpts: { candidates: [baseRow()] }, store: fakeStore(), kept: null });
  assert.equal(box.calls.concept, 1);
  assert.deepEqual(queue.log.candidateCalls, []);
  assert.deepEqual(box.calls.create[0].directions, ['s', 'e']);
});

test('a job resumed after a restart merges with the recorded base', async () => {
  const base = baseSheet([['idle', 's']], 2);
  const resumeSpec = { actions: ['idle'], directions: ['e'], frames: 2 };
  const { queue, box, store } = await run({
    rows: [wolfRow({ box_job_id: 'box-old', concept_key: `${PREFIX}concept.png`, reuse_base_id: BASE_ID })],
    queueOpts: { candidates: [], byId: { [BASE_ID]: baseRow() } },
    store: storeWith(base),
    box: fakeBox({ resumeSpec }),
  });
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.create.length, 0);
  assert.deepEqual(queue.log.candidateCalls, []);
  assert.deepEqual(queue.log.byIdCalls, [BASE_ID]);
  const m = storedManifest(store);
  assert.equal(m.reused_from, BASE_ID);
  assert.deepEqual(cellSource(store, m, 'idle/s/1'), [1, 0, 1]);
  assert.deepEqual(cellSource(store, m, 'idle/e/1'), [2, 0, 1]);
  assert.equal(queue.log.completed[0].result.concept_key, `${PREFIX}concept.png`);
});

test('a resumed job whose base row is gone fails with a clear error and cancels the box job', async () => {
  const { queue, box, store } = await run({
    rows: [wolfRow({ box_job_id: 'box-old', concept_key: `${PREFIX}concept.png`, reuse_base_id: BASE_ID })],
    queueOpts: { byId: {} },
    store: fakeStore(),
    box: fakeBox({ statuses: ['running'] }),
  });
  assert.equal(queue.log.failed.length, 1);
  assert.match(queue.log.failed[0].message, /earlier sheet .* is gone/);
  assert.deepEqual(box.calls.cancel, ['box-old']);
  assert.deepEqual(store.puts, []);
});

test('a resumed job whose base files are gone fails with a clear error', async () => {
  const { queue } = await run({
    rows: [wolfRow({ box_job_id: 'box-old', concept_key: `${PREFIX}concept.png`, reuse_base_id: BASE_ID })],
    queueOpts: { byId: { [BASE_ID]: baseRow() } },
    store: fakeStore(),
  });
  assert.equal(queue.log.failed.length, 1);
  assert.match(queue.log.failed[0].message, /earlier sheet .* is gone/);
});

test('a base that cannot be merged is skipped before the GPU is asked: full draw (M1)', async () => {
  const base = baseSheet([['idle', 's'], ['idle', 'e']], 2);
  base.png = sheetPng(1, 1, 2); // the manifest says 2 rows, the png has 1
  const { queue, box, store } = await run({ rows: [wolfRow()], queueOpts: { candidates: [baseRow()] }, store: storeWith(base) });
  assert.deepEqual(queue.log.failed, []);
  assert.equal(queue.log.completed.length, 1);
  assert.deepEqual([box.calls.create[0].actions, box.calls.create[0].directions], [['idle'], ['s', 'e']]);
  assert.equal('reuseBaseId' in queue.log.attached[0], false);
  assert.equal(storedManifest(store).reused_from, undefined);
});

test('an unreadable base PNG is skipped, the next older mergeable base is used (M1)', async () => {
  const bad = baseSheet([['idle', 's'], ['idle', 'e']], 2);
  bad.png = Buffer.from('not a png');
  const good = baseSheet([['idle', 's'], ['idle', 'e']], 2);
  const older = 'sprites/Grey_Wolf/older/';
  const { queue, box } = await run({
    rows: [wolfRow()],
    queueOpts: { candidates: [baseRow(), baseRow({ id: 'older', concept_key: `${older}concept.png`, atlas_key: `${older}sheet.png`, manifest_key: `${older}sheet.json` })] },
    store: storeWith(bad, { extra: { [`${older}concept.png`]: KEPT_BYTES, [`${older}sheet.png`]: good.png, [`${older}sheet.json`]: Buffer.from(JSON.stringify(good.manifest)) } }),
  });
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.create.length, 0);
  assert.deepEqual(queue.log.notes.map((n) => n.note), ['reused 4 of 4 cells from sheet 2026-10-30 12:34']);
});

test('a resumed job whose recorded base cannot be merged fails at intake with a clear message', async () => {
  const base = baseSheet([['idle', 's'], ['idle', 'e']], 2);
  base.png = sheetPng(1, 1, 2);
  const { queue, store } = await run({
    rows: [wolfRow({ box_job_id: 'box-old', concept_key: `${PREFIX}concept.png`, reuse_base_id: BASE_ID })],
    queueOpts: { byId: { [BASE_ID]: baseRow() } },
    store: storeWith(base),
    box: fakeBox({ resumeSpec: { actions: ['idle'], directions: ['e'], frames: 2 } }),
  });
  assert.equal(queue.log.completed.length, 0);
  assert.equal(queue.log.failed.length, 1);
  assert.match(queue.log.failed[0].message, /could not merge with the earlier sheet: frame idle\/e\/0 is outside its sheet/);
  assert.equal(store.puts.some((p) => p.key.endsWith('sheet.json')), false);
});

test('redraw and prop rows never look for a base', async () => {
  const base = baseSheet([['idle', 's'], ['idle', 'e']], 2);
  const box = fakeBox({ resumeSpec: { actions: ['idle'], directions: ['s', 'e'], frames: 2 } });
  const { queue } = await run({
    rows: [
      wolfRow({ id: 'rd', redraw_of: BASE_ID, redraw_frames: [{ action: 'idle', direction: 's', frame: 0 }], box_job_id: 'box-base' }),
      wolfRow({ id: 'prop', generation_kind: 'object' }),
    ],
    queueOpts: { candidates: [baseRow()] },
    store: storeWith(base),
    box,
  });
  // The redraw really ran its own path: one box redraw call, then a stored sheet.
  assert.equal(box.calls.redraw.length, 1);
  assert.deepEqual(queue.log.completed.map((c) => c.id), ['rd']);
  assert.equal(queue.log.completed[0].result.atlas_key, 'sprites/Grey_Wolf/rd/sheet.png');
  // The prop row went to the prop path (no box sheet job, no base either).
  assert.equal(box.calls.prop, 1);
  assert.deepEqual(queue.log.failed.map((f) => f.id), ['prop']);
  assert.equal(box.calls.create.length, 0);
  assert.deepEqual(queue.log.candidateCalls, []);
  assert.deepEqual(queue.log.byIdCalls, []);
});

// A sheet whose cells hold a centred figure of w x h opaque pixels, coloured
// [tag, row, frame]. sizes[row][frame] = [w, h].
function figurePng(tag, sizes) {
  const frames = sizes[0].length;
  const W = CW * frames;
  const px = Buffer.alloc(W * CH * sizes.length * 4);
  sizes.forEach((row, r) => row.forEach(([w, h], i) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        px.set([tag, r, i, 255], ((r * CH + Math.floor((CH - h) / 2) + y) * W + i * CW + Math.floor((CW - w) / 2) + x) * 4);
      }
    }
  }));
  return encodeRGBA(W, CH * sizes.length, px);
}

test('a newly drawn close-up next to kept base cells is flagged by the size check, then replaced from the nearest good frame', async () => {
  const normal = [20, 40];
  const base = baseSheet([['idle', 's']], 2, [q('idle', 's', 0), q('idle', 's', 1)]);
  base.png = figurePng(1, [[normal, normal]]);
  const box = fakeBox();
  box.fetchSheet = async () => ({
    ok: true,
    png: figurePng(2, [[normal, normal, normal, [32, 60], normal, normal]]), // frame 3 is a close-up
  });
  const { queue, store } = await run({
    rows: [wolfRow({ directions: ['s'], frames_per_action: 6 })],
    queueOpts: { candidates: [baseRow()] },
    store: storeWith(base),
    box,
  });
  assert.deepEqual(queue.log.failed, []);
  assert.deepEqual(box.calls.create[0].frames, 6);
  const m = storedManifest(store);
  const entry = (k) => m.quality.find((e) => `${e.action}/${e.direction}/${e.frame}` === k);
  assert.deepEqual(cellSource(store, m, 'idle/s/0'), [1, 0, 0], 'kept base cell');
  assert.deepEqual(cellSource(store, m, 'idle/s/1'), [1, 0, 1], 'kept base cell');
  assert.deepEqual(cellSource(store, m, 'idle/s/2'), [2, 0, 2], 'new, normal');
  assert.equal(entry('idle/s/3').replaced_from, 'idle/s/2', 'nearest good frame (tie keeps the lower index)');
  assert.equal(entry('idle/s/3').passed, true, 'replaced, so no longer flagged (the size-jump reason is dropped by the replace)');
  assert.deepEqual(cellSource(store, m, 'idle/s/3'), [2, 0, 2], 'pixels copied from frame 2');
  for (const k of ['idle/s/0', 'idle/s/1', 'idle/s/2', 'idle/s/4', 'idle/s/5']) assert.equal((entry(k) || {}).replaced_from, undefined);
});

// ---- fix round 1 ----
const PROVIDER_3D = { ...PROVIDER, request_template: { sheet_method: 'turnaround3d' } };
// A box whose turnaround job ('turn-1') returns one tag-3 cell per direction.
function turnaroundBox(dirs = ['s', 'e']) {
  const box = fakeBox();
  const { fetchSheet, fetchAtlas } = box;
  box.calls.turn = [];
  box.createTurnaround3d = async (_p, source) => { box.calls.turn.push(source); return { ok: true, boxJobId: 'turn-1' }; };
  box.fetchSheet = async (p, id) => (id === 'turn-1' ? { ok: true, png: sheetPng(3, dirs.length, 1) } : fetchSheet(p, id));
  box.fetchAtlas = async (p, id) => (id === 'turn-1'
    ? { ok: true, atlas: { cell: { w: CW, h: CH }, rows: dirs.map((direction, row) => ({ row, direction })) } }
    : fetchAtlas(p, id));
  return box;
}
function turnBase(pairs) {
  const base = baseSheet(pairs, 2);
  base.manifest.unmirrored = { idle: ['s', 'e'] };
  base.manifest.turnaround3d = { box_job_id: 'turn-old' };
  return base;
}

test('3D: a re-run drawing only new walk rows makes no turnaround call and keeps unmirrored.idle', async () => {
  const base = turnBase([['idle', 's'], ['idle', 'e']]);
  const box = turnaroundBox();
  const { queue, store } = await run({
    rows: [wolfRow({ actions: ['idle', 'walk'] })], queueOpts: { candidates: [baseRow()] }, store: storeWith(base), box, provider: PROVIDER_3D,
  });
  assert.deepEqual(queue.log.failed, []);
  assert.deepEqual(box.calls.create[0].actions, ['walk']);
  assert.deepEqual(box.calls.turn, []);
  const m = storedManifest(store);
  assert.deepEqual(m.unmirrored, { idle: ['s', 'e'] });
  assert.deepEqual(m.turnaround3d, { box_job_id: 'turn-old' });
  assert.equal(m.reused_cells, 4);
  assert.deepEqual(cellSource(store, m, 'idle/s/0'), [1, 0, 0]);
});

test('3D: a re-run drawing an idle row runs the turnaround; replaced kept cells leave the counts', async () => {
  // idle/e missing -> drawn; idle/s + walk/s + walk/e kept (6 cells); the turnaround replaces idle/s and idle/e.
  const base = turnBase([['idle', 's'], ['walk', 's'], ['walk', 'e']]);
  base.manifest.unmirrored = { idle: ['s'] };
  const box = turnaroundBox();
  const { queue, store } = await run({
    rows: [wolfRow({ actions: ['idle', 'walk'] })], queueOpts: { candidates: [baseRow()] }, store: storeWith(base), box, provider: PROVIDER_3D,
  });
  assert.deepEqual(queue.log.failed, []);
  assert.deepEqual([box.calls.create[0].actions, box.calls.create[0].directions], [['idle'], ['e']]);
  assert.deepEqual(box.calls.turn, ['box-1']);
  const m = storedManifest(store);
  assert.deepEqual(cellSource(store, m, 'idle/s/1'), [3, 0, 0], 'turnaround cell');
  assert.deepEqual(cellSource(store, m, 'idle/e/0'), [3, 1, 0], 'turnaround cell');
  assert.deepEqual(cellSource(store, m, 'walk/e/1'), [1, 2, 1], 'kept');
  assert.equal(m.reused_cells, 4);
  assert.deepEqual(m.turnaround3d, { box_job_id: 'turn-1' });
  assert.deepEqual(m.unmirrored.idle, ['s', 'e']);
  assert.deepEqual(queue.log.notes.map((n) => n.note), ['reused 4 of 8 cells from sheet 2026-10-30 12:34']);
});

test('3D: a drawn idle row takes every idle cell from the new draw, not the base turnaround cells (M3)', async () => {
  // idle/e is missing -> drawn. With a non-3D provider the turnaround does not run, so the
  // row must be wholly 2D from the new draw; idle/s (whole) stays the base's.
  const base = turnBase([['idle', 's']]);
  const { queue, store } = await run({
    rows: [wolfRow()], queueOpts: { candidates: [baseRow()] }, store: storeWith(base),
  });
  assert.deepEqual(queue.log.failed, []);
  const m = storedManifest(store);
  assert.deepEqual(cellSource(store, m, 'idle/s/0'), [1, 0, 0]);
  assert.deepEqual(cellSource(store, m, 'idle/e/0'), [2, 0, 0]);
  assert.deepEqual(cellSource(store, m, 'idle/e/1'), [2, 0, 1]);
  assert.equal(m.reused_cells, 2);
});

test('3D: frames 2 -> 6 on a turnaround base draws the idle rows whole', async () => {
  const base = turnBase([['idle', 's'], ['idle', 'e']]);
  const { queue, store } = await run({
    rows: [wolfRow({ frames_per_action: 6 })], queueOpts: { candidates: [baseRow()] }, store: storeWith(base),
  });
  assert.deepEqual(queue.log.failed, []);
  const m = storedManifest(store);
  assert.equal(m.reused_cells, 0);
  assert.equal(m.turnaround3d, undefined);
  for (let i = 0; i < 6; i += 1) assert.equal(cellSource(store, m, `idle/s/${i}`)[0], 2);
});

test('3D: the no-draw path makes no box call and keeps unmirrored.idle', async () => {
  const base = turnBase([['idle', 's'], ['idle', 'e']]);
  const box = turnaroundBox();
  const { queue, store } = await run({
    rows: [wolfRow()], queueOpts: { candidates: [baseRow()] }, store: storeWith(base), box, provider: PROVIDER_3D,
  });
  assert.deepEqual(queue.log.failed, []);
  assert.equal(box.calls.create.length, 0);
  assert.deepEqual(box.calls.turn, []);
  const m = storedManifest(store);
  assert.deepEqual(m.unmirrored, { idle: ['s', 'e'] });
  assert.deepEqual(m.turnaround3d, { box_job_id: 'turn-old' });
});

test('a base lookup that throws is logged and falls back to a full draw', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)));
  const base = baseSheet([['idle', 's'], ['idle', 'e']], 2);
  // (a) the candidate query fails
  const queueThrows = fakeQueue([wolfRow()]);
  queueThrows.reuseBaseCandidates = async () => { throw new Error('db down'); };
  const box = fakeBox();
  const d = createDispatcher({
    db: { query: async () => ({ rows: [] }) }, queue: queueThrows, box, store: storeWith(base), boxCancels,
    concepts: { getKept: async () => KEPT, upsertKept: async () => ({}), removeKept: async () => {} },
    loadProvider: async () => PROVIDER, pollMs: 1, stallMs: 300,
  });
  await d.start();
  assert.deepEqual(queueThrows.log.failed, []);
  assert.equal(queueThrows.log.completed.length, 1);
  assert.deepEqual(box.calls.create[0].directions, ['s', 'e']);
  assert.equal(queueThrows.log.attached[0].reuseBaseId, undefined);
  // (b) reading a candidate's file fails with a non-missing error
  const store = storeWith(base);
  const get = store.getObjectStream;
  store.getObjectStream = async (key) => {
    if (key === `${BASE_PREFIX}concept.png`) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return get(key);
  };
  const b = await run({ rows: [wolfRow()], queueOpts: { candidates: [baseRow()] }, store });
  assert.deepEqual(b.queue.log.failed, []);
  assert.equal(b.box.calls.create.length, 1);
  assert.deepEqual(b.box.calls.create[0].directions, ['s', 'e']);
  assert.equal(storedManifest(b.store).reused_from, undefined);
  assert.ok(errors.some((e) => /db down/.test(e)), 'logged');
  assert.ok(errors.some((e) => /ECONNREFUSED/.test(e)), 'logged');
});

test('a resumed job whose base manifest will not parse fails as unreadable', async () => {
  const base = baseSheet([['idle', 's']], 2);
  const store = storeWith(base, { extra: { [`${BASE_PREFIX}sheet.json`]: Buffer.from('{not json') } });
  const { queue } = await run({
    rows: [wolfRow({ box_job_id: 'box-old', concept_key: `${PREFIX}concept.png`, reuse_base_id: BASE_ID })],
    queueOpts: { byId: { [BASE_ID]: baseRow() } },
    store,
  });
  assert.equal(queue.log.failed.length, 1);
  assert.equal(queue.log.failed[0].message, `the earlier sheet ${BASE_ID} is unreadable`);
});
