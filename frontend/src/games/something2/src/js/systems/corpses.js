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
//
// The death sfx are WORLD-wide (every socket gets the whole world's list) but
// the creature snapshot covers only the 3x3 chunks around the player
// (server broadcastCreatures: neighborhoodKeys(chunkOf(player), 1)). So a
// death outside that neighbourhood is ignored, and a creature removed from
// outside it left the AOI (it did not die here): see aoiFilter.

import { actionFrameCount, rowFor, rowFrameCount, boxDir, DEATH_FRAME_MS } from "./sheetActions.js";
import { chunkOf } from "../core/worldCoords.js";

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

// (x, y) -> whether that world point is inside the creature snapshot's 3x3
// chunk neighbourhood around the player at (playerX, playerY) -- the same
// chunkOf the server's broadcastCreatures uses (both on top-left x/y). Null
// (no filter) when the chunk size is unknown.
export function aoiFilter(playerX, playerY, chunkSize) {
  if (!(chunkSize > 0) || !Number.isFinite(playerX) || !Number.isFinite(playerY)) return null;
  const p = chunkOf(playerX, playerY, chunkSize);
  return (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const c = chunkOf(x, y, chunkSize);
    return Math.abs(c.cx - p.cx) <= 1 && Math.abs(c.cy - p.cy) <= 1;
  };
}

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
    // When corpseAt turns null: lets live() drop it with a number compare.
    expiresAt: now + frames * DEATH_FRAME_MS + HOLD_MS + FADE_MS,
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

  // Take one world-state frame's `sfx` list. `inAoi` (aoiFilter) drops
  // deaths outside the snapshot's neighbourhood: no removal will match them.
  noteDeaths(sfx, now, inAoi = null) {
    this._pruneDeaths(now);
    if (!Array.isArray(sfx)) return;
    for (const e of sfx) {
      if (!e || e.e !== "death" || typeof e.c !== "string") continue;
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
      if (inAoi && !inAoi(e.x, e.y)) continue;
      this._deaths.push({ type: e.c, x: e.x, y: e.y, at: now });
      if (this._deaths.length > MAX_CORPSES) this._deaths.shift();
    }
  }

  // One creature dropped from the snapshot; see onRemovedBatch.
  onRemoved(creature, now, inAoi = null) {
    return this.onRemovedBatch(creature ? [creature] : [], now, inAoi)[0] || null;
  }

  // The creatures one snapshot dropped. Pending deaths are matched to them
  // nearest pair first across the whole batch (each death and each creature
  // used once), so one death is not credited to whichever creature came first.
  // A creature with no death row, no matching death, or last seen outside the
  // neighbourhood (`inAoi`: it left the AOI) just vanishes. Returns the new
  // corpses.
  onRemovedBatch(creatures, now, inAoi = null) {
    this._pruneDeaths(now);
    if (!Array.isArray(creatures) || this._deaths.length === 0) return [];
    const pairs = [];
    creatures.forEach((c, ci) => {
      if (!c || !hasDeathRow(c.sprite && c.sprite.manifest)) return;
      if (inAoi && !inAoi(Number.isFinite(c.tx) ? c.tx : c.x, Number.isFinite(c.ty) ? c.ty : c.y)) return;
      this._deaths.forEach((d, di) => {
        const d2 = this._distance2(c, d);
        if (d2 !== null) pairs.push({ ci, di, d2 });
      });
    });
    pairs.sort((a, b) => a.d2 - b.d2);
    const usedC = new Set();
    const usedD = new Set();
    const made = [];
    for (const { ci, di } of pairs) {
      if (usedC.has(ci) || usedD.has(di)) continue;
      const corpse = makeCorpse(creatures[ci], now);
      if (!corpse) continue;
      usedC.add(ci);
      usedD.add(di);
      this.dropId(corpse.id);
      this._corpses.push(corpse);
      if (this._corpses.length > MAX_CORPSES) this._corpses.shift();
      made.push(corpse);
    }
    if (usedD.size) this._deaths = this._deaths.filter((_, i) => !usedD.has(i));
    return made;
  }

  // The same creature id is back (a respawn): its corpse goes at once.
  dropId(id) {
    const i = this._corpses.findIndex((c) => c.id === id);
    if (i >= 0) this._corpses.splice(i, 1);
  }

  // The corpses still showing at `now` (faded ones are dropped). The returned
  // array is the store's own: do not mutate it.
  live(now) {
    if (this._corpses.some((c) => c.expiresAt <= now)) {
      this._corpses = this._corpses.filter((c) => c.expiresAt > now);
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

  // Squared distance from death `d` to creature `c` (the nearer of its drawn
  // centre and its snapshot-target centre), or null when the type differs or
  // it is out of reach.
  _distance2(c, d) {
    if (d.type !== c.type) return null;
    let best = Infinity;
    const at = (x, y) => {
      const p = centreOf(c, x, y);
      best = Math.min(best, (d.x - p.x) ** 2 + (d.y - p.y) ** 2);
    };
    at(c.x, c.y);
    if (Number.isFinite(c.tx) && Number.isFinite(c.ty)) at(c.tx, c.ty);
    return best <= DEATH_MATCH_PX * DEATH_MATCH_PX ? best : null;
  }
}
