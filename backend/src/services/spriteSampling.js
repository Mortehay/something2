'use strict';

// Sampling presets for GPU-box sprite sheets. Each sends `steps`/`cfg` in the
// box JobSpec (both engines accept them); NULL on a row sends neither, so the
// box uses its engine default (4 steps, cfg 1.0 today). CFG above 1.0 runs a
// second (negative) pass per step, so it roughly doubles the work.
// secondsPerCell: measured by the box on Q6_K + offload (2026-11-03), used only
// as a ratio against the box-default rate, which is FAST_SECONDS_PER_CELL there.
const FAST_SECONDS_PER_CELL = 30;
const SAMPLING_PRESETS = {
  sharp: { label: 'Sharper, no negative', steps: 6, cfg: 1.0, secondsPerCell: 88 },
  guided: { label: 'Guided, fewer steps', steps: 4, cfg: 4.0, secondsPerCell: 117 },
  guided_sharp: { label: 'Guided, sharper', steps: 6, cfg: 4.0, secondsPerCell: 175 },
};
const SAMPLING_KEYS = Object.keys(SAMPLING_PRESETS);

// The JobSpec fields for a row's preset; {} for NULL or an unknown key.
function samplingSpec(key) {
  const p = key ? SAMPLING_PRESETS[key] : null;
  return p ? { steps: p.steps, cfg: p.cfg } : {};
}

// How many times the box-default rate a preset costs (1 for NULL).
function samplingCostRatio(key) {
  const p = key ? SAMPLING_PRESETS[key] : null;
  return p ? p.secondsPerCell / FAST_SECONDS_PER_CELL : 1;
}

// The list the Sprite tab shows: the box default first, then the presets.
function samplingCatalog() {
  return [
    { id: null, label: 'Fast (box default)', steps: 4, cfg: 1.0, cost_ratio: 1 },
    ...SAMPLING_KEYS.map((id) => ({
      id, label: SAMPLING_PRESETS[id].label, steps: SAMPLING_PRESETS[id].steps,
      cfg: SAMPLING_PRESETS[id].cfg, cost_ratio: samplingCostRatio(id),
    })),
  ];
}

module.exports = { SAMPLING_PRESETS, SAMPLING_KEYS, samplingSpec, samplingCostRatio, samplingCatalog };
