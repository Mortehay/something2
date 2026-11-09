// Box time estimate for a sprite sheet (spec §5). Pure; mirrored in the frontend.
// seconds = 85 + c*D + 0.6*N + c*N + X
//   c = seconds per cell, D = requested facings, N = rendered cells, X = redraw time.
const { SAMPLING_PRESETS, HQ_FAST_SECONDS_PER_CELL } = require('./spriteSampling.js');

const ETA_MODEL = Object.freeze({
  fixedSeconds: 85,
  perCellOverhead: 0.6,
  roundSeconds: 40,
  r: Object.freeze({ low: 0, typical: 0.3, high: 1.45 }),
  rounds: Object.freeze({ low: 0, typical: 1, high: 3 }),
  gatewaySwitchMaxSeconds: 300,
});

const MIRRORED = ['w', 'nw', 'sw'];

function secondsPerCellFor({ steps, sampling = null, engine = null } = {}) {
  if (sampling != null && SAMPLING_PRESETS[sampling]) {
    const p = SAMPLING_PRESETS[sampling];
    // A preset with no measured HQ rate falls back to its diffusers rate.
    return (engine === 'comfyui-hq' && p.hqSecondsPerCell != null) ? p.hqSecondsPerCell : p.secondsPerCell;
  }
  if (engine === 'comfyui-hq' && sampling == null) return HQ_FAST_SECONDS_PER_CELL;
  if (steps == null) steps = 4; // box/catalog specs may carry steps:null
  if (steps === 4) return 32;
  if (steps === 8) return 60;
  return 7.7 * steps + 1.3;
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
  const base = ETA_MODEL.fixedSeconds + c * D + ETA_MODEL.perCellOverhead * N + c * N;
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
  return (sheetSeconds - ETA_MODEL.fixedSeconds - ETA_MODEL.perCellOverhead * cells) / (cells + requestedFacings);
}

module.exports = { ETA_MODEL, secondsPerCellFor, renderedFacings, cellsOf, boxSeconds, calibrateSecondsPerCell };
