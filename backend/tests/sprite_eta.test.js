const test = require('node:test');
const assert = require('node:assert/strict');
const eta = require('../src/services/spriteEta.js');
const near = (got, want, pct) => assert.ok(Math.abs(got - want) / want <= pct, `${got} vs ${want}`);

const ACCEPT = { actions: ['a','b','c','d','e','f'], directions: ['s', 'e', 'n'], frames: 4, qualityChecks: false };
// 72 cells = 6 actions x 3 facings x 4 frames, D = 3.
test('box job 6262e6b5 (72 cells, D=3, 4 steps, ref 1024) predicts 2,550 s, the box measured 2,549', () => {
  const c = eta.secondsPerCellFor({ steps: 4, refSize: 1024 });
  assert.equal(c, 30.4);
  near(eta.boxSeconds({ ...ACCEPT, secondsPerCell: c }).typical, 2550, 0.01);
});
test('the same spec at the 768 default is ~2,020 s', () => {
  const c = eta.secondsPerCellFor({ steps: 4 });
  assert.equal(c, 23.5);
  near(eta.boxSeconds({ ...ACCEPT, secondsPerCell: c }).typical, 2020, 0.01);
});
test('8 steps at 768 uses the measured 46.5; at 1024 the measured 60', () => {
  assert.equal(eta.secondsPerCellFor({ steps: 8 }), 46.5);
  assert.equal(eta.secondsPerCellFor({ steps: 8, refSize: 1024 }), 60);
});
test('fixed overhead is the box 270 s plus c*(N+D), no per-cell overhead', () => {
  assert.equal(eta.ETA_MODEL.fixedSeconds, 270);
  assert.equal(eta.ETA_MODEL.perCellOverhead, 0);
  assert.equal(eta.boxSeconds({ actions: ['idle'], directions: ['s'], frames: 1, secondsPerCell: 10, qualityChecks: false }).typical, 290);
});
test('default lane humanoid (7 actions, s/e/n, 4 frames, 4 steps, 768, QA off) is a single number', () => {
  const r = eta.boxSeconds({ actions: Array(7).fill('a'), directions: ['s','e','n'], frames: 4, secondsPerCell: 23.5, qualityChecks: false });
  assert.equal(r.low, r.high);
  near(r.typical, 270 + 23.5 * 87, 0.001);
});
test('QA on gives a range: low has no redraw, high > typical > low', () => {
  const r = eta.boxSeconds({ actions: Array(7).fill('a'), directions: ['s','e','n'], frames: 4, secondsPerCell: 32, qualityChecks: true });
  assert.ok(r.low < r.typical && r.typical < r.high);
});
test('west facings are mirrored: N ignores w/nw/sw, D does not', () => {
  assert.equal(eta.cellsOf({ actions: ['idle'], directions: ['s','e','n','w'], frames: 4 }), 12);
  assert.ok(eta.boxSeconds({ actions: ['idle'], directions: ['s','e','n','w'], frames: 4, secondsPerCell: 32, qualityChecks: false }).typical
    > eta.boxSeconds({ actions: ['idle'], directions: ['s','e','n'], frames: 4, secondsPerCell: 32, qualityChecks: false }).typical);
});
test('seconds per cell: other step counts by the box rule, scaled by size; presets scale by f(ref)', () => {
  near(eta.secondsPerCellFor({ steps: 6 }), (7.4 * 6 + 0.8) * 0.77, 0.001);
  near(eta.secondsPerCellFor({ steps: 6, refSize: 1024 }), 7.4 * 6 + 0.8, 0.001);
  near(eta.secondsPerCellFor({ steps: 6, refSize: 512 }), (7.4 * 6 + 0.8) * 0.58, 0.001);
  near(eta.secondsPerCellFor({ sampling: 'sharp' }), 145 * 0.77, 0.001);
  assert.equal(eta.secondsPerCellFor({ sampling: 'sharp', refSize: 1024 }), 145);
  assert.equal(eta.secondsPerCellFor({ sampling: 'sharp', engine: 'comfyui-hq' }), 118);
  assert.equal(eta.secondsPerCellFor({ sampling: 'sharp', engine: 'comfyui-hq', refSize: 512 }), 118, 'HQ has no ref_size');
});
test('calibration inverts a QA-off sheet back to its seconds per cell', () => {
  const t = eta.boxSeconds({ actions: Array(7).fill('a'), directions: ['s','e','n'], frames: 4, secondsPerCell: 30, qualityChecks: false }).typical;
  near(eta.calibrateSecondsPerCell({ sheetSeconds: t, cells: 84, requestedFacings: 3 }), 30, 0.001);
  assert.equal(eta.calibrateSecondsPerCell({ sheetSeconds: 2550, cells: 72, requestedFacings: 3 }), (2550 - 270) / 75);
});
test('secondsPerCellFor: steps null reads as 4 steps; a preset with no HQ rate falls back to its own', () => {
  assert.equal(eta.secondsPerCellFor({ steps: null }), 23.5);
  assert.equal(eta.secondsPerCellFor({}), 23.5);
  assert.equal(eta.secondsPerCellFor({ sampling: 'fits_slow', engine: 'comfyui-hq' }), 59);
  assert.equal(eta.secondsPerCellFor({ sampling: 'large_fast', engine: 'comfyui-hq' }), 97);
});
test('comfyui-hq at the default sampling uses the HQ fast rate the dispatcher counts down with', () => {
  const { HQ_FAST_SECONDS_PER_CELL } = require('../src/services/spriteSampling.js');
  assert.equal(eta.secondsPerCellFor({ steps: 4, engine: 'comfyui-hq' }), HQ_FAST_SECONDS_PER_CELL);
  assert.equal(HQ_FAST_SECONDS_PER_CELL, 40);
});
test('comfyui-hq with no preset is the HQ fast rate (40) at any refSize and steps; never the 768 anchors', () => {
  for (const refSize of [undefined, 512, 768, 1024]) {
    for (const steps of [null, 4, 8]) {
      assert.equal(eta.secondsPerCellFor({ steps, engine: 'comfyui-hq', refSize }), 40);
    }
  }
});
