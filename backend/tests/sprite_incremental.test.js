const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeRGBA } = require('../src/services/pngAlpha.js');
const { encodeRGBA } = require('../src/services/pngTrim.js');
const { planReuse, mergeSheets } = require('../src/services/spriteIncremental.js');

const CW = 4;
const CH = 4;

// Sheet whose pixel colour encodes (tag, action, direction, frame) so provenance is checkable.
function makeSheet(tag, actions, directions, frames, { extraRows = [], quality } = {}) {
  const pairs = [];
  for (const a of actions) for (const d of directions) pairs.push([a, d]);
  for (const r of extraRows) pairs.push(r);
  const W = CW * frames;
  const H = CH * pairs.length;
  const px = Buffer.alloc(W * H * 4);
  const out = {};
  const rows = [];
  pairs.forEach(([a, d], r) => {
    rows.push({ row: r, action: a, direction: d, frames });
    for (let i = 0; i < frames; i += 1) {
      out[`${a}/${d}/${i}`] = [i * CW, r * CH, CW, CH];
      for (let y = 0; y < CH; y += 1) for (let x = 0; x < CW; x += 1) {
        const o = ((r * CH + y) * W + i * CW + x) * 4;
        px[o] = tag; px[o + 1] = r * 10 + i; px[o + 2] = y * 10 + x; px[o + 3] = 255;
      }
    }
  });
  const manifest = {
    version: 1, sheet: 'sheet.png', concept: 'concept.png', engine: 'box', box_job_id: `job-${tag}`,
    cell: [CW, CH], actions: [...actions], frames_per_action: frames, rows, frames: out,
  };
  if (quality) manifest.quality = quality;
  return { png: encodeRGBA(W, H, px), manifest };
}
const q = (a, d, f, passed = true) => ({ action: a, direction: d, frame: f, passed, failed_checks: passed ? [] : ['x'] });
const pixelsAt = (img, rect) => {
  const [x, y, w, h] = rect; const rows = [];
  for (let j = 0; j < h; j += 1) rows.push(img.px.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4).toString('hex'));
  return rows;
};
const same = (imgA, rA, imgB, rB) => assert.deepEqual(pixelsAt(imgA, rA), pixelsAt(imgB, rB));

test('planReuse: full base, nothing to draw', () => {
  const base = makeSheet(1, ['idle', 'walk'], ['s', 'e'], 2);
  const p = planReuse({ actions: ['idle', 'walk'], directions: ['s', 'e'], frames: 2, baseManifest: base.manifest });
  assert.equal(p.total, 8);
  assert.equal(p.keep.size, 8);
  assert.deepEqual(p.drawRows, []);
  assert.equal(p.jobSpec, null);
});

test('planReuse: a row with a flagged cell is drawn; its good cells are kept, flagged ones come from the new draw', () => {
  const base = makeSheet(1, ['idle'], ['s'], 3, { quality: [q('idle', 's', 1, false), q('idle', 's', 0)] });
  const p = planReuse({ actions: ['idle'], directions: ['s'], frames: 3, baseManifest: base.manifest });
  assert.deepEqual([...p.keep].sort(), ['idle/s/0', 'idle/s/2']);
  assert.deepEqual(p.drawRows, [{ action: 'idle', direction: 's' }]);
  assert.deepEqual(p.jobSpec, { actions: ['idle'], directions: ['s'] });
});

test('planReuse: a row whose every cell is flagged is drawn whole (SOMET-702 I1)', () => {
  const base = makeSheet(1, ['idle'], ['s', 'e'], 2, { quality: [q('idle', 's', 0, false), q('idle', 's', 1, false)] });
  const p = planReuse({ actions: ['idle'], directions: ['s', 'e'], frames: 2, baseManifest: base.manifest });
  assert.deepEqual([...p.keep].sort(), ['idle/e/0', 'idle/e/1']);
  assert.deepEqual(p.drawRows, [{ action: 'idle', direction: 's' }]);
  assert.deepEqual(p.jobSpec, { actions: ['idle'], directions: ['s'] });
});

test('planReuse: a flag in a mirrored western row draws nothing; the game shows the eastern row flipped (SOMET-708)', () => {
  const base = makeSheet(1, ['idle'], ['e', 'w', 'nw'], 2, { quality: [q('idle', 'w', 0, false), q('idle', 'nw', 1, false)] });
  const p = planReuse({ actions: ['idle'], directions: ['e', 'w', 'nw'], frames: 2, baseManifest: base.manifest });
  assert.equal(p.keep.size, 6);
  assert.deepEqual(p.drawRows, []);
  assert.equal(p.jobSpec, null);
});

test('planReuse: a flag in an unmirrored western row still draws it (SOMET-708)', () => {
  const base = makeSheet(1, ['idle'], ['e', 'w'], 2, { quality: [q('idle', 'w', 0, false)] });
  base.manifest.unmirrored = { idle: ['w'] };
  const p = planReuse({ actions: ['idle'], directions: ['e', 'w'], frames: 2, baseManifest: base.manifest });
  assert.deepEqual(p.drawRows, [{ action: 'idle', direction: 'w' }]);
  assert.deepEqual([...p.keep].sort(), ['idle/e/0', 'idle/e/1', 'idle/w/1']);
});

test('planReuse: a missing cell in a mirrored western row is still drawn (SOMET-708)', () => {
  const base = makeSheet(1, ['idle'], ['e', 'w'], 2);
  const p = planReuse({ actions: ['idle'], directions: ['e', 'w'], frames: 3, baseManifest: base.manifest });
  assert.deepEqual(p.drawRows, [{ action: 'idle', direction: 'e' }, { action: 'idle', direction: 'w' }]);
});

test('planReuse redraw: every non-mirrored row of the requested actions is drawn whole (SOMET-711)', () => {
  const base = makeSheet(1, ['idle', 'attack'], ['s', 'e', 'w'], 2);
  const p = planReuse({ actions: ['attack'], directions: ['s', 'e', 'w'], frames: 2, baseManifest: base.manifest, redraw: true });
  assert.deepEqual(p.drawRows, [{ action: 'attack', direction: 's' }, { action: 'attack', direction: 'e' }]);
  assert.deepEqual([...p.keep].sort(), ['attack/w/0', 'attack/w/1']);
  assert.deepEqual(p.jobSpec, { actions: ['attack'], directions: ['s', 'e'] });
});

test('planReuse redraw: an unmirrored western row is redrawn too (SOMET-711)', () => {
  const base = makeSheet(1, ['attack'], ['e', 'w'], 2);
  base.manifest.unmirrored = { attack: ['w'] };
  const p = planReuse({ actions: ['attack'], directions: ['e', 'w'], frames: 2, baseManifest: base.manifest, redraw: true });
  assert.deepEqual(p.drawRows, [{ action: 'attack', direction: 'e' }, { action: 'attack', direction: 'w' }]);
  assert.equal(p.keep.size, 0);
});

test('planReuse: every cell good and present makes no draw, even with use-good-frames patches', () => {
  const base = makeSheet(1, ['idle'], ['s'], 2, { quality: [q('idle', 's', 0), { ...q('idle', 's', 1), replaced_from: 'idle/s/0' }] });
  const p = planReuse({ actions: ['idle'], directions: ['s'], frames: 2, baseManifest: base.manifest });
  assert.equal(p.keep.size, 2);
  assert.equal(p.jobSpec, null);
});

test('planReuse: in a drawn row, use-good-frames patched cells (replaced_from) come from the new draw (M2)', () => {
  const base = makeSheet(1, ['idle'], ['s'], 2, { quality: [q('idle', 's', 0), { ...q('idle', 's', 1), replaced_from: 'idle/s/0' }] });
  const p = planReuse({ actions: ['idle'], directions: ['s'], frames: 4, baseManifest: base.manifest });
  assert.deepEqual([...p.keep], ['idle/s/0']);
  assert.deepEqual(p.drawRows, [{ action: 'idle', direction: 's' }]);
});

test('planReuse: a turnaround base keeps no idle cell of a drawn idle row, but whole idle rows and other actions stay (M3)', () => {
  const base = makeSheet(1, ['idle', 'walk'], ['s', 'e'], 2);
  base.manifest.turnaround3d = { box_job_id: 't' };
  delete base.manifest.frames['idle/e/1'];
  delete base.manifest.frames['walk/e/1'];
  const p = planReuse({ actions: ['idle', 'walk'], directions: ['s', 'e'], frames: 2, baseManifest: base.manifest });
  assert.deepEqual([...p.keep].sort(), ['idle/s/0', 'idle/s/1', 'walk/e/0', 'walk/s/0', 'walk/s/1']);
  assert.deepEqual(p.drawRows.map((r) => `${r.action}/${r.direction}`), ['idle/e', 'walk/e']);
});

test('planReuse: missing action and direction produce ordered union jobSpec', () => {
  const base = makeSheet(1, ['idle'], ['s', 'e'], 2);
  const p = planReuse({ actions: ['idle', 'walk', 'attack'], directions: ['s', 'e', 'n'], frames: 2, baseManifest: base.manifest });
  // drawn rows: idle/n, walk/*, attack/*
  assert.deepEqual(p.drawRows.map((r) => `${r.action}/${r.direction}`), [
    'idle/n', 'walk/s', 'walk/e', 'walk/n', 'attack/s', 'attack/e', 'attack/n',
  ]);
  assert.deepEqual(p.jobSpec, { actions: ['idle', 'walk', 'attack'], directions: ['s', 'e', 'n'] });
  assert.equal(p.keep.size, 4);
  assert.equal(p.total, 18);
});

test('planReuse: jobSpec directions follow compass order, actions follow requested order', () => {
  const base = makeSheet(1, ['idle'], ['s'], 1);
  const p = planReuse({ actions: ['idle', 'walk'], directions: ['sw', 's', 'ne'], frames: 1, baseManifest: base.manifest });
  assert.deepEqual(p.jobSpec.directions, ['s', 'ne', 'sw']);
  assert.deepEqual(p.jobSpec.actions, ['idle', 'walk']);
});

test('planReuse: frames 2 -> 6 draws rows whole, keeps frames 0-1 unless flagged', () => {
  const base = makeSheet(1, ['idle'], ['s'], 2, { quality: [q('idle', 's', 1, false)] });
  const p = planReuse({ actions: ['idle'], directions: ['s'], frames: 6, baseManifest: base.manifest });
  assert.deepEqual(p.drawRows, [{ action: 'idle', direction: 's' }]);
  assert.deepEqual([...p.keep], ['idle/s/0']);
  assert.deepEqual(p.jobSpec, { actions: ['idle'], directions: ['s'] });
});

test('mergeSheets: frames 2 -> 6, 0-1 from base, 2-5 and flagged from the new draw', () => {
  const base = makeSheet(1, ['idle'], ['s'], 2, { quality: [q('idle', 's', 0), q('idle', 's', 1, false)] });
  const drawn = makeSheet(2, ['idle'], ['s'], 6, { quality: [0, 1, 2, 3, 4, 5].map((i) => q('idle', 's', i)) });
  const { keep } = planReuse({ actions: ['idle'], directions: ['s'], frames: 6, baseManifest: base.manifest });
  const m = mergeSheets({ actions: ['idle'], directions: ['s'], frames: 6, realWestern: false, base, drawn, keep });
  const img = decodeRGBA(m.png); const b = decodeRGBA(base.png); const d = decodeRGBA(drawn.png);
  assert.equal(img.width, CW * 6);
  assert.equal(Object.keys(m.manifest.frames).length, 6);
  same(img, m.manifest.frames['idle/s/0'], b, base.manifest.frames['idle/s/0']);
  same(img, m.manifest.frames['idle/s/1'], d, drawn.manifest.frames['idle/s/1']); // flagged -> redrawn
  for (let i = 2; i < 6; i += 1) same(img, m.manifest.frames[`idle/s/${i}`], d, drawn.manifest.frames[`idle/s/${i}`]);
  assert.equal(m.manifest.quality.length, 6);
  assert.ok(m.manifest.quality.every((e) => e.passed));
});

test('mergeSheets: extra cartesian rows in the drawn sheet are ignored; shape matches buildBoxSheetManifest', () => {
  const base = makeSheet(1, ['idle'], ['s', 'e'], 2);
  const drawn = makeSheet(2, ['idle', 'walk'], ['s', 'e'], 2, { quality: [q('walk', 'e', 0), q('idle', 'e', 0, false)] });
  const actions = ['idle', 'walk'];
  const directions = ['s', 'e'];
  const { keep } = planReuse({ actions, directions, frames: 2, baseManifest: base.manifest });
  // only walk/s and walk/e are drawn rows; idle rows come from base though drawn has them too
  const m = mergeSheets({ actions, directions, frames: 2, realWestern: false, base, drawn, keep });
  const img = decodeRGBA(m.png); const b = decodeRGBA(base.png); const d = decodeRGBA(drawn.png);
  assert.equal(img.height, CH * 4);
  assert.deepEqual(m.manifest.rows, [
    { row: 0, action: 'idle', direction: 's', frames: 2 }, { row: 1, action: 'idle', direction: 'e', frames: 2 },
    { row: 2, action: 'walk', direction: 's', frames: 2 }, { row: 3, action: 'walk', direction: 'e', frames: 2 },
  ]);
  assert.deepEqual(m.manifest.cell, [CW, CH]);
  assert.deepEqual(m.manifest.actions, actions);
  assert.equal(m.manifest.frames_per_action, 2);
  assert.equal(m.manifest.version, 1);
  assert.equal(m.manifest.sheet, 'sheet.png');
  assert.deepEqual(Object.keys(m.manifest.frames).sort(), [
    'idle/e/0', 'idle/e/1', 'idle/s/0', 'idle/s/1', 'walk/e/0', 'walk/e/1', 'walk/s/0', 'walk/s/1',
  ]);
  for (const k of ['idle/s/0', 'idle/e/1']) same(img, m.manifest.frames[k], b, base.manifest.frames[k]);
  for (const k of ['walk/s/0', 'walk/e/1']) same(img, m.manifest.frames[k], d, drawn.manifest.frames[k]);
  // idle/e/0 quality from the drawn sheet (failed) must NOT leak: idle is kept from base
  assert.ok(!m.manifest.quality.some((e) => e.action === 'idle' && e.direction === 'e' && e.passed === false));
  assert.ok(m.manifest.quality.some((e) => e.action === 'walk' && e.direction === 'e' && e.frame === 0));
});

test('mergeSheets: kept quality from base, drawn quality from new sheet', () => {
  const base = makeSheet(1, ['idle'], ['s'], 2, { quality: [q('idle', 's', 0), q('idle', 's', 1, false)] });
  const { keep } = planReuse({ actions: ['idle', 'walk'], directions: ['s'], frames: 2, baseManifest: base.manifest });
  assert.equal(keep.size, 1); // idle/s/1 flagged
  const drawnFull = makeSheet(2, ['idle', 'walk'], ['s'], 2, { quality: [q('walk', 's', 0, false), q('walk', 's', 1), q('idle', 's', 1)] });
  const m = mergeSheets({ actions: ['idle', 'walk'], directions: ['s'], frames: 2, realWestern: false, base, drawn: drawnFull, keep });
  const find = (a, f) => m.manifest.quality.find((e) => e.action === a && e.frame === f);
  assert.equal(find('idle', 0).passed, true);
  assert.equal(find('walk', 0).passed, false);
  assert.equal(find('idle', 1).passed, true); // flagged base cell replaced by redraw's entry
});

test('mergeSheets: no drawn sheet builds from base only', () => {
  const base = makeSheet(1, ['idle', 'walk'], ['s', 'e'], 2, { quality: [q('idle', 's', 0, false)] });
  // request a subset in a different order
  const actions = ['walk'];
  const directions = ['e'];
  const { keep } = planReuse({ actions, directions, frames: 2, baseManifest: base.manifest });
  const m = mergeSheets({ actions, directions, frames: 2, realWestern: false, base, drawn: null, keep });
  const img = decodeRGBA(m.png); const b = decodeRGBA(base.png);
  assert.equal(img.height, CH);
  assert.deepEqual(Object.keys(m.manifest.frames).sort(), ['walk/e/0', 'walk/e/1']);
  same(img, m.manifest.frames['walk/e/1'], b, base.manifest.frames['walk/e/1']);
  assert.deepEqual(m.manifest.quality, []);
});

test('mergeSheets: a drawn western row is unmirrored only on the drawn manifest\'s word, realWestern is ignored', () => {
  // idle/w missing from the base -> drawn; walk/w fully from the base (base mirrored it).
  const base = makeSheet(1, ['walk'], ['e', 'w'], 1, { extraRows: [['idle', 'e']] });
  const drawn = makeSheet(2, ['idle'], ['e', 'w'], 1);
  const actions = ['idle', 'walk'];
  const directions = ['e', 'w'];
  const p = planReuse({ actions, directions, frames: 1, baseManifest: base.manifest });
  const args = { actions, directions, frames: 1, base, drawn, keep: p.keep };
  assert.equal(mergeSheets({ ...args, realWestern: true }).manifest.unmirrored, undefined);
  drawn.manifest.unmirrored = { idle: ['w'] };
  assert.deepEqual(mergeSheets({ ...args, realWestern: false }).manifest.unmirrored, { idle: ['w'] });
  assert.deepEqual(mergeSheets({ ...args, realWestern: true }).manifest.unmirrored, { idle: ['w'] });
});

test('mergeSheets: base unmirrored directions are kept for rows fully from the base', () => {
  const base = makeSheet(1, ['idle'], ['s', 'e', 'w'], 2);
  base.manifest.unmirrored = { idle: ['s', 'e', 'w'] };
  base.manifest.turnaround3d = { box_job_id: 'turn-1' };
  const actions = ['idle', 'walk'];
  const directions = ['s', 'e', 'w'];
  const drawn = makeSheet(2, ['walk'], directions, 2);
  const p = planReuse({ actions, directions, frames: 2, baseManifest: base.manifest });
  const m = mergeSheets({ actions, directions, frames: 2, base, drawn, keep: p.keep }).manifest;
  assert.deepEqual(m.unmirrored, { idle: ['s', 'e', 'w'] });
  assert.deepEqual(m.turnaround3d, { box_job_id: 'turn-1' }, 'idle rows all from the base keep the turnaround marker');
});

test('mergeSheets: an idle row taken (partly) from the new drawing drops its base unmirrored entry and the turnaround marker', () => {
  const base = makeSheet(1, ['idle'], ['s', 'e'], 2);
  base.manifest.unmirrored = { idle: ['s', 'e'] };
  base.manifest.turnaround3d = { box_job_id: 'turn-1' };
  const directions = ['s', 'e', 'n'];
  // frames 2 -> 3: every idle row is drawn
  const p = planReuse({ actions: ['idle'], directions, frames: 3, baseManifest: base.manifest });
  const m = mergeSheets({ actions: ['idle'], directions, frames: 3, base, drawn: makeSheet(2, ['idle'], directions, 3), keep: p.keep }).manifest;
  assert.equal(m.unmirrored, undefined);
  assert.equal(m.turnaround3d, undefined);
});

test('mergeSheets: no idle requested -> no turnaround marker', () => {
  const base = makeSheet(1, ['idle', 'walk'], ['s'], 1);
  base.manifest.turnaround3d = { box_job_id: 'turn-1' };
  const p = planReuse({ actions: ['walk'], directions: ['s'], frames: 1, baseManifest: base.manifest });
  const m = mergeSheets({ actions: ['walk'], directions: ['s'], frames: 1, base, drawn: null, keep: p.keep }).manifest;
  assert.equal(m.turnaround3d, undefined);
});

test('mergeSheets: throws when a needed cell is in neither source', () => {
  const base = makeSheet(1, ['idle'], ['s'], 1);
  assert.throws(() => mergeSheets({ actions: ['idle', 'walk'], directions: ['s'], frames: 1, realWestern: false, base, drawn: null, keep: new Set(['idle/s/0']) }), /walk\/s\/0/);
  assert.throws(() => mergeSheets({ actions: ['idle', 'walk'], directions: ['s'], frames: 1, realWestern: false, base, drawn: null, keep: new Set(['idle/s/0']) }), { code: 'SPRITE_MERGE' });
});

test('mergeSheets: a flagged cell of a drawn row comes from the new draw, a good cell of another row from the base', () => {
  const base = makeSheet(1, ['idle', 'walk'], ['s'], 2, { quality: [q('idle', 's', 0), q('idle', 's', 1, false), q('walk', 's', 0), q('walk', 's', 1)] });
  const drawn = makeSheet(2, ['idle'], ['s'], 2, { quality: [q('idle', 's', 0), q('idle', 's', 1)] });
  const actions = ['idle', 'walk'];
  const p = planReuse({ actions, directions: ['s'], frames: 2, baseManifest: base.manifest });
  assert.deepEqual(p.jobSpec, { actions: ['idle'], directions: ['s'] });
  const m = mergeSheets({ actions, directions: ['s'], frames: 2, realWestern: false, base, drawn, keep: p.keep });
  same(decodeRGBA(m.png), m.manifest.frames['idle/s/0'], decodeRGBA(base.png), base.manifest.frames['idle/s/0']);
  same(decodeRGBA(m.png), m.manifest.frames['idle/s/1'], decodeRGBA(drawn.png), drawn.manifest.frames['idle/s/1']);
  same(decodeRGBA(m.png), m.manifest.frames['walk/s/1'], decodeRGBA(base.png), base.manifest.frames['walk/s/1']);
  assert.ok(m.manifest.quality.every((e) => e.passed));
});

test('mergeSheets: an all-good base with no draw merges from the base alone', () => {
  const base = makeSheet(1, ['idle'], ['s'], 2, { quality: [q('idle', 's', 0), q('idle', 's', 1)] });
  const p = planReuse({ actions: ['idle'], directions: ['s'], frames: 2, baseManifest: base.manifest });
  assert.equal(p.jobSpec, null);
  const m = mergeSheets({ actions: ['idle'], directions: ['s'], frames: 2, realWestern: false, base, drawn: null, keep: p.keep });
  same(decodeRGBA(m.png), m.manifest.frames['idle/s/1'], decodeRGBA(base.png), base.manifest.frames['idle/s/1']);
});

test('mergeSheets: mismatched drawn cell throws SPRITE_MERGE', () => {
  const base = makeSheet(1, ['idle'], ['s'], 1);
  const drawn = makeSheet(2, ['idle'], ['s'], 1);
  drawn.manifest.cell = [CW + 1, CH];
  assert.throws(() => mergeSheets({ actions: ['idle'], directions: ['s'], frames: 1, base, drawn, keep: new Set() }), { code: 'SPRITE_MERGE' });
});
