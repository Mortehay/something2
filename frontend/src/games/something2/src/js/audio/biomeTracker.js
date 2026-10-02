// Hysteresis for ambience (spec §3): a new biome must hold for holdMs before
// it replaces the current one, so walking a border does not restart loops.
export class BiomeTracker {
  constructor({ holdMs = 1500 } = {}) {
    this.holdMs = holdMs;
    this.current = undefined;
    this.candidate = null;
    this.since = 0;
  }

  sample(biome, nowMs) {
    if (biome == null) return undefined;
    if (this.current === undefined) { this.current = biome; return biome; }
    if (biome === this.current) { this.candidate = null; return undefined; }
    if (biome !== this.candidate) { this.candidate = biome; this.since = nowMs; return undefined; }
    if (nowMs - this.since >= this.holdMs) {
      this.current = biome;
      this.candidate = null;
      return biome;
    }
    return undefined;
  }
}
