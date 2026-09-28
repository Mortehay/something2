// Per-viewer volumes. Storage can throw (private window, blocked site data),
// so every access is wrapped and a bad value falls back to the default.
const KEY = 'something2.audio.volumes';
export const DEFAULT_VOLUMES = Object.freeze({ master: 0.8, music: 0.35, ambience: 0.6, sfx: 0.8, muted: false });

const inRange = (v) => typeof v === 'number' && v >= 0 && v <= 1;

export function loadVolumes(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(KEY);
    if (!raw) return { ...DEFAULT_VOLUMES };
    const p = JSON.parse(raw);
    const out = { ...DEFAULT_VOLUMES };
    for (const k of ['master', 'music', 'ambience', 'sfx']) if (inRange(p[k])) out[k] = p[k];
    if (typeof p.muted === 'boolean') out.muted = p.muted;
    const anyBad = ['master', 'music', 'ambience', 'sfx'].some((k) => k in p && !inRange(p[k]));
    return anyBad ? { ...DEFAULT_VOLUMES } : out;
  } catch (_) {
    return { ...DEFAULT_VOLUMES };
  }
}

export function saveVolumes(v, storage = globalThis.localStorage) {
  try { if (storage) storage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* per-viewer convenience only */ }
}
