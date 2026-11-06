// The dedicated boss arena WORLDS: the map spec (boss-arenas.map.json + the hub's plaza in
// vale-region.map.json), the paved fast floor, the ONE universal portal next to Vale
// Crossing, the boss -> arena table, planning/spawning there, loading and holding the world,
// the always-open portal and where it resolves to, and the status fields. Offline: nothing here touches a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gen = require('../scripts/gen-boss-arenas-spec.js');
const { crossSpecInputs } = require('../src/services/seedSync/mapsGroup.js');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { ServerMap } = require('../src/authority/collision.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { HOSTILE_CREATURES } = require('../seeds/data/entityTypes.js');
const { BESTIARY_P4_CREATURES } = require('../seeds/data/bestiaryP4.js');
const { POINT_TYPES } = require('../seeds/data/pointTypes.js');
const { DUNGEON_BOSSES } = require('../seeds/data/dungeonBosses.js');
const balance = require('../src/services/bossBalance.js');
const {
  ARENA_WORLDS, arenaForBoss, arenaForWorldName, universalGate, SEED_COMMAND,
} = require('../src/authority/bossArenaWorlds.js');
const { findArena, clearArenaCache, ARENA_RADIUS, LANDMARK_CLEARANCE } = require('../src/authority/bossArena.js');
const { WorldBossManager } = require('../src/authority/worldBoss.js');
const { CreatureSim } = require('../src/authority/creatures.js');

const MAPS = path.join(__dirname, '..', 'seeds', 'maps');
const readSpec = (name) => JSON.parse(fs.readFileSync(path.join(MAPS, `${name}.map.json`), 'utf8'));
const TILE_TYPES = Object.fromEntries(DEFAULT_TILE_TYPES.map((t) => [t.name, t]));
const FAST = 1.2; // road_stone: the fastest ground tile in the catalog

// ---- the spec ---------------------------------------------------------------------

test('the committed spec is exactly what the generator writes', () => {
  const have = fs.readFileSync(gen.SPEC_PATH, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(have, gen.render(gen.buildSpec()));
});

test('boss-arenas and the hub spec both pass the map-spec validator', () => {
  const rosters = {
    biomeNames: new Set(STARTER_BIOMES.map((b) => b.name)),
    creatureTypeNames: new Set([...HOSTILE_CREATURES, ...BESTIARY_P4_CREATURES].map((c) => c.name)),
    biomeCreatureTypes: new Map(STARTER_BIOMES.map((b) => [b.name, b.creature_types])),
    pointArtTypes: new Map(POINT_TYPES.map((t) => [t.name, t.point_kind])),
    bossTiers: new Map([
      ...DUNGEON_BOSSES.map((b) => [b.name, b.boss_tier]),
      ...Object.keys(balance.WORLD_BOSSES).map((n) => [n, 'world']),
    ]),
  };
  // exactly what `make seed-map` passes: worlds that other specs' links reach count as reachable
  const all = fs.readdirSync(MAPS).filter((f) => f.endsWith('.map.json'))
    .map((f) => ({ name: f.replace('.map.json', ''), spec: readSpec(f.replace('.map.json', '')) }));
  for (const name of ['boss-arenas', 'vale-region']) {
    const errs = validateMapSpec(readSpec(name), { ...rosters, ...crossSpecInputs(all, name) });
    assert.deepEqual(errs, [], `${name}: ${errs.join('; ')}`);
  }
});

test('one arena world per table entry, named as the table says, with no wandering creatures', () => {
  const spec = readSpec('boss-arenas');
  assert.equal(spec.worlds.length, ARENA_WORLDS.length);
  for (const a of ARENA_WORLDS) {
    const w = spec.worlds.find((x) => x.key === a.key);
    assert.ok(w, `${a.key} is in the spec`);
    assert.equal(w.name, a.worldName);
    assert.equal(w.density, 'dead', 'density dead: the boss is the only thing in the arena');
    assert.deepEqual(w.allowed_creature_types, []);
    assert.equal(w.width, 64);
    assert.ok(!w.village && !w.villages, 'no town in an arena');
  }
});

test('the table covers every world-tier boss the seeds and the balance table know', () => {
  const seeded = require('../seeds/sync/entities.json').tables.entity_types
    .filter((e) => e.boss_tier === 'world').map((e) => e.name);
  assert.ok(seeded.length >= 4);
  for (const name of [...seeded, ...Object.keys(balance.WORLD_BOSSES)]) {
    assert.ok(arenaForBoss({ name }), `${name} has an arena world`);
  }
  // a new boss with a known element still lands in that element's arena
  assert.equal(arenaForBoss({ name: 'Somebody New', element: 'fire' }).short, 'Ignis');
  assert.equal(arenaForBoss({ name: 'Somebody New', element: 'holy' }), null);
});

test('every arena has one return portal to the hub, and all four land on the ONE universal hub pad', () => {
  const spec = readSpec('boss-arenas');
  assert.equal(spec.links.length, 4);
  const pads = new Set();
  for (const l of spec.links) {
    assert.equal(l.kind, 'portal');
    assert.equal(l.to, '@Vale Crossing');
    pads.add(`${l.to_x},${l.to_y}`);
  }
  assert.equal(pads.size, 1, 'one hub tile for every link: the database ends with one hub row');
  assert.deepEqual([...pads], [`${gen.tileCentre(gen.HUB_PORTAL.col)},${gen.tileCentre(gen.HUB_PORTAL.row)}`]);
});

// ---- the floor: everything you walk on in the arena is the fastest tile ---------------

function mapFor(w, extra = {}) {
  const row = {
    seed: w.seed, chunk_size: w.chunk_size, width: w.width, height: w.height, entry_spawn: w.entry_spawn,
    biome_cell: w.biome_cell, authored_roads: w.roads, safe_road_radius: 0, safe_rects: [], ...extra.row,
  };
  const biomes = STARTER_BIOMES.filter((b) => (w.biomes || []).includes(b.name));
  return new ServerMap(buildWorldGenConfig({
    row, tileTypes: TILE_TYPES, doorways: extra.doorways || [], villages: extra.villages || [], biomes, links: [],
  }));
}

test('every tile of every arena disk resolves to road_stone, walkable, speed >= 1.2', () => {
  const spec = readSpec('boss-arenas');
  for (const w of spec.worlds) {
    const map = mapFor(w);
    let n = 0;
    for (let row = 0; row < w.height; row += 1) {
      for (let col = 0; col < w.width; col += 1) {
        const cx = col * 100 + 50; const cy = row * 100 + 50;
        if (Math.hypot(cx - gen.CENTER_PX, cy - gen.CENTER_PX) > gen.PAVED_RADIUS_PX) continue;
        n += 1;
        assert.equal(map.getTileAt(cx, cy), 'road_stone', `${w.key} tile (${row},${col})`);
        assert.ok(map.isWalkable(cx, cy), `${w.key} (${row},${col}) walkable`);
        assert.ok(map.speedAt(cx, cy) >= FAST, `${w.key} (${row},${col}) speed ${map.speedAt(cx, cy)}`);
      }
    }
    assert.ok(n > 140, `${w.key}: a real disk (${n} tiles)`);
  }
});

test('the paved disk is bigger than the arena the boss is placed on', () => {
  assert.ok(gen.PAVED_RADIUS_PX >= ARENA_RADIUS + 200);
});

test('the walk from the return portal to the arena is road_stone, three tiles wide, no gaps', () => {
  const spec = readSpec('boss-arenas');
  for (const w of spec.worlds) {
    const map = mapFor(w);
    for (const row of [31, 32, 33]) {
      for (let col = gen.PORTAL_TILE.col - 1; col <= 27; col += 1) {
        assert.equal(map.getTileAt(col * 100 + 50, row * 100 + 50), 'road_stone', `${w.key} (${row},${col})`);
      }
    }
    const spawn = w.entry_spawn;
    assert.equal(map.getTileAt(spawn.x, spawn.y), 'road_stone', 'entry spawn is on the road');
    const link = spec.links.find((l) => l.from === w.key);
    assert.equal(map.getTileAt(link.from_x, link.from_y), 'road_stone', 'return portal pad');
    assert.ok(map.isWalkable(link.from_x, link.from_y));
  }
});

test('the arena search settles on the paved centre of each arena world', () => {
  const spec = readSpec('boss-arenas');
  for (const a of ARENA_WORLDS) {
    clearArenaCache();
    const w = spec.worlds.find((x) => x.key === a.key);
    const link = spec.links.find((l) => l.from === a.key);
    const entry = {
      worldId: a.key,
      row: { name: w.name, key: w.key, width: w.width, height: w.height },
      villages: [],
      portalLinks: new Map([[`${Math.floor(link.from_y / 100)},${Math.floor(link.from_x / 100)}`, {}]]),
      waypoints: new Map(),
      chests: [],
      world: { map: mapFor(w) },
    };
    const arena = findArena(entry);
    assert.equal(arena.source, 'dedicated', a.key);
    assert.deepEqual([arena.x, arena.y], [gen.CENTER_PX, gen.CENTER_PX]);
    assert.equal(arena.name, `${a.short}'s Arena`);
    // the portal is far enough from the boss for the arena rules
    assert.ok(Math.hypot(link.from_x - arena.x, link.from_y - arena.y) >= LANDMARK_CLEARANCE);
  }
});

// ---- the hub: portals right next to the town --------------------------------------------

function hubMap() {
  const spec = readSpec('vale-region');
  const hub = spec.worlds.find((w) => w.key === 'vale_hub');
  const v = hub.village;
  const map = mapFor(hub, {
    doorways: ['E', 'W', 'N', 'S'],
    villages: [{ id: 'v', spec_key: v.key, min_row: v.min_row, min_col: v.min_col, width: v.width, height: v.height, gate_edge: v.gate_edge, spawn_x: v.spawn_x, spawn_y: v.spawn_y }],
  });
  const gateRow = v.min_row + Math.floor(v.height / 2);
  const gateCol = v.min_col + v.width - 1; // gate_edge 'E'
  return { spec, hub, v, map, gate: { x: gateCol * 100 + 50, y: gateRow * 100 + 50 } };
}

test('the universal hub pad stands on the old tavern plaza, on road_stone, outside the walls', () => {
  const { hub, v, map, gate } = hubMap();
  assert.equal(v.gate_edge, 'E', 'the geometry below assumes an east gate');
  const spec = readSpec('boss-arenas');
  const pad = { x: spec.links[0].to_x, y: spec.links[0].to_y };
  const d = Math.hypot(pad.x - gate.x, pad.y - gate.y);
  assert.ok(d <= 900, `the pad is ${Math.round(d)} px from the gate`);
  assert.ok(d >= 250, `the pad is clear of the gate itself (${Math.round(d)} px)`);
  assert.equal(map.getTileAt(pad.x, pad.y), 'road_stone');
  assert.ok(map.isWalkable(pad.x, pad.y));
  const row = Math.floor(pad.y / 100); const col = Math.floor(pad.x / 100);
  assert.ok(!(row >= v.min_row && row < v.min_row + v.height && col >= v.min_col && col < v.min_col + v.width), 'outside the village rect');
  assert.notEqual(col, 50, 'not on the spine');
  assert.notEqual(row, 46, 'not on the east road');
  // the tavern's footprint (rows 50-53, cols 52-56) is open ground now: nothing stands there
  for (let r = 50; r <= 53; r += 1) {
    for (let c = 52; c <= 56; c += 1) {
      assert.ok(map.isWalkable(c * 100 + 50, r * 100 + 50), `tile ${r},${c} (the former tavern) is open ground`);
    }
  }
  // the plaza is paved and joined to the east road
  for (let r = 46; r <= 51; r += 1) assert.equal(map.getTileAt(5350, r * 100 + 50), 'road_stone', `spur row ${r}`);
  assert.equal(hub.roads.filter((x) => x.type === 'road_stone').length, gen.HUB_ROADS.length, 'the old four spurs are gone');
});

test('the pad keeps its distance from every other landmark of the hub, and no other portal claims its tile', () => {
  const { hub } = hubMap();
  const spec = readSpec('boss-arenas');
  const pad = { x: spec.links[0].to_x, y: spec.links[0].to_y };
  const landmarks = [
    ...(hub.waypoints || []).map((w) => ({ id: `waypoint ${w.name}`, x: w.x, y: w.y })),
    ...(hub.chest ? [{ id: 'chest', x: hub.chest.x, y: hub.chest.y }] : []),
    { id: 'spire portal', x: 5850, y: 4350 },
    { id: 'village spawn', x: hub.village.spawn_x, y: hub.village.spawn_y },
  ];
  for (const lm of landmarks) {
    assert.ok(Math.hypot(pad.x - lm.x, pad.y - lm.y) >= 250, `pad is ${Math.round(Math.hypot(pad.x - lm.x, pad.y - lm.y))} px from ${lm.id}`);
  }
  const vale = readSpec('vale-region');
  for (const l of vale.links.filter((x) => x.kind === 'portal')) {
    assert.ok(!(pad.x === l.from_x && pad.y === l.from_y));
  }
});

// ---- planning, loading, holding, the gate -------------------------------------------------

const bossRow = (over = {}) => ({
  id: 901, name: 'Glacius, the Frost Leviathan', color: '#9cf', hp: 12000, max_hp: 12000, defense: 25, resistances: {},
  faction: 'hostile', gold_min: 0, gold_max: 0, attack_element: 'ice', vfx: null, prompt: 'zz', boss_tier: 'world',
  element: 'ice', hitbox_size: 96, auras: null, xp_reward: 0, base_damage: 40, display_width: 96, display_height: 96,
  behavior_name: null, abilities: null, ...over,
});

function arenaEntry(id = 'a-glacius', name = 'Boss Arena: Glacius') {
  const open = { isWalkable: () => true, speedAt: () => 1.2, chunkSize: 8 };
  return {
    worldId: id, row: { name, key: 'arena_glacius', width: 64, height: 64 }, villages: [],
    portalLinks: new Map([['32,14', {}]]), waypoints: new Map(), chests: [], sockets: new Map(),
    world: { map: open, creatures: new CreatureSim(open, () => 0.05), players: new Map(), now: 1000, isEmpty: () => true },
  };
}
function regionEntry(id = 'r1', name = 'Emerald Grove') {
  const open = { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 };
  return {
    worldId: id, row: { name, key: '', width: 100, height: 100 }, villages: [], portalLinks: new Map(), waypoints: new Map(),
    chests: [], sockets: new Map(),
    world: { map: open, creatures: new CreatureSim(open, () => 0.05), players: new Map(), now: 1000, isEmpty: () => true },
  };
}
async function mgr(opts = {}) {
  clearArenaCache();
  const m = new WorldBossManager({
    bossIntervalMs: 600000, bossWarningMs: 120000, rng: () => 0,
    loadCatalog: async () => ({ bosses: [bossRow()], minionsByElement: new Map() }),
    ...opts,
  });
  await m.refreshCatalog();
  return m;
}
const worldsOf = (...es) => new Map(es.map((e) => [e.worldId, e]));
const flush = () => new Promise((r) => setImmediate(r));

test('a loaded arena world hosts its boss, at the arena centre, even with a region world around', async () => {
  const m = await mgr();
  const arena = arenaEntry();
  const region = regionEntry();
  assert.equal(m.forceSpawn(Date.now(), worldsOf(region, arena), { preferredWorldId: 'r1' }, () => {}), true);
  assert.equal(m.activeWorldId, 'a-glacius', 'the preferred region is overruled: the boss has its own arena');
  const c = arena.world.creatures.get(m.bossCreatureId);
  assert.ok(c);
  assert.deepEqual([Math.round(c.x + c.width / 2), Math.round(c.y + c.height / 2)], [3200, 3200]);
  assert.equal(region.world.creatures.all().filter((x) => x.bossTier).length, 0, 'nothing in the region');
  const st = m.getStatus();
  assert.equal(st.dedicated, true);
  assert.equal(st.arenaWorldId, 'a-glacius');
  assert.equal(st.arenaWorldName, 'Boss Arena: Glacius');
  assert.equal(st.arenaOpen, true);
  assert.equal(st.arenaName, "Glacius's Arena");
  assert.equal(m.statusFor(st, 'elsewhere').arenaWorldName, 'Boss Arena: Glacius', 'the slim status says where to go too');
  assert.equal(m.statusFor(st, 'elsewhere').arenaOpen, true);
});

test('an arena world that is not loaded yet is loaded before the warning, and the boss spawns in it', async () => {
  const arena = arenaEntry();
  const region = regionEntry();
  const worlds = worldsOf(region);
  let loads = 0;
  const m = await mgr({
    ensureWorld: async (name) => { loads += 1; if (name !== arena.row.name) return null; worlds.set(arena.worldId, arena); return arena; },
  });
  const t0 = Date.now();
  m.nextSpawnTime = t0 + 140000;      // inside warning (120 s) + preload (30 s), not yet in the warning
  m.tick(t0, worlds, () => {});
  assert.equal(m.state, 'idle', 'not warning yet');
  assert.equal(loads, 1, 'the arena world was asked for');
  m.tick(t0 + 1, worlds, () => {});
  assert.equal(loads, 1, 'asked once');
  await flush(); await flush();
  m.nextSpawnTime = t0 + 100000;      // now inside the warning window
  const sent = [];
  m.tick(t0 + 2, worlds, (f) => sent.push(f));
  assert.equal(m.state, 'warning');
  assert.equal(m.activeWorldId, 'a-glacius', 'the warning already names the arena world');
  assert.equal(m.getStatus().dedicated, true);
  const warn = sent.find((f) => f.kind === 'world_boss_warning');
  assert.equal(warn.worldName, 'Boss Arena: Glacius');
  m.nextSpawnTime = t0 - 1;
  m.tick(t0 + 3, worlds, () => {});
  assert.equal(m.state, 'active');
  assert.ok(arena.world.creatures.get(m.bossCreatureId));
});

test('an arena that was never seeded: the boss falls back to a region, once-warned with the seed command', async () => {
  const region = regionEntry();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const m = await mgr({ ensureWorld: async () => null });
    await m.ensureArenaFor('Glacius, the Frost Leviathan');
    assert.ok(m._unseeded.has('Boss Arena: Glacius'));
    assert.equal(m.forceSpawn(Date.now(), worldsOf(region), {}, () => {}), true);
    assert.equal(m.activeWorldId, 'r1', 'the region fallback');
    assert.equal(m.getStatus().dedicated, false);
    m.forceSpawn(Date.now(), worldsOf(region), {}, () => {});
    const mine = warnings.filter((w) => w.includes('Boss Arena: Glacius'));
    assert.equal(mine.length, 1, 'warned once, not per spawn');
    assert.ok(mine[0].includes(SEED_COMMAND), mine[0]);
  } finally { console.warn = realWarn; }
});

test('a plan that fell back to a region moves onto the arena world if it has loaded by spawn time', async () => {
  const arena = arenaEntry();
  const region = regionEntry();
  const worlds = worldsOf(region);
  const m = await mgr();
  assert.equal(m._planNextBoss(worlds), true);
  assert.equal(m.activeWorldId, 'r1');
  worlds.set(arena.worldId, arena);
  assert.equal(m._spawnBoss(Date.now(), worlds, () => {}), true);
  assert.equal(m.activeWorldId, 'a-glacius');
  assert.ok(arena.world.creatures.get(m.bossCreatureId));
});

test('a spawn waits (and retries soon) while the arena world is still loading, then gives up to the region', async () => {
  const region = regionEntry();
  const worlds = worldsOf(region);
  let release;
  const m = await mgr({ ensureWorld: () => new Promise((r) => { release = r; }) });
  assert.equal(m._planNextBoss(worlds), true);
  const t0 = Date.now();
  assert.equal(m._spawnBoss(t0, worlds, () => {}), false, 'waits');
  assert.ok(m.nextSpawnTime - t0 <= 3000 + 5, 'retries in a few seconds');
  assert.equal(m._spawnBoss(t0 + 25000, worlds, () => {}), true, 'past the wait window: the region fallback');
  assert.equal(m.activeWorldId, 'r1');
  release(null);
});

test('the hub portal is ALWAYS open and resolves to the active boss, else the next boss, else the default', async () => {
  const m = await mgr();
  const arena = arenaEntry();
  const link = { toName: 'Boss Arena: Gorgon' }; // the row's placeholder arena: never what decides
  const gate = (now) => universalGate(m, link, 'Vale Crossing', now);
  // nothing planned yet and no tick: the first arena of the table
  let g = gate();
  assert.equal(g.universal, true);
  assert.equal(g.mode, 'default');
  assert.equal(g.worldName, ARENA_WORLDS[0].worldName);
  assert.match(g.message, /^Entering Boss Arena: Glacius\. No boss is active right now and none is planned yet\.$/);
  // the manager picks the NEXT boss as soon as it ticks idle, far from the warning
  m.tick(Date.now(), worldsOf(arena), () => {});
  assert.equal(m.state, 'idle');
  g = gate();
  assert.equal(g.mode, 'next');
  assert.equal(g.worldName, 'Boss Arena: Glacius');
  assert.equal(g.bossName, 'Glacius, the Frost Leviathan');
  assert.match(g.message, /^Entering Boss Arena: Glacius\. No boss is active right now; Glacius, the Frost Leviathan is next\.$/);
  // active: the boss that is fighting
  assert.equal(m.forceSpawn(Date.now(), worldsOf(arena), {}, () => {}), true);
  g = gate();
  assert.equal(g.mode, 'active');
  assert.equal(g.worldName, 'Boss Arena: Glacius');
  assert.match(g.message, /^Entering Boss Arena: Glacius \(Glacius, the Frost Leviathan is fighting there\)\.$/);
  // never refused, whatever the placeholder says; other portals are untouched
  assert.equal(universalGate(m, { toName: 'Boss Arena: Ignis' }, 'Vale Crossing').universal, true);
  assert.equal(universalGate(m, { toName: 'Vale Crossing' }, 'Boss Arena: Glacius').universal, false, 'the way OUT');
  assert.equal(universalGate(m, { toName: 'Boss Arena: Ignis' }, 'Boss Arena: Glacius').universal, false, 'arena to arena is not the hub portal');
  assert.equal(universalGate(m, { toName: 'Spire of Trials: Floor 1' }, 'Vale Crossing').universal, false);
  assert.equal(universalGate(m, null, 'Vale Crossing').universal, false);
});

test("the hub portal stays on the slain boss's arena for the loot window, then goes to the next boss; a timeout gives no window", async () => {
  const ignis = bossRow({ id: 902, name: 'Ignis, the Magma Colossus', element: 'fire', attack_element: 'fire' });
  const m = await mgr({ loadCatalog: async () => ({ bosses: [bossRow(), ignis], minionsByElement: new Map() }), rng: () => 0 });
  const arena = arenaEntry();
  m.forceSpawn(Date.now(), worldsOf(arena), { bossName: 'Glacius, the Frost Leviathan' }, () => {});
  const c = arena.world.creatures.get(m.bossCreatureId);
  c._playerDamage = new Map([['7', 12000]]);
  m.currentBoss._playerDamage = c._playerDamage;
  arena.world.creatures.remove(c.id);
  await m.onCreatureDeath(arena, null, '7', { dropLegendaryFn: async () => null, killed: { x: 3200, y: 3200 } });
  const now = Date.now();
  assert.equal(m.state, 'idle');
  assert.equal(m.arenaDestination(now + 1000).def.worldName, 'Boss Arena: Glacius', 'the loot window');
  assert.equal(m.arenaDestination(now + 1000).mode, 'active');
  assert.equal(m.getStatus().arenaOpen, true);
  // after the window the NEXT boss's arena (picked at the first idle tick; rng 0 -> the first catalog boss)
  m.tick(now + 6 * 60 * 1000, worldsOf(arena), () => {});
  const after = m.arenaDestination(now + 6 * 60 * 1000);
  assert.equal(after.mode, 'next');
  assert.equal(after.def.worldName, 'Boss Arena: Glacius');

  const m2 = await mgr();
  const arena2 = arenaEntry();
  m2.forceSpawn(Date.now(), worldsOf(arena2), {}, () => {});
  m2._despawnBoss(worldsOf(arena2), () => {}, 'timeout');
  assert.equal(m2.arenaDestination(Date.now()).mode, 'default', 'a timed-out boss leaves nothing to loot, nothing picked yet');
});

test("the next boss is chosen when an event ends and kept for the whole cycle, until the warning plans from it", async () => {
  const bosses = [
    bossRow(),
    bossRow({ id: 902, name: 'Ignis, the Magma Colossus', element: 'fire', attack_element: 'fire' }),
    bossRow({ id: 903, name: 'Gorgon, the Thunder Titan', element: 'lightning', attack_element: 'lightning' }),
  ];
  let n = 0;
  const m = await mgr({ loadCatalog: async () => ({ bosses, minionsByElement: new Map() }), rng: () => [0.5, 0.9, 0.1][n++ % 3] });
  const ignis = arenaEntry('a-ignis', 'Boss Arena: Ignis');
  const worlds = worldsOf(ignis);
  m.tick(Date.now(), worlds, () => {});
  const picked = m.arenaDestination().bossName;
  assert.equal(picked, 'Ignis, the Magma Colossus', 'rng 0.5 of three bosses');
  for (let i = 0; i < 5; i += 1) m.tick(Date.now() + i * 1000, worlds, () => {});
  assert.equal(m.arenaDestination().bossName, picked, 'kept while idle: it does not change tick to tick');
  // the warning plans THAT boss, in THAT arena
  m.nextSpawnTime = Date.now() + 60000;
  m.tick(Date.now(), worlds, () => {});
  assert.equal(m.state, 'warning');
  assert.equal(m.currentBoss.name, picked);
  assert.equal(m.activeWorldId, 'a-ignis');
  assert.equal(m.arenaDestination().def.worldName, 'Boss Arena: Ignis');
  // the status frame says where the portal leads, in the full and the slim form
  const st = m.getStatus();
  assert.equal(st.nextBossName, picked);
  assert.equal(st.nextArenaWorldName, 'Boss Arena: Ignis');
  assert.equal(m.statusFor(st, 'elsewhere').nextArenaWorldName, 'Boss Arena: Ignis');
});

test("a forced spawn of a different boss runs in ITS arena but leaves the cycle's pick as the next boss", async () => {
  const bosses = [bossRow(), bossRow({ id: 902, name: 'Ignis, the Magma Colossus', element: 'fire', attack_element: 'fire' })];
  const m = await mgr({ loadCatalog: async () => ({ bosses, minionsByElement: new Map() }), rng: () => 0 });
  const glacius = arenaEntry('a-glacius', 'Boss Arena: Glacius');
  const igArena = arenaEntry('a-ignis', 'Boss Arena: Ignis');
  const worlds = worldsOf(glacius, igArena);
  m.tick(Date.now(), worlds, () => {});
  assert.equal(m.arenaDestination().bossName, 'Glacius, the Frost Leviathan');
  assert.equal(m.forceSpawn(Date.now(), worlds, { bossName: 'Ignis, the Magma Colossus' }, () => {}), true);
  assert.equal(m.activeWorldId, 'a-ignis');
  assert.equal(m.arenaDestination().def.worldName, 'Boss Arena: Ignis', 'while it lasts the portal follows the active boss');
  m._despawnBoss(worlds, () => {}, 'timeout');
  m.tick(Date.now(), worlds, () => {});
  assert.equal(m.arenaDestination().bossName, 'Glacius, the Frost Leviathan', "then back to the cycle's pick");
});

test('an arena with no boss is a quiet, empty world that nothing holds', async () => {
  const m = await mgr();
  const arena = arenaEntry();
  assert.equal(m.holdsWorld('a-glacius'), false, 'idle and nobody there: eviction is allowed');
  m.tick(Date.now(), worldsOf(arena), () => {});
  assert.equal(arena.world.creatures.all().length, 0, 'no creature in it');
  assert.equal(m.holdsWorld('a-glacius'), false);
});

test('the arena world is held in memory while the event needs it, and released afterwards', async () => {
  const m = await mgr();
  const arena = arenaEntry();
  const worlds = worldsOf(arena);
  assert.equal(m.holdsWorld('a-glacius'), false, 'idle: nothing holds it');
  m.forceSpawn(Date.now(), worlds, {}, () => {});
  assert.equal(m.holdsWorld('a-glacius'), true, 'active: held');
  assert.equal(m.holdsWorld('some-other-world'), false);
  const c = arena.world.creatures.get(m.bossCreatureId);
  c._playerDamage = new Map([['7', 12000]]);
  m.currentBoss._playerDamage = c._playerDamage;
  arena.world.creatures.remove(c.id);
  await m.onCreatureDeath(arena, null, '7', { dropLegendaryFn: async () => null, killed: { x: 3200, y: 3200 } });
  assert.equal(m.holdsWorld('a-glacius', Date.now() + 1000), true, 'held through the loot window');
  assert.equal(m.holdsWorld('a-glacius', Date.now() + 6 * 60 * 1000), false, 'released after it');
});

test('the warning state holds the arena world too (it was loaded for the event)', async () => {
  const m = await mgr();
  const arena = arenaEntry();
  const worlds = worldsOf(arena);
  m.nextSpawnTime = Date.now() + 60000;
  m.tick(Date.now(), worlds, () => {});
  assert.equal(m.state, 'warning');
  assert.equal(m.holdsWorld('a-glacius'), true);
});

test('a region world is never "held"', async () => {
  const m = await mgr();
  const region = regionEntry();
  m.forceSpawn(Date.now(), worldsOf(region), {}, () => {});
  assert.equal(m.holdsWorld('r1'), false);
  assert.equal(arenaForWorldName('Emerald Grove'), null);
});

test('another boss uses its own arena: Ignis goes to Boss Arena: Ignis, not Glacius\'s', async () => {
  const ignis = bossRow({ id: 902, name: 'Ignis, the Magma Colossus', element: 'fire', attack_element: 'fire' });
  const m = await mgr({ loadCatalog: async () => ({ bosses: [ignis], minionsByElement: new Map() }) });
  const glacius = arenaEntry('a-glacius', 'Boss Arena: Glacius');
  const igArena = arenaEntry('a-ignis', 'Boss Arena: Ignis');
  assert.equal(m.forceSpawn(Date.now(), worldsOf(glacius, igArena), {}, () => {}), true);
  assert.equal(m.activeWorldId, 'a-ignis');
  assert.equal(m.summonWorldId(worldsOf(glacius, igArena), 'Ignis, the Magma Colossus'), 'a-ignis');
});

// ---- the universal portal: label, validator, tavern -------------------------------------

test('the hub portal is labelled "Boss Arena" (no boss named); every other portal keeps "To <world>"', () => {
  const { buildLandmarks } = require('../src/services/landmarks.js');
  const link = (toName, x) => [`52,${x}`, { id: `l${x}`, fromX: x * 100 + 50, fromY: 5250, toName, toWorldId: 'w', toX: 1, toY: 1 }];
  const out = buildLandmarks({
    waypoints: new Map(),
    portalLinks: new Map([link('Boss Arena: Gorgon', 54), link('Vale Crossing', 10), link('Spire of Trials: Floor 1', 20)]),
    activatedIds: new Set(),
  });
  assert.deepEqual(out.map((l) => l.name).sort(), ['Boss Arena', 'To Spire of Trials: Floor 1', 'To Vale Crossing']);
});

test('the validator allows a deliberately shared arrival tile only when the link says so', () => {
  const rosters = {
    biomeNames: new Set(STARTER_BIOMES.map((b) => b.name)),
    creatureTypeNames: new Set([...HOSTILE_CREATURES, ...BESTIARY_P4_CREATURES].map((c) => c.name)),
    biomeCreatureTypes: new Map(STARTER_BIOMES.map((b) => [b.name, b.creature_types])),
    pointArtTypes: new Map(POINT_TYPES.map((t) => [t.name, t.point_kind])),
    bossTiers: new Map(),
  };
  const all = fs.readdirSync(MAPS).filter((f) => f.endsWith('.map.json'))
    .map((f) => ({ name: f.replace('.map.json', ''), spec: readSpec(f.replace('.map.json', '')) }));
  const spec = readSpec('boss-arenas');
  for (const l of spec.links) delete l.shared_arrival;
  const errs = validateMapSpec(spec, { ...rosters, ...crossSpecInputs(all, 'boss-arenas') });
  assert.ok(errs.some((e) => /claims that tile again as its arrival tile/.test(e)), 'without the flag the collision is an error');
});

test('Vale Crossing has no tavern; every other village still does', () => {
  const mapService = require('../src/services/mapService.js');
  const base = { minRow: 10, minCol: 10, width: 6, height: 4, gateEdge: 'E' };
  const names = (v) => mapService.villageHouses(v).length;
  assert.equal(names({ ...base, specKey: 'vale-crossing' }), 3, 'skill house, quest house, cottage');
  assert.equal(names({ ...base, specKey: 'somewhere-else' }), 4, 'plus the tavern');
  assert.equal(names({ ...base }), 4, 'a village with no spec key keeps its tavern');
});
