// The Spire boss fixes: scaling with the floor, a late arrival's early respawn, a
// checkpoint that no longer holds the boss hostage, escorts that survive a world
// reload at their floor's level, phase adds, and a gate that opens when no boss
// could be placed. All against the real DungeonBossManager and CreatureSim.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DungeonBossManager } = require('../src/authority/dungeonBosses.js');
const { CreatureSim } = require('../src/authority/creatures.js');
const { scaleCreature } = require('../src/services/creatureLevel.js');
const { createBossController } = require('../src/authority/bossAI.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const ROW = {
  id: 77, name: 'zzElite', hp: 850, max_hp: 850, defense: 15, faction: 'hostile',
  boss_tier: 'dungeon_end', element: 'fire', hitbox_size: 80, base_damage: 20, aura_names: null, aura_defs: null,
};
const MINION = {
  id: 88, name: 'Fire Elemental Guard', hp: 60, max_hp: 60, defense: 4, faction: 'hostile',
  boss_tier: null, element: 'fire', hitbox_size: 40, base_damage: 10, aura_names: null, aura_defs: null,
};
const SPEC = { entity: 'zzElite', x: 1150, y: 1250, respawn_s: 1800 };

function harness({ spec = SPEC, row = ROW, levelMin = 30, levelMax = 34 } = {}) {
  let now = 1_000_000;
  const mgr = new DungeonBossManager({
    loadRow: async (n) => (n === row.name ? row : null),
    loadMinionRow: async (n) => (n === MINION.name ? MINION : null),
    clock: () => now,
    onKilled: () => {},
    log: { warn: () => {}, error: () => {} },
  });
  const entry = () => ({
    worldId: 'w-1',
    row: { dungeon_boss: spec, level_min: levelMin, level_max: levelMax },
    world: { creatures: new CreatureSim(stubMap(), () => 0.05) },
  });
  return { mgr, entry, advance: (ms) => { now += ms; } };
}
const kill = (e, id) => e.world.creatures._removeKilled(e.world.creatures.get(id));
const escorts = (e) => e.world.creatures.all().filter((c) => /^dminion:w-1:\d+$/.test(c.id));
const adds = (e) => e.world.creatures.all().filter((c) => /^dminion:w-1:add/.test(c.id));

test('a boss is scaled to its floor like any creature, not left at its catalogue stats', async () => {
  const h = harness();
  const e = h.entry();
  const c = await h.mgr.place(e);
  const want = scaleCreature({ hp: 850, damage: 20, defense: 15 }, c.level);
  assert.ok(c.level >= 30);
  assert.equal(c.hp, want.hp);
  assert.ok(c.hp > 850 * 4, 'a level-34 boss is far tougher than the level-1 row');
  assert.equal(c.damage, want.damage);
  assert.equal(c.mit.defense, want.defense);
});

test('the same boss on a deeper floor is stronger than on a shallow one', async () => {
  const shallow = harness({ levelMin: 10, levelMax: 14 });
  const deep = harness({ levelMin: 90, levelMax: 94 });
  const a = await shallow.mgr.place(shallow.entry());
  const b = await deep.mgr.place(deep.entry());
  assert.ok(b.hp > a.hp * 3);
});

test('a world-tier boss is NOT scaled: bossBalance tunes it by hand', async () => {
  const row = { ...ROW, name: 'zzWorld', boss_tier: 'world', hp: 450000, max_hp: 450000 };
  const h = harness({ row, spec: { ...SPEC, entity: 'zzWorld' }, levelMin: 120, levelMax: 124 });
  const c = await h.mgr.place(h.entry());
  assert.equal(c.hp, 450000);
});

test('escorts are scaled too, and come back at the same level and strength', async () => {
  const h = harness();
  const e = h.entry();
  await h.mgr.place(e);
  const [m0] = escorts(e);
  const want = scaleCreature({ hp: 60, damage: 10, defense: 4 }, m0.level);
  assert.equal(m0.hp, want.hp);
  assert.ok(m0.level >= 30);
  kill(e, m0.id);
  h.mgr.onMinionDeath(e, m0.id);
  h.advance(25_000);
  await h.mgr.sweep(new Map([['w-1', e]]));
  const back = e.world.creatures.get(m0.id);
  assert.ok(back, 'respawned');
  assert.equal(back.level, m0.level);
  assert.equal(back.hp, m0.hp);
});

test('escorts survive the world being evicted and loaded again', async () => {
  const h = harness();
  const e1 = h.entry();
  await h.mgr.place(e1);
  assert.equal(escorts(e1).length, 2);
  const e2 = h.entry();                      // same world id, a fresh sim: the old one is gone
  await h.mgr.place(e2);
  assert.equal(escorts(e2).length, 2, 'the new sim gets its escorts back');
  await h.mgr.place(e2);
  assert.equal(escorts(e2).length, 2, 'and a repeat placement does not double them');
});

test('an escort does not respawn while its boss is dead', async () => {
  const h = harness();
  const e = h.entry();
  await h.mgr.place(e);
  const m = escorts(e)[0];
  kill(e, m.id); h.mgr.onMinionDeath(e, m.id);
  kill(e, 'boss:w-1'); h.mgr.onDeath(e, 'boss:w-1', null);
  h.advance(60_000);
  assert.equal(await h.mgr.sweep(new Map([['w-1', e]])), 0);
  assert.equal(escorts(e).length, 1, 'only the other escort stands');
});

// ---- the respawn rules ------------------------------------------------------

test('a player standing at the checkpoint (300px from the post) no longer holds the boss back', async () => {
  const h = harness();
  const e = h.entry();
  await h.mgr.place(e);
  kill(e, 'boss:w-1'); h.mgr.onDeath(e, 'boss:w-1', null);
  h.advance(1_800_000);
  const atCheckpoint = () => [{ x: 1150 - 300, y: 1250 }];
  assert.equal(await h.mgr.sweep(new Map([['w-1', e]]), atCheckpoint), 1);
});

test('but someone standing ON the post still blocks it', async () => {
  const h = harness();
  const e = h.entry();
  await h.mgr.place(e);
  kill(e, 'boss:w-1'); h.mgr.onDeath(e, 'boss:w-1', null);
  h.advance(1_800_000);
  assert.equal(await h.mgr.sweep(new Map([['w-1', e]]), () => [{ x: 1150 + 100, y: 1250 }]), 0);
});

test('a player who still needs the boss brings it back 30s after the kill, not after 30 minutes', async () => {
  const h = harness();
  const e = h.entry();
  const worlds = new Map([['w-1', e]]);
  await h.mgr.place(e);
  kill(e, 'boss:w-1'); h.mgr.onDeath(e, 'boss:w-1', null);
  h.advance(20_000);
  assert.equal(await h.mgr.sweep(worlds, () => [], () => true), 0, 'not before 30s');
  h.advance(11_000);
  assert.equal(await h.mgr.sweep(worlds, () => [], () => false), 0, 'nobody needs it: the normal timer applies');
  assert.equal(await h.mgr.sweep(worlds, () => [], () => true), 1, 'someone does: it is back');
  assert.ok(e.world.creatures.get('boss:w-1'));
});

test('hasBoss: true once placed, false when the placement was refused', async () => {
  const ok = harness();
  await ok.mgr.place(ok.entry());
  assert.equal(ok.mgr.hasBoss('w-1'), true);
  const bad = harness({ spec: { entity: 'nope', x: 1, y: 1, respawn_s: 60 } });
  await bad.mgr.place(bad.entry());
  assert.equal(bad.mgr.hasBoss('w-1'), false, 'a gate behind a boss that never existed must not stay shut');
  const malformed = harness({ spec: { entity: 5 } });
  await malformed.mgr.place(malformed.entry());
  assert.equal(malformed.mgr.hasBoss('w-1'), false);
});

// ---- phase adds -----------------------------------------------------------------

test('a placed boss has a controller, and its phase change spawns scaled adds around it', async () => {
  const h = harness();
  const e = h.entry();
  const phases = [];
  h.mgr.onPhase = (_entry, evt) => phases.push(evt);
  const c = await h.mgr.place(e);
  assert.ok(c.bossAI, 'controller attached');
  c.hp = c.maxHp * 0.74;
  c.bossAI.tick(c, { now: 5000 });
  assert.equal(adds(e).length, 2);
  assert.equal(adds(e)[0].level, c.level);
  assert.ok(adds(e)[0].hp > 60, 'scaled');
  assert.equal(phases[0].boss, 'zzElite');
  assert.equal(phases[0].phase, 2);
});

test('adds are capped, count as minions for the death router, and vanish with the boss', async () => {
  const h = harness();
  const e = h.entry();
  const c = await h.mgr.place(e);
  const rec = h.mgr.records.get('w-1');
  for (let i = 0; i < 5; i += 1) h.mgr._spawnAdds(e, 'w-1', rec, { adds: 3, x: 1150, y: 1250 });
  assert.equal(adds(e).length, 6, 'never more than MAX_LIVE_ADDS');
  const one = adds(e)[0].id;
  assert.equal(h.mgr.isMinion('w-1', one), true, 'routed as a minion, never to the uuid DELETE');
  kill(e, one);
  assert.equal(h.mgr.onMinionDeath(e, one), true);
  assert.equal(adds(e).length, 5);
  kill(e, c.id); h.mgr.onDeath(e, c.id, 'u1');
  assert.equal(adds(e).length, 0, 'they die with their master');
});

test('the kill record carries who hurt the boss', async () => {
  const h = harness();
  const e = h.entry();
  const c = await h.mgr.place(e);
  c._playerDamage = new Map([['7', 100], ['8', 20]]);
  kill(e, c.id);
  const k = h.mgr.onDeath(e, c.id, '7');
  assert.deepEqual([...k.damagedBy.keys()].sort(), ['7', '8']);
});

test('a boss controller seeded from the world id is deterministic', () => {
  const a = createBossController({ name: 'x', boss_tier: 'dungeon_end' }, { seed: 'w-1' });
  const b = createBossController({ name: 'x', boss_tier: 'dungeon_end' }, { seed: 'w-1' });
  const c = { hp: 100, maxHp: 100, _skillCd: new Map() };
  const seqA = []; const seqB = [];
  for (let i = 0; i < 10; i += 1) {
    a.nextAttackAt = 0; b.nextAttackAt = 0;
    seqA.push(a.pick(c, 100, 0).name); seqB.push(b.pick(c, 100, 0).name);
  }
  assert.deepEqual(seqA, seqB);
});
