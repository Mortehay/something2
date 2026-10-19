// SOMET-644. JavaScript port of the GPU box's world-spec generator, for use
// when the box is unreachable. The reference is vendored next door, read-only:
// backend/tools/world_gen_ref/world_gen.py (see SOURCE.md there). This module
// mirrors it function by function under camelCased names, and must reproduce
// `to_json(plan_region(...))` BYTE FOR BYTE - see
// backend/tests/world_gen_parity.test.js and the golden fixtures.
//
// Porting rules (plan "Python->JS traps", Task 2 review):
//   - compute with plain numbers; `//`, `%`, round() go through pyCompat;
//   - every Python f"{v}" / str(v) is pyStr(v), never a template literal on a
//     number - "4.0" vs "4" is the whole difference;
//   - Python truthiness ([] and {} are False, 0 is False) is spelled out;
//   - output key order is Python dict insertion order, so objects are built in
//     the same order and never carry integer-like keys.
//
// The density behaviour ported is the CORRECTED one (reference module docstring,
// 2026-08-27): resolveDensity takes no biome, and the biome multiplier scales
// nothing - something2's creatureDensityField normalises to mean 1.0. The
// reference keeps the superseded claim in prose; it is not ported.
//
// report() and its private helpers are not here yet (SOMET-644 Task 4).

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const { isPyFloat, floorDiv, pyMod, pyRound, pyStr, dumpsPy } = require('./pyCompat');

// --- python semantics, spelled out ------------------------------------------

class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

const hasOwn = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

function isDict(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !isPyFloat(v);
}

// Python `bool(v)`.
function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0; // NaN is truthy in Python too
  if (isPyFloat(v)) return v.value !== 0;
  if (typeof v === 'string' || Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

// `for x in v` over what a JSON spec can hold: a list, a str (its characters),
// a dict (its keys). Anything else is iterated as nothing.
function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [...v];
  if (isDict(v)) return Object.keys(v);
  return [];
}

// Python int() on what a spec can hold: truncates toward zero, bool is 0/1.
function pyInt(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) {
    throw new TypeError(`int() argument must be a string or a number, not ${pyStr(v === undefined ? null : v)}`);
  }
  return Math.trunc(n) + 0;
}

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
}

// --- something2's constants, mirrored ---------------------------------------

// services/densityTiers.js. Rates are per 1000 tiles and are the world's MEAN.
const DENSITY_TIERS = Object.freeze({
  dead: 0.0, sparse: 9.0, normal: 18.0, dense: 36.0, horde: 62.0, swarm: 89.0,
});

// Their CHECK constraint order, weakest first.
const DENSITY_ORDER = Object.freeze(['dead', 'sparse', 'normal', 'dense', 'horde', 'swarm']);

// 1280x720 canvas, 128x64 iso diamond: one screen is ~225 tiles.
const TILES_PER_SCREEN = 225;

// Scatter + packs may never exceed this.
const MAX_WORLD_CREATURES = 5000;

// Only scatter is modelled; every estimate is a floor.
const PACKS_NOT_MODELLED = true;

function b(color, density, path_, flora, creatures, depth) {
  return { color, creature_density: density, path_tile: path_, flora, creatures, depth };
}

// The live `biomes` table, all 32 rows (something2 DB, 2026-08-27). Order
// matters: plan_region falls back to names[i % 32] and the descent pools are
// filtered from it.
const BIOMES = deepFreeze({
  // surface: the five starter biomes, widened 2026-08-27 with their P4 lines
  Meadow: b('#5aa84f', 0.5, 'road_dirt', ['bush', 'rose_bush', 'Tree', 'Stone'],
    ['Slime', 'Wolf', 'Beast Swarm', 'Beast Skirmisher', 'Beast Line'], 'surface'),
  'Deep Forest': b('#2f6b3a', 1.0, 'road_dirt', ['Tree', 'pine_tree', 'dead_tree', 'bush', 'Stone'],
    ['Wolf', 'Bat', 'Skeleton', 'Woodland Swarm', 'Woodland Skirmisher', 'Woodland Line'], 'surface'),
  'Arid Dunes': b('#c9a227', 0.8, 'road_sand', ['dead_tree', 'Stone'],
    ['Skeleton', 'Bat', 'Desert Swarm', 'Desert Skirmisher', 'Desert Line'], 'surface'),
  'Frozen Waste': b('#8fb8d6', 1.1, 'road_snow', ['IceRock', 'pine_tree'],
    ['Bat', 'Skeleton', 'Tundra Swarm', 'Tundra Skirmisher', 'Tundra Line'], 'surface'),
  Mire: b('#4d6b41', 2.0, 'road_dirt', ['dead_tree', 'bush', 'Stone'],
    ['Slime', 'Bat', 'Swamp Swarm', 'Swamp Skirmisher', 'Swamp Line'], 'surface'),
  // P4-creature biomes that read as outdoors: the bridge to the deep ones
  Highlands: b('#7d8471', 0.9, 'road_stone', ['Stone', 'pine_tree'],
    ['Highland Swarm', 'Highland Skirmisher', 'Highland Line'], 'surface'),
  'Storm Coast': b('#6b7280', 0.6, 'road_sand', ['Stone', 'dead_tree'],
    ['Storm Swarm', 'Storm Skirmisher', 'Storm Line'], 'surface'),
  'Verdant Jungle': b('#1f6b2e', 1.6, 'road_dirt', ['Tree', 'bush', 'rose_bush'],
    ['Jungle Swarm', 'Jungle Skirmisher', 'Jungle Line'], 'surface'),
  // deep: dungeon-flavoured, P4 creatures, denser
  'Abyssal Rift': b('#1c1a24', 2.4, 'road_stone', [],
    ['Void Swarm', 'Void Skirmisher', 'Void Line'], 'deep'),
  // Surface on authored evidence: vale-region pairs it with Arid Dunes.
  Ashfields: b('#4a4038', 1.7, 'road_ash', ['dead_tree', 'Stone'],
    ['Volcanic Swarm', 'Volcanic Skirmisher', 'Volcanic Line'], 'surface'),
  Blightworks: b('#5e6b3a', 2.0, 'road_ash', ['dead_tree', 'Stone'],
    ['Blight Swarm', 'Blight Skirmisher', 'Blight Line'], 'deep'),
  Catacombs: b('#55504a', 2.3, 'road_stone', ['Stone'],
    ['Undead Swarm', 'Undead Skirmisher', 'Undead Line'], 'deep'),
  Cavern: b('#5a5148', 1.9, 'road_dirt', ['Stone'],
    ['Cave Swarm', 'Cave Skirmisher', 'Cave Line'], 'deep'),
  'Crystal Hollows': b('#6fa8c9', 1.6, 'road_snow', ['IceRock', 'Stone'],
    ['Crystal Swarm', 'Crystal Skirmisher', 'Crystal Line'], 'deep'),
  Deepvault: b('#4f5560', 1.8, 'road_stone', ['Stone'],
    ['Construct Swarm', 'Construct Skirmisher', 'Construct Line'], 'deep'),
  'Dreaming Dark': b('#4a3f6b', 2.3, 'road_stone', [],
    ['Nightmare Swarm', 'Nightmare Skirmisher', 'Nightmare Line'], 'deep'),
  Emberdepths: b('#7a3b22', 2.2, 'road_ash', ['Stone'],
    ['Ember Swarm', 'Ember Skirmisher', 'Ember Line'], 'deep'),
  'Fallen Sanctum': b('#b8a97a', 2.2, 'road_stone', [],
    ['Fallen Swarm', 'Fallen Skirmisher', 'Fallen Line'], 'deep'),
  Frostvault: b('#a8c6d6', 1.8, 'road_snow', ['IceRock'],
    ['Rime Swarm', 'Rime Skirmisher', 'Rime Line'], 'deep'),
  'Fungal Deep': b('#6b7f3a', 2.1, 'road_dirt', ['bush', 'Stone'],
    ['Fungal Swarm', 'Fungal Skirmisher', 'Fungal Line'], 'deep'),
  Gloomfen: b('#4a5a4a', 1.9, 'road_dirt', ['dead_tree', 'bush'],
    ['Gloom Swarm', 'Gloom Skirmisher', 'Gloom Line'], 'deep'),
  'Grave of Titans': b('#7a7266', 2.1, 'road_stone', ['Stone'],
    ['Titan Swarm', 'Titan Skirmisher', 'Titan Line'], 'deep'),
  'Hive Warrens': b('#8a6a2f', 2.2, 'road_dirt', ['Stone'],
    ['Hive Swarm', 'Hive Skirmisher', 'Hive Line'], 'deep'),
  'Infernal Gate': b('#8c3a1e', 2.5, 'road_ash', [],
    ['Demonic Swarm', 'Demonic Skirmisher', 'Demonic Line'], 'deep'),
  Ossuary: b('#c9c2ad', 2.4, 'road_stone', ['Stone'],
    ['Bonelord Swarm', 'Bonelord Skirmisher', 'Bonelord Line'], 'deep'),
  'Pestilent Deep': b('#6b6b33', 2.4, 'road_ash', [],
    ['Plague Swarm', 'Plague Skirmisher', 'Plague Line'], 'deep'),
  'Shattered Vault': b('#6b2f6b', 2.3, 'road_stone', [],
    ['Chaos Swarm', 'Chaos Skirmisher', 'Chaos Line'], 'deep'),
  'Sunken Cistern': b('#3f5a63', 1.8, 'road_stone', ['Stone'],
    ['Drowned Swarm', 'Drowned Skirmisher', 'Drowned Line'], 'deep'),
  'Sunken Foundry': b('#6a5a48', 1.8, 'road_stone', ['Stone'],
    ['Stoneborn Swarm', 'Stoneborn Skirmisher', 'Stoneborn Line'], 'deep'),
  // Likewise: vale_frozen pairs it with Frozen Waste on the surface ring.
  'Sunken Ruins': b('#8a8577', 1.4, 'road_stone', ['Stone', 'dead_tree', 'bush'],
    ['Ruin Swarm', 'Ruin Skirmisher', 'Ruin Line'], 'surface'),
  'The Maw': b('#3d1f22', 2.5, 'road_ash', [],
    ['Eldritch Swarm', 'Eldritch Skirmisher', 'Eldritch Line'], 'deep'),
  'Umbral Warren': b('#2e2a35', 2.2, 'road_stone', ['Stone'],
    ['Umbral Swarm', 'Umbral Skirmisher', 'Umbral Line'], 'deep'),
});

const isBiome = (name) => hasOwn(BIOMES, name);
const biomeOr = (name) => (isBiome(name) ? BIOMES[name] : {});

const SURFACE = Object.freeze(Object.keys(BIOMES).filter((n) => BIOMES[n].depth === 'surface'));
const DEEP = Object.freeze(Object.keys(BIOMES).filter((n) => BIOMES[n].depth === 'deep'));

// Seven biomes carry NO flora by authored intent; a flora floor must not chase them.
const FLORA_OPTIONAL = Object.freeze(new Set(Object.keys(BIOMES).filter((n) => BIOMES[n].flora.length === 0)));

// SOMET-311: ~920 B/s per creature in the active neighbourhood, per socket.
const BYTES_PER_CREATURE_PER_SEC = 920;

// The authority broadcasts a radius-1 chunk neighbourhood: 9 chunks.
const NEIGHBOURHOOD_CHUNKS = 9;

// Above dense (~300 KiB/s, blessed by something2), below horde (~515).
const SOCKET_WARN_KIB_S = 400;

// --- what a biome can actually spawn ----------------------------------------
//
// Spawning is gated by `biomes.creature_types`: a world seeds nothing unless
// its `allowed_creature_types` INTERSECTS its biomes' lists (SOMET-315). So
// allowed_creature_types is DERIVED from the biomes, never chosen - which makes
// the intersection non-empty by construction.

/** Creatures these biomes can actually spawn: the union of their lists. */
function spawnable(biomes) {
  const seen = [];
  for (const name of pyIter(biomes)) {
    for (const c of biomeOr(name).creatures || []) {
      if (!seen.includes(c)) seen.push(c);
    }
  }
  return seen;
}

const BIOME_CREATURES = Object.freeze(Object.fromEntries(Object.entries(BIOMES).map(([n, x]) => [n, x.creatures])));

// --- the P4 bestiary ----------------------------------------------------------
//
// Loaded from a byte-identical copy of the reference's bestiary_p4.json, next
// to this module (the parity test pins its sha256).
const BESTIARY = deepFreeze(JSON.parse(fs.readFileSync(path.join(__dirname, 'bestiary_p4.json'), 'utf8')));
const FAMILIES = BESTIARY.families;
const ROLES = BESTIARY.roles;

// computeAuras is O(leaders x all) every tick, so leaders are rationed per world.
const LEADER_ROLES = Object.freeze(new Set(BESTIARY.leader_roles));
const MAX_LEADER_ROLES_PER_WORLD = 1;

// Which bestiary families suit which biome - the module's only editorial table.
const BIOME_FAMILIES = deepFreeze({
  Meadow: ['Beast', 'Woodland'],
  'Deep Forest': ['Woodland', 'Fungal', 'Gloom'],
  'Arid Dunes': ['Desert', 'Bonelord', 'Ruin'],
  'Frozen Waste': ['Tundra', 'Rime'],
  Mire: ['Swamp', 'Drowned', 'Blight'],
});

// Fewer distinct creature types than this and a world reads repetitive.
const THIN_VARIETY_BELOW = 5;

function familiesFor(biomes) {
  const out = [];
  for (const name of pyIter(biomes)) {
    for (const f of hasOwn(BIOME_FAMILIES, name) ? BIOME_FAMILIES[name] : []) {
      if (hasOwn(FAMILIES, f) && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

/**
 * Creature names for a world, matched to its families and level band. Roles
 * in catalog order (the difficulty ramp), only where the role's level range
 * OVERLAPS the band; leader roles capped at MAX_LEADER_ROLES_PER_WORLD.
 */
function bestiaryTypes(biomes, levelBand, limit = 12) {
  const band0 = truthy(levelBand) ? levelBand : [1, 3];
  const pair = band0.slice(0, 2);
  if (pair.length !== 2) {
    throw new ValueError(`not enough values to unpack (expected 2, got ${pyStr(pair.length)})`);
  }
  const [lo, hi] = pair;
  const fams = familiesFor(biomes);
  if (fams.length === 0) return [];

  const picked = [];
  let leaders = 0;
  for (const role of ROLES) {
    for (const fam of fams) {
      const band = hasOwn(FAMILIES, fam) && hasOwn(FAMILIES[fam], role) ? FAMILIES[fam][role] : undefined;
      if (!truthy(band)) continue;
      // Overlap, not containment.
      if (band[1] < lo || band[0] > hi) continue;
      if (LEADER_ROLES.has(role)) {
        if (leaders >= MAX_LEADER_ROLES_PER_WORLD) continue;
        leaders += 1;
      }
      const name = `${fam} ${role}`;
      if (!picked.includes(name)) picked.push(name);
      if (picked.length >= limit) return picked;
    }
  }
  return picked;
}

/**
 * Add one biome until the world can field THIN_VARIETY_BELOW kinds of
 * creature. Same depth first: a cross-depth repair puts a meadow inside the
 * Infernal Gate, so it is the last resort. `levelBand` is unused, as in the
 * reference.
 */
function enrichVariety(biomes, levelBand) {
  if (spawnable(biomes).length >= THIN_VARIETY_BELOW) return biomes;

  const here = new Set(pyIter(biomes).filter(isBiome).map((n) => BIOMES[n].depth));
  const names = Object.keys(BIOMES);
  const same = names.filter((n) => here.has(BIOMES[n].depth));
  const other = names.filter((n) => !here.has(BIOMES[n].depth));

  const current = pyIter(biomes);
  let best = biomes;
  let bestN = spawnable(biomes).length;
  for (const name of [...same, ...other]) {
    if (current.includes(name)) continue;
    const candidate = [...current, name];
    const n = spawnable(candidate).length;
    if (n > bestN) { best = candidate; bestN = n; }
    if (bestN >= THIN_VARIETY_BELOW) break;
  }
  return best;
}

function leaderCount(types) {
  let n = 0;
  for (const t of pyIter(types)) {
    // t.rsplit(" ", 1)[-1]
    if (LEADER_ROLES.has(t.slice(t.lastIndexOf(' ') + 1))) n += 1;
  }
  return n;
}

// The band for a surface world. An OMITTED band is not "derive it": seed-map.js
// turns it into level 1-1, a legal-looking value. So every world carries one,
// and [1, 2] leads into the deep ramp's first band [3, 5] with no gap.
const SURFACE_BAND = Object.freeze([1, 2]);

// Below this a world reads as empty space rather than a quiet stretch.
const EMPTY_BELOW_PER_SCREEN = 3.0;

// Above this a screen is a crowd and the wire cost bites.
const CROWDED_ABOVE_PER_SCREEN = 22.0;

// Fewer distinct flora types than this and the ground reads bare.
const THIN_FLORA_BELOW = 3;

const EDGES = Object.freeze(['N', 'E', 'S', 'W']);
const OPPOSITE = Object.freeze({ N: 'S', S: 'N', E: 'W', W: 'E' });
const DELTA = deepFreeze({ N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] });

// Positions are PIXELS, layout is TILES, at a fixed 100 px per tile.
const TILE_PX = 100;

// Tiles either side of a road that stay safe (world_safe_region, vale-region).
const SAFE_ROAD_RADIUS = 2;

/** Tile index -> the pixel centre of that tile. */
function toPx(tile) {
  return tile * TILE_PX + floorDiv(TILE_PX, 2);
}

/**
 * Is this a pixel coordinate, or a tile index someone forgot to convert? A
 * range check cannot tell (tile 64 is a legal pixel too); the centre offset
 * can: every emitted position is n*100+50. Python's isinstance(px, int)
 * excludes bool and float - a PyFloat is a float even when integral.
 */
function isTileCentre(px) {
  return typeof px === 'number' && Number.isInteger(px)
    && pyMod(px, TILE_PX) === floorDiv(TILE_PX, 2);
}

// Fields something2 reads as PIXELS; everything else in a world is TILES.
const PIXEL_FIELDS = deepFreeze([
  ['entry_spawn', ['x', 'y']],
  ['village', ['spawn_x', 'spawn_y']],
  ['chest', ['x', 'y']],
]);
const PIXEL_LIST_FIELDS = deepFreeze([
  ['waypoints', ['x', 'y']],
]);

const dictGet = (obj, key) => (hasOwn(obj, key) ? obj[key] : undefined);

/** Every pixel field in a world, checked for being pixels. */
function checkUnits(world) {
  const problems = [];
  const width = dictGet(world, 'width');
  const size = pyInt(truthy(width) ? width : 0);
  const limit = size * TILE_PX;
  const who = hasOwn(world, 'key') ? pyStr(world.key) : '?';
  const half = floorDiv(TILE_PX, 2);

  function check(where, value, key) {
    if (value === null || value === undefined) return;
    if (!isTileCentre(value)) {
      problems.push(
        `${who}.${where}.${key} = ${pyStr(value)} is not a tile `
        + 'centre - looks like TILE coordinates where something2 reads '
        + `PIXELS (${pyStr(TILE_PX)}px per tile, so tile n is n*${pyStr(TILE_PX)}+`
        + `${pyStr(half)})`,
      );
    } else if (truthy(limit) && !(value >= 0 && value < limit)) {
      problems.push(
        `${who}.${where}.${key} = ${pyStr(value)} is outside `
        + `the world's ${pyStr(limit)}px extent`,
      );
    }
  }

  for (const [field, keys] of PIXEL_FIELDS) {
    const obj = dictGet(world, field);
    if (isDict(obj)) {
      for (const k of keys) check(field, dictGet(obj, k), k);
    }
  }

  for (const [field, keys] of PIXEL_LIST_FIELDS) {
    const list = dictGet(world, field);
    pyIter(truthy(list) ? list : []).forEach((obj, i) => {
      if (isDict(obj)) {
        for (const k of keys) check(`${field}[${pyStr(i)}]`, dictGet(obj, k), k);
      }
    });
  }

  // The mirror: roads are TILES, so a pixel value there is the same mistake.
  const roads = dictGet(world, 'roads');
  pyIter(truthy(roads) ? roads : []).forEach((line, i) => {
    for (const point of pyIter(line)) {
      for (const v of pyIter(point)) {
        if (truthy(size) && !(v >= 0 && v < size)) {
          problems.push(
            `${who}.roads[${pyStr(i)}] point ${pyStr(point)} is `
            + `outside the ${pyStr(size)}-tile grid - roads are TILES, not `
            + 'pixels',
          );
        }
      }
    }
  });
  return problems;
}

// --- density, solved rather than named ----------------------------------------

const tierRate = (tier) => (hasOwn(DENSITY_TIERS, tier) ? DENSITY_TIERS[tier] : 0.0);

/**
 * Mean `creature_density` across a world's biomes. IT DOES NOT SCALE
 * ANYTHING: it describes distribution WITHIN a world. Returns a Python float.
 */
function biomeMultiplier(biomes) {
  const known = pyIter(biomes).filter(isBiome).map((n) => BIOMES[n].creature_density);
  if (known.length === 0) return 1.0;
  let sum = 0;
  for (const k of known) sum += k; // Python sum(): left to right from int 0
  return sum / known.length;
}

/**
 * Creatures on one screen - the felt number. No biome multiplier: something2's
 * resolveDensity has no biome parameter and creatureDensityField normalises to
 * mean 1.0, so a world's average is its resolved population over its area.
 * `biomes` is accepted and ignored. Returns a Python float.
 */
function perScreen(tier, biomes = null, width = 0, height = 0) {
  const area = pyInt(width) * pyInt(height);
  if (area <= 0) {
    // No world to measure: the tier's own rate.
    return tierRate(tier) * (TILES_PER_SCREEN / 1000.0);
  }
  return (resolveDensity(tier, width, height).scatter * TILES_PER_SCREEN) / area;
}

/** Mirror of their resolveDensity, scatter only. See PACKS_NOT_MODELLED. */
function resolveDensity(tier, width, height) {
  const area = pyInt(width) * pyInt(height);
  const target = pyRound((tierRate(tier) * area) / 1000.0);
  const scatter = Math.max(0, Math.min(target, MAX_WORLD_CREATURES));
  return { scatter, clamped: target > MAX_WORLD_CREATURES, area };
}

/**
 * The tier landing closest to `targetPerScreen`. `biomes` is accepted and
 * IGNORED - it once compensated for a multiplier that does not apply. Ties go
 * to the earlier tier in DENSITY_ORDER (strict <).
 */
function chooseDensity(targetPerScreen, biomes = null) {
  let best = 'normal';
  let bestErr = Infinity;
  for (const name of DENSITY_ORDER) {
    if (name === 'dead') continue;
    const err = Math.abs(DENSITY_TIERS[name] * (TILES_PER_SCREEN / 1000.0) - targetPerScreen);
    if (err < bestErr) { best = name; bestErr = err; }
  }
  return best;
}

/**
 * JSON per second down ONE socket for a player parked in the thick of it:
 * ~920 B/s per creature in the radius-1 chunk neighbourhood. A bandwidth cost,
 * falling with the SQUARE of chunk_size. Returns a Python float.
 */
function socketKibS(perScreenCount, chunkSize) {
  const tiles = NEIGHBOURHOOD_CHUNKS * chunkSize * chunkSize;
  const creatures = (perScreenCount * tiles) / TILES_PER_SCREEN;
  return (creatures * BYTES_PER_CREATURE_PER_SEC) / 1024.0;
}

/** Distinct decoration types a world can spawn - its trees and stones. */
function floraTypes(biomes) {
  const seen = [];
  for (const name of pyIter(biomes)) {
    for (const f of biomeOr(name).flora || []) {
      if (!seen.includes(f)) seen.push(f);
    }
  }
  return seen;
}

/**
 * Add one biome until the ground has THIN_FLORA_BELOW kinds of plant life.
 * Deliberately desolate worlds (FLORA_OPTIONAL) are not repaired. Candidates:
 * same depth first, then richest flora first (a stable sort, as Python's).
 */
function enrichFlora(biomes) {
  const current = pyIter(biomes);
  if (current.some((n) => typeof n === 'string' && FLORA_OPTIONAL.has(n))) return biomes;
  if (floraTypes(biomes).length >= THIN_FLORA_BELOW) return biomes;

  const here = new Set(current.filter(isBiome).map((n) => BIOMES[n].depth));
  const sortKey = (n) => [here.has(BIOMES[n].depth) ? 0 : 1, -BIOMES[n].flora.length];
  const order = Object.keys(BIOMES).sort((a, c) => {
    const [a0, a1] = sortKey(a);
    const [c0, c1] = sortKey(c);
    return (a0 - c0) || (a1 - c1);
  });
  for (const name of order) {
    if (current.includes(name)) continue;
    const candidate = [...current, name];
    if (floraTypes(candidate).length >= THIN_FLORA_BELOW) return candidate;
  }
  return biomes;
}

function creatureTypes(biomes) {
  const seen = [];
  for (const name of pyIter(biomes)) {
    for (const c of biomeOr(name).creatures || []) {
      if (!seen.includes(c)) seen.push(c);
    }
  }
  return seen;
}

// --- the region graph ---------------------------------------------------------

/** sha256 of "region/key" (UTF-8), first 6 hex digits, into 1000..60999. */
function seedFor(region, key) {
  const h = crypto.createHash('sha256').update(`${pyStr(region)}/${pyStr(key)}`, 'utf8').digest('hex');
  return 1000 + (parseInt(h.slice(0, 6), 16) % 60000);
}

/**
 * Grid positions outward from the origin, so a region grows compactly - links
 * only join orthogonal neighbours, and a straggling layout makes dead ends.
 */
function spiral(n) {
  const out = [[0, 0]];
  let x = 0;
  let y = 0;
  let dx = 1;
  let dy = 0;
  let steps = 1;
  let run = 0;
  while (out.length < n) {
    for (let s = 0; s < steps; s += 1) {
      x += dx;
      y += dy;
      out.push([x, y]);
      if (out.length >= n) return out;
    }
    [dx, dy] = [-dy, dx];
    run += 1;
    if (pyMod(run, 2) === 0) steps += 1;
  }
  return out.slice(0, Math.max(0, n));
}

/**
 * A complete, seedable something2 map spec. Takes the Python keyword
 * arguments as one object, under their Python names:
 *   { name, world_count = 6, target_per_screen = 6.0, size = 128,
 *     chunk_size = 32, biome_cell = 32, biome_plan = null,
 *     entry_biomes = ['Meadow'], bestiary = true }
 *
 * `biome_plan` is the semantic half (which biomes each world is, in graph
 * order); everything numeric is solved deterministically afterwards.
 */
function planRegion({
  name,
  world_count: worldCount = 6,
  target_per_screen: targetPerScreen = 6.0,
  size = 128,
  chunk_size: chunkSize = 32,
  biome_cell: biomeCell = 32,
  biome_plan: biomePlan = null,
  entry_biomes: entryBiomes = ['Meadow'],
  bestiary = true,
} = {}) {
  if (typeof name !== 'string') throw new TypeError('planRegion: name must be a string');
  if (worldCount < 1) throw new ValueError('a region needs at least one world');

  const names = Object.keys(BIOMES);
  const cells = spiral(worldCount);
  const worlds = [];
  const byCell = new Map();
  const cellKey = (gx, gy) => `${gx},${gy}`;
  const regionSlug = slug(name);
  // How many deep worlds so far. The band ramps on THIS, not the loop index,
  // so it stays monotonic when surface worlds are interleaved.
  let depthRank = 0;

  cells.forEach(([gx, gy], i) => {
    let biomes;
    if (truthy(biomePlan) && i < biomePlan.length) {
      biomes = pyIter(biomePlan[i]).filter(isBiome);
      if (biomes.length === 0) biomes = [names[pyMod(i, names.length)]];
    } else if (i === 0) {
      biomes = pyIter(entryBiomes).filter(isBiome);
      if (biomes.length === 0) biomes = ['Meadow'];
    } else {
      // A DESCENT, not a shuffle: surface near the entry, deep further out.
      // Progression is the INDEX, not grid distance - the spiral puts late
      // worlds next to the entry, and bands must ramp with the journey.
      const pool = i <= Math.max(1, floorDiv(worldCount, 3)) ? SURFACE : DEEP;
      biomes = [...new Set([pool[pyMod(i, pool.length)], pool[pyMod(i + 2, pool.length)]])];
    }

    // Both repairs apply to every author: the deterministic pairing can land
    // two thin biomes together too.
    biomes = enrichFlora(biomes);
    if (truthy(bestiary)) biomes = enrichVariety(biomes, null);

    // EVERY world gets a band (see SURFACE_BAND); the deep ramp is computed
    // after the biomes, on depthRank.
    let band;
    if (biomes.every((n) => biomeOr(n).depth === 'surface')) {
      band = [...SURFACE_BAND];
    } else {
      const lo = 3 + depthRank * 2;
      band = [lo, lo + 2 + floorDiv(depthRank, 2)];
      depthRank += 1;
    }

    const key = i ? `${regionSlug}_${pyStr(i)}` : `${regionSlug}_hub`;
    const tier = chooseDensity(targetPerScreen, biomes);

    const w = {
      key,
      name: title(name, i),
      allows_fast_travel: i === 0,
      grid: [gx, gy],
      seed: seedFor(name, key),
      width: size,
      height: size,
      chunk_size: chunkSize,
      biomes,
      biome_cell: biomeCell,
      // Derived, never chosen. See spawnable.
      allowed_creature_types: spawnable(biomes),
      density: tier,
      is_entry: i === 0,
    };
    // ALWAYS written, never null: absent and null both mean level 1-1 to the seeder.
    w.level_band = band;
    if (i === 0) {
      const centre = toPx(floorDiv(size, 2));
      w.entry_spawn = { x: centre, y: centre };
      // Centred ON the spawn tile (6x4 around mid includes mid). gate_edge is
      // corrected in addRoads once the exits are known.
      const mid = floorDiv(size, 2);
      w.village = {
        // Hyphens: world keys are `vale_hub`, village keys `vale-crossing`.
        key: `${regionSlug.replaceAll('_', '-')}-crossing`,
        min_row: mid - 2,
        min_col: mid - 3,
        width: 6,
        height: 4,
        gate_edge: 'E',
        spawn_x: centre,
        spawn_y: centre,
      };
    }
    worlds.push(w);
    byCell.set(cellKey(gx, gy), w);
  });

  const links = [];
  for (const w of worlds) {
    const [gx, gy] = w.grid;
    for (const edge of EDGES) {
      const [dx, dy] = DELTA[edge];
      const nb = byCell.get(cellKey(gx + dx, gy + dy));
      if (nb) links.push({ from: w.key, edge, to: nb.key });
    }
  }

  // Roads and waypoints need each world's exits: a second pass.
  const exits = new Map();
  for (const l of links) {
    if (!exits.has(l.from)) exits.set(l.from, []);
    exits.get(l.from).push(l.edge);
  }
  for (const w of worlds) addRoads(w, exits.get(w.key) || []);

  return { name, topology: 'region', worlds, links };
}

/**
 * A road from the middle of a world to every edge it exits by, in TILE
 * [row, col] polylines; the waypoint where they meet is in PIXELS. Mutates
 * `world`, as the reference does.
 */
function addRoads(world, edges) {
  if (!truthy(edges)) return;

  const size = pyInt(hasOwn(world, 'width') ? world.width : 128);
  const mid = floorDiv(size, 2);
  const last = size - 1;

  // 1..size-2, NOT 0..size-1: the wall ring occupies the outermost cells and
  // stampBounds overwrites anything authored there (their mapSpec.js:516).
  const ends = { N: [1, mid], S: [last - 1, mid], W: [mid, 1], E: [mid, last - 1] };
  const roads = pyIter(edges).filter((e) => hasOwn(ends, e)).map((e) => [[mid, mid], [...ends[e]]]);
  if (roads.length === 0) return;

  world.roads = roads;
  world.safe_road_radius = SAFE_ROAD_RADIUS;

  // The gate must open onto a real exit; prefer E, like their entry world.
  const village = dictGet(world, 'village');
  if (isDict(village)) village.gate_edge = edges.includes('E') ? 'E' : edges[0];
  // One per world (one_waypoint_per_world), where the roads meet.
  world.waypoints = [{
    x: toPx(mid),
    y: toPx(mid),
    name: `${pyStr(hasOwn(world, 'name') ? world.name : world.key)} Waystone`,
  }];
}

// Python str.isalnum() on one code point: isalpha (Unicode L*) or isnumeric
// (Numeric_Type Digit/Decimal/Numeric, i.e. N*). Unicode tables follow the
// runtime (Python 3.12: Unicode 15.0; Node: its ICU) - identical for every
// fixture name, see the parity test.
const ALNUM = /^[\p{L}\p{N}]$/u;

function slug(s) {
  let out = '';
  // Per code point, like Python's iteration; lower() per character, so İ
  // becomes "i̇" (two code points) and a lone Σ is σ, as in Python.
  for (const c of s) out += ALNUM.test(c) ? c.toLowerCase() : '_';
  out = out.replace(/^_+/, '').replace(/_+$/, '');
  while (out.includes('__')) out = out.replaceAll('__', '_');
  return out || 'region';
}

function title(region, i) {
  return i === 0 ? `${pyStr(region)} Crossing` : `${pyStr(region)} ${pyStr(i)}`;
}

/** The file `make seed-map SPEC=<name>` reads: json.dumps(spec, indent=2) + "\n". */
function toJson(spec) {
  return `${dumpsPy(spec, { indent: 2 })}\n`;
}

module.exports = {
  // errors
  ValueError,
  // constants and tables
  DENSITY_TIERS, DENSITY_ORDER, TILES_PER_SCREEN, MAX_WORLD_CREATURES, PACKS_NOT_MODELLED,
  BIOMES, SURFACE, DEEP, FLORA_OPTIONAL, BYTES_PER_CREATURE_PER_SEC, NEIGHBOURHOOD_CHUNKS,
  SOCKET_WARN_KIB_S, BIOME_CREATURES, BESTIARY, FAMILIES, ROLES, LEADER_ROLES,
  MAX_LEADER_ROLES_PER_WORLD, BIOME_FAMILIES, THIN_VARIETY_BELOW, SURFACE_BAND,
  EMPTY_BELOW_PER_SCREEN, CROWDED_ABOVE_PER_SCREEN, THIN_FLORA_BELOW, EDGES, OPPOSITE, DELTA,
  TILE_PX, SAFE_ROAD_RADIUS, PIXEL_FIELDS, PIXEL_LIST_FIELDS,
  // functions, in reference order
  spawnable, familiesFor, bestiaryTypes, enrichVariety, leaderCount, toPx, isTileCentre,
  checkUnits, biomeMultiplier, perScreen, resolveDensity, chooseDensity, socketKibS,
  floraTypes, enrichFlora, creatureTypes, seedFor, spiral, planRegion, addRoads, slug, title,
  toJson,
};
