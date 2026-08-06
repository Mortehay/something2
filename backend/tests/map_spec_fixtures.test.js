const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { HOSTILE_CREATURES } = require('../seeds/data/entityTypes.js');

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
const CREATURES = new Set(HOSTILE_CREATURES.map((c) => c.name));

const specFiles = () => fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.map.json'));

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
const SHIPPED_EXAMPLES = ['hub-vale.map.json', 'loop-catacombs.map.json', 'spine-descent.map.json'];

test('all three example topologies ship', () => {
  const files = specFiles();
  for (const f of SHIPPED_EXAMPLES) {
    assert.ok(files.includes(f), `expected shipped example ${f} to still be present`);
  }
});

test('every shipped spec validates against the live catalogs', () => {
  for (const f of specFiles()) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
    const errs = validateMapSpec(spec, { biomeNames: BIOMES, creatureTypeNames: CREATURES });
    assert.deepEqual(errs, [], `${f}: ${errs.join('; ')}`);
  }
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
  const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, 'hub-vale.map.json'), 'utf8'));
  const hub = spec.worlds.find((w) => w.is_entry);
  assert.ok(hub.village, 'the hub is the bind point and needs a village');
  const outgoing = spec.links.filter((l) => l.from === hub.key).length;
  assert.ok(outgoing <= 4, `hub has ${outgoing} spokes; UNIQUE(from_world_id, edge) allows 4`);
});

test('loop-catacombs actually contains a cycle', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, 'loop-catacombs.map.json'), 'utf8'));
  assert.ok(hasCycle(spec), 'no cycle: the loop topology does not close on the grid');
});

test('spine-descent escalates its level bands with depth', () => {
  // The point of a spine is a difficulty ramp. Without this, a spec could
  // declare bands that wander or flatten and every other test would still be
  // green -- the same shape of hole that let a dangling creature reference
  // survive in biomes_seed.test.js.
  const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, 'spine-descent.map.json'), 'utf8'));
  const banded = spec.worlds.filter((w) => w.level_band);
  assert.ok(banded.length >= 4, 'spine-descent should band most of its worlds');

  const dist = bfsDistances(spec);
  // Compare per BFS tier, not adjacent pairs in a flat sorted-by-distance
  // list: cache/elite/gorge all sit at distance 2, so a flat sort's relative
  // order among them is just file order. Reordering those entries in the
  // JSON is semantically meaningless and must not be able to trip this
  // check. Group by tier instead and require each tier's minimum band floor
  // to be >= the previous tier's -- mirroring the creature_count escalation
  // test above, which has the same three-way tie at distance 2.
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
