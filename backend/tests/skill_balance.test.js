const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/authority/world.js');
const { applyDamage } = require('../src/authority/damage.js');
const balance = require('../src/authority/skillBalance.js');
const { getSkillById } = require('../seeds/data/skills.js');

function makeWorld() {
  const map = { isWalkable: () => true, width: 2000, height: 2000, decorations: [] };
  const sword = { id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' };
  return new World(map, new Map([[sword.id, sword]]), sword.id);
}

function addPlayer(world, userId = 'u1') {
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100,
    strength: 100, dexterity: 100, constitution: 100, intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {},
    sources: {},
  };
  world.addPlayer(userId, { x: 100, y: 100 }, { items: [], equipment: {} }, { x: 100, y: 100 }, 0, stats);
  const p = world.getPlayer(userId);
  p.maxHp = 1000; p.hp = 500; p.maxMana = 200; p.mana = 50; p.stamina = 100; p.maxStamina = 100;
  return p;
}

test('the server enforces a skill cooldown; the client timer is not the rule', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.mana = 200;
  assert.equal(w.castSkill('u1', 'mag_mana_surge', 100, 100, 0, 1).ok, true);
  const again = w.castSkill('u1', 'mag_mana_surge', 100, 100, 0, 1);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'cooldown');
  w.now += 61000;
  assert.equal(w.castSkill('u1', 'mag_mana_surge', 100, 100, 0, 1).ok, true);
});

test('a cast refused for lack of mana does not start the cooldown', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.mana = 0;
  assert.equal(w.castSkill('u1', 'mag_haste', 100, 100, 0, 1).reason, 'mana');
  p.mana = 200;
  assert.equal(w.castSkill('u1', 'mag_haste', 100, 100, 0, 1).ok, true);
});

test('a skill with no cooldown still waits one second, as on the client', () => {
  const w = makeWorld();
  addPlayer(w);
  assert.equal(w.castSkill('u1', 'mnk_fast_mana_aura', 100, 100, 0, 1).ok, true);
  assert.equal(w.castSkill('u1', 'mnk_fast_mana_aura', 100, 100, 0, 1).reason, 'cooldown');
});

test('Blood Pact no longer heals: it is a timed damage buff', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  const before = p.hp;
  assert.equal(w.castSkill('u1', 'cul_blood_pact', 100, 100, 0, 1).ok, true);
  assert.equal(p.hp, before);
  assert.equal(p._buffMods.dealt, 1.25);
});

test('Martyrdom Aura heals nothing and pays more the lower your life is', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.hp = 400; // 60% missing -> three 20% steps -> +45%
  w.castSkill('u1', 'cul_martyrdom_aura', 100, 100, 0, 1);
  assert.equal(p.hp, 400);
  assert.ok(Math.abs(p._buffMods.dealt - 1.45) < 1e-9);
});

test('Fast Mana Aura restores no mana; it doubles regeneration for its duration', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.mana = 10;
  w.castSkill('u1', 'mnk_fast_mana_aura', 100, 100, 0, 1);
  assert.equal(p.mana, 10);
  assert.equal(p._buffMods.manaRegen, 2);
  const target = {
    buffs: p.buffs, _buffMods: p._buffMods, mana: 10, maxMana: 200,
    stats: { manaRegen: 10 }, hp: 5, maxHp: 10,
  };
  balance.tickBuffs(target, 1000, w.now + 1000);
  assert.equal(target.mana, 20, 'one extra second of base regen on top of the normal one');
});

test('Mana Shield soaks 70% of a hit from mana and the rest hits life', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.mana = 100;
  p.hp = 1000;
  w.castSkill('u1', 'mag_mana_shield', 100, 100, 0, 1);
  applyDamage(p, 100, 'physical', {}, w.now);
  assert.equal(p.mana, 30, '70 of 100 damage paid from mana');
  assert.equal(p.hp, 970);
});

test('Mana Shield stops absorbing when mana runs out', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.mana = 14;
  p.hp = 1000;
  w.castSkill('u1', 'mag_mana_shield', 100, 100, 0, 1);
  applyDamage(p, 100, 'physical', {}, w.now);
  assert.equal(p.mana, 0);
  assert.equal(p.hp, 1000 - 86);
});

test('Shield Wall and Bone Armor reduce or negate incoming hits', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.hp = 1000;
  w.castSkill('u1', 'war_shield_wall', 100, 100, 0, 1);
  applyDamage(p, 100, 'physical', {}, w.now);
  assert.equal(p.hp, 930);
  w.castSkill('u1', 'cul_bone_armor', 100, 100, 0, 1);
  p.buffs.delete('war_shield_wall');
  balance.refreshBuffMods(p);
  for (let i = 0; i < 3; i++) applyDamage(p, 100, 'physical', {}, w.now);
  assert.equal(p.hp, 900, 'Bone Armor cost 30 life; the three hits cost nothing');
  assert.equal(p.buffs.has('cul_bone_armor'), false, 'spent after three hits');
  applyDamage(p, 100, 'physical', {}, w.now);
  assert.equal(p.hp, 800);
});

test('Last Stand: life cannot fall below 1', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.hp = 50;
  w.castSkill('u1', 'war_last_stand', 100, 100, 0, 1);
  applyDamage(p, 500, 'physical', {}, w.now);
  assert.equal(p.hp, 1);
});

test('a healing buff heals a fixed share of max HP, not by the word HP in its text', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.hp = 100;
  p.mana = 200;
  w.castSkill('u1', 'mnk_touch_of_life', 100, 100, 0, 1);
  assert.equal(p.hp, 400);
  const hpBefore = p.hp;
  w.castSkill('u1', 'cul_life_transfusion', 100, 100, 0, 1);
  assert.equal(p.hp, hpBefore - 50, 'a buff with no entry restores nothing; it only costs its 50 life');
});

test('Haste speeds movement and attacks while it lasts', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.mana = 200;
  w.castSkill('u1', 'mag_haste', 100, 100, 0, 1);
  assert.equal(p._buffMods.speed, 1.35);
  assert.equal(p._buffMods.atk, 1.35);
});

test('leech heals a capped share of max HP per cast', () => {
  const p = { maxHp: 1000, _buffMods: null };
  const drain = getSkillById('cul_soul_drain');
  assert.equal(balance.leechHeal(p, drain, 10000), 10);
  assert.equal(balance.leechHeal(p, drain, 10), 4);
  assert.equal(balance.leechHeal(p, getSkillById('war_crushing_blow'), 100), 0);
});

test('damage grows with level and cooldown; multi-hit skills keep their hit counts', () => {
  const low = balance.baseDamageOf({ id: 'x', reqLvl: 1, cooldown: 1 });
  const high = balance.baseDamageOf({ id: 'y', reqLvl: 40, cooldown: 30 });
  assert.ok(high.base > low.base);
  assert.ok(high.base <= 30 && low.base >= 4);
  assert.deepEqual(balance.baseDamageOf({ id: 'arc_barrage' }), { base: 4, hits: 5 });
});

test('buffs heal or restore mana only through the BUFFS table, and instant ones have a real cooldown', () => {
  const heals = Object.entries(balance.BUFFS).filter(([, b]) => b.heal || b.healFlat).map(([id]) => id).sort();
  assert.deepEqual(heals, ['dru_healing_touch', 'dru_primal_metamorphosis', 'mnk_touch_of_life', 'war_unstoppable']);
  const mana = Object.entries(balance.BUFFS).filter(([, b]) => b.mana).map(([id]) => id);
  assert.deepEqual(mana, ['mag_mana_surge']);
  for (const [id, b] of Object.entries(balance.BUFFS)) {
    const s = getSkillById(id);
    assert.ok(s && s.type === 'buff', `${id} is a buff skill`);
    assert.ok(b.dur > 0, `${id} has a duration`);
    if (b.heal || b.mana) assert.ok(Number(s.cooldown) >= 10, `${id} instant restores need a real cooldown`);
  }
});
