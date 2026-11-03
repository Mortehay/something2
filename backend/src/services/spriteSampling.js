'use strict';

// Sampling presets for GPU-box sprite sheets. Each sends `steps`/`cfg`/`quant`
// in the box JobSpec (both engines accept them); NULL on a row sends none, so
// the box uses its engine default (4 steps, cfg 1.0, Q2_K today). CFG above 1.0
// runs a second (negative) pass per step, so it roughly doubles the work.
// The presets pin Q6_K: the box measured them there, and steps/cfg against the
// default Q2_K weights would A/B sampling at the wrong precision.
// A box redraw re-renders at the original job's settings (box config.json).
// secondsPerCell: measured by the box on Q6_K + offload (2026-11-03).
const SAMPLING_PRESETS = {
  sharp: { label: 'Sharper, no negative', steps: 6, cfg: 1.0, quant: 'q6_k', secondsPerCell: 88 },
  guided: { label: 'Guided, fewer steps', steps: 4, cfg: 4.0, quant: 'q6_k', secondsPerCell: 117 },
  guided_sharp: { label: 'Guided, sharper', steps: 6, cfg: 4.0, quant: 'q6_k', secondsPerCell: 175 },
};
const SAMPLING_KEYS = Object.keys(SAMPLING_PRESETS);

// The box default (4 steps, cfg 1.0) measured on Q6_K; the HQ (ComfyUI) engine
// is ~235/175 slower for the same output (box, 2026-11-03), and its own
// default is 20 steps, so an HQ row always sends explicit values.
const FAST_SECONDS_PER_CELL = 30;
const HQ_COST_FACTOR = 235 / 175;
const HQ_FAST = { steps: 4, cfg: 1.0, quant: 'q6_k' };

// The JobSpec fields for a row's preset on an engine; {} = the box default.
function samplingSpec(key, engine = 'diffusers') {
  const p = key ? SAMPLING_PRESETS[key] : null;
  if (p) return { steps: p.steps, cfg: p.cfg, quant: p.quant };
  return engine === 'comfyui-hq' ? { ...HQ_FAST } : {};
}

// Seconds per cell the box measured for this preset on this engine; null for
// the diffusers default (its rate is the connector's own measured history).
function expectedSecondsPerCell(key, engine = 'diffusers') {
  const p = key ? SAMPLING_PRESETS[key] : null;
  const hq = engine === 'comfyui-hq';
  if (p) return p.secondsPerCell * (hq ? HQ_COST_FACTOR : 1);
  return hq ? FAST_SECONDS_PER_CELL * HQ_COST_FACTOR : null;
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

module.exports = { SAMPLING_PRESETS, SAMPLING_KEYS, samplingSpec, expectedSecondsPerCell, sheetDeadlineMs, samplingCatalog };
