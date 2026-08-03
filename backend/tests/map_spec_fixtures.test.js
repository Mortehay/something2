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

test('difficulty escalates with distance from the entry', () => {
  // An adventure map whose creature counts are flat is not an adventure. This
  // asserts the shape of the content, not just its syntax -- specifically,
  // that a world one hop farther from the entry never dips below what a
  // closer world already offered, not merely that a single farthest world is
  // the biggest number ("flat everywhere plus one outlier" would pass a
  // max>min-and-entry-is-min check without ever escalating with distance).
  for (const f of specFiles()) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
    const entry = spec.worlds.find((w) => w.is_entry);
    const counts = spec.worlds.map((w) => w.creature_count);
    assert.ok(Math.max(...counts) > Math.min(...counts), `${f}: every world has the same creature_count`);
    assert.equal(entry.creature_count, Math.min(...counts),
      `${f}: the entry world should be the safest`);

    const dist = bfsDistances(spec);
    // bfsDistances buckets a world unreachable from the entry under the key
    // `undefined` (dist.get(w.key) returns undefined, never throws), and
    // sorting a mixed undefined/number array yields NaN from the comparator,
    // so ordering silently becomes unspecified instead of failing loudly.
    // Pin the sibling-reachability guard here: if it's ever weakened, this
    // turns a silent mis-bucket into a loud test failure.
    assert.equal(dist.size, spec.worlds.length, `${f}: not every world is reachable from the entry`);
    const minByDistance = new Map();
    for (const w of spec.worlds) {
      const d = dist.get(w.key);
      const prev = minByDistance.get(d);
      minByDistance.set(d, prev === undefined ? w.creature_count : Math.min(prev, w.creature_count));
    }
    const orderedDistances = [...minByDistance.keys()].sort((a, b) => a - b);
    let prevMin = -Infinity;
    for (const d of orderedDistances) {
      const minAtD = minByDistance.get(d);
      assert.ok(minAtD >= prevMin,
        `${f}: distance ${d}'s safest world (creature_count ${minAtD}) is easier than a world closer to the entry (creature_count ${prevMin})`);
      prevMin = minAtD;
    }
  }
});

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
  const sorted = [...banded].sort((a, b) => dist.get(a.key) - dist.get(b.key));
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].level_band[0] >= sorted[i - 1].level_band[0],
      `${sorted[i].key} is deeper than ${sorted[i - 1].key} but its band starts lower`,
    );
  }
  assert.ok(sorted[sorted.length - 1].level_band[1] > sorted[0].level_band[1] * 2,
    'the deepest world should be meaningfully harder than the entry, not marginally');
});
