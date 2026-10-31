// Synthesised UI cues (no clip assets): the teleport cast's start, completion
// and interruption. Recipes are plain data so they can be tested without an
// AudioContext; playCue turns one into scheduled oscillators on a given bus.
//
// A recipe is a list of voices: { type, f0, f1, at, dur, gain } where the pitch
// glides from f0 to f1 over `dur` seconds starting `at` seconds from now.
export const CUES = Object.freeze({
  // A rising shimmer for as long as the cast runs (2.5s).
  "cast-start": [
    { type: "sine", f0: 220, f1: 880, at: 0, dur: 2.5, gain: 0.05 },
    { type: "triangle", f0: 330, f1: 1320, at: 0, dur: 2.5, gain: 0.025 },
  ],
  // Two bright notes when the cast completes.
  "cast-ready": [
    { type: "sine", f0: 784, f1: 784, at: 0, dur: 0.18, gain: 0.08 },
    { type: "sine", f0: 1175, f1: 1175, at: 0.12, dur: 0.35, gain: 0.08 },
  ],
  // A short falling blip when it is interrupted.
  "cast-cancel": [
    { type: "square", f0: 300, f1: 120, at: 0, dur: 0.18, gain: 0.04 },
  ],
});

export function cueDuration(name) {
  const voices = CUES[name];
  return voices ? Math.max(...voices.map((v) => v.at + v.dur)) : 0;
}

// Schedules the cue on `ctx`, routed into `bus` (a GainNode). Returns a stop()
// that fades the voices out early (used when a cast is cancelled), or null for
// an unknown cue.
export function playCue(ctx, bus, name) {
  const voices = CUES[name];
  if (!ctx || !bus || !voices) return null;
  const t0 = ctx.currentTime;
  const nodes = [];
  for (const v of voices) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = v.type;
    osc.frequency.setValueAtTime(v.f0, t0 + v.at);
    if (v.f1 !== v.f0) osc.frequency.linearRampToValueAtTime(v.f1, t0 + v.at + v.dur);
    // Short attack and release so there are no clicks.
    amp.gain.setValueAtTime(0.0001, t0 + v.at);
    amp.gain.linearRampToValueAtTime(v.gain, t0 + v.at + Math.min(0.03, v.dur / 4));
    amp.gain.setValueAtTime(v.gain, t0 + v.at + Math.max(0, v.dur - 0.05));
    amp.gain.linearRampToValueAtTime(0.0001, t0 + v.at + v.dur);
    osc.connect(amp);
    amp.connect(bus);
    osc.start(t0 + v.at);
    osc.stop(t0 + v.at + v.dur + 0.02);
    nodes.push({ osc, amp });
  }
  return function stop() {
    const now = ctx.currentTime;
    for (const { osc, amp } of nodes) {
      try {
        amp.gain.cancelScheduledValues(now);
        amp.gain.setValueAtTime(amp.gain.value, now);
        amp.gain.linearRampToValueAtTime(0.0001, now + 0.06);
        osc.stop(now + 0.08);
      } catch {
        // already stopped
      }
    }
  };
}
