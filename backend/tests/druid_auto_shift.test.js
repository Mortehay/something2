// A Druid does not press the form button first: a skill of another form shifts to it, a spell
// shifts back to human, and it is all part of the one paid cast.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/authority/world.js');
const balance = require('../src/authority/skillBalance.js');

function setup() {
  const map = { isWalkable: () => true, width: 2000, height: 2000, decorations: [] };
  const sword = { id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' };
  const w = new World(map, new Map([[sword.id, sword]]), sword.id);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100,
    strength: 100, dexterity: 100, constitution: 100, intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {}, sources: {},
  };
  w.addPlayer('u1', { x: 100, y: 100 }, { items: [], equipment: {} }, { x: 100, y: 100 }, 0, stats);
  const p = w.getPlayer('u1');
  p.maxHp = 1000; p.hp = 1000; p.maxMana = 500; p.mana = 500; p.stamina = 100; p.maxStamina = 100;
  return { w, p };
}

test('a wolf skill from human form puts the Druid in wolf form', () => {
  const { w, p } = setup();
  assert.equal(balance.activeForm(p), null);
  const r = w.castSkill('u1', 'dru_wolf_rend', 100, 100, 1, 0);
  assert.notEqual(r.reason, 'form');
  assert.equal(r.ok, true);
  assert.equal(balance.activeForm(p), 'wolf');
});

test('a bear skill from wolf form swaps to bear form', () => {
  const { w, p } = setup();
  w.castSkill('u1', 'dru_wolf_form', 100, 100, 1, 0);
  assert.equal(balance.activeForm(p), 'wolf');
  const r = w.castSkill('u1', 'dru_bear_slam', 100, 100, 1, 0);
  assert.equal(r.ok, true);
  assert.equal(balance.activeForm(p), 'bear');
  assert.equal([...p.buffs.values()].filter((b) => b.fx && b.fx.form).length, 1);
});

test('a spell cast in a form keeps the form (and is cast at reduced power)', () => {
  const { w, p } = setup();
  w.castSkill('u1', 'dru_bear_form', 100, 100, 1, 0);
  assert.equal(balance.activeForm(p), 'bear');
  p.inv.equipment.main_hand = { id: 'w1', name: 'wand', category: 'weapon', kind: 'projectile', damage: 5 };
  const r = w.castSkill('u1', 'dru_moonfire', 100, 100, 1, 0);
  assert.equal(r.ok, true);
  assert.equal(balance.activeForm(p), 'bear', 'the shape is kept');
});

test('a refused cast (no mana) does not change shape', () => {
  const { w, p } = setup();
  p.mana = 0;
  const r = w.castSkill('u1', 'dru_wolf_rend', 100, 100, 1, 0);
  assert.equal(r.ok, false);
  assert.equal(balance.activeForm(p), null);
});

test('a form skill whose form gem the player does not own is still refused', () => {
  const { w, p } = setup();
  p.ownedGems = new Set(['dru_wolf_rend']);
  const r = w.castSkill('u1', 'dru_wolf_rend', 100, 100, 1, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'form');
});
