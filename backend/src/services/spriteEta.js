// Box time estimate for a sprite sheet (spec §5). Pure; mirrored in the frontend.
// seconds = 270 + c*(N + D) + X   (the box's own card-time formula, 2026-11-09)
//   c = (7.4*steps + 0.8) * f(ref), D = requested facings, N = rendered cells,
//   X = redraw time. Excludes queue wait, model switch and QA redraw rounds.
const { SAMPLING_PRESETS, HQ_FAST_SECONDS_PER_CELL } = require('./spriteSampling.js');

const ETA_MODEL = Object.freeze({
  fixedSeconds: 270,
  perCellOverhead: 0,
  roundSeconds: 40,
  r: Object.freeze({ low: 0, typical: 0.3, high: 1.45 }),
  rounds: Object.freeze({ low: 0, typical: 1, high: 3 }),
  gatewaySwitchMaxSeconds: 300,
});

const MIRRORED = ['w', 'nw', 'sw'];

// The reference size the dispatcher asks the box for on the diffusers lane, and the
// box's per-size time factor (1024 = 1.0).
const DEFAULT_REF_SIZE = 768;
const REF_SIZE_FACTOR = Object.freeze({ 1024: 1.0, 768: 0.77, 512: 0.58 });
const refFactor = (refSize) => REF_SIZE_FACTOR[refSize] ?? REF_SIZE_FACTOR[DEFAULT_REF_SIZE];
// Measured seconds per cell on the default diffusers lane, by size and steps.
const MEASURED = Object.freeze({ 768: { 4: 23.5, 8: 46.5 }, 1024: { 4: 30.4, 8: 60 } });

function secondsPerCellFor({ steps, sampling = null, engine = null, refSize = DEFAULT_REF_SIZE } = {}) {
  if (sampling != null && SAMPLING_PRESETS[sampling]) {
    const p = SAMPLING_PRESETS[sampling];
    // HQ has no ref_size: its rates stay unscaled (a preset with no measured HQ rate
    // falls back to its diffusers rate as it was).
    if (engine === 'comfyui-hq') return p.hqSecondsPerCell != null ? p.hqSecondsPerCell : p.secondsPerCell;
    return p.secondsPerCell * refFactor(refSize);
  }
  if (engine === 'comfyui-hq' && sampling == null) return HQ_FAST_SECONDS_PER_CELL;
  if (steps == null) steps = 4; // box/catalog specs may carry steps:null
  const measured = MEASURED[refSize] && MEASURED[refSize][steps];
  if (measured != null) return measured;
  return (7.4 * steps + 0.8) * refFactor(refSize);
}

function renderedFacings(directions) {
  return (directions || []).filter((d) => !MIRRORED.includes(d)).length;
}

function cellsOf({ actions, directions, frames }) {
  return (actions || []).length * renderedFacings(directions) * frames;
}

function boxSeconds({ actions, directions, frames, secondsPerCell, qualityChecks, measuredRedrawSeconds }) {
  const c = secondsPerCell;
  const N = cellsOf({ actions, directions, frames });
  const D = (directions || []).length;
  const base = ETA_MODEL.fixedSeconds + c * (N + D);
  const out = {};
  for (const k of ['low', 'typical', 'high']) {
    let x;
    if (Number.isFinite(measuredRedrawSeconds)) x = measuredRedrawSeconds;
    else if (!qualityChecks) x = 0;
    else x = ETA_MODEL.r[k] * N * c + ETA_MODEL.roundSeconds * ETA_MODEL.rounds[k];
    out[k] = Math.round(base + x);
  }
  return out;
}

function calibrateSecondsPerCell({ sheetSeconds, cells, requestedFacings }) {
  return (sheetSeconds - ETA_MODEL.fixedSeconds) / (cells + requestedFacings);
}

module.exports = { ETA_MODEL, DEFAULT_REF_SIZE, REF_SIZE_FACTOR, secondsPerCellFor, renderedFacings, cellsOf, boxSeconds, calibrateSecondsPerCell };
