// Pure helpers for the first-entry preload screen. No DOM, no clock of their own
// (callers pass `now`), so they are testable without timers.

// Estimates the time left from how fast images have been settling lately.
// A sliding window rather than the lifetime average: the first seconds include
// connection setup and the catalogue burst, and an average over them lies for the
// rest of the load.
export function createEtaTracker(windowMs = 6000) {
  const samples = []; // { t, done }
  return {
    sample(now, done) {
      samples.push({ t: now, done });
      while (samples.length > 2 && now - samples[1].t >= windowMs) samples.shift();
    },
    // Seconds remaining, or null while there is not yet enough to say (fewer
    // than two samples, or nothing settled across the window).
    eta(now, remaining) {
      if (remaining <= 0) return 0;
      if (samples.length < 2) return null;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = (Math.max(now, last.t) - first.t) / 1000;
      const dn = last.done - first.done;
      if (dt <= 0 || dn <= 0) return null;
      return remaining / (dn / dt);
    },
  };
}

// 65 -> { m: 1, s: 5 }; null/NaN -> null so the caller shows "calculating".
export function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return { m: 0, s };
  return { m: Math.floor(s / 60), s: s % 60 };
}

export function percent(done, total) {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.floor((done / total) * 100));
}
