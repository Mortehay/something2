// SOMET-644. One-to-one port of the GPU box's generator smoke suite
// (backend/tools/world_gen_ref/smoke-world-gen.py, 34 cases) onto the JS port
// (backend/src/services/worldGen/worldGen.js). Same case names, same
// assertions; no DB, no Python.
//
// Python's `_name` functions become tests titled with the case string. Numbers
// the port returns as Python floats (report rows and totals) are PyFloat
// wrappers; they compare through valueOf, and `+x` is used where a strict
// equality is needed.
//
// Skipped: "preview renders and scales with the region" - it calls Pillow's
// world_preview.render, which is not part of the port.

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../src/services/worldGen/worldGen');
const { floorDiv } = require('../src/services/worldGen/pyCompat');

const plan = (name, kw = {}) => W.planRegion({ name, ...kw });
const setOf = (xs) => new Set(xs);
const subset = (a, b) => [...a].every((x) => b.has(x));
const sortedArr = (xs) => [...xs].sort();
const exitsOf = (spec) => {
  const exits = {};
  for (const l of spec.links) (exits[l.from] ||= []).push(l.edge);
  return exits;
};
const entryOf = (spec) => spec.worlds.find((w) => w.is_entry);
const depthsOf = (w) => setOf(w.biomes.map((b) => W.BIOMES[b].depth));

test('their tier table, reproduced per screen', () => {
  const want = { sparse: 2.0, normal: 4.1, dense: 8.1, horde: 14.0, swarm: 20.0 };
  for (const [tier, expect] of Object.entries(want)) {
    const got = (W.DENSITY_TIERS[tier] * W.TILES_PER_SCREEN) / 1000.0;
    assert.ok(Math.abs(got - expect) < 0.1, `${tier}: ${got.toFixed(2)} vs ${expect}`);
  }
});

test('the Meadow trap was never real', () => {
  const ps = +W.perScreen('normal', ['Meadow'], 128, 128);
  assert.ok(ps > W.EMPTY_BELOW_PER_SCREEN, String(ps));
  // The biome must make no difference at all - that is the whole correction.
  for (const biomes of [['Meadow'], ['Mire'], ['Abyssal Rift'], []]) {
    assert.ok(Math.abs(+W.perScreen('normal', biomes, 128, 128) - ps) < 0.01, JSON.stringify(biomes));
  }
});

test('a tier is chosen for the target, and the biome plays no part', () => {
  assert.equal(W.chooseDensity(6.0, ['Meadow']), W.chooseDensity(6.0, ['Mire']));
  assert.equal(W.chooseDensity(2.0), 'sparse');
  assert.equal(W.chooseDensity(4.1), 'normal');
  assert.equal(W.chooseDensity(8.1), 'dense');
  assert.equal(W.chooseDensity(14.0), 'horde');
  assert.equal(W.chooseDensity(20.0), 'swarm');
});

test('a target between two tiers is not silently missed', () => {
  const rep = W.report(plan('Gap', { world_count: 4, target_per_screen: 6.0 }), 6.0);
  assert.ok(rep.ok, rep.problems.join('; '));
  assert.ok(rep.caveats.length > 0, 'a 32% shortfall went unmentioned');
  assert.ok(rep.caveats[0].includes('6.0') && rep.caveats[0].includes('coarse'), rep.caveats[0]);

  // And a target that IS a tier says nothing.
  const onTier = W.report(plan('OnTier', { world_count: 4, target_per_screen: 8.1 }), 8.1);
  assert.equal(onTier.caveats.length, 0, onTier.caveats.join('; '));
});

test('every world declares a level band, and an omitted one means 1-1', () => {
  const spec = plan('Bands', { world_count: 8, target_per_screen: 8.1 });
  const bands = spec.worlds.map((w) => w.level_band);

  assert.ok(bands.every((b) => Array.isArray(b) && b.length > 0), `a world has no band: ${JSON.stringify(bands)}`);
  // A null is the same as an absent key to the seeder's ternary, so neither is ok.
  assert.ok(!W.toJson(spec).includes('null'), 'a null band reached the spec');

  // The entry must stay a level-1 area.
  assert.equal(bands[0][0], 1, JSON.stringify(bands[0]));
  assert.deepEqual(bands[0], [...W.SURFACE_BAND]);

  for (let i = 0; i + 1 < bands.length; i += 1) {
    const [a, b] = [bands[i], bands[i + 1]];
    assert.ok(a[0] <= b[0] && a[1] <= b[1], `band went backwards: ${a} -> ${b}`);
  }
  assert.ok(bands.at(-1)[0] > bands[0][0], 'the region does not ramp at all');

  // The surface band must lead into the deep ramp without overlapping it.
  const deep = spec.worlds
    .filter((w) => w.biomes.some((x) => (W.BIOMES[x] ?? {}).depth === 'deep'))
    .map((w) => w.level_band);
  assert.ok(deep.length > 0 && deep[0][0] > W.SURFACE_BAND[1], `${W.SURFACE_BAND} ${deep[0]}`);
});

test('the socket guard is reachable, and discriminating', () => {
  const reachable = setOf(Array.from({ length: 300 }, (_, i) => W.chooseDensity((i + 1) / 10.0)));
  assert.ok(reachable.size >= 4, `only ${[...reachable]} reachable from any target`);

  const kib = {};
  for (const t of reachable) {
    kib[t] = +W.socketKibS((W.DENSITY_TIERS[t] * W.TILES_PER_SCREEN) / 1000.0, 32);
  }
  const over = Object.keys(kib).filter((t) => kib[t] > W.SOCKET_WARN_KIB_S);
  const under = Object.keys(kib).filter((t) => kib[t] <= W.SOCKET_WARN_KIB_S);
  assert.ok(over.length > 0, `no reachable tier exceeds ${W.SOCKET_WARN_KIB_S} KiB/s - the guard can never fire: ${JSON.stringify(kib)}`);
  assert.ok(under.length > 0, `every reachable tier exceeds ${W.SOCKET_WARN_KIB_S} KiB/s - the guard fires always: ${JSON.stringify(kib)}`);

  // And end to end, because a reachable tier is not proof the report emits it.
  const quiet = W.report(plan('Q', { world_count: 4, target_per_screen: 4.1 }));
  const loud = W.report(plan('L', { world_count: 4, target_per_screen: 14.0 }));
  assert.equal(quiet.problems.filter((p) => p.includes('KiB/s')).length, 0, quiet.problems.join('; '));
  assert.ok(loud.problems.filter((p) => p.includes('KiB/s')).length > 0, loud.problems.join('; '));

  // ONCE, not once per world: checked at 20 worlds.
  const big = W.report(plan('B', { world_count: 20, target_per_screen: 14.0 }));
  const sock = big.problems.filter((p) => p.includes('KiB/s'));
  assert.equal(sock.length, 1, `20-world region emitted ${sock.length} socket warnings, expected 1 - the cost is per REGION, not per world`);
  assert.ok(sock[0].includes('every world in the region'), sock[0]);
});

test('a generated region has no empty worlds', () => {
  const rep = W.report(plan('Emerald Reach', { world_count: 8, target_per_screen: 6.0 }));
  const empty = rep.worlds.filter((r) => r.verdict === 'EMPTY').map((r) => r.key);
  assert.equal(empty.length, 0, `empty worlds: ${empty}`);
  assert.ok(rep.totals.min_per_screen >= W.EMPTY_BELOW_PER_SCREEN);
});

test('asking for emptiness still reports it', () => {
  const rep = W.report(plan('Hollow', { world_count: 3, target_per_screen: 0.5 }));
  assert.ok(rep.totals.empty_worlds > 0, 'a 0.5/screen region claimed to be fine');
  assert.ok(!rep.ok);
});

test('every world is reachable and there is exactly one entry', () => {
  const spec = plan('Linkage', { world_count: 9, target_per_screen: 6.0 });
  const rep = W.report(spec);
  const bad = rep.problems.filter((p) => p.includes('unreachable') || p.includes('entry worlds'));
  assert.equal(bad.length, 0, bad.join('; '));
  const keys = setOf(spec.worlds.map((w) => w.key));
  for (const l of spec.links) {
    assert.ok(keys.has(l.from) && keys.has(l.to), JSON.stringify(l));
  }
});

test('links are symmetric across the grid', () => {
  const spec = plan('Mirror', { world_count: 9, target_per_screen: 6.0 });
  const have = setOf(spec.links.map((l) => JSON.stringify([l.from, l.edge, l.to])));
  for (const l of spec.links) {
    const back = JSON.stringify([l.to, W.OPPOSITE[l.edge], l.from]);
    assert.ok(have.has(back), `${l.from} -${l.edge}-> ${l.to} has no return link`);
  }
});

test('thin flora is repaired, not just reported', () => {
  // Catacombs and Deepvault carry one flora type each, and the same one.
  const thin = ['Catacombs', 'Deepvault'];
  assert.ok(W.floraTypes(thin).length < W.THIN_FLORA_BELOW, String(W.floraTypes(thin)));
  const fixed = W.enrichFlora(thin);
  assert.ok(W.floraTypes(fixed).length >= W.THIN_FLORA_BELOW, String(fixed));
  assert.equal(fixed.length, 3, 'repair should add exactly one biome');

  const spec = plan('Bare', { world_count: 1, target_per_screen: 6.0, entry_biomes: ['Arid Dunes'] });
  const rep = W.report(spec);
  assert.ok(!rep.problems.some((p) => p.includes('flora')), rep.problems.join('; '));
});

test('deliberately desolate biomes are exempt from the flora floor', () => {
  assert.equal(W.FLORA_OPTIONAL.size, 7, String(sortedArr(W.FLORA_OPTIONAL)));
  for (const name of W.FLORA_OPTIONAL) {
    assert.deepEqual(W.enrichFlora([name]), [name], `repair added a biome to ${name}, which is meant to be bare`);
    const rep = W.report({
      worlds: [{
        key: 'w', name: 'w', biomes: [name], density: 'normal',
        width: 128, height: 128, chunk_size: 32, is_entry: true,
        allowed_creature_types: W.spawnable([name]),
      }],
      links: [],
    });
    assert.ok(!rep.problems.some((p) => p.includes('read bare')), `${name}: ${rep.problems.join('; ')}`);
  }
});

test('a world still short of flora is reported, not hidden', () => {
  // Creatures must be ones Arid Dunes admits, or the ZERO-creatures check fires first.
  const thin = W.report({
    worlds: [{
      key: 'w', name: 'w', biomes: ['Arid Dunes'], density: 'dense',
      width: 128, height: 128, is_entry: true,
      allowed_creature_types: W.spawnable(['Arid Dunes']),
    }],
    links: [],
  });
  assert.ok(thin.problems.some((p) => p.includes('read bare')), thin.problems.join('; '));
});

test('creatures come from the BIOME table, never from entity_types', () => {
  const spec = plan('Variety', { world_count: 6, target_per_screen: 6.0 });
  const rep = W.report(spec);
  for (const r of rep.worlds) {
    const allowed = setOf(r.creature_types);
    const admits = setOf(W.spawnable(r.biomes));
    assert.ok(allowed.size > 0, `${r.key} allows nothing`);
    assert.ok(subset(allowed, admits), `${r.key} allows ${[...allowed].filter((x) => !admits.has(x))}, which its biomes ${r.biomes} cannot spawn`);
  }
});

test('a biome/creature mismatch is reported as EMPTY, not as healthy', () => {
  const unspawnable = ['Woodland Line', 'Desert Swarm'];
  assert.ok(!unspawnable.some((x) => W.BIOME_CREATURES.Meadow.includes(x)),
    `the example is stale again: Meadow now admits ${unspawnable}`);

  const rep = W.report({
    worlds: [{
      key: 'w', name: 'w', biomes: ['Meadow'], density: 'swarm',
      width: 128, height: 128, is_entry: true,
      allowed_creature_types: unspawnable,
    }],
    links: [],
  });
  const row = rep.worlds[0];
  assert.equal(row.verdict, 'EMPTY', row.verdict);
  assert.ok(row.creatures === 0 && +row.per_screen === 0.0, JSON.stringify(row));
  assert.ok(rep.problems.some((p) => p.includes('ZERO creatures')), rep.problems.join('; '));
  assert.equal(rep.totals.empty_worlds, 1);
});

test("the biome table matches something2's, all 32 of them", () => {
  assert.equal(Object.keys(W.BIOME_CREATURES).length, 32);
  // Every biome this generator can CHOOSE must be in the spawn table.
  const missing = Object.keys(W.BIOMES).filter((b) => !(b in W.BIOME_CREATURES));
  assert.equal(missing.length, 0, String(missing));
  // Only Swarm/Skirmisher/Line roles appear in any biome list.
  const roles = setOf(Object.values(W.BIOME_CREATURES).flatMap((v) => v)
    .filter((t) => t.includes(' ')).map((t) => t.slice(t.lastIndexOf(' ') + 1)));
  assert.ok(subset(roles, setOf(['Swarm', 'Skirmisher', 'Line'])), String([...roles]));
});

test('leaders are rationed, because auras are O(leaders x population)', () => {
  const rep = W.report(plan('Leaders', { world_count: 9, target_per_screen: 8.0 }));
  for (const r of rep.worlds) {
    assert.ok(r.leaders <= W.MAX_LEADER_ROLES_PER_WORLD, `${r.key} ${r.leaders}`);
  }
  assert.ok(!rep.problems.some((p) => p.includes('leader roles')));
});

test('the four-creature ceiling is gone, and regions now meet the floor', () => {
  const ceiling = setOf(Object.keys(W.BIOMES).flatMap((b) => W.BIOMES[b].creatures)).size;
  assert.ok(ceiling >= W.THIN_VARIETY_BELOW, String(ceiling));

  // A biome that is already varied enough is left alone.
  assert.ok(W.spawnable(['Mire']).length >= W.THIN_VARIETY_BELOW);
  assert.deepEqual(W.enrichVariety(['Mire'], [1, 5]), ['Mire'], 'repaired a healthy biome');

  // A genuinely thin one still gets help. min() keeps the FIRST minimal key.
  let thin = null;
  for (const b of Object.keys(W.BIOMES)) {
    if (thin === null || W.BIOMES[b].creatures.length < W.BIOMES[thin].creatures.length) thin = b;
  }
  const fixed = W.enrichVariety([thin], [1, 5]);
  assert.ok(W.spawnable(fixed).length >= W.spawnable([thin]).length, `${thin} ${fixed}`);
  assert.ok(fixed.length <= 2, 'repair should add at most one biome');

  const rep = W.report(plan('Kinds', { world_count: 9, target_per_screen: 6.0 }));
  assert.ok(!rep.problems.some((p) => p.includes('read repetitive')), rep.problems.join('; '));
});

test('per_screen and creatures describe the same world', () => {
  const rep = W.report(plan('C', { world_count: 8, target_per_screen: 6.0 }));
  for (const row of rep.worlds) {
    const implied = (row.creatures * W.TILES_PER_SCREEN) / Math.max(row.area, 1);
    assert.ok(Math.abs(implied - row.per_screen) < 0.05, JSON.stringify(row));
  }
  assert.ok(!('weighted_creatures' in rep.totals),
    'the placeholder for the unresolved reading outlived the question');

  // The clamp is the case the tier alone cannot describe.
  const clamped = W.report({
    worlds: [{
      key: 'w', name: 'w', biomes: ['Mire'], density: 'swarm',
      width: 512, height: 512, is_entry: true,
      allowed_creature_types: ['Slime'],
    }],
    links: [],
  });
  const row = clamped.worlds[0];
  assert.equal(row.creatures, W.MAX_WORLD_CREATURES, JSON.stringify(row));
  assert.ok(Math.abs(row.per_screen - (W.MAX_WORLD_CREATURES * W.TILES_PER_SCREEN) / row.area) < 0.05);
});

test('the five original biomes carry their P4 lines', () => {
  const five = ['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire'];
  const kinds = W.spawnable(five);
  assert.equal(kinds.length, 19, `${kinds.length} kinds, expected 19: ${sortedArr(kinds)}`);

  const legacy = setOf(['Slime', 'Wolf', 'Bat', 'Skeleton']);
  for (const b of five) {
    const gained = W.BIOMES[b].creatures.filter((c) => !legacy.has(c));
    assert.equal(setOf(gained).size, 3, `${b} has ${sortedArr(gained)}, expected 3 P4 lines`);
  }
  assert.ok(kinds.length >= W.THIN_VARIETY_BELOW, String(kinds.length));
});

test('a region descends: surface at the entry, deep further out', () => {
  const n = 9;
  const spec = plan('Descent', { world_count: n, target_per_screen: 6.0 });
  spec.worlds.forEach((w, i) => {
    const depths = depthsOf(w);
    if (i <= Math.max(1, floorDiv(n, 3))) {
      assert.deepEqual([...depths], ['surface'], `${w.key} ${i} ${w.biomes}`);
    } else {
      assert.ok(depths.has('deep'), `${w.key} ${i} ${w.biomes}`);
    }
  });
  const entry = spec.worlds[0];
  assert.ok(entry.is_entry && JSON.stringify(entry.level_band) === JSON.stringify(W.SURFACE_BAND), JSON.stringify(entry));
  assert.ok(depthsOf(spec.worlds.at(-1)).has('deep'));
});

test('repairs stay on their side of the surface/deep line', () => {
  for (const name of ['Infernal Gate', 'Abyssal Rift', 'The Maw', 'Catacombs']) {
    const fixed = W.enrichVariety([name], null);
    const depths = setOf(fixed.map((b) => W.BIOMES[b].depth));
    assert.deepEqual([...depths], ['deep'], `${name} ${fixed}`);
  }
  const spec = plan('Coherent', { world_count: 9, target_per_screen: 6.0 });
  for (const w of spec.worlds) {
    assert.equal(depthsOf(w).size, 1, `${w.key} ${w.biomes}`);
  }
});

test('the DEEP ramp is strictly increasing, in descent order', () => {
  for (const n of [4, 8, 12]) {
    const spec = plan('Bands', { world_count: n, target_per_screen: 8.1 });
    const deep = spec.worlds
      .filter((w) => w.biomes.some((b) => W.BIOMES[b].depth === 'deep'))
      .map((w) => w.level_band);
    for (let i = 0; i + 1 < deep.length; i += 1) {
      const [a, b] = [deep[i], deep[i + 1]];
      assert.ok(b[0] > a[0] && b[1] > a[1], `${n} ${a} ${b}`);
    }
    for (const [lo, hi] of deep) assert.ok(hi > lo, `${lo} ${hi}`);

    const surface = spec.worlds
      .filter((w) => w.biomes.every((b) => W.BIOMES[b].depth === 'surface'))
      .map((w) => w.level_band);
    assert.ok(surface.every((b) => JSON.stringify(b) === JSON.stringify(W.SURFACE_BAND)), JSON.stringify(surface));
  }
});

test('bandwidth is projected, so a dense big map is a visible decision', () => {
  const quiet = +W.socketKibS(4.0, 32);
  const loud = +W.socketKibS(20.0, 32);
  assert.ok(loud > quiet * 4, `${quiet} ${loud}`);

  const rep = W.report({
    worlds: [{
      key: 'w', name: 'w', biomes: ['Infernal Gate'], density: 'swarm',
      width: 224, height: 224, chunk_size: 32, is_entry: true,
      allowed_creature_types: W.spawnable(['Infernal Gate']),
    }],
    links: [],
  });
  assert.ok(rep.problems.some((p) => p.includes('KiB/s')), rep.problems.join('; '));
  assert.ok(rep.worlds[0].socket_kib_s > W.SOCKET_WARN_KIB_S);
});

test('variety is reported when a world would read repetitive', () => {
  const thin = W.report({
    worlds: [{
      key: 'w', name: 'w', biomes: ['Meadow'], density: 'dense',
      width: 128, height: 128, is_entry: true,
      allowed_creature_types: ['Slime', 'Wolf'],
    }],
    links: [],
  });
  assert.ok(thin.problems.some((p) => p.includes('read repetitive')), thin.problems.join('; '));
});

test('roads stop short of the wall ring', () => {
  for (const n of [1, 6, 9]) {
    const spec = plan('Ring', { world_count: n, target_per_screen: 6.0 });
    for (const w of spec.worlds) {
      const size = w.width;
      for (const line of w.roads ?? []) {
        for (const [row, col] of line) {
          assert.ok(row >= 1 && row <= size - 2, `${w.key} row ${row} ${size}`);
          assert.ok(col >= 1 && col <= size - 2, `${w.key} col ${col} ${size}`);
        }
      }
    }
  }
});

test('roads reach every exit, and stay inside the world', () => {
  const spec = plan('Roads', { world_count: 9, target_per_screen: 6.0 });
  const exits = exitsOf(spec);
  for (const w of spec.worlds) {
    const want = exits[w.key] ?? [];
    const roads = w.roads ?? [];
    assert.equal(roads.length, want.length, `${w.key} ${roads.length} ${want}`);
    assert.equal(w.safe_road_radius, W.SAFE_ROAD_RADIUS);
    const size = w.width;
    for (const line of roads) {
      assert.equal(line.length, 2, JSON.stringify(line));
      for (const [row, col] of line) {
        assert.ok(row >= 0 && row < size && col >= 0 && col < size, `${w.key} ${row} ${col}`);
      }
      // Every road starts at the middle, which is where the waypoint is.
      assert.deepEqual(line[0], [floorDiv(size, 2), floorDiv(size, 2)]);
    }
  }
});

test('one waypoint per world, in pixels not tiles', () => {
  const spec = plan('Waypoints', { world_count: 6, target_per_screen: 6.0 });
  for (const w of spec.worlds) {
    const wps = w.waypoints ?? [];
    assert.ok(wps.length <= 1, `${w.key} ${wps.length}`);
    for (const p of wps) {
      const mid = floorDiv(w.width, 2);
      assert.ok(p.x === W.toPx(mid) && p.y === W.toPx(mid), JSON.stringify(p));
      assert.ok(p.name);
    }
  }
});

test('the village contains its own spawn, and its gate is a real exit', () => {
  for (const n of [1, 4, 9]) {
    const spec = plan('Village', { world_count: n, target_per_screen: 6.0 });
    const exits = exitsOf(spec);
    const entry = entryOf(spec);
    const v = entry.village;

    // Every village in vale-region contains its own spawn point.
    const col = floorDiv(v.spawn_x - floorDiv(W.TILE_PX, 2), W.TILE_PX);
    const row = floorDiv(v.spawn_y - floorDiv(W.TILE_PX, 2), W.TILE_PX);
    assert.ok(v.min_row <= row && row < v.min_row + v.height, `${n} ${row} ${JSON.stringify(v)}`);
    assert.ok(v.min_col <= col && col < v.min_col + v.width, `${n} ${col} ${JSON.stringify(v)}`);

    // A gate onto an edge with no link opens onto the map boundary.
    const mine = exits[entry.key] ?? [];
    if (mine.length) assert.ok(mine.includes(v.gate_edge), `${n} ${v.gate_edge} ${mine}`);
  }
});

test('tiles-vs-pixels is CAUGHT, not merely documented', () => {
  // Tile 64 of a 128-wide world is also a legal pixel coordinate; only the
  // tile-centre offset finds it.
  assert.ok(W.isTileCentre(6450) && !W.isTileCentre(64));
  assert.ok(!W.isTileCentre(6400), '6400 is a tile EDGE, not a centre');

  const good = plan('Units', { world_count: 4, target_per_screen: 6.0 });
  assert.equal(W.report(good).problems.filter((p) => p.includes('PIXELS')).length, 0);

  const broken = plan('Units', { world_count: 4, target_per_screen: 6.0 });
  const entry = entryOf(broken);
  const mid = floorDiv(entry.width, 2);
  entry.waypoints = [{ x: mid, y: mid, name: 'wrong units' }];
  entry.entry_spawn = { x: mid, y: mid };
  const caught = W.report(broken).problems.filter((p) => p.includes('PIXELS'));
  assert.equal(caught.length, 4, `expected 4 unit problems, got ${caught.length}`);

  // And the mirror: a road written in pixels is out of the tile grid.
  entry.roads = [[[mid, mid], [W.toPx(mid), W.toPx(mid)]]];
  assert.ok(W.report(broken).problems.some((p) => p.includes('roads are TILES')));
});

test("the spec matches something2's shape", () => {
  const spec = plan('Shape', { world_count: 4, target_per_screen: 6.0 });
  assert.deepEqual(sortedArr(Object.keys(spec)), ['links', 'name', 'topology', 'worlds']);
  assert.equal(spec.topology, 'region');
  const required = ['key', 'name', 'grid', 'seed', 'width', 'height', 'chunk_size',
    'biomes', 'biome_cell', 'allowed_creature_types', 'density',
    'is_entry', 'allows_fast_travel'];
  for (const w of spec.worlds) {
    const missing = required.filter((k) => !(k in w));
    assert.equal(missing.length, 0, `${w.key} missing ${missing}`);
    assert.ok(W.DENSITY_ORDER.includes(w.density), w.density);
    assert.ok(w.biomes.every((b) => b in W.BIOMES), String(w.biomes));
  }
  const entry = entryOf(spec);
  assert.ok('village' in entry && 'entry_spawn' in entry);
  for (const l of spec.links) {
    assert.deepEqual(sortedArr(Object.keys(l)), ['edge', 'from', 'to']);
    assert.ok(W.EDGES.includes(l.edge));
  }
});

test('generation is deterministic', () => {
  const a = plan('Same', { world_count: 5, target_per_screen: 6.0 });
  const b = plan('Same', { world_count: 5, target_per_screen: 6.0 });
  assert.deepEqual(a, b, 'two identical requests produced different regions');
  const c = plan('Other', { world_count: 5, target_per_screen: 6.0 });
  assert.notDeepEqual(a.worlds.map((w) => w.seed), c.worlds.map((w) => w.seed));
});

test('preview renders and scales with the region', {
  skip: "needs Pillow's world_preview.render, which is not part of the JS port",
}, () => {});

test('a big swarm world is clamped and says so', () => {
  const r = W.resolveDensity('swarm', 224, 224);
  assert.ok(r.scatter <= W.MAX_WORLD_CREATURES);
  const crowded = W.report({
    worlds: [{
      key: 'w', name: 'w', biomes: ['Mire'], density: 'swarm',
      width: 224, height: 224, is_entry: true,
      allowed_creature_types: ['Slime'],
    }],
    links: [],
  });
  assert.ok(crowded.problems.some((p) => p.includes('KiB/s down a single socket')), crowded.problems.join('; '));
});
