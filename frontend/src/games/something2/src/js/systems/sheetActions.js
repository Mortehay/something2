// SOMET-656: which frame of a GPU-box sprite sheet an actor shows right now.
// Pure -- no clock, no DOM. Callers pass `now` from RenderSystem.nowMs and
// event times stamped on the same (performance.now) clock.
//
// Box sheet.json (backend/src/services/spriteSheetManifest.js):
//   { cell, actions, frames_per_action, rows: [{row, action, direction, frames}],
//     frames: { "<action>/<dir>/<i>": [x, y, w, h], ... } }
// Directions are lower-case, rows are contiguous 0..frames-1. Legacy atlases
// ("S/0" keys) have no `rows`, which is how they are told apart.

// In order around the compass, so index distance is angular distance.
const DIR_ORDER = ["s", "se", "e", "ne", "n", "nw", "w", "sw"];
const DIR_INDEX = new Map(DIR_ORDER.map((d, i) => [d, i]));

// Actor facings are WORLD directions (server DIR_FACING, Player.facingFromVector);
// box sheet rows are SCREEN directions -- camera azimuths, "s" = facing the
// viewer, "e" = right profile facing SCREEN-RIGHT (the box's own measurement).
// Under worldToScreen (core/iso.js) world SE is straight down and world NW
// straight up, so the sheet row is the world facing turned 45 degrees.
// The box's WESTERN rows (w, nw, sw) are unreliable (humanoid "w" is a near
// copy of "e", the wolf's a near-frontal 3/4), so rowFor draws them as the
// mirrored eastern row instead (SOMET-659) -- unless the manifest's
// `unmirrored` lists that row: those were drawn by the box's 3D turnaround,
// where a direction is a camera position, so the western rows are real.
const WORLD_TO_SCREEN = {
  e: "se", se: "s", s: "sw", sw: "w", w: "nw", nw: "n", n: "ne", ne: "e",
};
const LOOPED = new Set(["idle", "walk", "sway"]);

export const DEFAULT_FPS = 8;
export const DAMAGE_MS = 300;

// Either world-facing format (creatures: "SE", players: "se") -> the on-screen
// box sheet direction.
export function boxDir(facing) {
  if (typeof facing !== "string") return "s";
  return WORLD_TO_SCREEN[facing.toLowerCase()] || "s";
}

export function isBoxManifest(m) {
  return Boolean(m && Array.isArray(m.rows) && m.rows.length);
}

// Per-manifest entry, built once: `byAction` is action -> dir -> frame count;
// `timings` is the lazily computed {attackDurMs, castDurMs, damageMs} for the
// fps in `timingsFps`.
const indexCache = new WeakMap();
function entryFor(manifest) {
  let entry = indexCache.get(manifest);
  if (entry) return entry;
  const idx = new Map();
  for (const r of manifest.rows) {
    if (!r || typeof r.action !== "string" || typeof r.direction !== "string") continue;
    const n = Number(r.frames);
    if (!(n > 0)) continue;
    let byDir = idx.get(r.action);
    if (!byDir) { byDir = new Map(); idx.set(r.action, byDir); }
    byDir.set(r.direction, Math.floor(n));
  }
  // action -> Set of directions drawn as-is (manifest.unmirrored).
  const unmirrored = new Map();
  const um = manifest.unmirrored;
  if (um && typeof um === "object") {
    for (const [action, dirs] of Object.entries(um)) {
      if (Array.isArray(dirs)) unmirrored.set(action, new Set(dirs));
    }
  }
  entry = { byAction: idx, unmirrored, timings: null, timingsFps: NaN };
  indexCache.set(manifest, entry);
  return entry;
}
const rowIndex = (manifest) => entryFor(manifest).byAction;

function countIn(idx, action) {
  const byDir = idx.get(action);
  if (!byDir) return 0;
  let n = 0;
  for (const c of byDir.values()) if (c > n) n = c;
  return n;
}

// Frames in one cycle of `action` (the longest of its rows); 0 when absent.
export function actionFrameCount(manifest, action) {
  if (!isBoxManifest(manifest)) return 0;
  return countIn(rowIndex(manifest), action);
}

export function actionDurationMs(manifest, action, fps = DEFAULT_FPS) {
  return (actionFrameCount(manifest, action) / fps) * 1000;
}

const NO_TIMINGS = Object.freeze({ attackDurMs: 0, castDurMs: 0, damageMs: 0 });

// {attackDurMs, castDurMs, damageMs} for a manifest, cached on the manifest's
// index entry (recomputed only if a different fps is asked for). The returned
// object is shared: do not mutate it.
export function actionTimings(manifest, fps = DEFAULT_FPS) {
  if (!isBoxManifest(manifest)) return NO_TIMINGS;
  const entry = entryFor(manifest);
  if (entry.timings && entry.timingsFps === fps) return entry.timings;
  const idx = entry.byAction;
  entry.timings = {
    attackDurMs: (countIn(idx, "attack") / fps) * 1000,
    castDurMs: (countIn(idx, "cast") / fps) * 1000,
    damageMs: countIn(idx, "damage") > 0 ? DAMAGE_MS : 0,
  };
  entry.timingsFps = fps;
  return entry.timings;
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

// SOMET-659: western screen rows -> the eastern row drawn mirrored.
const MIRROR_OF = { w: "e", nw: "ne", sw: "se" };

// The sheet row (direction) to draw `action` at screen direction `dir`, or
// null when the sheet has no such action. Writes `out.flipX` (when `out` is
// given): true when the row must be drawn mirrored horizontally. A western
// dir uses its eastern counterpart flipped; if that row is missing but the
// western one exists, the western row unflipped; otherwise the nearest row.
export function rowFor(manifest, action, dir, out) {
  if (out) out.flipX = false;
  if (!isBoxManifest(manifest)) return null;
  const entry = entryFor(manifest);
  return pickRow(entry.byAction.get(action), dir, out, entry.unmirrored.get(action));
}

function pickRow(byDir, dir, out, asIs) {
  if (!byDir) return null;
  if (asIs && asIs.has(dir) && byDir.has(dir)) return dir;
  const east = MIRROR_OF[dir];
  if (east !== undefined && byDir.has(east)) {
    if (out) out.flipX = true;
    return east;
  }
  if (byDir.has(dir)) return dir;
  // The nearest fallback can land on a western row too (e.g. "n" missing ties
  // nw/ne); the same rule applies to it: its eastern twin, mirrored.
  const near = nearestDir(byDir, dir);
  const twin = MIRROR_OF[near];
  if (twin !== undefined && byDir.has(twin)) {
    if (out) out.flipX = true;
    return twin;
  }
  return near;
}

// Positional core of actionFrameKey (no options literal): the renderer's hot
// path. `loop` is derived from the action. Returns the key or null, and writes
// `out.flipX` (see rowFor) when `out` -- e.g. the actor's anim record -- is given.
export function frameKeyFor(manifest, dir, action, startedAt, now, fps, out) {
  return keyFor(manifest, dir, action, startedAt, now, fps, undefined, out);
}

function keyFor(manifest, dir, action, startedAt, now, fps, loop, out) {
  if (out) out.flipX = false;
  if (!isBoxManifest(manifest)) return null;
  const entry = entryFor(manifest);
  const idx = entry.byAction;
  let useAction = action;
  let d = pickRow(idx.get(action), dir, out, entry.unmirrored.get(action));
  let looped = loop !== undefined ? loop : LOOPED.has(action);
  if (d === null && action !== "idle") {
    useAction = "idle";
    d = pickRow(idx.get("idle"), dir, out, entry.unmirrored.get("idle"));
    looped = true;
  }
  if (d === null) return null;
  const n = idx.get(useAction).get(d);
  return `${useAction}/${d}/${frameIndex(n, startedAt, now, fps, looped)}`;
}

// The frame key to draw, or null (the caller then uses staticFrameKey).
// Fallbacks: action+dir -> action at the nearest dir -> idle+dir -> idle at
// the nearest dir -> null. An idle fallback loops, as idle always does.
// Western dirs resolve to the mirrored eastern row (see rowFor); pass `out`
// to learn whether to flip.
export function actionFrameKey(manifest, { dir, action, startedAt, now, fps = DEFAULT_FPS, loop, out } = {}) {
  return keyFor(manifest, dir, action, startedAt, now, fps, loop, out);
}

const at = (v) => (Number.isFinite(v) ? v : -Infinity);

// What an actor is doing at `now`: returns the action name and writes it, and
// the time its animation clock started, to `state.action` / `state.actionStartedAt`
// (the anim record itself, so a steady actor allocates nothing).
// state: { moving?, movingUntil?, attackAt?, castAt?, hitAt?, attackDurMs?,
//          castDurMs?, damageMs? (default 300), phase? }.
// Priority: damage > (the more recent of cast/attack) > walk > idle. Loops
// start at the actor's own `phase` so a crowd is not in lockstep.
export function pickAction(state, now) {
  const s = state || {};
  const hitAt = at(s.hitAt);
  const damageMs = Number.isFinite(s.damageMs) ? s.damageMs : DAMAGE_MS;
  if (now - hitAt < damageMs) return set(s, "damage", hitAt);
  const attackAt = at(s.attackAt);
  const castAt = at(s.castAt);
  const attacking = now - attackAt < (s.attackDurMs || 0);
  const casting = now - castAt < (s.castDurMs || 0);
  if (casting && (!attacking || castAt >= attackAt)) return set(s, "cast", castAt);
  if (attacking) return set(s, "attack", attackAt);
  const phase = Number.isFinite(s.phase) ? s.phase : 0;
  const moving = s.moving === true || now < at(s.movingUntil);
  return set(s, moving ? "walk" : "idle", phase);
}

function set(s, action, startedAt) {
  s.action = action;
  s.actionStartedAt = startedAt;
  return action;
}
