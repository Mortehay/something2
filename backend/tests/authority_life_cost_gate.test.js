// SOMET-472. The GATE test: the pure arithmetic in life_cost.test.js proves
// nothing about whether a Cultist ever loses hp instead of mana. Everything
// here runs through the real World.canAttack / World.attack path.
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { derivePlayerStats } = require('../src/services/playerStats.js');

function stubMap() {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8, getChunk: () => [] };
}

// A staff with a SPELL STONE socketed, costing 20 mana. The stone is not
// decoration: since 1714440167000 a bare weapon's own mana_cost column is
// vestigial and activeWeaponType neutralises it to 0, so an unsocketed staff
// costs nothing and would prove nothing about a cost gate. This is the only
// arrangement in which a live player pays mana at all.
//
// 20 mana is AC5's stated case: ceil(20 * 0.6) = 12 hp at multiplier 1, and
// ceil(20 * 0.6 * 0.9) = 11 hp with the Cultist start node's grant. Both
// written out by hand here, so this file cannot agree with a broken
// lifeCostFor.
const STAFF = {
  id: 1, name: 'test staff', category: 'weapon', kind: 'projectile',
  damage: 10, cooldown: 0.55, range: 500, projectile_speed: 650,
  projectile_radius: 10, pierce: 1, mana_cost: 0, stamina_cost: 0, element: null,
};
const SPELL_STONE = {
  id: 40, name: 'stone_of_test', category: 'stone', stone_mode: 'replace',
  element: 'arcane', mana_cost: 20, damage: 10, cooldown: 0.55,
};
const TYPES = new Map([[1, STAFF], [40, SPELL_STONE]]);
const INV = {
  items: [{ id: 'i1', typeId: 1, socketedStoneTypeId: 40 }],
  equipment: { main_hand: 'i1' },
};

// `progression` here is the shape loadProgression returns -- the six stat
// columns plus composeStats' `rules`. Passing it through the REAL
// derivePlayerStats is deliberate: that is the only route by which a tree rule
// can reach the gate, so a bundle hand-built with a literal multiplier would
// prove nothing about the wiring.
function statsWithRules(rules) {
  return derivePlayerStats({
    experience: 0, level: 1, passive_points: 0,
    strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
    rules,
  });
}

function armed(usesLifeCost, hp, rules = undefined) {
  const w = new World(stubMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 }, INV, { x: 100, y: 100 }, 0,
    rules === undefined ? undefined : statsWithRules(rules), 1, null, null, usesLifeCost);
  const p = w.getPlayer('u1');
  p.hp = hp;
  return { w, p };
}

test('a cultist cast that would be lethal is refused AND costs nothing', () => {
  // AC1 + AC5: 12 hp against a 12 hp cost lands them on 0, and 11 hp cannot
  // pay a 12 hp cast at all.
  const { w, p } = armed(true, 11);
  const before = { hp: p.hp, mana: p.mana, stamina: p.stamina, cd: p._attackCd };

  assert.equal(w.canAttack('u1').ok, false,
    'the pre-check must refuse it too, or ammo is spent on a cast that never happens');
  const r = w.attack('u1', 1, 0);

  assert.deepEqual(r.kills, []);
  assert.equal(w.projectiles.count(), 0, 'a refused cast must not put a projectile in the air');
  assert.deepEqual(
    { hp: p.hp, mana: p.mana, stamina: p.stamina, cd: p._attackCd }, before,
    'a refused cast costs nothing: not life, not mana, not stamina, not the cooldown');
});

// AC2: the refusal has to be indistinguishable from the existing
// "not enough mana" refusal, or a client would have to learn a second shape.
test('a life refusal has the same shape as the existing mana refusal', () => {
  const life = armed(true, 11);
  const mana = armed(false, 100);
  mana.p.mana = 5;      // below the staff's 20

  const lifeCheck = life.w.canAttack('u1');
  const manaCheck = mana.w.canAttack('u1');
  assert.deepEqual(lifeCheck, manaCheck,
    'canAttack must answer identically for both refusals -- {ok:false, weapon}');
  assert.equal(lifeCheck.ok, false);
  assert.equal(lifeCheck.weapon.id, 1, 'the weapon still rides the refusal, as it always has');

  assert.deepEqual(life.w.attack('u1', 1, 0), mana.w.attack('u1', 1, 0));
  assert.deepEqual(life.w.attack('u1', 1, 0),
    { kills: [], attacks: [], impacts: [], stoneHit: null });
});

test('a cultist cast they can just afford is paid in life, never in mana', () => {
  const { w, p } = armed(true, 13);   // 13 - 12 = 1, the floor exactly
  const manaBefore = p.mana;
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 1);
  assert.equal(p.mana, manaBefore, 'a cultist never spends mana');
  assert.equal(w.projectiles.count(), 1);
});

// AC3. Asserted against a literal, not against `maxMana - w.mana_cost`.
test('the identical cast on a non-cultist is paid in mana, never in life', () => {
  const { w, p } = armed(false, 100);
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 100, 'a mana caster must not lose hp to their own spell');
  assert.equal(p.mana, 80, 'the default pool is 100 and the staff costs 20');
  assert.equal(w.projectiles.count(), 1);
});

test('a cultist with plenty of life casts repeatedly, paying 12 each time', () => {
  const { w, p } = armed(true, 100);
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 88);
  p._attackCd = 0;               // skip the cooldown; this test is about cost
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 76);
});

// AC5's second literal, and the whole reason lifeCostMultiplier is read from
// the composed tree rules rather than hardcoded: 20 * 0.6 * 0.9 = 10.8 -> 11.
test('the tree rule reaches the gate: the start node makes a 20-mana cast cost 11', () => {
  const { w, p } = armed(true, 100, { lifeCostMultiplier: 0.9 });
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 89);
});

test('a missing rules bundle degrades to no discount, not to a free cast', () => {
  const noRules = armed(true, 100, {});
  noRules.w.attack('u1', 1, 0);
  assert.equal(noRules.p.hp, 88, 'rules present but empty -> multiplier 1');

  const junkRules = armed(true, 100, { lifeCostMultiplier: null });
  junkRules.w.attack('u1', 1, 0);
  assert.equal(junkRules.p.hp, 88, 'a NULL multiplier -> multiplier 1');
});

test('a free weapon is unaffected for either class', () => {
  const FREE = new Map([[2, {
    id: 2, name: 'club', category: 'weapon', kind: 'melee',
    damage: 10, cooldown: 0.45, reach: 85, arc_width: 0.8,
    mana_cost: 0, stamina_cost: 2, element: null,
  }]]);
  const w = new World(stubMap(), FREE, 2);
  w.addPlayer('u1', { x: 100, y: 100 }, { items: [], equipment: {} }, { x: 100, y: 100 },
    0, undefined, 1, null, null, true);
  const p = w.getPlayer('u1');
  p.hp = 3;                      // below any life cost, but there is none
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 3);
  assert.equal(p.stamina, p.maxStamina - 2);
});

// The stamina refusal has to keep working for a Cultist: the life branch is
// reached only after stamina, and a class that could swing a stamina weapon it
// cannot afford would be a second gate by omission.
test('stamina still refuses a cultist independently of life', () => {
  const HEAVY = new Map([[3, {
    id: 3, name: 'maul', category: 'weapon', kind: 'melee',
    damage: 10, cooldown: 0.45, reach: 85, arc_width: 0.8,
    mana_cost: 0, stamina_cost: 40, element: null,
  }]]);
  const w = new World(stubMap(), HEAVY, 3);
  w.addPlayer('u1', { x: 100, y: 100 }, { items: [], equipment: {} }, { x: 100, y: 100 },
    0, undefined, 1, null, null, true);
  const p = w.getPlayer('u1');
  p.stamina = 10;
  const hpBefore = p.hp;
  assert.equal(w.canAttack('u1').ok, false);
  w.attack('u1', 1, 0);
  assert.equal(p.stamina, 10);
  assert.equal(p.hp, hpBefore, 'a stamina refusal must not bleed the cultist');
});

// usesLifeCost is join-supplied and must not be talked into existence by a
// truthy string off the wire.
test('usesLifeCost is a strict boolean on the player', () => {
  const w = new World(stubMap(), TYPES, 1);
  w.addPlayer('u1', { x: 0, y: 0 }, INV, { x: 0, y: 0 }, 0, undefined, 1, null, null, 'Cultist');
  assert.equal(w.getPlayer('u1').usesLifeCost, false);
  w.addPlayer('u2', { x: 0, y: 0 }, INV, { x: 0, y: 0 }, 0, undefined, 2, null, null);
  assert.equal(w.getPlayer('u2').usesLifeCost, false, 'the default is mana, for every existing caller');
});

// The gate must exist exactly once. Two hand-written copies is how a class
// ends up unable to fire but still losing an arrow.
test('there is ONE cost gate, not two', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/authority/world.js'), 'utf8');
  const body = src.split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const refusals = body.match(/resourceRefusal\(/g) || [];
  assert.equal(refusals.length, 3,
    'one definition plus exactly two call sites: canAttack and attack');
  const spends = body.match(/spendResources\(/g) || [];
  assert.equal(spends.length, 3,
    'one definition plus exactly two call sites: the melee branch and the projectile branch');
  assert.equal((body.match(/p\.mana -= /g) || []).length, 1,
    'mana is deducted in spendResources and nowhere else in this file');
});
