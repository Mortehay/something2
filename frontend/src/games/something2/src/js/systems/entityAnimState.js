// SOMET-656: per-actor animation timing for box sprite sheets. The server
// sends no "is walking" / "is attacking" state, so it is inferred here from
// the events and positions the client already sees (see Game._onWorldState).
//
// Keys: 'c:<creatureId>', 'p:<userId>' (remote players), 'self' (local).
// One record per actor, mutated in place: a steady actor allocates nothing
// per frame. Times are on RenderSystem.nowMs's clock (performance.now).

// 0.01 tile (MAP_TILE_SIZE = 100 world px): below this, a position change is
// reconciliation jitter, not walking.
export const MOVE_EPS_PX = 1;
// Creatures arrive at ~5 Hz; holding 'moving' bridges the gap between frames
// where the interpolated position has caught up with its target.
export const MOVING_HOLD_MS = 150;
// Half the 300 ms damage window (sheetActions DAMAGE_MS); see noteHit.
export const HIT_MERGE_MS = 150;

// A stable 0..999 ms offset per key (FNV-1a), so a crowd's idle/walk loops
// do not tick in lockstep.
export function phaseFor(key) {
  let h = 2166136261;
  const s = String(key);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000;
}

export class EntityAnimState {
  constructor() {
    this._map = new Map();
  }

  get size() { return this._map.size; }

  _rec(key) {
    let r = this._map.get(key);
    if (!r) {
      r = {
        attackAt: -Infinity, castAt: -Infinity, hitAt: -Infinity,
        lastX: NaN, lastY: NaN, movingUntil: -Infinity,
        phase: phaseFor(key),
        // Filled by the renderer from the sheet before pickAction.
        attackDurMs: 0, castDurMs: 0, damageMs: 0,
      };
      this._map.set(key, r);
    }
    return r;
  }

  noteAttack(key, now, isCast = false) {
    const r = this._rec(key);
    if (isCast) r.castAt = now; else r.attackAt = now;
  }

  // One hit reaches the client twice -- the world-state impact and the hp
  // drop on the next creatures/state frame -- so a hit inside the first half
  // of a flinch already showing keeps its clock rather than restarting it.
  noteHit(key, now) {
    const r = this._rec(key);
    if (now - r.hitAt < HIT_MERGE_MS) return;
    r.hitAt = now;
  }

  // Called once per draw. `tx`/`ty` (creatures only) are the latest snapshot
  // target: an actor still short of it is walking even if this frame's
  // interpolation step was tiny.
  observePosition(key, x, y, now, tx, ty) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const r = this._rec(key);
    // lastX is NaN on the first observation, so `moved` is false there.
    const moved = Math.abs(x - r.lastX) > MOVE_EPS_PX || Math.abs(y - r.lastY) > MOVE_EPS_PX;
    const short = Number.isFinite(tx) && Number.isFinite(ty)
      && (Math.abs(tx - x) > MOVE_EPS_PX || Math.abs(ty - y) > MOVE_EPS_PX);
    if (moved || short) r.movingUntil = now + MOVING_HOLD_MS;
    r.lastX = x;
    r.lastY = y;
  }

  stateFor(key) {
    return this._map.get(key) || null;
  }

  forget(key) {
    this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }
}

// Wire actor ('c:<id>' / 'p:<userId>') -> anim key; the local player's own
// id becomes 'self'. Anything else is null.
export function actorKey(a, localUserId) {
  if (typeof a !== "string" || a.length < 3) return null;
  if (a.startsWith("c:")) return a;
  if (a.startsWith("p:")) return localUserId != null && a === `p:${localUserId}` ? "self" : a;
  return null;
}

const FULL_CIRCLE = Math.PI * 2 - 1e-6;

// Take one world-state frame's single-shot events into `anim`:
//  - attacks: a swing by `a`. A full-circle arc (slam/nova) is a cast. Skill
//    effect names are free-form vfx library rows, so they are NOT used as a
//    cast signal. The local player's plain swings are skipped: Game notes them
//    at send time, and the echo one round trip later would restart the swing.
//  - impacts: `t` was hit.
//  - sfx: a creature's 'skill_cast' (it carries a: 'c:<id>') is a cast; this
//    also covers projectile/summon skills, which stamp no attack descriptor.
export function noteFrameEvents(anim, msg, now, localUserId) {
  if (!anim || !msg) return;
  if (Array.isArray(msg.attacks)) {
    for (const e of msg.attacks) {
      if (!e || e.b === true) continue;
      const key = actorKey(e.a, localUserId);
      if (!key) continue;
      const isCast = Number.isFinite(e.arc) && e.arc >= FULL_CIRCLE;
      if (key === "self" && !isCast) continue;
      anim.noteAttack(key, now, isCast);
    }
  }
  if (Array.isArray(msg.impacts)) {
    for (const e of msg.impacts) {
      const key = e && actorKey(e.t, localUserId);
      if (key) anim.noteHit(key, now);
    }
  }
  if (Array.isArray(msg.sfx)) {
    for (const e of msg.sfx) {
      if (!e || e.e !== "skill_cast") continue;
      const key = actorKey(e.a, localUserId);
      if (key) anim.noteAttack(key, now, true);
    }
  }
}
