// Box time estimate for a sprite sheet. Plain ESM, no UI imports: the backend
// parity test loads this file directly. Mirrors backend/src/services/spriteEta.js
// (boxSeconds, cellsOf, renderedFacings); seconds-per-cell comes from the catalog.
// seconds = 270 + c*(N + D) + X (the box formula; perCellOverhead is 0, kept for shape)
export const ETA_MODEL = Object.freeze({
  fixedSeconds: 270,
  perCellOverhead: 0,
  roundSeconds: 40,
  r: Object.freeze({ low: 0, typical: 0.3, high: 1.45 }),
  rounds: Object.freeze({ low: 0, typical: 1, high: 3 }),
});

// Rate used when neither the catalog nor the connector reports one (the 4-step rate measured at the 768 reference).
export const DEFAULT_SECONDS_PER_CELL = 23.5;

const MIRRORED = ['w', 'nw', 'sw'];

export function renderedFacings(directions) {
  return (directions || []).filter((d) => !MIRRORED.includes(d)).length;
}

export function cellsOf({ actions, directions, frames }) {
  return (actions || []).length * renderedFacings(directions) * frames;
}

export function boxSeconds(
  { actions, directions, frames, secondsPerCell, qualityChecks, measuredRedrawSeconds },
  model = ETA_MODEL,
) {
  const c = secondsPerCell;
  const N = cellsOf({ actions, directions, frames });
  const D = (directions || []).length;
  const base = model.fixedSeconds + c * (N + D);
  const out = {};
  for (const k of ['low', 'typical', 'high']) {
    let x;
    if (Number.isFinite(measuredRedrawSeconds)) x = measuredRedrawSeconds;
    else if (!qualityChecks) x = 0;
    else x = model.r[k] * N * c + model.roundSeconds * model.rounds[k];
    out[k] = Math.round(base + x);
  }
  return out;
}

export function durationLabel(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return '< 1 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `~${h ? `${h} h ` : ''}${h && !m ? '' : `${m} min`}`.trimEnd();
}

export function etaLabel({ low, typical, high }) {
  const lo = durationLabel(low);
  const hi = durationLabel(high);
  return lo === hi ? durationLabel(typical) : `${lo} – ${hi}`;
}
