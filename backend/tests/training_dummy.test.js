const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const dummyMod = require('../src/authority/trainingDummy.js');

function boot({ isEntry = true } = {}) {
  const map = { isWalkable: () => true, width: 2000, height: 2000, decorations: [] };
  const sword = { id: 7, name: 'sword', category: 'weapon', kind: 'melee', damage: 40, cooldown: 0.5, reach: 90 };
  const world = new World(map, new Map([[7, sword]]), 7);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100, strength: 100, dexterity: 100, constitution: 100,
    intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {}, sources: {},
  };
  const inv = { items: [{ id: 'w1', typeId: 7 }], equipment: { main_hand: 'w1' } };
  world.addPlayer('u1', { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, stats);
  const entry = { worldId: 'w-1', world, row: { is_entry: isEntry, entry_spawn: { x: 100, y: 100 } } };
  return { world, entry, player: world.getPlayer('u1') };
}

test('placed once, only in an entry world, and never persisted or pruned', () => {
  const { entry, world } = boot();
  const d = dummyMod.placeDummy(entry);
  assert.ok(d && d.isDummy);
  assert.strictEqual(dummyMod.placeDummy(entry), d, 'idempotent');
  assert.strictEqual(world.creatures.getDirty().length, 0);
  d.dirty = true;
  assert.strictEqual(world.creatures.getDirty().length, 0, 'no world_creatures row to write');
  assert.strictEqual(world.creatures.pruneInactive(new Set()), 0);
  assert.ok(world.creatures.get(d.id));
  assert.strictEqual(dummyMod.placeDummy(boot({ isEntry: false }).entry), null);
});

test('it takes player damage without losing hp, and counts it', () => {
  const { entry, world } = boot();
  const d = dummyMod.placeDummy(entry);
  d.x = 140; d.y = 100;
  const res = world.castSkill('u1', 'war_crushing_blow', 140, 100, 1, 0);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(d.hp, d.maxHp, 'hp restored');
  const s = d.sessions.get('u1');
  assert.ok(s && s.hits >= 1 && s.total > 0);
  assert.ok(world.creatures.get(d.id), 'still standing');
});

test('stats: dps window, average, max, and a session resets after a pause', () => {
  const dummy = { isDummy: true };
  dummyMod.recordHit(dummy, 10, 'a', 1000);
  dummyMod.recordHit(dummy, 30, 'a', 2000);
  let st = dummyMod.sessionStats(dummy.sessions.get('a'), 2000);
  assert.strictEqual(st.total, 40);
  assert.strictEqual(st.hits, 2);
  assert.strictEqual(st.max, 30);
  assert.strictEqual(st.dps, 40, '40 damage over the 1s elapsed (min window 1s)');
  assert.deepStrictEqual(dummyMod.liveSessions(dummy, 2500).map(([u]) => u), ['a']);
  assert.deepStrictEqual(dummyMod.liveSessions(dummy, 2000 + dummyMod.IDLE_RESET_MS + 1), []);
  dummyMod.recordHit(dummy, 5, 'a', 2000 + dummyMod.IDLE_RESET_MS + 100);
  st = dummyMod.sessionStats(dummy.sessions.get('a'), 2000 + dummyMod.IDLE_RESET_MS + 100);
  assert.strictEqual(st.total, 5, 'a pause starts a fresh session');
  // old hits leave the 5s window
  const d2 = { isDummy: true };
  dummyMod.recordHit(d2, 100, 'b', 0);
  dummyMod.recordHit(d2, 50, 'b', 5500);
  assert.strictEqual(dummyMod.sessionStats(d2.sessions.get('b'), 5500).dps, Math.round(50 / 5));
});

test('hits from non-players are ignored and a second attacker has their own session', () => {
  const { applyDamage } = require('../src/authority/damage.js');
  const dummy = { isDummy: true, hp: 10, maxHp: 10 };
  applyDamage(dummy, 99, 'physical', undefined, 1000, 'c:wolf');
  assert.ok(!dummy.sessions);
  applyDamage(dummy, 20, 'physical', undefined, 1000, 'p:u1');
  applyDamage(dummy, 30, 'physical', undefined, 1000, 'p:u2');
  assert.strictEqual(dummy.sessions.size, 2);
  assert.strictEqual(dummy.hp, 10);
});
