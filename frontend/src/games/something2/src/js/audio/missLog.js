// Sounds the game wanted and did not have (spec §3 "Misses log"). Each key is
// recorded once per session; drain() hands the unsent ones to the poster.
export class MissLog {
  constructor() { this.seen = new Set(); this.pending = []; }

  record(missKey, world) {
    if (!missKey || this.seen.has(missKey)) return false;
    this.seen.add(missKey);
    const first = missKey.indexOf('/');
    const last = missKey.lastIndexOf('/');
    if (first < 0 || last <= first) return false;
    this.pending.push({
      subject_kind: missKey.slice(0, first),
      subject_key: missKey.slice(first + 1, last),
      slot: missKey.slice(last + 1),
      world: world || null,
    });
    return true;
  }

  drain() { const out = this.pending; this.pending = []; return out; }
}
