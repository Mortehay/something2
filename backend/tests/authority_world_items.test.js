const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');

const TYPES = new Map([
  [1, { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
        damage: 10, cooldown: 0.3, reach: 200, arc_width: 3.0, mana_cost: 0, element: null, defense: 0, resistances: {} }],
  [3, { id: 3, name: 'bow', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'projectile',
        damage: 10, cooldown: 0.05, range: 2000, projectile_speed: 4000, projectile_radius: 40, pierce: 1,
        mana_cost: 0, element: null, defense: 0, resistances: {} }],
  [5, { id: 5, name: 'leather-vest', category: 'armor', slot: 'chest', two_handed: false,
        defense: 4, resistances: {}, damage: 0, cooldown: 0, mana_cost: 0, element: null }],
]);

function armWorld() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return new World(map, TYPES, 1);
}
const emptyInv = () => ({ items: [], equipment: {} });
const armoredInv = () => ({ items: [{ id: 'a5', typeId: 5 }], equipment: { chest: 'a5' } });

test('a player with no equipment uses the default weapon', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  assert.equal(w.activeWeapon('u1').id, 1);
});

test('main_hand equipment determines the active weapon', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, { items: [{ id: 'b3', typeId: 3 }], equipment: { main_hand: 'b3' } });
  assert.equal(w.activeWeapon('u1').id, 3);
});

test('MELEE player damage is mitigated by the target armor', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, emptyInv());      // attacker, dagger dmg 10
  w.addPlayer('u2', { x: 150, y: 100 }, armoredInv());    // defender, chest defense 4
  const before = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.equal(before - w.getPlayer('u2').hp, 6, '10 raw - 4 defense');
});

test('PROJECTILE player damage is mitigated by the SAME path (paths must not drift)', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, { items: [{ id: 'b3', typeId: 3 }], equipment: { main_hand: 'b3' } });
  w.addPlayer('u2', { x: 200, y: -32 }, armoredInv());    // center (232,0); attacker center (32,32)
  // aim from u1 center toward u2 center
  const p = w.getPlayer('u1'), q = w.getPlayer('u2');
  const ax = (q.x + q.width / 2) - (p.x + p.width / 2);
  const ay = (q.y + q.height / 2) - (p.y + p.height / 2);
  const before = q.hp;
  w.attack('u1', ax, ay);
  for (let i = 0; i < 30 && q.hp === before; i++) w.tickProjectiles(0.02);
  assert.equal(before - q.hp, 6, 'bow 10 raw - 4 defense, same mitigation as melee');
});

test('snapshot exposes each player equipment map', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, armoredInv());
  const pl = w.snapshot().players[0];
  assert.deepEqual(pl.equipment, { chest: 'a5' });
  assert.equal(pl.weaponId, undefined, 'weaponId is retired');
});

// F1: autoLoot must ride the same wire snapshot as hp/mana/equipment so the
// client mirror can be corrected every tick instead of only agreeing with the
// server by luck of topology (initChunked happening to reset both to false).
test('snapshot exposes autoLoot, and it reflects setAutoLoot', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  assert.strictEqual(w.snapshot().players[0].autoLoot, false, 'addPlayer defaults to false');

  w.setAutoLoot('u1', true);
  assert.strictEqual(w.snapshot().players[0].autoLoot, true, 'snapshot reflects setAutoLoot(true)');

  w.setAutoLoot('u1', false);
  assert.strictEqual(w.snapshot().players[0].autoLoot, false, 'snapshot reflects setAutoLoot(false)');

  // Strict boolean coercion (setAutoLoot's own contract) must survive the
  // round trip through snapshot() too — a truthy string must not read as on.
  w.setAutoLoot('u1', 'true');
  assert.strictEqual(w.snapshot().players[0].autoLoot, false, 'truthy non-boolean must not enable it');
});

function fakePool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

test('setEquipment recomputes mitigation on success', async () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  w.addPlayer('u2', { x: 150, y: 100 }, { items: [{ id: 'a5', typeId: 5 }], equipment: {} });

  // First attack: no armor, should deal 10 damage
  const before1 = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  const damage1 = before1 - w.getPlayer('u2').hp;
  assert.equal(damage1, 10, 'first hit should deal full 10 damage (no armor)');

  // Equip the vest
  const pool = fakePool();
  const r = await w.setEquipment(pool, 'u2', 'a5', 'chest');
  assert.equal(r.ok, true);
  assert.equal(w.getPlayer('u2').mit.defense, 4, 'mitigation should be recomputed after successful equip');

  // Second attack: with armor, should deal 6 damage
  w.getPlayer('u1')._attackCd = 0;
  const before2 = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  const damage2 = before2 - w.getPlayer('u2').hp;
  assert.equal(damage2, 6, 'second hit should deal 6 damage (10 - 4 defense)');
});

test('setEquipment with an unowned item is a no-op', async () => {
  const w = armWorld();
  w.addPlayer('u2', { x: 150, y: 100 }, { items: [], equipment: {} });

  const pool = fakePool();
  const r = await w.setEquipment(pool, 'u2', 'ghost-item', 'chest');

  assert.equal(r.ok, false, 'should reject unowned item');
  assert.equal(w.getPlayer('u2').inv.equipment.chest, undefined, 'chest should remain unequipped');
  assert.equal(w.getPlayer('u2').mit.defense, 0, 'mitigation should remain zero');

  const insertCalls = pool.calls.filter((c) => c.sql.includes('INSERT INTO player_equipment'));
  assert.equal(insertCalls.length, 0, 'no INSERT calls should be made for rejected equip');
});

test('clearEquipment recomputes mitigation', async () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  w.addPlayer('u2', { x: 150, y: 100 }, armoredInv());

  // Confirm mitigation is active (defense 4)
  assert.equal(w.getPlayer('u2').mit.defense, 4, 'defender should start with 4 defense');

  // First attack: with armor, should deal 6 damage
  const before1 = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  const damage1 = before1 - w.getPlayer('u2').hp;
  assert.equal(damage1, 6, 'first hit should deal 6 damage (with armor)');

  // Clear the equipment
  const pool = fakePool();
  const r = await w.clearEquipment(pool, 'u2', 'chest');
  assert.equal(r.ok, true);
  assert.equal(w.getPlayer('u2').mit.defense, 0, 'mitigation should be recomputed after clear');

  // Second attack: no armor, should deal 10 damage
  w.getPlayer('u1')._attackCd = 0;
  const before2 = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  const damage2 = before2 - w.getPlayer('u2').hp;
  assert.equal(damage2, 10, 'second hit should deal full 10 damage (armor cleared)');
});
