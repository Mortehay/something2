// Pure "who is due to make a nearby ambient sound now" scheduler (spec §3
// "Creature `nearby`" / "World point `nearby`"). No Web Audio here -- the
// engine asks tick() every 250ms for who should play, and reports playback
// endings back via ended(id) so a slot can be reused.
//
// Kept separate from SfxLimiter on purpose: this caps how many *nearby*
// ambient voices even get a turn to compete for a slot at all (spec: "at
// most 4 simultaneous creature voices; the nearest ones win"), independently
// of the limiter's own global 12-voice cap that an admitted one then goes
// through. Two different questions -- "whose turn is it" vs "is there room
// on the bus" -- with two different caps.
import { MAP_TILE_SIZE } from '../core/constants.js';

const DEFAULT_RADIUS_PX = 8 * MAP_TILE_SIZE;
const DEFAULT_MAX_VOICES = 4;
const DEFAULT_MIN_GAP_MS = 4000;
const DEFAULT_MAX_GAP_MS = 10000;

export class NearbyScheduler {
  constructor({
    radiusPx = DEFAULT_RADIUS_PX,
    maxVoices = DEFAULT_MAX_VOICES,
    minGapMs = DEFAULT_MIN_GAP_MS,
    maxGapMs = DEFAULT_MAX_GAP_MS,
    rand = Math.random,
    now = () => performance.now(),
  } = {}) {
    this.radiusPx = radiusPx;
    this.maxVoices = maxVoices;
    this.minGapMs = minGapMs;
    this.maxGapMs = maxGapMs;
    this.rand = rand;
    this.now = now;
    this.nextAt = new Map();   // emitter id -> next eligible time (ms)
    this.sounding = new Set(); // emitter ids currently occupying a slot
  }

  // emitters: [{id, key, x, y}]. Returns the subset due to sound now, nearest
  // first: [{id, key, x, y, distance}].
  //
  // An emitter outside radiusPx is skipped entirely -- it neither starts nor
  // advances a schedule while out of range. The first time an in-range
  // emitter is ever seen, its next-time is seeded to `now + random offset in
  // [0, maxGapMs]`, so a group that all enter together doesn't all sound at
  // once. It becomes "due" once `now` reaches that time, but only WINS a
  // slot if it is among the nearest `maxVoices - (already sounding)` due
  // emitters this tick; a due-but-not-chosen emitter keeps its current
  // next-time and simply competes again on the next tick (it is not pushed
  // further out for losing). An emitter that wins a slot has its next-time
  // pushed out by `random(minGapMs, maxGapMs)` and is marked "sounding" --
  // excluded from further contention -- until the caller calls ended(id).
  tick(emitters, listener) {
    const nowMs = this.now();
    const lx = (listener && listener.x) || 0;
    const ly = (listener && listener.y) || 0;
    const due = [];
    for (const e of emitters || []) {
      if (!e || e.id == null) continue;
      const dx = (e.x || 0) - lx;
      const dy = (e.y || 0) - ly;
      const distance = Math.hypot(dx, dy);
      if (distance > this.radiusPx) continue;
      let nextAt = this.nextAt.get(e.id);
      if (nextAt === undefined) {
        nextAt = nowMs + this.rand() * this.maxGapMs;
        this.nextAt.set(e.id, nextAt);
      }
      if (this.sounding.has(e.id)) continue; // already occupying a slot
      if (nowMs < nextAt) continue;
      // Spread `e` (not a hand-picked subset) so any extra field the caller
      // attached -- AudioEngine's `kind: 'creature'|'point'` -- passes
      // through untouched; this scheduler doesn't need to know what it means.
      due.push({ ...e, distance });
    }
    due.sort((a, b) => a.distance - b.distance);
    const free = Math.max(0, this.maxVoices - this.sounding.size);
    const admitted = due.slice(0, free);
    for (const d of admitted) {
      this.sounding.add(d.id);
      this.nextAt.set(d.id, nowMs + this.minGapMs + this.rand() * (this.maxGapMs - this.minGapMs));
    }
    return admitted;
  }

  // Frees the slot an admitted emitter held -- whether it actually played
  // (finished, or was evicted) or never made it to a voice at all (an
  // unbound chain, no clip, or the sfx limiter itself refused it). The
  // caller must call this exactly once per id tick() ever admitted, or that
  // slot leaks for the rest of the session.
  ended(id) { this.sounding.delete(id); }

  // Full reset on a world change / destroy (mirrors SfxLimiter.clear()):
  // drops all scheduling state so a stale id from the old world can never
  // block or alias one in the new world.
  clear() { this.nextAt.clear(); this.sounding.clear(); }
}
