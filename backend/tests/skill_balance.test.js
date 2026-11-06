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

// The catalog's price for a skill after the balance pass (seeds/data/skillSpec.js): an HP
// cost is a percent of max life (these fixtures use maxHp 1000), and a buff that used to be
// free now costs something.
const hpCost = (id) => Math.round(1000 * getSkillById(id).cost / 100);

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
  assert.equal(p.hp, before - hpCost('cul_blood_pact'), 'it only pays its life cost');
  assert.equal(p._buffMods.dealt, 1.25);
});

test('Martyrdom Aura heals nothing and pays more the lower your life is', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.hp = 400; // 60% missing -> three 20% steps -> +45%
  w.castSkill('u1', 'cul_martyrdom_aura', 100, 100, 0, 1);
  assert.equal(p.hp, 400 - hpCost('cul_martyrdom_aura'));
  assert.ok(Math.abs(p._buffMods.dealt - 1.45) < 1e-9);
});

test('Fast Mana Aura restores no mana; it doubles regeneration for its duration', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  const auraCost = getSkillById('mnk_fast_mana_aura').cost;
  assert.ok(auraCost > 0, 'no longer a free permanent buff');
  p.mana = 10 + auraCost;
  w.castSkill('u1', 'mnk_fast_mana_aura', 100, 100, 0, 1);
  assert.equal(p.mana, 10, 'restores no mana: it only paid its cost');
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
  p.mana = 100 + getSkillById('mag_mana_shield').cost;
  p.hp = 1000;
  w.castSkill('u1', 'mag_mana_shield', 100, 100, 0, 1);
  applyDamage(p, 100, 'physical', {}, w.now);
  assert.equal(p.mana, 30, '70 of 100 damage paid from mana');
  assert.equal(p.hp, 970);
});

test('Mana Shield stops absorbing when mana runs out', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  p.mana = 14 + getSkillById('mag_mana_shield').cost;
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
  assert.equal(p.hp, 930 - hpCost('cul_bone_armor'), 'Bone Armor costs its life; the three hits cost nothing');
  assert.equal(p.buffs.has('cul_bone_armor'), false, 'spent after three hits');
  applyDamage(p, 100, 'physical', {}, w.now);
  assert.equal(p.hp, 930 - hpCost('cul_bone_armor') - 100);
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
  assert.equal(p.hp, hpBefore - hpCost('cul_life_transfusion'), 'a buff with no entry restores nothing; it only costs its life');
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
  // The id regex is only the fallback now: a skill with a `lifesteal` effect in the
  // table (soul drain, siphon strike...) heals through skillEffectsApply instead.
  const drain = { id: 'test_leech_drain' };
  assert.equal(balance.leechHeal(p, drain, 10000), 10);
  assert.equal(balance.leechHeal(p, drain, 10), 4);
  assert.equal(balance.leechHeal(p, getSkillById('cul_soul_drain'), 10000), 0, 'tabled: healed by its lifesteal effect');
  assert.equal(balance.leechHeal(p, getSkillById('war_crushing_blow'), 100), 0);
});

test('damage grows with level and cooldown; multi-hit skills keep their hit counts', () => {
  const low = balance.baseDamageOf({ id: 'x', reqLvl: 1, cooldown: 1 });
  const high = balance.baseDamageOf({ id: 'y', reqLvl: 40, cooldown: 30 });
  assert.ok(high.base > low.base);
  assert.ok(low.base >= 4);
  // No ceiling any more: a level-40 skill follows the weapon curve (it used to stop at 30).
  assert.ok(high.base > 30);
  const barrage = balance.baseDamageOf({ id: 'arc_barrage', reqLvl: 25, channeled: true });
  assert.equal(barrage.hits, 5, 'multi-hit skills keep their hit counts');
  // ...and the total is split across them rather than multiplied.
  const single = balance.baseDamageOf({ id: 'z', reqLvl: 25, channeled: true });
  assert.ok(Math.abs(barrage.base * barrage.hits - single.base) < 1e-9);
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

// --- Druid forms scale with the tree's formPower -----------------------------
test('a form cast with formPower is stronger than one without', () => {
  const sb = require('../src/authority/skillBalance.js');
  const cast = (formPower) => {
    const p = { maxHp: 100, hp: 100, mana: 100, stats: { rules: { formPower } } };
    sb.castBuff(p, { id: 'dru_bear_form', nameEn: 'Bear Form' }, 0);
    return p.buffs.get('dru_bear_form').fx;
  };
  const base = cast(0);
  const boosted = cast(0.5);
  assert.ok(boosted.hpMult > base.hpMult, 'more life from the form');
  assert.ok(boosted.taken < base.taken, 'less damage taken in the form');
  const capped = cast(5);
  assert.ok(Math.abs(capped.hpMult - (1 + (base.hpMult - 1) * 2)) < 1e-9, 'capped at +100%');
  const hawk = (fp) => { const p = { maxHp: 100, hp: 100, mana: 100, stats: { rules: { formPower: fp } } }; sb.castBuff(p, { id: 'dru_hawk_form' }, 0); return p.buffs.get('dru_hawk_form').fx; };
  assert.ok(hawk(0.5).speed > hawk(0).speed && hawk(0.5).dodge > hawk(0).dodge);
  const wolf = (fp) => { const p = { maxHp: 100, hp: 100, mana: 100, stats: { rules: { formPower: fp } } }; sb.castBuff(p, { id: 'dru_wolf_form' }, 0); return p.buffs.get('dru_wolf_form').fx; };
  assert.ok(wolf(0.5).atk > wolf(0).atk && wolf(0.5).crit > wolf(0).crit);
});

test('skillElementOf gives one element, and its multiplier falls back to physical', () => {
  const sb = require('../src/authority/skillBalance.js');
  assert.strictEqual(sb.skillElementOf({ class: 'Druid', type: 'melee' }), 'physical');
  assert.strictEqual(sb.skillElementOf({ class: 'Druid', type: 'magic' }), 'lightning');
  assert.strictEqual(sb.skillElementOf({ class: 'Mage', type: 'magic' }), 'fire');
  assert.strictEqual(sb.skillElementOf({ class: 'Warrior', type: 'melee' }), 'physical');
  assert.strictEqual(sb.skillElementOf({ class: 'Druid', type: 'magic', element: 'ice' }), 'ice');
  const stats = { damageMult: { physical: 1.5, lightning: 2, fire: 1.2 } };
  assert.strictEqual(sb.skillElementMult(stats, 'lightning'), 2);
  assert.strictEqual(sb.skillElementMult(stats, 'shadow'), 1.5, 'unknown element -> physical');
  assert.strictEqual(sb.skillElementMult(null, 'fire'), 1);
});
