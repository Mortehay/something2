const test = require('node:test');
const assert = require('node:assert');
const syn = require('../src/authority/skillSynergy.js');
const { SKILLS, getSkillById } = require('../seeds/data/skills.js');

const skill = (id) => { const s = getSkillById(id); assert.ok(s, id); return s; };

test('tags come from type, explicit element and the name', () => {
  assert.ok(syn.skillTags(skill('mag_frostbolt')).has('ice'));
  assert.ok(syn.skillTags(skill('mag_fireball')).has('fire'));
  assert.ok(syn.skillTags(skill('mag_fireball')).has('magic'));
  assert.ok(syn.skillTags(skill('dru_entangling_roots')).has('control'));
  assert.ok(syn.skillTags(skill('dru_entangling_roots')).has('curse'), 'a debuff is a curse');
  assert.ok(syn.skillTags(skill('war_battle_shout')).has('buff'));
});

test('every class has skills that start and skills that finish a synergy', () => {
  for (const cls of ['Warrior', 'Archer', 'Mage', 'Monk', 'Cultist', 'Druid']) {
    const list = SKILLS.filter((s) => s.class === cls);
    const primes = list.filter((s) => syn.SYNERGIES.some((x) => x.from.some((t) => syn.skillTags(s).has(t))));
    const finish = list.filter((s) => s.type !== 'buff' && syn.SYNERGIES.some((x) => x.to.some((t) => syn.skillTags(s).has(t))));
    assert.ok(primes.length >= 5 && finish.length >= 5, `${cls}: ${primes.length} primers, ${finish.length} finishers`);
  }
});

test('ice then fire is Shatter (+30%), once, and only inside the window', () => {
  const p = {};
  const frost = skill('mag_frostbolt');
  const fire = skill('mag_fireball');
  assert.strictEqual(syn.onCast(p, frost, 1000).name, null, 'a primer alone does nothing');
  const r = syn.onCast(p, fire, 2000);
  assert.strictEqual(r.name, 'Shatter');
  assert.ok(r.mult >= 1.30);
  assert.strictEqual(syn.onCast(p, fire, 2100).name, null, 'the primer was consumed');
  const q = {};
  syn.onCast(q, frost, 0);
  assert.strictEqual(syn.onCast(q, fire, syn.PRIMER_MS + 1).name, null, 'expired');
});

test('the same skill cannot prime itself', () => {
  const p = {};
  const s = skill('mag_frostbolt');
  syn.onCast(p, s, 0);
  assert.strictEqual(syn.onCast(p, s, 500).name, null);
});

test('the chain grows with different skills in quick succession and is capped', () => {
  const p = {};
  const ids = ['war_crushing_blow', 'war_whirlwind', 'war_shield_slam', 'war_skull_splitter', 'war_twin_slash'];
  const chains = ids.map((id, i) => syn.onCast(p, skill(id), i * 1000).chain);
  assert.deepStrictEqual(chains, [0, 1, 2, 3, 3]);
  assert.strictEqual(syn.onCast(p, skill('war_decapitate'), 4000 + syn.CHAIN_WINDOW_MS + 1).chain, 0, 'a pause resets it');
});

test('a buff primes and chains but never carries a damage multiplier', () => {
  const p = {};
  const r = syn.onCast(p, skill('war_battle_shout'), 0);
  assert.strictEqual(r.mult, 1);
  const hit = syn.onCast(p, skill('war_crushing_blow'), 500);
  assert.strictEqual(hit.name, 'Empowered Strike');
});

test('druid forms: a form skill needs its form, spells are refused in animal form', () => {
  assert.strictEqual(syn.formOfSkill(skill('dru_bear_slam')), 'bear');
  assert.strictEqual(syn.formOfSkill(skill('dru_hawk_dive_slash')), 'hawk');
  assert.strictEqual(syn.formOfSkill(skill('dru_wolf_pounce')), 'wolf');
  assert.strictEqual(syn.formOfSkill(skill('dru_maul')), 'bear');
  assert.strictEqual(syn.formOfSkill(skill('dru_feral_bite')), 'wolf');
  assert.strictEqual(syn.formOfSkill(skill('dru_bear_form')), null, 'the form itself is not gated');
  assert.strictEqual(syn.formOfSkill(skill('war_whirlwind')), null);
  assert.strictEqual(syn.formGate(skill('dru_bear_slam'), null).reason, 'form');
  assert.strictEqual(syn.formGate(skill('dru_bear_slam'), 'wolf').reason, 'form');
  assert.strictEqual(syn.formGate(skill('dru_bear_slam'), 'bear'), null);
  assert.strictEqual(syn.formGate(skill('dru_moonfire'), 'bear').reason, 'form_spell');
  assert.strictEqual(syn.formGate(skill('dru_moonfire'), null), null);
  assert.strictEqual(syn.formGate(skill('dru_rejuvenation'), 'bear'), null, 'buffs stay castable');
  assert.strictEqual(syn.formGate(skill('mag_fireball'), 'bear'), null, 'only a Druid is gated');
});

test('every druid form has skills to use', () => {
  for (const f of ['bear', 'hawk', 'wolf']) {
    assert.ok(SKILLS.filter((s) => syn.formOfSkill(s) === f).length >= 4, f);
  }
});
