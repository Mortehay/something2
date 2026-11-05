'use strict';

// Sampling presets for GPU-box sprite sheets. Each sends `steps`/`cfg`/`quant`
// in the box JobSpec (both engines accept them); NULL on a row sends none, so
// the box uses its engine default (4 steps, cfg 1.0, Q2_K today). CFG above 1.0
// runs a second (negative) pass per step, so it roughly doubles the work.
// The presets pin Q6_K: the box measured them there, and steps/cfg against the
// default Q2_K weights would A/B sampling at the wrong precision.
// A box redraw re-renders at the original job's settings (box config.json).
// secondsPerCell: box job path on Q6_K + group offload (2026-11-03): sharp
// measured 145 s; guided/guided_sharp scaled from it by transformer passes
// (8 and 12 against sharp's 6). Per rendered cell: with MIRROR_WEST an 8-way
// sheet renders 5 directions, so these overstate an 8-way sheet by ~25%.
// fits_slow stays on the box's default Q2_K (no quant sent), which fits the card.
// Box, 2026-11-04, warm passes: 4 steps 30.0 s/cell, 8 steps 58.6 s/cell, linear in
// steps. large_fast is sharp's 145 s scaled by that linearity (4/6), not measured.
//
// CFG ABOVE 1 IS A NO-OP ON DIFFUSERS: with no negative embedding the box clamps it
// to 1.0 (box, 2026-11-04: 0 negative embeddings on real guided jobs). So on that
// engine guided_sharp renders the same as sharp, and guided is just 4 steps. Their
// keys stay for the rows that already hold them and for the ComfyUI connector.
const SAMPLING_PRESETS = {
  fits_slow: { label: 'Fits card, slower', steps: 8, cfg: 1.0, quant: null, secondsPerCell: 59, hqSecondsPerCell: null },
  large_fast: { label: 'Larger than VRAM, 4 steps', steps: 4, cfg: 1.0, quant: 'q6_k', secondsPerCell: 97, hqSecondsPerCell: null },
  sharp: { label: 'Sharper, no negative', steps: 6, cfg: 1.0, quant: 'q6_k', secondsPerCell: 145, hqSecondsPerCell: 118 },
  guided: { label: 'Guided, fewer steps', steps: 4, cfg: 4.0, quant: 'q6_k', secondsPerCell: 190, hqSecondsPerCell: 157 },
  guided_sharp: { label: 'Guided, sharper', steps: 6, cfg: 4.0, quant: 'q6_k', secondsPerCell: 290, hqSecondsPerCell: 235 },
};
const SAMPLING_KEYS = Object.keys(SAMPLING_PRESETS);

// HQ (ComfyUI, parked): measured 235 s/cell at guided_sharp (box,
// 2026-11-03); the other HQ rates are scaled from the harness ratios. Its own
// default is 20 steps, so an HQ row always sends explicit values (HQ_FAST).
const HQ_FAST_SECONDS_PER_CELL = 40;
const HQ_FAST = { steps: 4, cfg: 1.0, quant: 'q6_k' };

// The JobSpec fields for a row's preset on an engine; {} = the box default.
function samplingSpec(key, engine = 'diffusers') {
  const p = key ? SAMPLING_PRESETS[key] : null;
  if (p) return { steps: p.steps, cfg: p.cfg, ...(p.quant ? { quant: p.quant } : {}) };
  return engine === 'comfyui-hq' ? { ...HQ_FAST } : {};
}

// Seconds per cell the box measured for this preset on this engine; null for
// the diffusers default (its rate is the connector's own measured history).
function expectedSecondsPerCell(key, engine = 'diffusers') {
  const p = key ? SAMPLING_PRESETS[key] : null;
  const hq = engine === 'comfyui-hq';
  if (p) return hq ? p.hqSecondsPerCell : p.secondsPerCell;
  return hq ? HQ_FAST_SECONDS_PER_CELL : null;
}

// How long a sheet job may run: the old floor (per-cell timeout, 3x the box's
// own estimate) or, when the rate is known, 3x it plus 15 min for the stages
// that do not scale with cells (concept, turnaround encode, cutout).
function sheetDeadlineMs({ cells, cellTimeoutMs, estimatedSeconds, secondsPerCell }) {
  const floor = Math.max(cells * cellTimeoutMs, (Number(estimatedSeconds) || 0) * 3 * 1000);
  if (!secondsPerCell) return floor;
  return Math.max(floor, Math.round((cells * secondsPerCell * 3 + 900) * 1000));
}

// The list the Sprite tab shows: the box default first (on diffusers its time
// comes from the connector's measured history, so seconds_per_cell is null),
// then the presets; hq_seconds_per_cell is the rate on the HQ engine.
function samplingCatalog() {
  return [
    { id: null, label: 'Fast (box default)', steps: 4, cfg: 1.0, quant: null, seconds_per_cell: null,
      hq_seconds_per_cell: Math.round(expectedSecondsPerCell(null, 'comfyui-hq')) },
    ...SAMPLING_KEYS.map((id) => {
      const p = SAMPLING_PRESETS[id];
      return {
        id, label: p.label, steps: p.steps, cfg: p.cfg, quant: p.quant, seconds_per_cell: p.secondsPerCell,
        hq_seconds_per_cell: Math.round(expectedSecondsPerCell(id, 'comfyui-hq')),
      };
    }),
  ];
}

// What the Sprite tab's Generation method select offers: each entry is a
// sampling preset plus how the directions are drawn. hq = false: the parked
// ComfyUI connector cannot run it (it draws 2d only and has no Q2_K lane).
const METHOD_DEFS = [
  { id: 'fits_fast', label: 'Fits card, fast', sampling: null, sheet_method: '2d', hq: true },
  { id: 'fits_slow', label: 'Fits card, slower', sampling: 'fits_slow', sheet_method: '2d', hq: false },
  { id: 'large_fast', label: 'Larger than VRAM, 4 steps', sampling: 'large_fast', sheet_method: '2d', hq: false },
  { id: 'large_sharp', label: 'Larger than VRAM, 6 steps', sampling: 'sharp', sheet_method: '2d', hq: true },
  // ComfyUI only: on diffusers their cfg is clamped to 1.0 (see above).
  { id: 'large_guided', label: 'Guided, 4 steps', sampling: 'guided', sheet_method: '2d', hq: true, diffusers: false },
  { id: 'large_guided_sharp', label: 'Guided, 6 steps', sampling: 'guided_sharp', sheet_method: '2d', hq: true, diffusers: false },
  { id: 'turnaround3d', label: '3D turnaround (static idle from a 3D model)', sampling: null, sheet_method: 'turnaround3d', hq: false },
];

function generationMethods() {
  const presets = samplingCatalog();
  return METHOD_DEFS.map((m) => {
    const { steps, cfg, quant, seconds_per_cell, hq_seconds_per_cell } = presets.find((p) => p.id === m.sampling);
    return { ...m, steps, cfg, quant, seconds_per_cell, hq_seconds_per_cell };
  });
}

module.exports = { generationMethods, SAMPLING_PRESETS, SAMPLING_KEYS, samplingSpec, expectedSecondsPerCell, sheetDeadlineMs, samplingCatalog };
