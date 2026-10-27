const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pngSize } = require('../src/services/spriteSheet');
const { buildBoxSheetManifest, staticFrameFor } = require('../src/services/spriteSheetManifest');

const FIX = path.join(__dirname, 'fixtures', 'gpuBox');
const load = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const png = (n) => fs.readFileSync(path.join(FIX, n));
const DIRS8 = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];

function wolf(over = {}) {
  return buildBoxSheetManifest({
    atlas: load('atlas-wolf.json'), sheetPng: png('wolf-sheet.png'),
    actions: ['idle'], directions: DIRS8, frames: 2, engine: 'qwen', boxJobId: 'job1', kind: 'creature', ...over,
  });
}
function tree(over = {}) {
  const atlas = load('atlas-tree.json');
  return buildBoxSheetManifest({
    atlas, sheetPng: png('tree-sheet.png'),
    actions: ['idle', 'sway'], directions: ['s'], frames: 2, engine: 'qwen', boxJobId: 'job2', kind: 'object', ...over,
  });
}

test('builds rows and frames from the captured atlas', () => {
  const r = wolf();
  assert.equal(r.ok, true);
  const m = r.manifest;
  const size = pngSize(png('wolf-sheet.png'));
  assert.equal(m.version, 1);
  assert.equal(m.sheet, 'sheet.png');
  assert.equal(m.concept, 'concept.png');
  assert.equal(m.engine, 'qwen');
  assert.equal(m.box_job_id, 'job1');
  assert.deepEqual(m.cell, [48, 64]);
  assert.equal(m.frames_per_action, 2);
  assert.equal(m.rows.length, 8);
  for (const row of m.rows) assert.equal(row.frames, 2);
  assert.deepEqual(m.rows[1], { row: 1, action: 'idle', direction: 'se', frames: 2 });
  assert.deepEqual(m.frames['idle/se/1'], [48, 64, 48, 64]);
  assert.equal(Object.keys(m.frames).length, 16);
  for (const [x, y, w, h] of Object.values(m.frames)) {
    assert.ok(x + w <= size.width && y + h <= size.height);
  }
});

test('rejects a rect outside the sheet', () => {
  const small = Buffer.from(png('wolf-sheet.png'));
  small.writeUInt32BE(48, 16); // width 48: column 1 no longer fits
  const r = wolf({ sheetPng: small });
  assert.equal(r.ok, false);
  assert.match(r.error, /idle\/s\/1/);
});

test('rejects an atlas missing a requested action or facing', () => {
  assert.equal(wolf({ actions: ['idle', 'walk'] }).ok, false);
  const atlas = load('atlas-wolf.json');
  atlas.rows = atlas.rows.filter((r) => r.direction !== 'sw').map((r, i) => ({ ...r, row: i }));
  atlas.grid.rows = 7;
  const r = wolf({ atlas });
  assert.equal(r.ok, false);
  assert.match(r.error, /idle\/sw/);
});

test('rejects frame-count and row-count disagreements', () => {
  assert.equal(wolf({ frames: 3 }).ok, false);
  const atlas = load('atlas-wolf.json');
  atlas.grid.rows = 9;
  assert.equal(wolf({ atlas }).ok, false);
  assert.equal(wolf({ sheetPng: Buffer.from('nope') }).ok, false);
});

test('prop manifest loops the sway row on bare keys', () => {
  const { manifest: m } = tree();
  assert.deepEqual(m.frames['0'], m.frames['sway/s/0']);
  assert.deepEqual(m.frames['1'], m.frames['sway/s/1']);
  assert.notDeepEqual(m.frames['0'], m.frames['idle/s/0']);
});

test('prop without sway loops idle', () => {
  const atlas = load('atlas-tree.json');
  atlas.rows = [atlas.rows[0]];
  atlas.grid.rows = 1;
  const r = tree({ atlas, actions: ['idle'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.frames['0'], r.manifest.frames['idle/s/0']);
});

test('creatures get no bare keys', () => {
  assert.equal('0' in wolf().manifest.frames, false);
});

test('staticFrameFor prefers idle facing south', () => {
  assert.equal(staticFrameFor(wolf().manifest), 'idle/s/0');
  assert.equal(staticFrameFor({ frames: { 'walk/e/0': [0, 0, 1, 1] } }), 'walk/e/0');
});

test('game reads it: only bare keys parse as tile frame keys', () => {
  const keys = Object.keys(tree().manifest.frames).filter((k) => Number.isFinite(parseInt(k, 10)));
  assert.deepEqual(keys, ['0', '1']);
});

test('copies atlas.quality for known frames', () => {
  const atlas = load('atlas-wolf.json');
  const known = { action: 'idle', direction: 's', frame: 1, flags: ['soft'] };
  atlas.quality = [known, { action: 'idle', direction: 's', frame: 99, flags: ['soft'] }];
  const r = wolf({ atlas });
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.quality, [known]);
  assert.equal(r.manifest.version, 1);
});

test('no quality key without atlas.quality', () => {
  assert.equal('quality' in wolf().manifest, false);
});

test('non-array quality is ignored', () => {
  const atlas = load('atlas-wolf.json');
  atlas.quality = { action: 'idle' };
  assert.equal('quality' in wolf({ atlas }).manifest, false);
});
