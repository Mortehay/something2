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
const levelOf = (priority) => {
  const i = SFX_PRIORITY_ORDER.indexOf(priority);
  return i < 0 ? 0 : i;
};

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
  admit({ clipKey, priority, distance }) {
    const nowMs = this.now();
    const recent = (this.recentPlays.get(clipKey) || []).filter((t) => nowMs - t < this.sameClipWindowMs);
    if (recent.length >= this.sameClipMax) {
      this.recentPlays.set(clipKey, recent);
      return { ok: false };
    }

    const level = levelOf(priority);
    let evict;
    if (this.voices.size >= this.maxVoices) {
      let worst = null;
      for (const [id, v] of this.voices) {
        if (levelOf(v.priority) >= level) continue; // only a strictly lower priority may be bumped
        if (!worst || v.distance > worst.distance) worst = { id, distance: v.distance };
      }
      if (!worst) return { ok: false }; // full, and nothing lower-priority to bump
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
}
