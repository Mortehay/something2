// WHERE creatures go, as opposed to how many of them a world gets.
//
// Placement used to rejection-sample the interior uniformly, so every screen of
// a world was statistically identical: no reason to prefer one direction over
// another, and no such thing as a dangerous place. This module supplies a
// per-tile WEIGHT that placement uses as an extra acceptance gate, so creatures
// concentrate away from safety, in hostile biomes, and in noise peaks.
//
// PURELY REDISTRIBUTIVE. placeMapCreatures loops `for (i = 0; i < count; i++)`
// and places `count` creatures whatever this says; the field decides only where
// they land. A world's total comes from its density tier and
// MAX_WORLD_CREATURES, never from here. Normalizing to mean 1.0 is therefore
// about keeping the ACCEPTANCE RATE high -- an un-normalized field would reject
// most samples, exhaust maxAttempts and under-deliver -- and not about hitting
// a target count.
//
// IMPORTS NOTHING FROM mapService, deliberately and permanently. mapService
// requires this module, so a require back would be a cycle and whichever loaded
// second would see a half-built exports object -- the same trap safeRegion.js's
// header documents. The two mapService helpers this needs (the value-noise
// function and the biome sampler) are passed IN, exactly as safeRegion takes
// pathCells as an argument rather than recomputing them.

// --- the three terms ---------------------------------------------------

// Distance from safety, in tiles, at which a region is as dangerous as it gets.
const SAFETY_RAMP = 20;

// Rising step rather than a smooth curve: a player should be able to feel the
// transition when they leave the road, and steps are exactly testable in a way
// an interpolated curve is not.
function safetyForDistance(d) {
  if (d <= 0) return 0;        // inside safety; creatureTileCandidates also refuses these
  if (d <= 5) return 0.4;
  if (d <= 12) return 1;
  if (d <= SAFETY_RAMP) return 1.4;
  return 1.6;                  // also the value for Infinity (no safe tile on the map)
}

// Noise cell size in tiles. A screen is ~225 tiles (~15x15), so 12 puts a full
// quiet-to-thick cycle at roughly two screens -- something a player walks
// THROUGH, rather than something that averages out under them.
const NOISE_CELL = 12;

// Salted away from the terrain field (cfg.seed), the biome field
// (BIOME_FIELD_XOR), the decoration field (DECO_SEED_XOR) and both placement
// streams, so creature-thick regions do not silently line up with forests.
const NOISE_SALT = 0x27d4eb2f;

const NOISE_MIN = 0.3;
const NOISE_MAX = 1.8;

// `noise` is globalValueNoise, injected. Its [0,1) output maps linearly onto
// the band.
function noiseWeight(seed, gRow, gCol, noise = defaultNoise) {
  const v = noise(((seed >>> 0) ^ NOISE_SALT) >>> 0, gRow, gCol, NOISE_CELL);
  const u = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
  return NOISE_MIN + u * (NOISE_MAX - NOISE_MIN);
}

// Only so noiseWeight is callable in a unit test without wiring mapService in.
// Production always injects globalValueNoise.
function defaultNoise(seed, gRow, gCol, cell) {
  const x = Math.sin(seed * 0.0001 + gRow / cell * 12.9898 + gCol / cell * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// --- the field ---------------------------------------------------------

// Bounds on the NORMALIZED weight. The floor keeps quiet regions quiet without
// creating dead map; the ceiling is what makes the density ladder's "peak"
// column true by construction. Deliberately tight: a true set-piece horde is
// authored (Slice C), not an accident of three multipliers peaking at once.
const WEIGHT_MIN = 0.15;
const WEIGHT_MAX = 1.5;

// Multi-source BFS from every safe tile, capped at SAFETY_RAMP + 1.
//
// safeRegion exposes isSafeTile -- a boolean, not a distance. Probing outward
// per sample would be O(r^2) inside a loop that already runs up to 40 times per
// creature; this walks the map ONCE instead. A 224x224 map is ~50k cells and
// completes in single-digit milliseconds.
//
// Capped because nothing past the ramp changes the answer: safetyForDistance is
// constant beyond it, so the frontier is dropped rather than expanded across
// the rest of the map.
function safeDistanceField(width, height, safeAt) {
  const dist = new Int32Array(width * height).fill(-1);
  let frontier = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (safeAt(r, c)) { dist[r * width + c] = 0; frontier.push(r * width + c); }
    }
  }
  let d = 0;
  while (frontier.length && d < SAFETY_RAMP + 1) {
    const next = [];
    d += 1;
    for (const idx of frontier) {
      const r = Math.floor(idx / width), c = idx % width;
      // 4-neighbour: this measures travel distance from safety, and a diagonal
      // step is not a shorter walk in a game whose movement is axis-aligned.
      if (r > 0) pushIf(dist, next, (r - 1) * width + c, d);
      if (r < height - 1) pushIf(dist, next, (r + 1) * width + c, d);
      if (c > 0) pushIf(dist, next, r * width + (c - 1), d);
      if (c < width - 1) pushIf(dist, next, r * width + (c + 1), d);
    }
    frontier = next;
  }
  return dist;   // -1 means "further than the ramp", which reads as Infinity
}

function pushIf(dist, next, idx, d) {
  if (dist[idx] !== -1) return;
  dist[idx] = d;
  next.push(idx);
}

// safeCtx is anything exposing safeAt(gRow, gCol) -> boolean. mapService passes
// an adapter over safeRegion.isSafeTile; tests pass a literal.
//
// deps: { noise, regionAt } -- globalValueNoise and sampleBiomeRegion. Injected
// rather than imported; see the header.
function buildDensityField(cfg, safeCtx, deps = {}) {
  const noise = deps.noise || defaultNoise;
  const regionAt = deps.regionAt || (() => null);

  // An unbounded config has no map to walk and no interior to normalize over.
  // A flat field is the correct answer, and it keeps every caller free of a
  // null check.
  if (!cfg || !cfg.bounds) {
    return { weightAt: () => 1, max: WEIGHT_MAX };
  }

  const { width, height } = cfg.bounds;
  const dist = safeDistanceField(width, height, (r, c) => safeCtx.safeAt(r, c));

  const raw = (gRow, gCol) => {
    const d = dist[gRow * width + gCol];
    const safety = safetyForDistance(d === -1 ? Infinity : d);
    if (safety === 0) return 0;
    const region = regionAt(cfg, gRow, gCol);
    const biome = (region && Number.isFinite(region.creatureDensity) && region.creatureDensity > 0)
      ? region.creatureDensity : 1;
    return safety * biome * noiseWeight(cfg.seed, gRow, gCol, noise);
  };

  // Mean over INTERIOR tiles only (strictly inside the wall ring), matching the
  // rLo/rHi/cLo/cHi bounds both placers sample within -- normalizing over tiles
  // no creature can occupy would bias the field.
  //
  // Safe tiles contribute 0 and are counted, deliberately: they are part of the
  // map's area, and excluding them would inflate every other tile's weight on a
  // village-heavy map.
  let sum = 0, n = 0;
  for (let r = 1; r <= height - 2; r++) {
    for (let c = 1; c <= width - 2; c++) { sum += raw(r, c); n += 1; }
  }
  // A map that is entirely safe (or 2 tiles wide) has no signal to normalize
  // against. Flat is the only defensible answer; dividing by 0 is not.
  const mean = n > 0 && sum > 0 ? sum / n : 0;
  if (mean === 0) return { weightAt: () => 1, max: WEIGHT_MAX };

  const weightAt = (gRow, gCol) => {
    const w = raw(gRow, gCol) / mean;
    return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
  };

  return { weightAt, max: WEIGHT_MAX };
}

module.exports = {
  buildDensityField, safetyForDistance, noiseWeight, safeDistanceField,
  WEIGHT_MIN, WEIGHT_MAX, SAFETY_RAMP, NOISE_CELL, NOISE_SALT, NOISE_MIN, NOISE_MAX,
};
