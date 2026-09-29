// Pure voice-count/priority gate for SFX (spec §3 "Limits"). No Web Audio
// here -- AudioEngine asks admit() before starting a source and calls
// release() when a voice ends, so this stays testable without a real
// AudioContext.
//
// Priority is an ORDERED level, lowest first:
//   nearby (creature/world-point ambience, Task 7) < nearest (a non-own sfx
//   event) < own (the player's own actions always win a contested slot).
//
// Eviction at capacity is NOT a flat priority comparison -- see admit()'s
// comment for the exact rule per tier, but in one line: 'own' always wins,
// bumping a held 'nearby' voice first and a held 'nearest' voice only if no
// 'nearby' voice is held; 'nearest' does the same (bumps 'nearby' first,
// unconditionally, else competes with other 'nearest' voices purely on
// distance); 'nearby' may only ever bump a farther held 'nearby' voice, never
// 'nearest' or 'own', however near it is.
export const SFX_PRIORITY_ORDER = ['nearby', 'nearest', 'own'];
const TOP_PRIORITY = SFX_PRIORITY_ORDER[SFX_PRIORITY_ORDER.length - 1];
const BOTTOM_PRIORITY = SFX_PRIORITY_ORDER[0];
const isTop = (priority) => priority === TOP_PRIORITY;
const isBottom = (priority) => priority === BOTTOM_PRIORITY;

const MAX_VOICES = 12;
const SAME_CLIP_WINDOW_MS = 100;
const SAME_CLIP_MAX = 3;

export class SfxLimiter {
  constructor({ now = () => performance.now(), maxVoices = MAX_VOICES, sameClipWindowMs = SAME_CLIP_WINDOW_MS, sameClipMax = SAME_CLIP_MAX } = {}) {
    this.now = now;
    this.maxVoices = maxVoices;
    this.sameClipWindowMs = sameClipWindowMs;
    this.sameClipMax = sameClipMax;
    this.voices = new Map();      // voiceId -> { clipKey, priority, distance }
    this.recentPlays = new Map(); // clipKey -> [timestamp, ...] within the window
    this._nextId = 1;
  }

  // {clipKey, priority, distance} -> {ok, evict?, voiceId?}. `evict`, when
  // present, is the voiceId of an existing voice the caller must stop to make
  // room -- admit() has already forgotten it, so the caller only needs to
  // stop its actual playback.
  //
  // Controller ruling ("nearest win"), fix round 1, extended for the
  // 'nearby' tier (Task 7): eviction at capacity is NOT a strict
  // priority-level comparison across the board.
  //   - 'own' (top) always wins a slot: it bumps the farthest held 'nearby'
  //     voice if any is held, regardless of its own distance (an own action
  //     is always worth hearing); only when NO 'nearby' voice is held does it
  //     fall back to bumping the farthest held 'nearest' voice, equally
  //     unconditionally. A held 'own' voice is never evicted.
  //   - 'nearest' does the same in miniature: it bumps the farthest held
  //     'nearby' voice unconditionally if one is held (a nearby ambience is
  //     never worth keeping over a real sfx event); only with none held does
  //     it compete with the OTHER held 'nearest' voices purely on distance --
  //     it may evict only the farthest held 'nearest' voice, and only when it
  //     is itself nearer. Equal distance does not win -- ties are refused.
  //     A held 'own' voice is never evicted by 'nearest'.
  //   - 'nearby' may only ever evict a FARTHER held 'nearby' voice, on the
  //     same nearer-wins/no-ties rule -- never a 'nearest' or 'own' voice,
  //     however near it is. With no 'nearby' voice held (or none farther),
  //     it is refused, full stop.
  admit({ clipKey, priority, distance }) {
    const nowMs = this.now();
    const recent = (this.recentPlays.get(clipKey) || []).filter((t) => nowMs - t < this.sameClipWindowMs);
    if (recent.length >= this.sameClipMax) {
      this.recentPlays.set(clipKey, recent);
      return { ok: false };
    }

    let evict;
    if (this.voices.size >= this.maxVoices) {
      const target = this._evictionTarget(priority, distance);
      if (!target) return { ok: false };
      evict = target.id;
      this.voices.delete(evict);
    }

    const voiceId = this._nextId++;
    this.voices.set(voiceId, { clipKey, priority, distance });
    recent.push(nowMs);
    this.recentPlays.set(clipKey, recent);
    return evict !== undefined ? { ok: true, evict, voiceId } : { ok: true, voiceId };
  }

  // The farthest held voice of exactly one priority tier, or null if none is
  // held.
  _farthestOf(priority) {
    let worst = null;
    for (const [id, v] of this.voices) {
      if (v.priority !== priority) continue;
      if (!worst || v.distance > worst.distance) worst = { id, distance: v.distance };
    }
    return worst;
  }

  // Which held voice (if any) a newcomer of this priority/distance may bump,
  // per the tier rules documented on admit() above. Returns null when the
  // newcomer must be refused.
  _evictionTarget(priority, distance) {
    if (isTop(priority)) {
      return this._farthestOf(BOTTOM_PRIORITY) || this._farthestOf('nearest');
    }
    if (isBottom(priority)) {
      const nearby = this._farthestOf(BOTTOM_PRIORITY);
      return nearby && distance < nearby.distance ? nearby : null;
    }
    // 'nearest': prefer bumping a held 'nearby' voice unconditionally; with
    // none held, compete with the other held 'nearest' voices on distance.
    const nearby = this._farthestOf(BOTTOM_PRIORITY);
    if (nearby) return nearby;
    const nearest = this._farthestOf('nearest');
    return nearest && distance < nearest.distance ? nearest : null;
  }

  release(voiceId) {
    this.voices.delete(voiceId);
  }

  // Drops all tracked voices and clip-history, but deliberately leaves
  // _nextId untouched -- fix round 1, finding 1. AudioEngine calls this on a
  // world change instead of constructing a fresh SfxLimiter so voice ids
  // stay monotonic across the reset: a voice from the OLD world that is
  // still awaiting its buffer when the world changes must never be able to
  // alias a voice id minted for the NEW world (see AudioEngine's pending-set
  // cancellation, which is the primary guard; this is the second one).
  clear() {
    this.voices.clear();
    this.recentPlays.clear();
  }
}
