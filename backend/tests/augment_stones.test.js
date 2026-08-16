// SOMET-332 slice C: augment stones — a socketed stone that ADDS to the weapon
// it sits in, rather than replacing that weapon's spell.

const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { activeWeaponType } = require('../src/authority/items.js');
const { stoneKind, isCompatible } = require('../src/services/stones.js');

const SWORD = {
  id: 1, name: 'sword', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.3,
  reach: 120, arc_width: 1.2, mana_cost: 0, stamina_cost: 0, element: null, stone_mode: 'replace',
};
const BOW = {
  id: 2, name: 'bow', category: 'weapon', kind: 'projectile', damage: 10, cooldown: 0.3,
  range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0,
  element: null, stone_mode: 'replace',
};
const FROST_AUGMENT = {
  id: 10, name: 'stone_of_frost_edge', category: 'stone', stone_mode: 'augment',
  element: 'ice', bonus_damage: 4, damage: 0, cooldown: 0, mana_cost: 0,
};
const SPELL_STONE = {
  id: 11, name: 'stone_of_fire', category: 'stone', stone_mode: 'replace',
  element: 'fire', damage: 20, cooldown: 0.9, mana_cost: 12,
};

const TYPES = new Map([[1, SWORD], [2, BOW], [10, FROST_AUGMENT], [11, SPELL_STONE]]);

// An inventory with `stoneId` socketed into the equipped main-hand weapon.
function inv(weaponTypeId, stoneTypeId = null, stoneItemId = 'stone-1') {
  return {
    items: [{
      id: 'w1',
      typeId: weaponTypeId,
      socketedStoneTypeId: stoneTypeId,
      socketedStoneItemId: stoneTypeId ? stoneItemId : null,
    }],
    equipment: { main_hand: 'w1' },
  };
}

// ---------------------------------------------------------------------------
// activeWeaponType: augment must NOT take the replace path
// ---------------------------------------------------------------------------

test('an augment stone leaves the host weapon spell fields alone', () => {
  // AC 2. The replace branch overwrites damage/cooldown/mana_cost/element --
  // an augment doing that would turn a sword into a wand, which is the exact
  // behaviour this slice exists to avoid.
  const w = activeWeaponType(inv(1, 10), TYPES, 1);
  assert.equal(w.damage, 10, "the sword's own damage");
  assert.equal(w.cooldown, 0.3);
  assert.equal(w.mana_cost, 0, 'an augment must not impose a mana cost');
  assert.equal(w.element, null, "the weapon's own element, not the stone's");
  assert.equal(w.kind, 'melee');
});

test('the augment rider is exposed separately from the weapon', () => {
  const w = activeWeaponType(inv(1, 10), TYPES, 1);
  assert.deepEqual(w.augment, { element: 'ice', bonusDamage: 4, impactBehaviorId: null });
});

test('a REPLACE stone still replaces, exactly as before', () => {
  // AC 1: no existing stone changes behaviour.
  const w = activeWeaponType(inv(1, 11), TYPES, 1);
  assert.equal(w.damage, 20, "the stone's spell damage");
  assert.equal(w.element, 'fire');
  assert.equal(w.mana_cost, 12);
  assert.equal(w.augment, undefined, 'a replace stone must expose no augment rider');
});

test('TRAP 1: an augment stone carries stoneItemId, or it never gains XP', () => {
  // world.js gates stone XP on `w.stoneItemId != null`. Before this slice only
  // the replace branch set it, so an augment stone would have landed every hit
  // and levelled never -- with nothing failing loudly. This is the assertion
  // that would have caught it.
  const w = activeWeaponType(inv(1, 10, 'stone-42'), TYPES, 1);
  assert.equal(w.stoneItemId, 'stone-42');
});

test('an augment with no bonus damage is ignored rather than half-applied', () => {
  // The DB constraint forbids it, but the catalog is also fed by fixtures and
  // by snapshots predating the column. A zero bonus must not produce a rider
  // that adds nothing while still claiming the weapon is augmented.
  const types = new Map(TYPES);
  types.set(12, { ...FROST_AUGMENT, id: 12, bonus_damage: null });
  const w = activeWeaponType(inv(1, 12), types, 1);
  assert.equal(w.augment, undefined);
});

test('a stone whose mode is missing entirely falls back to replace', () => {
  // stone_mode is NOT NULL in the schema, so `undefined` here means a fixture
  // or a stale catalog -- and falling through to the AUGMENT branch would let
  // an old spell stone silently stop replacing.
  const types = new Map(TYPES);
  types.set(13, { id: 13, name: 's', category: 'stone', element: 'fire', damage: 7, cooldown: 1, mana_cost: 3 });
  const w = activeWeaponType(inv(1, 13), types, 1);
  assert.equal(w.damage, 7, 'took the replace path');
  assert.equal(w.augment, undefined);
});

// ---------------------------------------------------------------------------
// Socket compatibility
// ---------------------------------------------------------------------------

test('an augment stone classifies as its own kind, not as a spell stone', () => {
  assert.equal(stoneKind(FROST_AUGMENT), 'augment');
  assert.equal(stoneKind(SPELL_STONE), 'spell');
  assert.equal(stoneKind({ element: null, stat_bonus_stat: 'strength' }), 'buff');
});

test('an augment stone is refused by a projectile weapon, not silently inert', () => {
  // DELIBERATE LIMITATION, pinned so it cannot rot: the bonus packet is
  // applied on the melee paths only. Accepting the socket and adding nothing
  // is the silent-inertness failure this epic exists to remove.
  //
  // When projectiles.js starts applying the packet, THIS test fails and is the
  // reminder to lift the restriction.
  assert.equal(isCompatible('augment', 'weapon', 'melee'), true);
  assert.equal(isCompatible('augment', 'weapon', 'projectile'), false);
  assert.equal(isCompatible('augment', 'armor', null), false);
  // The other two kinds are untouched by the new argument.
  assert.equal(isCompatible('spell', 'weapon'), true);
  assert.equal(isCompatible('buff', 'armor'), true);
  assert.equal(isCompatible('buff', 'weapon'), true);
});

// ---------------------------------------------------------------------------
// Damage: two packets, through the real World
// ---------------------------------------------------------------------------

function armWorld() {
  return new World(
    { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] },
    TYPES, 1,
  );
}

test('AC 2: the augment adds its bonus on top of the weapon damage', () => {
  const plain = armWorld();
  plain.addPlayer('u1', { x: 100, y: 100 }, inv(1));
  plain.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
  plain.attack('u1', 1, 0);
  const plainHp = plain.creatures.get('c1').hp;

  const augmented = armWorld();
  augmented.addPlayer('u1', { x: 100, y: 100 }, inv(1, 10));
  augmented.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
  augmented.attack('u1', 1, 0);
  const augHp = augmented.creatures.get('c1').hp;

  assert.ok(augHp < plainHp,
    `augmented swing must hurt more: plain left ${plainHp}, augmented left ${augHp}`);
});

test('AC 3: the bonus is resisted as its OWN element, not the weapon\'s', () => {
  // The whole reason for two packets, and the assertion a blended packet
  // cannot pass. The sword is physical and the augment is ice, so:
  //   * an ICE-resistant target must shrug off part of the BONUS;
  //   * a FIRE-resistant target must not, because nothing in this swing is
  //     fire — its resistance is irrelevant.
  // Blending the two into one packet would make BOTH targets resist (or
  // neither), because the blend would carry a single element.
  //
  // Framed as a comparison rather than an exact number because RESIST_CAP
  // (0.8) means nothing is ever fully immune — an exact-value assertion here
  // would be pinned to that constant rather than to the behaviour.
  const swingAgainst = (resistances) => {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, inv(1, 10));
    w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
    w.creatures.get('c1').mit = { defense: 0, resistances };
    w.attack('u1', 1, 0);
    return 500 - w.creatures.get('c1').hp;      // damage actually taken
  };

  const vsIce = swingAgainst({ ice: 0.8 });
  const vsFire = swingAgainst({ fire: 0.8 });
  const vsNothing = swingAgainst({});

  assert.equal(vsFire, vsNothing,
    'a fire resistance must not blunt an ICE augment on a PHYSICAL sword');
  assert.ok(vsIce < vsNothing,
    `an ice resistance must blunt the ice bonus: took ${vsIce} vs ${vsNothing}`);
  // ...and only the BONUS, never the sword's own physical damage.
  const bonusLost = vsNothing - vsIce;
  assert.ok(bonusLost <= 4,
    `only the 4-point bonus may be resisted, but ${bonusLost} damage was lost`);
});

test('AC 4: a landed augment swing awards stone XP', () => {
  // The observable half of trap 1, through the real attack path.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(1, 10, 'stone-7'));
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
  const { stoneHit } = w.attack('u1', 1, 0);
  assert.deepEqual(stoneHit, { stoneItemId: 'stone-7' });
});

test('a MISSED augment swing awards no stone XP', () => {
  // stoneHit is gated on `landed` as well as on the id; an augment must not
  // have widened that.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(1, 10, 'stone-7'));
  assert.equal(w.attack('u1', 1, 0).stoneHit, null);
});

test('a creature finished off by the BONUS is still reported as killed once', () => {
  // The reason both packets are applied inside applyMeleeArc's single loop: a
  // second pass would either miss a kill the bonus made (target already gone)
  // or report it twice.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(1, 10));
  // hp between the weapon's 10 and the augmented 14, so ONLY the bonus kills.
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 12, facing: 'S', color: '#f00' }]);
  const { kills } = w.attack('u1', 1, 0);
  assert.deepEqual(kills, [{ id: 'c1', killerUserId: 'u1' }]);
  assert.equal(w.creatures.get('c1'), undefined, 'and it is gone from the sim');
});
