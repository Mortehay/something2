// Client-only creature corpses: a killed creature whose box sheet has a
// `death` row stays where it fell, plays `death` once, holds the last frame
// (lying down) for HOLD_MS, fades out over FADE_MS, and is dropped. Pure --
// no clock, no DOM; times are on RenderSystem.nowMs's clock (performance.now).
//
// A corpse is never gameplay state: it is not in CreatureManager, so nothing
// targets, inspects, minimaps or sends it.
//
// The signal. The authority deletes a killed creature at once and says so
// only as a `death` sfx on the world-state frame ({e:'death', c:<type>,
// x, y} at the creature's CENTRE -- no id, see backend sfxEvents.creatureDeath).
// The creature then drops out of the next `creatures` snapshot (~5 Hz), which
// is also what a creature merely leaving the neighbourhood looks like. Both
// ride the same socket and the state frame for the killing tick is sent
// before that tick's snapshot, so the death sfx always arrives first: it is
// held for DEATH_MATCH_MS, and a removal is a death only when a pending death
// of the same type lies within DEATH_MATCH_PX of the creature.

import { actionFrameCount, rowFor, rowFrameCount, boxDir, DEATH_FRAME_MS } from "./sheetActions.js";

export const HOLD_MS = 1000;
export const FADE_MS = 400;
export const MAX_CORPSES = 64;
// A death sfx waits this long for its creature to leave the snapshot (a
// snapshot every ~200 ms; generous for a late frame).
export const DEATH_MATCH_MS = 1500;
// How far the death point may be from the creature's last known centre. The
// snapshot target trails the server by up to one snapshot of movement.
export const DEATH_MATCH_PX = 96;

const DEFAULT_SIZE = 48;

export function hasDeathRow(manifest) {
  return actionFrameCount(manifest, "death") > 0;
}

// A corpse for `creature` (its current, drawn state) starting at `now`, or
// null when its sheet has no death row. Copies what it needs: the live
// creature object is dropped by CreatureManager right after.
export function makeCorpse(creature, now) {
  const manifest = creature && creature.sprite && creature.sprite.manifest;
  if (!hasDeathRow(manifest)) return null;
  const out = { flipX: false };
  // The same row choice and mirroring as a living creature (sheetActions.rowFor).
  const dir = rowFor(manifest, "death", boxDir(creature.facing), out);
  const frames = dir === null ? 0 : rowFrameCount(manifest, "death", dir);
  if (!(frames > 0)) return null;
  return {
    id: creature.id,
    type: creature.type,
    x: creature.x, y: creature.y,
    width: creature.width, height: creature.height,
    displayWidth: creature.displayWidth, displayHeight: creature.displayHeight,
    bossTier: creature.bossTier || null,
    render_mode: creature.render_mode, renderMode: creature.renderMode,
    place_order: creature.place_order || 0,
    sprite: creature.sprite,
    dir, flipX: out.flipX === true, frames,
    startedAt: now,
  };
}

// {frame, alpha} for `corpse` at `now`, or null once it has faded out.
export function corpseAt(corpse, now) {
  const elapsed = Math.max(0, now - corpse.startedAt);
  const last = corpse.frames - 1;
  const playMs = corpse.frames * DEATH_FRAME_MS;
  if (elapsed < playMs) return { frame: Math.min(last, Math.floor(elapsed / DEATH_FRAME_MS)), alpha: 1 };
  const afterHold = elapsed - playMs - HOLD_MS;
  if (afterHold < 0) return { frame: last, alpha: 1 };
  if (afterHold < FADE_MS) return { frame: last, alpha: 1 - afterHold / FADE_MS };
  return null;
}

function centreOf(c, x, y) {
  return { x: x + (c.width || DEFAULT_SIZE) / 2, y: y + (c.height || DEFAULT_SIZE) / 2 };
}

export class CorpseStore {
  constructor() {
    this._corpses = [];   // oldest first
    this._deaths = [];    // pending death sfx: {type, x, y, at}, oldest first
  }

  get size() { return this._corpses.length; }
  get pendingDeaths() { return this._deaths.length; }

  // Take one world-state frame's `sfx` list.
  noteDeaths(sfx, now) {
    this._pruneDeaths(now);
    if (!Array.isArray(sfx)) return;
    for (const e of sfx) {
      if (!e || e.e !== "death" || typeof e.c !== "string") continue;
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
      this._deaths.push({ type: e.c, x: e.x, y: e.y, at: now });
      if (this._deaths.length > MAX_CORPSES) this._deaths.shift();
    }
  }

  // CreatureManager dropped `creature` from the snapshot. Returns the new
  // corpse, or null (no matching death, or no death row: it just vanishes).
  onRemoved(creature, now) {
    if (!creature || !hasDeathRow(creature.sprite && creature.sprite.manifest)) return null;
    this._pruneDeaths(now);
    const i = this._matchDeath(creature);
    if (i < 0) return null;
    const corpse = makeCorpse(creature, now);
    if (!corpse) return null;
    this._deaths.splice(i, 1);
    this.dropId(creature.id);
    this._corpses.push(corpse);
    if (this._corpses.length > MAX_CORPSES) this._corpses.shift();
    return corpse;
  }

  // The same creature id is back (a respawn): its corpse goes at once.
  dropId(id) {
    const i = this._corpses.findIndex((c) => c.id === id);
    if (i >= 0) this._corpses.splice(i, 1);
  }

  // The corpses still showing at `now` (faded ones are dropped). The returned
  // array is the store's own: do not mutate it.
  live(now) {
    if (this._corpses.some((c) => corpseAt(c, now) === null)) {
      this._corpses = this._corpses.filter((c) => corpseAt(c, now) !== null);
    }
    return this._corpses;
  }

  clear() {
    this._corpses = [];
    this._deaths = [];
  }

  _pruneDeaths(now) {
    while (this._deaths.length && now - this._deaths[0].at > DEATH_MATCH_MS) this._deaths.shift();
  }

  // Index of the nearest pending death of this creature's type within reach of
  // either its drawn position or its latest snapshot target, or -1.
  _matchDeath(creature) {
    const points = [centreOf(creature, creature.x, creature.y)];
    if (Number.isFinite(creature.tx) && Number.isFinite(creature.ty)) {
      points.push(centreOf(creature, creature.tx, creature.ty));
    }
    const max2 = DEATH_MATCH_PX * DEATH_MATCH_PX;
    let best = -1;
    let bestD2 = Infinity;
    this._deaths.forEach((d, i) => {
      if (d.type !== creature.type) return;
      for (const p of points) {
        const d2 = (d.x - p.x) ** 2 + (d.y - p.y) ** 2;
        if (d2 <= max2 && d2 < bestD2) { best = i; bestD2 = d2; }
      }
    });
    return best;
  }
}
