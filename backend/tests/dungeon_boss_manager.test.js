// SOMET-609 (S9, spec §4.1). One owner places a dungeon boss, notes its death
// and brings it back exactly once after respawn_s -- across double loads,
// eviction/reload and repeated sweeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');
const {
  DungeonBossManager, parseDungeonBoss, dungeonBossLevel, bossCreatureId,
} = require('../src/authority/dungeonBosses.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const ROW = {
  id: 77, name: 'zzElite', hp: 4100, max_hp: 4100, defense: 36, faction: 'hostile',
  boss_tier: 'dungeon_elite', element: 'arcane', hitbox_size: 80, base_damage: 56,
  aura_names: null, aura_defs: null,
};
const SPEC = { entity: 'zzElite', x: 1150, y: 1250, respawn_s: 600 };

function harness({ row = ROW, spec = SPEC, levelMin = 41, levelMax = 50 } = {}) {
  let now = 1_000_000;
  const warnings = [];
  const kills = [];
  const loads = [];
  const mgr = new DungeonBossManager({
    loadRow: async (name) => { loads.push(name); return name === row?.name ? row : null; },
    clock: () => now,
    onKilled: (k) => kills.push(k),
    log: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
  });
  const newEntry = () => ({
    worldId: 'w-1',
    row: { dungeon_boss: spec, level_min: levelMin, level_max: levelMax },
    world: { creatures: new CreatureSim(stubMap(), () => 0.05) },
  });
  return { mgr, newEntry, warnings, kills, loads, advance: (ms) => { now += ms; } };
}
const bosses = (entry) => entry.world.creatures.all().filter((c) => c.bossTier);
const kill = (entry, id) => entry.world.creatures._removeKilled(entry.world.creatures.get(id));

test('place adds one boss with fixed id, tier, level, full hp and a leash post', async () => {
  const h = harness();
  const e = h.newEntry();
  const c = await h.mgr.place(e);
  assert.equal(c.id, 'boss:w-1');
  assert.equal(bossCreatureId('w-1'), 'boss:w-1');
  assert.equal(c.bossTier, 'dungeon_elite');
  assert.equal(c.level, 47, 'Elite at [41,50] = ceil(45.5)+1');
  assert.equal(c.hp, 4100);
  assert.equal(c.width, 80);
  assert.deepEqual(c.home, { x: 1150, y: 1250 });
  // Ruling P1: the post is a tile CENTRE and `home` is read as a centre
  // (creatures.js snap-home: c.x = home.x - width/2), so the top-left x/y sit
  // half a hitbox up-left of the post -- the boss stands ON its post.
  assert.equal(c.x, 1150 - 40);
  assert.equal(c.y, 1250 - 40);
  assert.equal(bosses(e).length, 1);
});

test('a double place, and concurrent places, leave exactly one instance', async () => {
  const h = harness();
  const e = h.newEntry();
  await Promise.all([h.mgr.place(e), h.mgr.place(e)]);
  await h.mgr.place(e);
  assert.equal(bosses(e).length, 1);
});

test('a kill is noted once, fires onKilled once, and the boss stays dead until due', async () => {
  const h = harness();
  const e = h.newEntry();
  await h.mgr.place(e);
  const before = e.world.creatures.get('boss:w-1');
  before.x = 1300; // moved before dying: the kill record carries the LAST position
  kill(e, 'boss:w-1');
  const k = h.mgr.onDeath(e, 'boss:w-1', 'u9');
  // x/y are the boss's last CENTRE (a drop lands where it stood, like
  // loot.js's dropX = dead.x + size/2): top-left 1300/1210 + 40.
  assert.deepEqual(
    { ...k, entry: undefined },
    { entry: undefined, worldId: 'w-1', creatureId: 'boss:w-1', killerUserId: 'u9', entityName: 'zzElite',
      entityTypeId: 77, bossTier: 'dungeon_elite', level: 47, x: 1340, y: 1250 });
  assert.equal(k.entry, e);
  assert.equal(h.mgr.onDeath(e, 'boss:w-1', 'u9'), null, 'a duplicate death report is ignored');
  assert.equal(h.kills.length, 1);

  h.advance(599_999);
  assert.equal(await h.mgr.place(e), null, 'a reload before due places nothing');
  assert.equal(await h.mgr.sweep(new Map([['w-1', e]])), 0);
  assert.equal(bosses(e).length, 0);
});

test('eviction + reload while dead does not bring the boss back early (no leave/rejoin farming)', async () => {
  const h = harness();
  const e1 = h.newEntry();
  await h.mgr.place(e1);
  kill(e1, 'boss:w-1');
  h.mgr.onDeath(e1, 'boss:w-1', null);
  h.advance(60_000);
  const e2 = h.newEntry(); // a brand-new entry: what loadWorld builds after evictWorld
  assert.equal(await h.mgr.place(e2), null);
  assert.equal(bosses(e2).length, 0);
});

test('after respawn_s the sweep places it exactly once; a second sweep adds nothing', async () => {
  const h = harness();
  const e = h.newEntry();
  await h.mgr.place(e);
  const placed = e.world.creatures.get('boss:w-1');
  placed.hp = 1; // wounded before dying: the respawn must not inherit it
  kill(e, 'boss:w-1');
  h.mgr.onDeath(e, 'boss:w-1', null);
  h.advance(600_000);
  const worlds = new Map([['w-1', e]]);
  assert.equal(await h.mgr.sweep(worlds), 1);
  assert.equal(await h.mgr.sweep(worlds), 0);
  assert.equal(bosses(e).length, 1);
  assert.equal(e.world.creatures.get('boss:w-1').hp, 4100, 'respawns at full hp');
});

test('a respawned boss can die and respawn again (the timer re-arms)', async () => {
  const h = harness();
  const e = h.newEntry();
  const worlds = new Map([['w-1', e]]);
  await h.mgr.place(e);
  for (let i = 0; i < 2; i += 1) {
    kill(e, 'boss:w-1');
    assert.ok(h.mgr.onDeath(e, 'boss:w-1', null), `death ${i + 1} is noted`);
    h.advance(600_000);
    assert.equal(await h.mgr.sweep(worlds), 1, `respawn ${i + 1}`);
  }
  assert.equal(h.kills.length, 2);
});

test('a due boss is NOT respawned while a player stands within 1000px of its post', async () => {
  const h = harness();
  const e = h.newEntry();
  await h.mgr.place(e);
  kill(e, 'boss:w-1');
  h.mgr.onDeath(e, 'boss:w-1', null);
  h.advance(600_000);
  const worlds = new Map([['w-1', e]]);
  assert.equal(await h.mgr.sweep(worlds, () => [{ x: 1150 + 999, y: 1250 }]), 0);
  assert.equal(await h.mgr.sweep(worlds, () => [{ x: 1150 + 1000, y: 1250 }]), 1, 'exactly 1000px is clear');
});

test('a due boss in an unloaded world waits; the next load places it', async () => {
  const h = harness();
  const e1 = h.newEntry();
  await h.mgr.place(e1);
  kill(e1, 'boss:w-1');
  h.mgr.onDeath(e1, 'boss:w-1', null);
  h.advance(700_000);
  assert.equal(await h.mgr.sweep(new Map()), 0);
  const e2 = h.newEntry();
  assert.ok(await h.mgr.place(e2));
  assert.equal(bosses(e2).length, 1);
});

test('a missing, renamed or untiered boss row places nothing and warns once', async () => {
  for (const row of [null, { ...ROW, boss_tier: null }, { ...ROW, boss_tier: 'world' }]) {
    const h = harness({ row: row ?? { ...ROW, name: 'zzOther' } });
    const e = h.newEntry();
    assert.equal(await h.mgr.place(e), null);
    assert.equal(await h.mgr.place(e), null);
    assert.equal(bosses(e).length, 0);
    assert.equal(h.warnings.length, 1, JSON.stringify(h.warnings));
  }
});

test('a malformed dungeon_boss places nothing, warns once, never queries the catalog', async () => {
  for (const spec of [[], 'x', { entity: '', x: 1, y: 1, respawn_s: 1 }, { entity: 'zzElite', x: 1, y: 1, respawn_s: 0 }]) {
    const h = harness({ spec });
    const e = h.newEntry();
    assert.equal(await h.mgr.place(e), null);
    await h.mgr.place(e);
    assert.equal(h.warnings.length, 1);
    assert.deepEqual(h.loads, []);
  }
  const h = harness({ spec: null });
  assert.equal(await h.mgr.place(h.newEntry()), null);
  assert.equal(h.warnings.length, 0, 'no boss is the normal case, not a warning');
});

test('isBoss is an id test: only boss:<thisWorld>', () => {
  const { mgr } = harness();
  assert.equal(mgr.isBoss('w-1', 'boss:w-1'), true);
  assert.equal(mgr.isBoss('w-2', 'boss:w-1'), false);
  assert.equal(mgr.isBoss('w-1', 'wb_123_4'), false);
  assert.equal(mgr.isBoss('w-1', '6f1c...uuid'), false);
});

test('an onKilled that throws or rejects is logged, never propagated', async () => {
  for (const onKilled of [() => { throw new Error('boom'); }, async () => { throw new Error('later'); }]) {
    const h = harness();
    h.mgr.onKilled = onKilled;
    const e = h.newEntry();
    await h.mgr.place(e);
    kill(e, 'boss:w-1');
    assert.doesNotThrow(() => h.mgr.onDeath(e, 'boss:w-1', null));
    await new Promise((r) => setImmediate(r));
    assert.ok(h.warnings.some((m) => /onKilled failed/.test(String(m))));
  }
});

test('levels: End = band ceiling, Elite = ceil(mid)+1 capped at the ceiling', () => {
  assert.equal(dungeonBossLevel('dungeon_end', 1, 7), 7);
  assert.equal(dungeonBossLevel('dungeon_elite', 1, 7), 5);
  assert.equal(dungeonBossLevel('dungeon_elite', 16, 26), 22);
  assert.equal(dungeonBossLevel('dungeon_elite', 41, 50), 47);
  assert.equal(dungeonBossLevel('dungeon_elite', 1, 1), 1);
  assert.equal(dungeonBossLevel('dungeon_end', null, undefined), 1);
});

test('parseDungeonBoss keeps the four fields and rejects junk', () => {
  assert.deepEqual(parseDungeonBoss({ entity: 'A', x: 1, y: 2, respawn_s: 3 }), { entity: 'A', x: 1, y: 2, respawnS: 3 });
  for (const bad of [null, [], { entity: 'A', x: -1, y: 2, respawn_s: 3 }, { entity: 'A', x: 1, y: 2, respawn_s: 1.5 }]) {
    assert.equal(parseDungeonBoss(bad), null, JSON.stringify(bad));
  }
});

// Ruling N-1/P6 (S2 quietSpawn): a room that simply loads with its boss in it
// is silent; a boss coming BACK after its timer announces itself once.
const spawnSfx = (entry) => entry.world.creatures.sfx.filter((ev) => ev.e === 'spawn');

test('world-load placement is quiet, a due sweep respawn plays exactly one spawn sfx', async () => {
  const h = harness();
  const e = h.newEntry();
  const placed = await h.mgr.place(e, { quiet: true });
  assert.ok(placed, 'the boss is placed');
  assert.equal(spawnSfx(e).length, 0, 'world-load placement emits no spawn sfx');
  assert.equal('quietSpawn' in placed, false, 'quietSpawn is an input flag, never stored');

  kill(e, 'boss:w-1');
  h.mgr.onDeath(e, 'boss:w-1', null);
  e.world.creatures.sfx.length = 0;
  h.advance(600_000);
  assert.equal(await h.mgr.sweep(new Map([['w-1', e]])), 1);
  const spawns = spawnSfx(e);
  assert.equal(spawns.length, 1, 'a sweep respawn emits exactly one spawn sfx');
  assert.equal(spawns[0].a, 'c:boss:w-1');
  assert.equal('quietSpawn' in e.world.creatures.get('boss:w-1'), false, 'never stored on a respawn either');
});
