const test = require('node:test');
const assert = require('node:assert/strict');
const eta = require('../src/services/spriteEta.js');
const near = (got, want, pct) => assert.ok(Math.abs(got - want) / want <= pct, `${got} vs ${want}`);

test('replays box job 3990224b (1 action x 8 dirs x 6 frames, 4 steps, QA on, redraw 988 s) within 2% of the 2,322 s actual', () => {
  const dirs = ['s','se','e','ne','n','nw','w','sw'];
  const r = eta.boxSeconds({ actions: ['walk'], directions: dirs, frames: 6, secondsPerCell: 32, qualityChecks: true, measuredRedrawSeconds: 988 });
  near(r.typical, 2322, 0.02);
});
test('replays box job 98045cb9 (7 x 3 dirs x 4 frames, 8 steps, redraw 7,751 s) within 2% of the 13,254 s actual', () => {
  const r = eta.boxSeconds({ actions: ['idle','walk','attack','cast','damage','death','use'], directions: ['s','e','n'], frames: 4, secondsPerCell: 60, qualityChecks: true, measuredRedrawSeconds: 7751 });
  near(r.typical, 13254, 0.02);
});
test('default lane humanoid (7 actions, s/e/n, 4 frames, 4 steps, QA off) is ~49 min and a single number', () => {
  const r = eta.boxSeconds({ actions: Array(7).fill('a'), directions: ['s','e','n'], frames: 4, secondsPerCell: 32, qualityChecks: false });
  assert.equal(r.low, r.high);
  near(r.typical, 2950, 0.03);
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
test('seconds per cell: 4 steps 32, 8 steps 60, 6 steps by the linear rule, presets their own rate', () => {
  assert.equal(eta.secondsPerCellFor({ steps: 4 }), 32);
  assert.equal(eta.secondsPerCellFor({ steps: 8 }), 60);
  near(eta.secondsPerCellFor({ steps: 6 }), 47.5, 0.001);
  assert.equal(eta.secondsPerCellFor({ sampling: 'sharp' }), 145);
  assert.equal(eta.secondsPerCellFor({ sampling: 'sharp', engine: 'comfyui-hq' }), 118);
});
test('calibration inverts a QA-off sheet back to its seconds per cell', () => {
  const t = eta.boxSeconds({ actions: Array(7).fill('a'), directions: ['s','e','n'], frames: 4, secondsPerCell: 30, qualityChecks: false }).typical;
  near(eta.calibrateSecondsPerCell({ sheetSeconds: t, cells: 84, requestedFacings: 3 }), 30, 0.01);
});
test('secondsPerCellFor: steps null reads as 4 steps; a preset with no HQ rate falls back to its own', () => {
  assert.equal(eta.secondsPerCellFor({ steps: null }), 32);
  assert.equal(eta.secondsPerCellFor({}), 32);
  assert.equal(eta.secondsPerCellFor({ sampling: 'fits_slow', engine: 'comfyui-hq' }), 59);
  assert.equal(eta.secondsPerCellFor({ sampling: 'large_fast', engine: 'comfyui-hq' }), 97);
});
