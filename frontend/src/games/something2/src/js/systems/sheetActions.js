// SOMET-656: which frame of a GPU-box sprite sheet an actor shows right now.
// Pure -- no clock, no DOM. Callers pass `now` from RenderSystem.nowMs and
// event times stamped on the same (performance.now) clock.
//
// Box sheet.json (backend/src/services/spriteSheetManifest.js):
//   { cell, actions, frames_per_action, rows: [{row, action, direction, frames}],
//     frames: { "<action>/<dir>/<i>": [x, y, w, h], ... } }
// Directions are lower-case, rows are contiguous 0..frames-1. Legacy atlases
// ("S/0" keys) have no `rows`, which is how they are told apart.

// Clockwise around the compass, so index distance is angular distance.
const DIR_ORDER = ["s", "se", "e", "ne", "n", "nw", "w", "sw"];
const DIR_INDEX = new Map(DIR_ORDER.map((d, i) => [d, i]));
const LOOPED = new Set(["idle", "walk", "sway"]);

export const DEFAULT_FPS = 8;
export const DAMAGE_MS = 300;

// Either facing format (creatures: "SE", players: "se") -> a box direction.
export function boxDir(facing) {
  if (typeof facing !== "string") return "s";
  const d = facing.toLowerCase();
  return DIR_INDEX.has(d) ? d : "s";
}

export function isBoxManifest(m) {
  return Boolean(m && Array.isArray(m.rows) && m.rows.length);
}

// action -> dir -> frame count, built once per manifest object.
const indexCache = new WeakMap();
function rowIndex(manifest) {
  let idx = indexCache.get(manifest);
  if (idx) return idx;
  idx = new Map();
  for (const r of manifest.rows) {
    if (!r || typeof r.action !== "string" || typeof r.direction !== "string") continue;
    const n = Number(r.frames);
    if (!(n > 0)) continue;
    let byDir = idx.get(r.action);
    if (!byDir) { byDir = new Map(); idx.set(r.action, byDir); }
    byDir.set(r.direction, Math.floor(n));
  }
  indexCache.set(manifest, idx);
  return idx;
}

// Frames in one cycle of `action` (the longest of its rows); 0 when absent.
export function actionFrameCount(manifest, action) {
  if (!isBoxManifest(manifest)) return 0;
  const byDir = rowIndex(manifest).get(action);
  if (!byDir) return 0;
  let n = 0;
  for (const c of byDir.values()) if (c > n) n = c;
  return n;
}

export function actionDurationMs(manifest, action, fps = DEFAULT_FPS) {
  return (actionFrameCount(manifest, action) / fps) * 1000;
}

// The direction of `byDir` closest to `dir`, or null. Ties go to the next
// direction clockwise (+d before -d), so the choice is deterministic.
function nearestDir(byDir, dir) {
  if (!byDir || byDir.size === 0) return null;
  if (byDir.has(dir)) return dir;
  const i = DIR_INDEX.has(dir) ? DIR_INDEX.get(dir) : 0;
  for (let d = 1; d <= 4; d += 1) {
    const cw = DIR_ORDER[(i + d) % 8];
    if (byDir.has(cw)) return cw;
    const ccw = DIR_ORDER[(i - d + 8) % 8];
    if (byDir.has(ccw)) return ccw;
  }
  return null;
}

function frameIndex(n, startedAt, now, fps, loop) {
  const raw = Math.floor(((now - startedAt) * fps) / 1000);
  // NaN/Infinity would build "walk/s/NaN" -> no rect -> a vanished actor.
  const f = Number.isFinite(raw) ? raw : 0;
  if (loop) return ((f % n) + n) % n;
  return f < 0 ? 0 : (f >= n ? n - 1 : f);
}

// The frame key to draw, or null (the caller then uses staticFrameKey).
// Fallbacks: action+dir -> action at the nearest dir -> idle+dir -> idle at
// the nearest dir -> null. An idle fallback loops, as idle always does.
export function actionFrameKey(manifest, { dir, action, startedAt, now, fps = DEFAULT_FPS, loop } = {}) {
  if (!isBoxManifest(manifest)) return null;
  const idx = rowIndex(manifest);
  let useAction = action;
  let d = nearestDir(idx.get(action), dir);
  let looped = loop !== undefined ? loop : LOOPED.has(action);
  if (d === null && action !== "idle") {
    useAction = "idle";
    d = nearestDir(idx.get("idle"), dir);
    looped = true;
  }
  if (d === null) return null;
  const n = idx.get(useAction).get(d);
  return `${useAction}/${d}/${frameIndex(n, startedAt, now, fps, looped)}`;
}

const at = (v) => (Number.isFinite(v) ? v : -Infinity);

// What an actor is doing at `now`, and the time its animation clock started.
// state: { moving?, movingUntil?, attackAt?, castAt?, hitAt?, attackDurMs?,
//          castDurMs?, damageMs? (default 300), phase? }.
// Priority: damage > (the more recent of cast/attack) > walk > idle. Loops
// start at the actor's own `phase` so a crowd is not in lockstep.
export function pickAction(state, now) {
  const s = state || {};
  const hitAt = at(s.hitAt);
  const damageMs = Number.isFinite(s.damageMs) ? s.damageMs : DAMAGE_MS;
  if (now - hitAt < damageMs) return { action: "damage", startedAt: hitAt };
  const attackAt = at(s.attackAt);
  const castAt = at(s.castAt);
  const attacking = now - attackAt < (s.attackDurMs || 0);
  const casting = now - castAt < (s.castDurMs || 0);
  if (casting && (!attacking || castAt >= attackAt)) return { action: "cast", startedAt: castAt };
  if (attacking) return { action: "attack", startedAt: attackAt };
  const phase = Number.isFinite(s.phase) ? s.phase : 0;
  const moving = s.moving === true || now < at(s.movingUntil);
  return { action: moving ? "walk" : "idle", startedAt: phase };
}
