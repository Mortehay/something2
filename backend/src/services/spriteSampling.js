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

// The JobSpec fields for a row's preset; {} for NULL or an unknown key.
function samplingSpec(key) {
  const p = key ? SAMPLING_PRESETS[key] : null;
  return p ? { steps: p.steps, cfg: p.cfg, quant: p.quant } : {};
}

// The list the Sprite tab shows: the box default first (its time comes from the
// connector's measured history, so seconds_per_cell is null), then the presets.
function samplingCatalog() {
  return [
    { id: null, label: 'Fast (box default)', steps: 4, cfg: 1.0, quant: null, seconds_per_cell: null },
    ...SAMPLING_KEYS.map((id) => {
      const p = SAMPLING_PRESETS[id];
      return { id, label: p.label, steps: p.steps, cfg: p.cfg, quant: p.quant, seconds_per_cell: p.secondsPerCell };
    }),
  ];
}

module.exports = { SAMPLING_PRESETS, SAMPLING_KEYS, samplingSpec, samplingCatalog };
