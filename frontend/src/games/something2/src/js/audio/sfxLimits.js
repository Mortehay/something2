// Pure voice-count/priority gate for SFX (spec §3 "Limits"). No Web Audio
// here -- AudioEngine asks admit() before starting a source and calls
// release() when a voice ends, so this stays testable without a real
// AudioContext.
//
// Priority is an ORDERED level, lowest first, so a later slice can slot a new
// tier in without touching the comparison logic:
//   nearby (creature ambience, Task 7) < nearest < own (the player's own
//   actions always win a contested slot).
export const SFX_PRIORITY_ORDER = ['nearby', 'nearest', 'own'];
const TOP_PRIORITY = SFX_PRIORITY_ORDER[SFX_PRIORITY_ORDER.length - 1];
const isTop = (priority) => priority === TOP_PRIORITY;

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
  // Controller ruling ("nearest win"), fix round 1: eviction at capacity is
  // NOT a strict priority-level comparison across the board. `own` (the top
  // priority) always wins a slot from any non-top voice, evicting whichever
  // held non-top voice is farthest -- unconditionally, regardless of the
  // newcomer's own distance (an own action is always worth hearing). Below
  // that, a non-top newcomer (today only 'nearest'; Task 7 adds 'nearby')
  // competes with the OTHER held non-top voices purely on distance: it may
  // only evict the farthest held non-top voice, and only when it is itself
  // nearer than that voice. Equal distance does not win -- ties are refused,
  // not evicted. A held 'own' voice is never evicted by a non-top newcomer.
  admit({ clipKey, priority, distance }) {
    const nowMs = this.now();
    const recent = (this.recentPlays.get(clipKey) || []).filter((t) => nowMs - t < this.sameClipWindowMs);
    if (recent.length >= this.sameClipMax) {
      this.recentPlays.set(clipKey, recent);
      return { ok: false };
    }

    let evict;
    if (this.voices.size >= this.maxVoices) {
      const top = isTop(priority);
      let worst = null;
      for (const [id, v] of this.voices) {
        if (isTop(v.priority)) continue; // a held 'own' voice is never evicted
        if (!worst || v.distance > worst.distance) worst = { id, distance: v.distance };
      }
      if (!worst) return { ok: false }; // full of 'own' voices, nothing evictable
      if (!top && distance >= worst.distance) return { ok: false }; // nearer-wins: refused, not a tie-evict
      evict = worst.id;
      this.voices.delete(evict);
    }

    const voiceId = this._nextId++;
    this.voices.set(voiceId, { clipKey, priority, distance });
    recent.push(nowMs);
    this.recentPlays.set(clipKey, recent);
    return evict !== undefined ? { ok: true, evict, voiceId } : { ok: true, voiceId };
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
