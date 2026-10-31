const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { applyTurnaround } = require('../src/services/spriteTurnaround.js');
const { buildBoxSheetManifest } = require('../src/services/spriteSheetManifest.js');
const { decodeRGBA } = require('../src/services/pngAlpha.js');
const { turnaroundFor } = require('./helpers/turnaroundFixture.js');

const FX = path.join(__dirname, 'fixtures', 'gpuBox');
const WOLF_SHEET = fs.readFileSync(path.join(FX, 'wolf-sheet.png'));
const WOLF_ATLAS = JSON.parse(fs.readFileSync(path.join(FX, 'atlas-wolf.json'), 'utf8'));
const DIRS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];

const wolfManifest = () => buildBoxSheetManifest({
  atlas: WOLF_ATLAS, sheetPng: WOLF_SHEET, actions: ['idle'], directions: DIRS, frames: 2,
  engine: 'x', boxJobId: 'box-1', kind: 'creature',
}).manifest;

const pixel = (png, x, y) => {
  const img = decodeRGBA(png);
  return [...img.px.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
};

test('every idle frame of a turned direction becomes that direction\'s turnaround cell', () => {
  const manifest = wolfManifest();
  const t = turnaroundFor(DIRS);
  const r = applyTurnaround({ sheetPng: WOLF_SHEET, manifest, turnaroundPng: t.png, turnaroundAtlas: t.atlas });
  assert.equal(r.ok, true, r.error);
  for (const [i, dir] of DIRS.entries()) {
    for (const f of [0, 1]) {
      const [x, y] = manifest.frames[`idle/${dir}/${f}`];
      const v = (i + 1) * 10;
      assert.deepEqual(pixel(r.png, x + 5, y + 7), [v, v, v, v], `idle/${dir}/${f}`);
    }
  }
  assert.deepEqual(r.manifest.unmirrored, { idle: DIRS });
  assert.deepEqual(r.manifest.frames, manifest.frames, 'frame rects are unchanged');
});

test('directions the turnaround lacks keep their 2D frames and stay mirrored', () => {
  const manifest = wolfManifest();
  const t = turnaroundFor(['s', 'w']);
  const r = applyTurnaround({ sheetPng: WOLF_SHEET, manifest, turnaroundPng: t.png, turnaroundAtlas: t.atlas });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.manifest.unmirrored.idle, ['s', 'w']);
  const [x, y] = manifest.frames['idle/e/0'];
  for (const [dx, dy] of [[0, 0], [20, 30], [47, 63]]) {
    assert.deepEqual(pixel(r.png, x + dx, y + dy), pixel(WOLF_SHEET, x + dx, y + dy));
  }
});

test('refuses, with a reason, what it cannot paste', () => {
  const manifest = wolfManifest();
  const ok = turnaroundFor(DIRS);
  const cases = [
    [{ turnaroundAtlas: {} }, /missing cell or rows/],
    [{ ...(() => { const t = turnaroundFor(DIRS, { w: 96, h: 128 }); return { turnaroundPng: t.png, turnaroundAtlas: t.atlas }; })() }, /96x128.*48x64/],
    [{ turnaroundPng: Buffer.from('nope') }, /turnaround is not an 8-bit RGBA PNG/],
    [{ turnaroundAtlas: { ...ok.atlas, rows: [{ row: 0, direction: 'up' }] } }, /no direction/],
    [{ turnaroundAtlas: { ...ok.atlas, rows: [{ row: 30, direction: 's' }] } }, /outside/],
  ];
  for (const [over, re] of cases) {
    const r = applyTurnaround({ sheetPng: WOLF_SHEET, manifest, turnaroundPng: ok.png, turnaroundAtlas: ok.atlas, ...over });
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  }
});
