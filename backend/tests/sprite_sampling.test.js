const test = require('node:test');
const assert = require('node:assert/strict');
const { samplingSpec, expectedSecondsPerCell, sheetDeadlineMs, samplingCatalog } = require('../src/services/spriteSampling.js');

test('on the HQ engine a row with no preset still sends explicit fast values (the HQ default is 20 steps)', () => {
  assert.deepEqual(samplingSpec(null, 'diffusers'), {});
  assert.deepEqual(samplingSpec(null, 'comfyui-hq'), { steps: 4, cfg: 1.0, quant: 'q6_k' });
  assert.deepEqual(samplingSpec('guided_sharp', 'comfyui-hq'), { steps: 6, cfg: 4.0, quant: 'q6_k' });
  assert.deepEqual(samplingSpec('guided_sharp', 'diffusers'), { steps: 6, cfg: 4.0, quant: 'q6_k' });
});

test('expected seconds per cell: preset rate, the HQ rate on HQ; null for the diffusers default', () => {
  assert.equal(expectedSecondsPerCell(null, 'diffusers'), null);
  assert.equal(expectedSecondsPerCell('guided_sharp', 'diffusers'), 290);
  assert.equal(Math.round(expectedSecondsPerCell('guided_sharp', 'comfyui-hq')), 235);
  assert.equal(Math.round(expectedSecondsPerCell(null, 'comfyui-hq')), 40);
});

test('the run deadline covers 3x the expected rate plus 15 min of fixed stages', () => {
  // The cancelled HQ test job: 4 cells, box estimate 492 s, guided_sharp on HQ.
  const rate = expectedSecondsPerCell('guided_sharp', 'comfyui-hq');
  assert.equal(sheetDeadlineMs({ cells: 4, cellTimeoutMs: 120000, estimatedSeconds: 492, secondsPerCell: rate }),
    Math.round((4 * rate * 3 + 900) * 1000));
  // No expected rate: unchanged from before.
  assert.equal(sheetDeadlineMs({ cells: 4, cellTimeoutMs: 120000, estimatedSeconds: 492, secondsPerCell: null }), 1476000);
  assert.equal(sheetDeadlineMs({ cells: 4, cellTimeoutMs: 120000, estimatedSeconds: 0, secondsPerCell: null }), 480000);
});

test('the catalog carries the HQ cost factor for the estimate', () => {
  const c = samplingCatalog();
  assert.equal(c.find((p) => p.id === 'guided_sharp').hq_seconds_per_cell, 235);
  assert.equal(c.find((p) => p.id === null).hq_seconds_per_cell, 40);
});

test('generation methods: fits card fast and slower, larger than VRAM, and 3D', () => {
  const { generationMethods } = require('../src/services/spriteSampling.js');
  const byId = Object.fromEntries(generationMethods().map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(byId), ['fits_fast', 'fits_slow', 'large_sharp', 'large_guided', 'large_guided_sharp', 'turnaround3d']);
  // Fits card: nothing pins a quant, so the box stays on its Q2_K default.
  assert.equal(byId.fits_fast.sampling, null);
  assert.equal(byId.fits_fast.quant, null);
  assert.equal(byId.fits_slow.quant, null);
  assert.ok(byId.fits_slow.steps > byId.fits_fast.steps);
  assert.deepEqual(samplingSpec(byId.fits_slow.sampling), { steps: 8, cfg: 1.0 });
  // Larger than VRAM: every one pins Q6_K.
  for (const id of ['large_sharp', 'large_guided', 'large_guided_sharp']) assert.equal(byId[id].quant, 'q6_k');
  assert.equal(byId.turnaround3d.sheet_method, 'turnaround3d');
  for (const id of ['fits_fast', 'fits_slow', 'large_sharp']) assert.equal(byId[id].sheet_method, '2d');
  // The parked ComfyUI connector draws 2d only and has no Q2_K lane.
  assert.equal(byId.turnaround3d.hq, false);
  assert.equal(byId.fits_slow.hq, false);
});
