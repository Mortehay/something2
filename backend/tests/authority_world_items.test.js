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
