// Pure voice-count/priority gate for SFX (spec §3 "Limits"). No Web Audio
// here -- AudioEngine asks admit() before starting a source and calls
// release() when a voice ends, so this stays testable without a real
// AudioContext.
//
// Priority is an ORDERED level, lowest first:
//   nearby (creature/world-point ambience) < nearest (a non-own sfx event)
//   < boss (SOMET-605: boss one-shots) < own (the player's own actions).
//
// Eviction at capacity is NOT a flat priority comparison -- see admit()'s
// comment for the exact rule per tier.
export const SFX_PRIORITY_ORDER = ['nearby', 'nearest', 'boss', 'own'];

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
  // Eviction at capacity, per tier (a held 'own' voice is never evicted):
  //   - 'own' always wins: it bumps the farthest held 'nearby', else the
  //     farthest 'nearest', else (last resort, ruling G5) the farthest 'boss',
  //     all unconditionally.
  //   - 'boss' bumps the farthest held 'nearby', else 'nearest',
  //     unconditionally; otherwise only a FARTHER held 'boss' (nearer wins,
  //     ties refused). Never 'own'.
  //   - 'nearest' bumps a held 'nearby' unconditionally, else a farther
  //     'nearest'. Never 'boss' or 'own'.
  //   - 'nearby' may only bump a farther held 'nearby'.
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
    switch (priority) {
      case 'own':
        return this._farthestOf('nearby') || this._farthestOf('nearest') || this._farthestOf('boss');
      case 'boss': {
        const low = this._farthestOf('nearby') || this._farthestOf('nearest');
        if (low) return low;
        const other = this._farthestOf('boss');
        return other && distance < other.distance ? other : null;
      }
      case 'nearest': {
        const nearby = this._farthestOf('nearby');
        if (nearby) return nearby;
        const nearest = this._farthestOf('nearest');
        return nearest && distance < nearest.distance ? nearest : null;
      }
      case 'nearby': {
        const nearby = this._farthestOf('nearby');
        return nearby && distance < nearby.distance ? nearby : null;
      }
      default:
        return null;
    }
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
