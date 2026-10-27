// backend/tests/enemy_aura_player_stats.test.js
// SOMET-606. A debuffed player walks slower and hits softer, and two
// overlapping auras respect the 0.5 floor in a REAL movement distance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World, weaponDamage } = require('../src/authority/world.js');

const map = () => ({ chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] });
const FROZEN = new Set();
const A = (name, over) => ({ name, targetSide: 'enemies', radius: 2000, damageMult: 1, defenseMult: 1,
  speedMult: 1, dotDps: 0, dotElement: 'physical', tickMs: 1000, ...over });

// Walk east for 1 s at 20 Hz; return the x distance covered.
function walk(auras) {
  const w = new World(map(), new Map(), null);
  w.addPlayer('u1', { x: 0, y: 0 });
  if (auras.length) w.creatures.addCreatures([{ id: 'S', type: 'T', x: 400, y: 400, hp: 100, faction: 'hostile', auras }]);
  w.tickCreatures(0.05, FROZEN);                 // stamp the debuff first
  const p = w.getPlayer('u1');
  const x0 = p.x;
  for (let i = 0; i < 20; i++) {
    w.setInput('u1', i + 1, 1, 0);
    w.tick(0.05);
    w.tickCreatures(0.05, FROZEN);
  }
  return p.x - x0;
}

test('no aura: 200 px/s (PLAYER_SPEED baseline, literal)', () => {
  assert.ok(Math.abs(walk([]) - 200) < 1e-6);
});

test('speed 0.6 aura: 120 px/s', () => {
  const d = walk([A('mire', { speedMult: 0.6 })]);
  assert.ok(Math.abs(d - 120) < 1e-6, `walked ${d}, expected 120`);
});

test('two different 0.6 auras: floored at 0.5 -> 100 px/s, not 72', () => {
  const d = walk([A('mire', { speedMult: 0.6 }), A('dread', { speedMult: 0.6 })]);
  assert.ok(Math.abs(d - 100) < 1e-6, `walked ${d}, expected 100`);
});

test('leaving the aura restores full speed on the next tick', () => {
  const w = new World(map(), new Map(), null);
  w.addPlayer('u1', { x: 0, y: 0 });
  w.creatures.addCreatures([{ id: 'S', type: 'T', x: 0, y: 0, hp: 100, faction: 'hostile', auras: [A('mire', { radius: 300, speedMult: 0.5 })] }]);
  w.tickCreatures(0.05, FROZEN);
  const p = w.getPlayer('u1');
  p.x = 5000;
  w.tickCreatures(0.05, FROZEN);                 // out of range now
  const x0 = p.x;
  w.setInput('u1', 1, 1, 0); w.tick(0.05);
  assert.ok(Math.abs(p.x - x0 - 10) < 1e-6, `moved ${p.x - x0}, expected 10 (200 * 0.05)`);
});

test('weaponDamage scales by the damage debuff', () => {
  const p = { stats: { meleeMult: 1, spellMult: 1, damageMult: null, rules: {} }, _buff: { damageMult: 0.7, defenseMult: 1, speedMult: 1, auras: [] } };
  const w = { kind: 'melee', damage: 10, element: null };
  assert.ok(Math.abs(weaponDamage(p, w) - 7) < 1e-9);
  delete p._buff;
  assert.equal(weaponDamage(p, w), 10, 'no _buff -> unchanged');
});

test('chill and an aura compose multiplicatively in the same speed read', () => {
  const { playerSpeedMult } = require('../src/authority/world.js');
  const { applyElementEffect } = require('../src/authority/effects.js');
  const p = { effects: new Map(), _buff: { damageMult: 1, defenseMult: 1, speedMult: 0.8, auras: [] } };
  assert.equal(playerSpeedMult(p, 0), 0.8);
  applyElementEffect(p, 'ice', 0, null);
  const chilled = playerSpeedMult(p, 1);
  assert.ok(chilled < 0.8 && chilled > 0, `chill must slow further: ${chilled}`);
});

// ---------------------------------------------------------------------------
// Skill damage (controller ruling Q2: LITERAL fixture values, not a measured,
// already-rounded number fed back into the expectation).
//
// war_crushing_blow: a single-hit melee skill. Its description says "180%",
// so castSkill's base is round(10 * 1.80 * 0.55) = round(9.9) = 10; with
// meleeMult 1 and a physical element multiplier of 1 that is 10 damage
// against a defense-0 target. Under a 0.5 damage debuff:
// max(2, round(10 * 0.5)) = 5.
// ---------------------------------------------------------------------------
function skillWorld() {
  const sword = { id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' };
  const w = new World({ isWalkable: () => true, width: 2000, height: 2000, decorations: [] },
    new Map([[sword.id, sword]]), sword.id);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100,
    strength: 100, dexterity: 100, constitution: 100, intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {},
    sources: Object.fromEntries(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']
      .map((k) => [k, { base: 100, tree: 0, gear: 0 }])),
  };
  w.addPlayer('u1', { x: 100, y: 100 }, { items: [], equipment: {} }, { x: 100, y: 100 }, 0, stats);
  const p = w.getPlayer('u1');
  p.stamina = 100;
  w.creatures.creatures.set('c1', {
    id: 'c1', name: 'Goblin', x: 140, y: 100, width: 48, height: 48, hp: 180, maxHp: 180,
    effects: new Map(), mit: { defense: 0, resists: {} },
  });
  return { w, p };
}

test('skill damage: crushing blow deals 10 unbuffed (literal fixture baseline)', () => {
  const { w } = skillWorld();
  assert.equal(w.castSkill('u1', 'war_crushing_blow', 140, 100, 1, 0).ok, true);
  assert.equal(180 - w.creatures.get('c1').hp, 10);
});

test('skill damage: a 0.5 damage debuff halves crushing blow to 5', () => {
  const { w, p } = skillWorld();
  p._buff = { damageMult: 0.5, defenseMult: 1, speedMult: 1, auras: [] };
  assert.equal(w.castSkill('u1', 'war_crushing_blow', 140, 100, 1, 0).ok, true);
  assert.equal(180 - w.creatures.get('c1').hp, 5);
});

// ---------------------------------------------------------------------------
// Stone bonus damage (controller ruling Q3): the debuff is on TOTAL outgoing
// damage, so an augment stone's bonus packet is reduced too. Sword 10 +
// ice augment 4 against a defense-0, no-resist target: 14 unbuffed; under a
// 0.6 debuff the sword packet is 6 and the bonus 2.4 -> 8.4, not 10.
// ---------------------------------------------------------------------------
const SWORD = {
  id: 1, name: 'sword', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.3,
  reach: 120, arc_width: 1.2, mana_cost: 0, stamina_cost: 0, element: null, stone_mode: 'replace',
};
const FROST_AUGMENT = {
  id: 10, name: 'stone_of_frost_edge', category: 'stone', stone_mode: 'augment',
  element: 'ice', bonus_damage: 4, damage: 0, cooldown: 0, mana_cost: 0,
};
function augmentedSwing(buff) {
  const w = new World(map(), new Map([[1, SWORD], [10, FROST_AUGMENT]]), 1);
  w.addPlayer('u1', { x: 100, y: 100 }, {
    items: [{ id: 'w1', typeId: 1, socketedStoneTypeId: 10, socketedStoneItemId: 'stone-1' }],
    equipment: { main_hand: 'w1' },
  });
  if (buff) w.getPlayer('u1')._buff = buff;
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
  w.creatures.get('c1').mit = { defense: 0, resistances: {} };
  w.attack('u1', 1, 0);
  return 500 - w.creatures.get('c1').hp;
}

test('stone bonus: sword 10 + augment 4 = 14 unbuffed (literal baseline)', () => {
  assert.ok(Math.abs(augmentedSwing(null) - 14) < 1e-9, `took ${augmentedSwing(null)}`);
});

test('stone bonus: a 0.6 damage debuff reduces the augment bonus too (8.4, not 10)', () => {
  const took = augmentedSwing({ damageMult: 0.6, defenseMult: 1, speedMult: 1, auras: [] });
  assert.ok(Math.abs(took - 8.4) < 1e-9, `took ${took}, expected 8.4 (6 sword + 2.4 bonus)`);
});
