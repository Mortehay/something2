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

  noteHit(key, now) {
    this._rec(key).hitAt = now;
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
