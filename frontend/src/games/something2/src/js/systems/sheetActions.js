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
// viewer. Under worldToScreen (core/iso.js) world SE is straight down and
// world NW straight up, so the sheet row is the world facing turned 45 degrees.
// The box's WESTERN rows (w, nw, sw) are unreliable (humanoid "w" is a near
// copy of "e", the wolf's a near-frontal 3/4), so rowFor draws them as the
// mirrored eastern row instead (SOMET-659) -- unless the manifest's
// `unmirrored` lists that row: those were drawn by the box's 3D turnaround,
// where a direction is a camera position, so the western rows are real.
const WORLD_TO_SCREEN = {
  e: "se", se: "s", s: "sw", sw: "w", w: "nw", nw: "n", n: "ne", ne: "e",
};
// SOMET-767: the box's SIDES are the mirror of ours. Its "e" row is a profile
// facing SCREEN-LEFT -- measured at full size on every live sheet (30 hero
// appearances, 70 creatures, 2026-11-12), with no exception -- and its western
// rows, built by mirroring the eastern ones, face screen-right. The turnaround's
// camera convention agrees: a camera to the east sees the figure's left side.
// So a screen direction is looked up under the box's name for the OTHER side;
// the row/flip logic below then holds unchanged, and the drawn figure faces
// where the actor moves. Front and back (s, n) have no side and map to themselves.
const BOX_SIDE = { e: "w", w: "e", ne: "nw", nw: "ne", se: "sw", sw: "se" };
const LOOPED = new Set(["idle", "walk", "sway"]);

export const DEFAULT_FPS = 8;
export const DAMAGE_MS = 300;
// The manifest carries no per-action duration; a death plays at this rate
// (systems/corpses.js).
export const DEATH_FRAME_MS = 150;

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
  // Box contract 2026-11-09: actions that play once and hold their last frame
  // -- a row marked `play: "once"`, or `death` (manifests from before the flag).
  const once = new Set(["death"]);
  for (const r of manifest.rows) {
    if (!r || typeof r.action !== "string" || typeof r.direction !== "string") continue;
    const n = Number(r.frames);
    if (!(n > 0)) continue;
    if (r.play === "once") once.add(r.action);
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
  entry = { byAction: idx, unmirrored, once, timings: null, timingsFps: NaN };
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

// Whether `action` plays once and holds (never loops) on this sheet.
export function isOneShot(manifest, action) {
  if (action === "death") return true;
  return isBoxManifest(manifest) && entryFor(manifest).once.has(action);
}

// Frames in the `action`/`dir` row itself (no fallback); 0 when absent.
export function rowFrameCount(manifest, action, dir) {
  if (!isBoxManifest(manifest)) return 0;
  const byDir = rowIndex(manifest).get(action);
  return (byDir && byDir.get(dir)) || 0;
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

// The box row name (a key of `byDir`) closest to screen direction `screenDir`,
// or null. Searched in SCREEN space so ties go to the next direction clockwise
// on screen (+d before -d) and the choice is deterministic; each candidate is
// looked up under the box's name for it (BOX_SIDE).
function nearestDir(byDir, screenDir) {
  if (!byDir || byDir.size === 0) return null;
  const want = BOX_SIDE[screenDir] || screenDir;
  if (byDir.has(want)) return want;
  const i = DIR_INDEX.has(screenDir) ? DIR_INDEX.get(screenDir) : 0;
  for (let d = 1; d <= 4; d += 1) {
    const cw = DIR_ORDER[(i + d) % 8];
    const cwRow = BOX_SIDE[cw] || cw;
    if (byDir.has(cwRow)) return cwRow;
    const ccw = DIR_ORDER[(i - d + 8) % 8];
    const ccwRow = BOX_SIDE[ccw] || ccw;
    if (byDir.has(ccwRow)) return ccwRow;
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
// Diagonal -> whether its side-view stand-in (the "e" row) is drawn mirrored.
const SIDE_FLIP = { se: false, ne: false, sw: true, nw: true };
// Which way a direction faces on screen; s / n (undefined) face neither way.
const SIDE_OF = { e: 1, ne: 1, se: 1, w: -1, nw: -1, sw: -1 };

// The sheet row (direction) to draw `action` at screen direction `dir`, or
// null when the sheet has no such action. Writes `out.flipX` (when `out` is
// given): true when the row must be drawn mirrored horizontally. The drawn
// figure always faces `dir`'s side of the screen: because the box's "e" row
// faces screen-left (BOX_SIDE), a screen-EAST dir is the e row flipped and a
// screen-WEST dir the e row as it is; a real (unmirrored) w row serves the
// eastern dirs unflipped; otherwise the nearest row, flipped when it faces away.
export function rowFor(manifest, action, dir, out) {
  if (out) out.flipX = false;
  if (!isBoxManifest(manifest)) return null;
  const entry = entryFor(manifest);
  return pickRow(entry.byAction.get(action), dir, out, entry.unmirrored.get(action));
}

function pickRow(byDir, screenDir, out, asIs) {
  if (!byDir) return null;
  // SOMET-767: from here on `dir` is the box's name for the row that faces screenDir.
  const dir = BOX_SIDE[screenDir] || screenDir;
  if (asIs && asIs.has(dir) && byDir.has(dir)) return dir;
  const east = MIRROR_OF[dir];
  if (east !== undefined && byDir.has(east)) {
    if (out) out.flipX = true;
    return east;
  }
  if (byDir.has(dir)) return dir;
  // SOMET-686: a w row beats the side-view stand-ins below when it is drawn
  // as-is, or when the sheet has no e row to stand in. nw / sw with no row of
  // their own draw it as it is; an eastern direction with no e row mirrors it.
  if (byDir.has("w") && ((asIs && asIs.has("w")) || !byDir.has("e"))) {
    if (dir === "nw" || dir === "sw") return "w";
    if ((dir === "e" || dir === "ne" || dir === "se") && !byDir.has("e")) {
      if (out) out.flipX = true;
      return "w";
    }
  }
  // SOMET-669: a four-facing sheet (s / e / n) has no diagonals. Diagonal
  // movement is sideways on screen, so it walks the side view -- the eastern
  // row, mirrored on the western side -- not whichever of s / n / e the
  // nearest search's tie-break happens to land on.
  const side = SIDE_FLIP[dir];
  if (side !== undefined && byDir.has("e")) {
    if (out) out.flipX = side;
    return "e";
  }
  // The nearest fallback can land on a western row too (e.g. "n" missing ties
  // nw/ne); the same rule applies to it: its eastern twin, mirrored.
  const near = nearestDir(byDir, screenDir);
  const twin = MIRROR_OF[near];
  if (twin !== undefined && byDir.has(twin)) {
    if (out) out.flipX = true;
    return twin;
  }
  // A row from the other side of the sheet faces away from `dir`: mirror it.
  if (out && SIDE_OF[dir] * SIDE_OF[near] < 0) out.flipX = true;
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
  // A one-shot action never loops, whatever the caller asks.
  let looped = !isOneShot(manifest, action) && (loop !== undefined ? loop : LOOPED.has(action));
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
