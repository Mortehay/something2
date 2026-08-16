const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { placeMapCreatures } = require('../src/services/mapService.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { HOSTILE_CREATURES } = require('../seeds/data/entityTypes.js');
const { BESTIARY_P4_CREATURES } = require('../seeds/data/bestiaryP4.js');

const MAPS_DIR = path.join(__dirname, '..', 'seeds', 'maps');
const BIOMES = new Set(STARTER_BIOMES.map((b) => b.name));
// Derived from the creature catalog, which is now the thing that decides
// whether a creature exists. Wolf was excluded here for a while on the
// grounds that no migration seeded it -- true at the time, and the opposite
// of what biomes_seed.test.js asserted, with both files green. Now that
// seeds/data/entityTypes.js restores Wolf, one source answers the question
// for both. Village Guard is still excluded: it is a village gate defender
// placed by insertVillageGuards, not a creature a world lists in
// allowed_creature_types -- and HOSTILE_CREATURES leaves it out by design.
// HOSTILE_CREATURES (4 legacy) is unioned with BESTIARY_P4_CREATURES (288
// generated, SOMET-250 Task 6), mirroring seed-catalogs.js's own
// `[...HOSTILE_CREATURES, ...BESTIARY_P4_CREATURES]` union -- both lists are
// live-seeded into the database, so both are valid ground truth for what a
// map spec may reference as an allowed_creature_type or guard.creature_type.
const CREATURES = new Set(
  [...HOSTILE_CREATURES, ...BESTIARY_P4_CREATURES].map((c) => c.name)
);

// SOMET-315. The other half of the same catalog: not just "does this biome
// exist" but "which creatures can spawn in it". Without this, a spec could
// name a real biome and a real creature and still seed a world with zero
// creatures, because creatureTileCandidates intersects the two per tile.
const BIOME_ROSTERS = new Map(STARTER_BIOMES.map((b) => [b.name, b.creature_types]));

const specFiles = () => fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.map.json'));

const readSpec = (name) =>
  JSON.parse(fs.readFileSync(path.join(MAPS_DIR, `${name}.map.json`), 'utf8'));

// SOMET-355. hub-vale, spine-descent and loop-catacombs were merged into the
// single spec `vale-region`, because the doorways connecting them could not be
// declared while each lived in its own file: validateMapSpec checks every link
// against ITS OWN spec's grid, so a cross-file link is unexpressible, and the
// three maps were in fact wired together by ten hand-drawn map_links rows that
// no spec declared. One spec, one grid, three disjoint regions.
//
// Each region survives as a key prefix (`vale_`, `spine_`, `cata_`), and the
// per-region assertions below still run against exactly the worlds they always
// did -- de-prefixed, so a region view is shaped like the standalone spec it
// used to be and helpers like bfsDistances/hasCycle work on it unchanged.
//
// `is_entry` is synthesised per region rather than read: a spec may declare
// only ONE entry world (validateMapSpec enforces it), so after the merge only
// Vale Crossing carries the flag, and bfsDistances needs a root for the spine
// and catacombs views too. The root is the region's own historical entry key.
const REGION_ENTRY_KEY = { vale: 'hub', spine: 'entry', cata: 'entry' };

function region(prefix, spec = readSpec('vale-region')) {
  const strip = (k) => k.slice(prefix.length + 1);
  const mine = (k) => k.startsWith(`${prefix}_`);
  const worlds = spec.worlds.filter((w) => mine(w.key)).map((w) => ({
    ...w, key: strip(w.key), is_entry: strip(w.key) === REGION_ENTRY_KEY[prefix],
  }));
  // Links with BOTH ends inside the region. The three connector links that
  // join the regions are deliberately excluded -- they are what makes the
  // merged graph one map, and counting them would, for instance, make the hub
  // look like it had more spokes than it does.
  const links = spec.links
    .filter((l) => mine(l.from) && mine(l.to))
    .map((l) => ({ ...l, from: strip(l.from), to: strip(l.to) }));
  return { name: prefix, worlds, links };
}

// BFS hop distance from the entry over the UNDIRECTED link graph. Shared by
// the cycle test and the escalation test below so both reason about the same
// graph shape.
function bfsDistances(spec) {
  const entry = spec.worlds.find((w) => w.is_entry);
  const adjacency = new Map(spec.worlds.map((w) => [w.key, new Set()]));
  for (const l of spec.links) {
    adjacency.get(l.from).add(l.to);
    adjacency.get(l.to).add(l.from);
  }
  const dist = new Map([[entry.key, 0]]);
  const queue = [entry.key];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adjacency.get(cur) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(cur) + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

// True iff the UNDIRECTED graph, after collapsing any duplicate/mirror
// declaration of the same unordered {a,b} pair down to one physical edge,
// contains a cycle. A spec can legally re-declare a link's mirror explicitly
// (setLink already writes the mirror edge physically either way), so a raw
// links.length >= worlds.length count can be padded to look like a cycle by
// re-stating an already-implied connection -- that inflates the edge count
// without adding any new physical connection, so it must not count here.
function hasCycle(spec) {
  const adjacency = new Map(spec.worlds.map((w) => [w.key, new Set()]));
  const seenPairs = new Set();
  for (const l of spec.links) {
    const pairKey = [l.from, l.to].sort().join('|');
    if (seenPairs.has(pairKey)) continue; // duplicate/mirror of an existing edge
    seenPairs.add(pairKey);
    adjacency.get(l.from).add(l.to);
    adjacency.get(l.to).add(l.from);
  }
  const visited = new Set();
  const dfs = (node, parent) => {
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!visited.has(next)) {
        if (dfs(next, node)) return true;
      } else if (next !== parent) {
        return true; // back edge to an already-visited, non-parent node
      }
    }
    return false;
  };
  for (const key of adjacency.keys()) {
    if (!visited.has(key) && dfs(key, null)) return true;
  }
  return false;
}

// Present, not exhaustive: a new spec dropped in by an author is supposed to
// be "covered automatically -- nothing to register" per
// .claude/skills/map-planner/SKILL.md, which tells authors to validate with
// `node --test tests/map_spec_fixtures.test.js`. An exact-set assertion here
// would fail a fourth, unrelated, perfectly valid spec and name nothing to
// do with the author's own work.
const SHIPPED_EXAMPLES = ['vale-region.map.json', 'p5-descent.map.json'];

test('the shipped example specs are all present', () => {
  const files = specFiles();
  for (const f of SHIPPED_EXAMPLES) {
    assert.ok(files.includes(f), `expected shipped example ${f} to still be present`);
  }
});

test('every shipped spec validates against the live catalogs', () => {
  const files = specFiles();
  // Non-vacuity: an empty MAPS_DIR (or a renamed extension) would otherwise
  // make this loop pass while validating nothing at all.
  assert.ok(files.length >= SHIPPED_EXAMPLES.length,
    `expected at least ${SHIPPED_EXAMPLES.length} specs, found ${files.length}`);
  for (const f of files) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
    const errs = validateMapSpec(spec, {
      biomeNames: BIOMES, creatureTypeNames: CREATURES, biomeCreatureTypes: BIOME_ROSTERS,
    });
    assert.deepEqual(errs, [], `${f}: ${errs.join('; ')}`);
  }
});

// SOMET-315: the END-TO-END form of the rule the validator now enforces.
//
// The validator reasons about two catalog columns; this runs the REAL placer
// over every shipped world and asserts creatures actually come out. Thirteen
// worlds across loop-catacombs and spine-descent shipped seeding zero
// creatures for years -- their allowlists were the pre-biome generic roster
// (Slime/Bat/Skeleton) while their biomes had moved to per-biome families --
// and every existing test stayed green, because nothing ever ran placement
// against the shipped spec text.
//
// GEOMETRY ONLY: no villages, roads or safe_rects are fed in. Those can only
// REMOVE candidate tiles, so this is an upper bound on what placement finds --
// deliberately so, because this test is about the biome/allowlist relationship
// and must not turn into a second, drifting copy of safe-region behaviour.
// Measured over the 13 (whole interior tile space, live config including safe
// regions and villages): safe regions rejected 0 tiles and the biome
// intersection rejected 100% of the rest, so the bound is not hiding anything
// here.
//
// PROBE_COUNT rather than the world's real density target: cost. Asking each
// of ~86 worlds for its full tier is ~30k placements and ~16s; 40 is enough to
// prove the tile space is not empty and keeps the file at a couple of seconds.
// It is a floor, not an equality -- under-delivery against a tier is a
// separate concern that populateWorld warns about at seed time.
const PROBE_COUNT = 40;

test('every shipped world with an allowlist actually places creatures', () => {
  const tileTypes = {};
  for (const t of DEFAULT_TILE_TYPES) {
    tileTypes[t.name] = { walkable: t.walkable, speed: t.speed };
  }
  // The bounded-world overlay's own two tiles, which stampBounds writes and
  // the tile catalog does not carry.
  tileTypes.map_wall = { walkable: false, speed: 1 };
  tileTypes.map_doorway = { walkable: true, speed: 1 };
  const biomeByName = new Map(STARTER_BIOMES.map((b) => [b.name, b]));

  let checked = 0;
  const empty = [];
  for (const f of specFiles()) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
    for (const w of spec.worlds) {
      const names = w.allowed_creature_types ?? [];
      if (names.length === 0) continue; // deliberately unpopulated, not a bug
      const allowed = names.map((n) => ({ name: n, hp: 10, defense: 0, resistances: {} }));
      const cfg = {
        seed: w.seed, chunkSize: w.chunk_size, width: w.width, height: w.height,
        tileTypes, biomes: (w.biomes ?? []).map((n) => biomeByName.get(n)),
        biomeCell: w.biome_cell, doorways: [], villages: [],
        levelMin: 1, levelMax: 1, safeRoadRadius: 0, safeRects: [], authoredRoads: [],
      };
      const placed = placeMapCreatures(cfg, PROBE_COUNT, allowed, w.seed >>> 0);
      checked++;
      if (placed.length < PROBE_COUNT) {
        empty.push(`${f}/${w.key}: ${placed.length}/${PROBE_COUNT} placed `
          + `(biomes ${JSON.stringify(w.biomes ?? [])}, allows ${JSON.stringify(names)})`);
      }
    }
  }
  // Non-vacuity: a spec loader that silently produced no worlds, or an
  // allowlist key renamed out from under the `continue` above, would make the
  // loop assert nothing.
  assert.ok(checked >= 80, `expected to probe most shipped worlds, probed ${checked}`);
  assert.deepEqual(empty, [], empty.join('\n'));
});

// "difficulty escalates with distance from the entry" (creature_count-based)
// lived here until SOMET-246 retired creature_count as an authored spec
// field -- it is now DERIVED by populateWorld from `density`, and this task
// deliberately ships all three example specs on the 'normal' default (no
// per-world density; authoring real tiers is a later sub-project's job per
// docs/superpowers/plans/2026-08-06-p1-world-population.md). With every
// world at the same tier there is no per-spec escalating number left to
// assert on here. spine-descent's own level_band ramp is still covered by
// "spine-descent escalates its level bands with depth" below, and
// reachability of every world from the entry is still enforced by
// validateMapSpec itself via "every shipped spec validates against the live
// catalogs" above.

test('hub-vale has a village in its hub and at most four spokes', () => {
  const spec = region('vale');
  const hub = spec.worlds.find((w) => w.is_entry);
  assert.ok(hub.village, 'the hub is the bind point and needs a village');
  const outgoing = spec.links.filter((l) => l.from === hub.key).length;
  assert.ok(outgoing <= 4, `hub has ${outgoing} spokes; UNIQUE(from_world_id, edge) allows 4`);
});

test('loop-catacombs actually contains a cycle', () => {
  const spec = region('cata');
  assert.ok(hasCycle(spec), 'no cycle: the loop topology does not close on the grid');
});

test('spine-descent escalates its level bands with depth', () => {
  // The point of a spine is a difficulty ramp. Without this, a spec could
  // declare bands that wander or flatten and every other test would still be
  // green -- the same shape of hole that let a dangling creature reference
  // survive in biomes_seed.test.js.
  const spec = region('spine');
  const banded = spec.worlds.filter((w) => w.level_band);
  assert.ok(banded.length >= 4, 'spine-descent should band most of its worlds');

  const dist = bfsDistances(spec);
  // Compare per BFS tier, not adjacent pairs in a flat sorted-by-distance
  // list: cache/elite/gorge all sit at distance 2, so a flat sort's relative
  // order among them is just file order. Reordering those entries in the
  // JSON is semantically meaningless and must not be able to trip this
  // check. Group by tier instead and require each tier's minimum band floor
  // to be >= the previous tier's. (This grouping was inherited from the
  // creature_count escalation test, which had the same three-way tie at
  // distance 2 and was deleted with the field it read -- see the note above
  // "hub-vale has a village in its hub". This is now the only escalation
  // check in the file.)
  const minFloorByDistance = new Map();
  for (const w of banded) {
    const d = dist.get(w.key);
    const prev = minFloorByDistance.get(d);
    minFloorByDistance.set(d, prev === undefined ? w.level_band[0] : Math.min(prev, w.level_band[0]));
  }
  const orderedDistances = [...minFloorByDistance.keys()].sort((a, b) => a - b);
  let prevFloor = -Infinity;
  for (const d of orderedDistances) {
    const floorAtD = minFloorByDistance.get(d);
    assert.ok(floorAtD >= prevFloor,
      `distance ${d}'s lowest band floor (${floorAtD}) is lower than a tier closer to the entry (${prevFloor})`);
    prevFloor = floorAtD;
  }

  // "Meaningfully harder", kept from the original check: the deepest tier's
  // toughest band ceiling must clear double the entry's ceiling.
  const entryBand = banded.find((w) => dist.get(w.key) === 0).level_band;
  const deepestDistance = Math.max(...orderedDistances);
  const deepestMax = Math.max(
    ...banded.filter((w) => dist.get(w.key) === deepestDistance).map((w) => w.level_band[1]),
  );
  assert.ok(deepestMax > entryBand[1] * 2,
    'the deepest world should be meaningfully harder than the entry, not marginally');
});

// P3's whole point: the catacombs were meadows. Every dungeon world must now
// name an underground biome, and no shipped spec may still reference the
// surface biomes underground.
test('every loop-catacombs world uses an underground biome', () => {
  const spec = region('cata');
  const surface = new Set(['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire']);
  const offenders = spec.worlds.filter((w) => (w.biomes || []).some((b) => surface.has(b)));
  assert.deepEqual(offenders.map((w) => w.key), []);
});

test('spine-descent goes underground as it descends', () => {
  const spec = region('spine');
  const byKey = Object.fromEntries(spec.worlds.map((w) => [w.key, w.biomes]));
  assert.deepEqual(byKey.entry, ['Meadow']);            // entry stays surface
  assert.deepEqual(byKey.cache, ['Cavern']);            // underground by band 3-5
  assert.deepEqual(byKey.end, ['Frostvault', 'Abyssal Rift']);
});

// Each hub world gains exactly one new SURFACE biome and keeps its established
// biome first so its character leads; banding order is terrain_tiles order
// within a biome, but biome order across a world's list matters too.
//
// `mire` is the one exception, and it is a NAVIGABILITY fix, not a style
// choice. Mire's terrain_tiles are ['swamp','water','earth'] and the value
// noise is bell-shaped, so whichever biome leads gets the fat middle of the
// distribution -- with Mire first that middle is `water` (impassable), which
// covered ~42% of Blackfen Sinks' interior and put the N doorway's arrival
// tile (1,32) inside a 3-cell water-locked pocket: 3 of 3844 interior cells
// reachable, a guaranteed SOMET-184 movement freeze one hop south of the entry
// world. Reversing the pair drops water to 29% and yields ONE connected
// walkable component covering 70.7% of the interior. The plan's table is what
// was wrong here; both biomes are kept, only the lead changes, and the world
// still reads as a storm-lashed tidal fen (water 29% + swamp 9%). Verified by
// generating the world and flood-filling it -- see the P3 final fix report.
test('hub-vale keeps its original biome first and gains one new surface biome', () => {
  const spec = region('vale');
  const expected = {
    hub: ['Meadow', 'Highlands'],
    forest: ['Deep Forest', 'Verdant Jungle'],
    dunes: ['Arid Dunes', 'Ashfields'],
    frozen: ['Frozen Waste', 'Sunken Ruins'],
    mire: ['Storm Coast', 'Mire'],   // reversed on purpose: see above
  };
  for (const w of spec.worlds) assert.deepEqual(w.biomes, expected[w.key], w.key);
});

// The rule the exception above must not be allowed to erode: every hub world
// still carries BOTH its original biome and exactly one new surface biome.
// Stated separately from the exact lists so re-ordering a world for
// navigability can never quietly drop a biome at the same time.
test('every hub-vale world still pairs its original biome with one new surface biome', () => {
  const spec = region('vale');
  const ORIGINAL = new Set(['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire']);
  const NEW_SURFACE = new Set(['Highlands', 'Verdant Jungle', 'Storm Coast', 'Sunken Ruins', 'Ashfields']);
  for (const w of spec.worlds) {
    assert.equal(w.biomes.length, 2, `${w.key} must carry exactly two biomes`);
    assert.equal(w.biomes.filter((b) => ORIGINAL.has(b)).length, 1,
      `${w.key} must keep exactly one original biome, got ${JSON.stringify(w.biomes)}`);
    assert.equal(w.biomes.filter((b) => NEW_SURFACE.has(b)).length, 1,
      `${w.key} must gain exactly one new surface biome, got ${JSON.stringify(w.biomes)}`);
  }
});

// ---------------------------------------------------------------------------
// Fast-travel safety invariant (Plan B slice 2).
//
// This does NOT pin which worlds are travel targets -- that is a curation
// decision and is expected to change. It pins the one property that must hold
// however the curation is revised: a DUNGEON ROOM is never a target.
//
// 7 creatures carry blocks_portal_id to gate dungeon entrances. Fast travel
// into a dungeon interior walks straight past them, so one wrongly-flagged
// world silently defeats a mechanic that took deliberate work to place. The
// naming convention is the discriminator the shipped content actually uses:
// every dungeon room is "The <Dungeon>: <Room>". It correctly excludes "The
// Deep Cut" (no colon), which is a surface gorge, and correctly includes all
// 56 rooms across the six dungeon chains.
// ---------------------------------------------------------------------------
const DUNGEON_ROOM = /^The .+: .+$/;

test('no dungeon room is a fast-travel target', () => {
  const flagged = [];
  const offenders = [];
  for (const file of fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.json'))) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, file), 'utf8'));
    for (const w of spec.worlds) {
      if (w.allows_fast_travel !== true) continue;
      flagged.push(w.name);
      if (DUNGEON_ROOM.test(w.name)) offenders.push(`${file}: ${w.name}`);
    }
  }
  assert.deepEqual(offenders, [],
    'these dungeon rooms would let a character skip their portal guard');
  // Non-vacuous: an invariant over an empty set proves nothing, and this test
  // would pass trivially if every flag were accidentally deleted.
  assert.ok(flagged.length > 0,
    'no world allows fast travel at all -- the invariant above is vacuous');
});
