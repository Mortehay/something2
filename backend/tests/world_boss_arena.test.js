// A world boss fights on a FOUND, validated arena (src/authority/bossArena.js), not on
// a hard-coded point that may be inside a village or a wall.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findArena, clearArenaCache, ARENA_RADIUS, MIN_OPEN, LANDMARK_CLEARANCE, EDGE_MARGIN,
} = require('../src/authority/bossArena.js');
const { WorldBossManager } = require('../src/authority/worldBoss.js');
const { CreatureSim } = require('../src/authority/creatures.js');
const { villageContaining } = require('../src/services/mapService.js');

const TILE = 100;
const open = () => true;

// A world `tiles` x `tiles` big whose walkability is `walk(x, y)`.
function world({ id = 'w1', name = 'Emerald Grove', key = '', tiles = 100, walk = open, villages = [], portals = [], waypoints = [], chests = [] } = {}) {
  const map = { isWalkable: walk, speedAt: () => 1, chunkSize: 8 };
  return {
    worldId: id,
    row: { name, key, width: tiles, height: tiles },
    villages,
    portalLinks: new Map(portals.map(([r, c]) => [`${r},${c}`, {}])),
    waypoints: new Map(waypoints.map((w, i) => [`wp${i}`, { id: `wp${i}`, ...w }])),
    chests,
    world: { map, creatures: new CreatureSim(map, () => 0.05) },
  };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test.beforeEach(() => clearArenaCache());

test('an open world: the configured point is used as is', () => {
  const a = findArena(world({ name: 'Vale Crossing', key: 'vale_hub' }));
  assert.deepEqual([a.x, a.y, a.source, a.name], [8800, 8800, 'configured', 'Colossus Caldera']);
  assert.equal(a.radius, ARENA_RADIUS);
});

test('Vale Crossing\'s old arena point is inside the hub town: the arena moves out of it', () => {
  // A village box covering (8800, 8800) -- tile 88,88.
  const village = { minRow: 80, minCol: 80, width: 20, height: 20, gateEdge: 'S' };
  const e = world({ name: 'Vale Crossing', key: 'vale_hub', villages: [village] });
  const a = findArena(e);
  assert.equal(a.source, 'found');
  assert.equal(a.name, 'Colossus Caldera', 'keeps the region\'s name');
  // No part of the arena disk touches a village tile (and there is a margin).
  for (let ang = 0; ang < 360; ang += 15) {
    const px = a.x + Math.cos((ang * Math.PI) / 180) * a.radius;
    const py = a.y + Math.sin((ang * Math.PI) / 180) * a.radius;
    assert.equal(villageContaining(Math.floor(py / TILE), Math.floor(px / TILE), e.villages), null, `ring point ${ang} is in a village`);
  }
  assert.equal(villageContaining(Math.floor(a.y / TILE), Math.floor(a.x / TILE), e.villages), null);
});

test('never on a portal, a waypoint or a chest', () => {
  const e = world({
    name: 'Vale Crossing', key: 'vale_hub',
    portals: [[88, 88]], waypoints: [{ x: 8700, y: 8900 }], chests: [{ x: 8900, y: 8700 }],
  });
  const a = findArena(e);
  for (const l of [{ x: 8850, y: 8850 }, { x: 8700, y: 8900 }, { x: 8900, y: 8700 }]) {
    assert.ok(dist(a, l) >= LANDMARK_CLEARANCE, `${dist(a, l)} from ${JSON.stringify(l)}`);
  }
  assert.equal(a.source, 'found');
});

test('a blocked configured point (a lake there) moves the arena to open ground', () => {
  const lake = (x, y) => !((x - 8800) ** 2 + (y - 8800) ** 2 < 900 * 900);
  const e = world({ name: 'Vale Crossing', key: 'vale_hub', walk: lake });
  const a = findArena(e);
  assert.equal(a.source, 'found');
  assert.ok(dist(a, { x: 8800, y: 8800 }) > 400);
  // and the chosen disk is really open
  let ok = 0, n = 0;
  for (let dy = -a.radius; dy <= a.radius; dy += 64) for (let dx = -a.radius; dx <= a.radius; dx += 64) {
    if (dx * dx + dy * dy > a.radius * a.radius) continue;
    n += 1; if (lake(a.x + dx, a.y + dy)) ok += 1;
  }
  assert.ok(ok / n >= MIN_OPEN, `${ok}/${n}`);
});

test('a world with no configured arena starts at 0.75 of the map and stays inside the edge margin', () => {
  const a = findArena(world({ name: 'Nowhere Special', tiles: 60 }));
  assert.equal(a.x, 4500);
  assert.equal(a.y, 4500);
  assert.ok(a.x >= EDGE_MARGIN && a.x <= 6000 - EDGE_MARGIN);
  assert.equal(a.name, 'Boss Arena');
});

test('the same world gives the same arena, every time (no RNG, nothing to persist)', () => {
  const mk = () => world({ name: 'Vale Crossing', key: 'vale_hub', walk: (x, y) => !((x - 8800) ** 2 + (y - 8800) ** 2 < 900 * 900), portals: [[70, 70]] });
  const a = findArena(mk());
  clearArenaCache();
  const b = findArena(mk());
  assert.deepEqual(a, b);
  assert.deepEqual(findArena(mk()), a, 'and from the cache');
});

test('a world that is all wall falls back without throwing, to the middle of the map', () => {
  const a = findArena(world({ name: 'Solid Rock', walk: () => false, tiles: 50 }));
  assert.equal(a.source, 'fallback');
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
});

test('a world with only a small clearing: the most open legal spot wins, flagged as a fallback', () => {
  // Every spot is 80% open at best: never reaches MIN_OPEN.
  const e = world({ name: 'Marsh', tiles: 40, walk: (x, y) => ((Math.floor(x / 100) + Math.floor(y / 100)) % 5) !== 0 });
  const a = findArena(e);
  assert.equal(a.source, 'fallback');
});

// ---- the spawn lands on it ---------------------------------------------------------

const bossRow = {
  id: 901, name: 'zzArena Boss', color: '#f00', hp: 12000, max_hp: 12000, defense: 25, resistances: {}, faction: 'hostile',
  gold_min: 0, gold_max: 0, attack_element: 'fire', vfx: null, prompt: 'zz', boss_tier: 'world', element: 'fire',
  hitbox_size: 96, auras: null, xp_reward: 0, base_damage: 40, display_width: 96, display_height: 96,
  behavior_name: null, abilities: null,
};
async function mgr() {
  const m = new WorldBossManager({
    bossIntervalMs: 600000, bossWarningMs: 120000, rng: () => 0,
    loadCatalog: async () => ({ bosses: [bossRow], minionsByElement: new Map() }),
  });
  await m.refreshCatalog();
  return m;
}

test('the boss spawns standing on the validated arena, with the arena as its leash post', async () => {
  const village = { minRow: 80, minCol: 80, width: 20, height: 20, gateEdge: 'S' };
  const e = world({ name: 'Vale Crossing', key: 'vale_hub', villages: [village] });
  const m = await mgr();
  assert.equal(m.forceSpawn(Date.now(), new Map([['w1', e]]), {}, () => {}), true);
  const arena = findArena(e);
  const c = e.world.creatures.get(m.bossCreatureId);
  assert.ok(c);
  assert.equal(Math.round(c.x + c.width / 2), arena.x, 'centred on the arena');
  assert.equal(Math.round(c.y + c.height / 2), arena.y);
  assert.deepEqual(c.home, { x: arena.x, y: arena.y });
  assert.notEqual(arena.x, 8800, 'not the old hard-coded point inside the town');
  assert.equal(villageContaining(Math.floor(arena.y / TILE), Math.floor(arena.x / TILE), e.villages), null);
});

test('the status frame carries the arena for the minimap and the world ring', async () => {
  const e = world({ name: 'Vale Crossing', key: 'vale_hub' });
  const m = await mgr();
  m.forceSpawn(Date.now(), new Map([['w1', e]]), {}, () => {});
  const s = m.getStatus();
  assert.deepEqual(s.arena, { x: 8800, y: 8800, r: ARENA_RADIUS, name: 'Colossus Caldera' });
  assert.equal(s.arenaName, 'Colossus Caldera');
  m._despawnBoss(new Map([['w1', e]]), null, 'timeout');
  assert.equal(m.getStatus().arena, null, 'no arena once the event is idle');
});

test('the nearest waypoint is measured from the found arena, not the old point', async () => {
  const e = world({
    name: 'Vale Crossing', key: 'vale_hub', walk: (x, y) => !((x - 8800) ** 2 + (y - 8800) ** 2 < 900 * 900),
    waypoints: [{ x: 8800, y: 8800 }, { x: 5000, y: 5000 }],
  });
  const m = await mgr();
  m.forceSpawn(Date.now(), new Map([['w1', e]]), {}, () => {});
  const arena = findArena(e);
  const wps = [...e.waypoints.values()];
  const nearest = wps.reduce((a, b) => (dist(a, arena) <= dist(b, arena) ? a : b));
  assert.equal(m.nearestWaypointId, nearest.id);
});
