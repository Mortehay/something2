// SOMET-656: per-actor animation timing for box sprite sheets. The server
// sends no "is walking" / "is attacking" state, so it is inferred here from
// the events and positions the client already sees (see Game._onWorldState).
//
// Keys: 'c:<creatureId>', 'p:<userId>' (remote players), 'self' (local).
// One record per actor, mutated in place: a steady actor allocates nothing
// per frame. Times are on RenderSystem.nowMs's clock (performance.now).

import { DAMAGE_MS } from "./sheetActions.js";

// 0.01 tile (MAP_TILE_SIZE = 100 world px): below this, a position change is
// reconciliation jitter, not walking.
export const MOVE_EPS_PX = 1;
// Creatures arrive at ~5 Hz; holding 'moving' bridges the gap between frames
// where the interpolated position has caught up with its target.
export const MOVING_HOLD_MS = 150;
// The whole damage window (sheetActions DAMAGE_MS); see noteHit.
export const HIT_MERGE_MS = DAMAGE_MS;
// A swing/cast still playing is not restarted by a repeat send; when the
// sheet's duration is unknown (0) this is how long it is left alone.
export const MIN_RESTART_MS = 250;
// A record with no event, no observation and no movement for this long is
// dropped by sweep().
export const STALE_MS = 10000;

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
        lastX: NaN, lastY: NaN, movingUntil: -Infinity, seenAt: -Infinity,
        phase: phaseFor(key),
        // Filled by the renderer from the sheet before pickAction.
        attackDurMs: 0, castDurMs: 0, damageMs: 0,
        // Written by frameKeyFor (SOMET-659): draw the sheet row mirrored.
        flipX: false,
      };
      this._map.set(key, r);
    }
    return r;
  }

  noteAttack(key, now, isCast = false) {
    const r = this._rec(key);
    // Constant attack resends every 50 ms and click-spam resends refused
    // swings: restarting each time would pin the sprite on frame 0.
    const at = isCast ? r.castAt : r.attackAt;
    const dur = (isCast ? r.castDurMs : r.attackDurMs) || MIN_RESTART_MS;
    if (now - at < dur) return;
    if (isCast) r.castAt = now; else r.attackAt = now;
  }

  // Drop records of actors that went quiet (e.g. world-wide events for
  // far-away actors the client never tracked). Called once per state frame.
  sweep(now) {
    for (const [key, r] of this._map) {
      const last = Math.max(r.attackAt, r.castAt, r.hitAt, r.movingUntil, r.seenAt);
      if (now - last > STALE_MS) this._map.delete(key);
    }
  }

  // One hit reaches the client twice -- the world-state impact and the hp
  // drop on the next creatures/state frame (~5 Hz, so up to ~200 ms later) --
  // so a hit inside the flinch already showing keeps its clock.
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
    r.seenAt = now;
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
//  - sfx: a remote player's skill use ({e:'use', s:'skill:<id>', a:'p:<uid>'})
//    is a cast too: castSkill stamps no attack descriptor. A creature's 'skill_cast' (it carries a: 'c:<id>') is a cast; this
//    also covers projectile/summon skills, which stamp no attack descriptor.
export function noteFrameEvents(anim, msg, now, localUserId, tracked) {
  if (!anim || !msg) return;
  // These lists are world-wide broadcasts; `tracked(key)` (when given) keeps
  // records from being created for actors this client never draws.
  const keyOf = (a) => {
    const key = actorKey(a, localUserId);
    return key && (key === "self" || !tracked || tracked(key)) ? key : null;
  };
  if (Array.isArray(msg.attacks)) {
    for (const e of msg.attacks) {
      if (!e) continue;
      const key = keyOf(e.a);
      if (!key) continue;
      const isCast = Number.isFinite(e.arc) && e.arc >= FULL_CIRCLE;
      if (key === "self" && !isCast) continue;
      anim.noteAttack(key, now, isCast);
    }
  }
  if (Array.isArray(msg.impacts)) {
    for (const e of msg.impacts) {
      // A blocked impact (authority/vfx blockedImpact) carries no damage.
      if (!e || e.b === true) continue;
      const key = keyOf(e.t);
      if (key) anim.noteHit(key, now);
    }
  }
  if (Array.isArray(msg.sfx)) {
    for (const e of msg.sfx) {
      if (!e) continue;
      const isCast = e.e === "skill_cast"
        || (e.e === "use" && typeof e.s === "string" && e.s.startsWith("skill:"));
      if (!isCast) continue;
      const key = keyOf(e.a);
      // 'self' is noted at send time; the echo would restart the cast.
      if (key && key !== "self") anim.noteAttack(key, now, true);
    }
  }
}
