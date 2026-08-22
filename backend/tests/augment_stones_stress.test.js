// SOMET-332 / SOMET-343 validation stress pass.
//
// Deliberately adversarial: the cases a happy-path suite does not reach.
// Written during validation, not implementation — AC 7 in particular was
// shipped as "holds by construction but is not covered by a test", and this
// is that cover.

const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { activeWeaponType } = require('../src/authority/items.js');
const { stoneKind, isCompatible } = require('../src/services/stones.js');
const { ProjectileSim } = require('../src/authority/projectiles.js');

const SWORD = {
  id: 1, name: 'sword', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.3,
  reach: 120, arc_width: 1.2, mana_cost: 0, stamina_cost: 0, element: null, stone_mode: 'replace',
};
const AUG = {
  id: 10, name: 'frost_edge', category: 'stone', stone_mode: 'augment',
  element: 'ice', bonus_damage: 4, damage: 0, cooldown: 0, mana_cost: 0,
};
const TYPES = new Map([[1, SWORD], [10, AUG]]);

const inv = (stoneTypeId, stoneItemId = 's1') => ({
  items: [{ id: 'w1', typeId: 1, socketedStoneTypeId: stoneTypeId, socketedStoneItemId: stoneTypeId ? stoneItemId : null }],
  equipment: { main_hand: 'w1' },
});

// ---------------------------------------------------------------------------
// AC 7 — unsocketing removes the bonus
// ---------------------------------------------------------------------------

test('AC 7: an unsocketed weapon carries no augment', () => {
  // unsocketStone clears socketedStoneTypeId on the in-memory item; this is
  // the half that was never asserted — that combat then sees a plain weapon.
  const withStone = activeWeaponType(inv(10), TYPES, 1);
  assert.ok(withStone.augment, 'precondition: the socketed weapon IS augmented');

  const after = activeWeaponType(inv(null), TYPES, 1);
  assert.equal(after.augment, undefined, 'the bonus must be gone');
  assert.equal(after.stoneItemId ?? null, null, 'and so must the XP credit');
  assert.equal(after.damage, 10, "with the weapon's own damage intact");
});

test('AC 7: an unsocketed weapon deals exactly its own damage again', () => {
  const damageDealt = (stoneTypeId) => {
    const w = new World({ chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] }, TYPES, 1);
    w.addPlayer('u1', { x: 100, y: 100 }, inv(stoneTypeId));
    w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
    w.attack('u1', 1, 0);
    return 500 - w.creatures.get('c1').hp;
  };
  const augmented = damageDealt(10);
  const bare = damageDealt(null);
  assert.ok(augmented > bare, 'precondition: the augment did something');
  assert.equal(augmented - bare, 4, 'and removing it removes exactly the bonus');
});

// ---------------------------------------------------------------------------
// Adversarial input
// ---------------------------------------------------------------------------

test('a dangling socket (stone type missing from the catalog) is inert, not a crash', () => {
  // A catalog reload can drop a type an item still references.
  const w = activeWeaponType(inv(999), TYPES, 1);
  assert.equal(w.augment, undefined);
  assert.equal(w.damage, 10);
});

test('a zero or negative bonus never produces a rider', () => {
  for (const bad of [0, -5, null, undefined, NaN, 'four']) {
    const types = new Map(TYPES);
    types.set(11, { ...AUG, id: 11, bonus_damage: bad });
    const w = activeWeaponType(inv(11), types, 1);
    assert.equal(w.augment, undefined, `bonus_damage=${String(bad)} must not augment`);
  }
});

test('an augment with no element is not treated as one', () => {
  // The element is what the second damage packet is resisted as. Without one
  // there is nothing coherent to apply.
  const types = new Map(TYPES);
  types.set(12, { ...AUG, id: 12, element: null });
  assert.equal(activeWeaponType(inv(12), types, 1).augment, undefined);
});

test('an augment stone is never classified as a buff stone', () => {
  // stoneBonuses.js keys buff stones on stat_bonus_stat != null. An augment
  // leaking into that path would grant a phantom stat bonus.
  assert.equal(stoneKind(AUG), 'augment');
  assert.equal(AUG.stat_bonus_stat ?? null, null);
  assert.equal(isCompatible('augment', 'armor'), false, 'and it cannot ride armor');
});

test('an unequipped augmented weapon contributes nothing', () => {
  // The stone is socketed but the weapon is in the backpack. mitigation() and
  // socketedBuffStones both walk EQUIPPED slots only; the augment must too.
  const backpack = {
    items: [{ id: 'w1', typeId: 1, socketedStoneTypeId: 10, socketedStoneItemId: 's1' }],
    equipment: {},
  };
  const w = activeWeaponType(backpack, TYPES, 1);
  assert.equal(w.augment, undefined, 'nothing equipped -> falls back to the default weapon');
});

// ---------------------------------------------------------------------------
// Projectile edges (SOMET-343)
// ---------------------------------------------------------------------------

const WALK_ALL = { isWalkable: () => true };
const creaturesStub = (list) => {
  const byId = new Map(list.map((c) => [c.id, c]));
  return {
    forEachNear(_x, _y, _r, fn) { for (const c of byId.values()) fn(c); },
    all() { return [...byId.values()]; },
    get(id) { return byId.get(id); },
    damageCreatureById(id, dmg) {
      const c = byId.get(id);
      if (!c) return false;
      c.hp -= dmg;
      if (c.hp <= 0) { byId.delete(id); return true; }
      return false;
    },
  };
};

test('a shot whose augment has a junk bonus behaves as unaugmented', () => {
  const bow = { damage: 10, range: 700, projectile_speed: 100, projectile_radius: 8, pierce: 1, element: null };
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...bow, augment: { element: 'ice', bonusDamage: 0 } } });
  const target = { userId: 'u2', x: 0, y: -32, width: 64, height: 64, hp: 100, maxHp: 100 };
  target.x = 32 - 32;
  sim.step(1, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(target.hp, 90, 'weapon damage only');
});

test('ammo cannot resurrect a detonation on a weapon that has none', () => {
  // Guards the merge direction: ammo with a NULL aoe must not turn into 0 or
  // otherwise flip a non-detonating shot into a detonating one.
  const bow = { damage: 10, range: 40, projectile_speed: 100, projectile_radius: 8, pierce: 1, element: null };
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: bow, ammo: { name: 'arrow', aoe_radius: null } });
  const r = sim.step(1, { creatures: creaturesStub([]), players: [], map: WALK_ALL });
  assert.equal(r.detonations.length, 0);
});
