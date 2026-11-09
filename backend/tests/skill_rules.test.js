// The skill rules of the passive tree (the second wave): damage by the skill's
// attribute, crit, costs, recharge, sustain, control and the keystones that spend
// them. Skills are the main way to fight, so each rule is exercised through
// World.castSkill, not just through its helper.
const test = require('node:test');
const assert = require('node:assert');
const sb = require('../src/authority/skillBalance.js');
const { World } = require('../src/authority/world.js');
const { derivePlayerStats } = require('../src/services/playerStats.js');
const C = require('../src/services/progressionConstants.js');

function worldWith(weaponName, rules = {}, statOverrides = {}) {
  const map = { isWalkable: () => true, width: 4000, height: 4000, decorations: [] };
  const weapon = {
    id: 9, name: weaponName, category: 'weapon', kind: weaponName === 'bow' ? 'projectile' : 'melee',
    damage: 0, cooldown: 0.5, reach: 90,
  };
  const world = new World(map, new Map([[9, weapon]]), 9);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100, strength: 30, dexterity: 30, constitution: 30,
    intelligence: 30, wisdom: 30, charisma: 30,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules, sources: {}, ...statOverrides,
  };
  world.addPlayer('u', { x: 1000, y: 1000 }, { items: [], equipment: {} }, { x: 1000, y: 1000 }, 0, stats);
  const p = world.getPlayer('u');
  p.stamina = 100; p.mana = 100; p.maxMana = 100; p.hp = 500; p.maxHp = 500;
  return { world, p, cx: p.x + p.width / 2, cy: p.y + p.height / 2 };
}

function addDummy(world, id, cx, cy) {
  world.creatures.creatures.set(id, {
    id, name: 'Goblin', x: cx - 24, y: cy - 24, width: 48, height: 48, hp: 100000, maxHp: 100000,
    effects: new Map(), mit: { defense: 0, resists: {} },
  });
}
const lost = (world, id) => 100000 - world.creatures.get(id).hp;

function hitWith(weapon, skillId, rules, statOverrides = {}, setupFn = null) {
  const { world, p, cx, cy } = worldWith(weapon, rules, statOverrides);
  addDummy(world, 'c', cx + 60, cy);
  if (setupFn) setupFn(p, world);
  const res = world.castSkill('u', skillId, cx + 60, cy, 1, 0);
  assert.strictEqual(res.ok, true, `${skillId}: ${res.reason} ${res.error}`);
  return { dmg: lost(world, 'c'), p, world, res };
}

test('<attribute>SkillDamage boosts only the skills that name that attribute', () => {
  const base = hitWith('sword', 'war_crushing_blow', {}).dmg; // a strength skill
  assert.ok(hitWith('sword', 'war_crushing_blow', { strengthSkillDamage: 1 }).dmg >= base * 1.9);
  assert.strictEqual(hitWith('sword', 'war_crushing_blow', { dexteritySkillDamage: 1 }).dmg, base);
  assert.strictEqual(hitWith('sword', 'war_crushing_blow', { intelligenceSkillDamage: 1 }).dmg, base);
});

test('skillDamageMult, lowLifeDamage and fullManaDamage multiply skill damage', () => {
  const base = hitWith('sword', 'war_crushing_blow', {}).dmg;
  assert.ok(Math.abs(hitWith('sword', 'war_crushing_blow', { skillDamageMult: 2 }).dmg - base * 2) <= 1);
  const wounded = (rules) => hitWith('sword', 'war_crushing_blow', rules, {}, (p) => { p.hp = 100; p.maxHp = 500; }).dmg;
  assert.ok(wounded({ lowLifeDamage: 1 }) >= base * 1.9, 'wounded');
  assert.strictEqual(hitWith('sword', 'war_crushing_blow', { lowLifeDamage: 1 }).dmg, base, 'healthy: no bonus');
  const full = (rules, mana) => hitWith('staff', 'mag_fireball', rules, {}, (p) => { p.mana = mana; p.maxMana = 100; }).dmg;
  assert.ok(full({ fullManaDamage: 1 }, 100) > full({}, 100) * 1.8, 'nearly full mana');
  assert.strictEqual(full({ fullManaDamage: 1 }, 30), full({}, 30), 'low mana: no bonus');
});

test('critChance and critDamage reach rollCrit', () => {
  const player = (rules) => ({ stats: { rules }, buffs: new Map() });
  assert.strictEqual(sb.rollCrit(player({ critChance: 1 }), {}), 1.5, 'a sure crit at the base multiplier');
  assert.strictEqual(sb.rollCrit(player({ critChance: 1, critDamage: 0.5 }), {}), 2, 'critDamage adds to 1.5');
  assert.strictEqual(sb.rollCrit({ stats: null, buffs: new Map() }, {}), 1, 'no stats: no crit and no crash');
});

test('manaCostMult and staminaCostMult discount skills, rounded up, never free', () => {
  const spent = (weapon, skillId, rules, pool) => {
    const { world, p, cx, cy } = worldWith(weapon, rules);
    addDummy(world, 'c', cx + 60, cy);
    const before = p[pool];
    assert.strictEqual(world.castSkill('u', skillId, cx + 60, cy, 1, 0).ok, true);
    return before - p[pool];
  };
  const full = spent('staff', 'mag_fireball', {}, 'mana');
  assert.ok(full > 1);
  assert.strictEqual(spent('staff', 'mag_fireball', { manaCostMult: 0.5 }, 'mana'), Math.ceil(full * 0.5));
  assert.ok(spent('staff', 'mag_fireball', { manaCostMult: 0.0001 }, 'mana') >= 1, 'never free');
  assert.strictEqual(spent('staff', 'mag_fireball', { staminaCostMult: 0.1 }, 'mana'), full, 'the other pool is not discounted');
  const stam = spent('sword', 'war_crushing_blow', {}, 'stamina');
  assert.strictEqual(spent('sword', 'war_crushing_blow', { staminaCostMult: 0.5 }, 'stamina'), Math.ceil(stam * 0.5));
});

test('skillCooldownMult speeds skill recharge (floored); manaPerWisdom adds mana', () => {
  const quick = derivePlayerStats({ rules: { skillCooldownMult: 0.8 } });
  assert.strictEqual(quick.skillCooldownMult.melee, 0.8);
  assert.strictEqual(quick.skillCooldownMult.spell, 0.8);
  assert.strictEqual(derivePlayerStats({ rules: { skillCooldownMult: 0.001 } }).skillCooldownMult.melee, C.SKILL_MIN_COOLDOWN_MULT);
  assert.strictEqual(derivePlayerStats({}).skillCooldownMult.melee, 1);
  const wise = derivePlayerStats({ wisdom: 25, rules: { manaPerWisdom: 2 } });
  assert.strictEqual(wise.maxMana, derivePlayerStats({ wisdom: 25 }).maxMana + 40);
});

test('skillLeech heals a share of skill damage and widens the cap; killHeal heals per kill', () => {
  const player = (rules) => ({ stats: { rules }, maxHp: 1000, _buffMods: null });
  const skill = { id: 'war_crushing_blow' };
  assert.strictEqual(sb.leechHeal(player({}), skill, 1000), 0);
  const healed = sb.leechHeal(player({ skillLeech: 0.1 }), skill, 1000);
  assert.ok(healed > 10, `the 1%-of-max-HP cap (10) is widened by the node: ${healed}`);
  assert.ok(healed <= 100);

  const { world, p, cx, cy } = worldWith('sword', { killHeal: 0.1 });
  addDummy(world, 'c', cx + 60, cy);
  world.creatures.get('c').hp = 1;
  p.hp = 100;
  assert.strictEqual(world.castSkill('u', 'war_crushing_blow', cx + 60, cy, 1, 0).ok, true);
  assert.ok(p.hp >= 100 + p.maxHp * 0.1 - 1, `killed a creature: hp ${p.hp}`);
});

test('dodgeChance negates a blow (capped at 50%); reflectShare sends a share back', () => {
  const target = (rules) => ({ stats: { rules }, buffs: new Map(), maxHp: 100, hp: 100 });
  const src = { id: 'attacker' };
  try {
    sb.setRng(() => 0.4);
    assert.strictEqual(sb.mitigateIncoming(target({ dodgeChance: 0.5 }), 50, 'physical', src), 0, 'rolled under 50%');
    assert.strictEqual(sb.mitigateIncoming(target({ dodgeChance: 0.1 }), 50, 'physical', src), 50, 'rolled over 10%');
    sb.setRng(() => 0.6);
    assert.strictEqual(sb.mitigateIncoming(target({ dodgeChance: 5 }), 50, 'physical', src), 50, 'capped at 50%, so 0.6 is a hit');
  } finally {
    sb.setRng(null);
  }
  const t = target({ reflectShare: 0.2 });
  assert.strictEqual(sb.mitigateIncoming(t, 50, 'fire', src), 50);
  assert.strictEqual(t._pendingReflect.length, 1);
  assert.strictEqual(t._pendingReflect[0].amount, 10);
  const dot = target({ dodgeChance: 1, reflectShare: 1 });
  dot._dotTick = true;
  assert.strictEqual(sb.mitigateIncoming(dot, 50, 'fire', src), 50, 'a burn tick is not a blow');
  assert.strictEqual(sb.mitigateIncoming(target({ dodgeChance: 1 }), 50, 'fire', null), 50, 'no source, no dodge');
});

test('aoeRadiusMult widens an area skill; spells carry the tree\'s on-hit statuses', () => {
  const caught = (rules, distance) => {
    const { world, cx, cy } = worldWith('staff', rules);
    addDummy(world, 'c', cx + 100 + distance, cy);
    world.castSkill('u', 'mag_fireball', cx + 100, cy, 1, 0);
    return lost(world, 'c');
  };
  assert.strictEqual(caught({}, 150), 0, 'outside the blast');
  assert.ok(caught({ aoeRadiusMult: 2 }, 150) > 0, 'Wide Casting reaches it');

  const burned = hitWith('staff', 'mag_magic_missiles', {}, { hitStatuses: ['burn'] });
  assert.ok(burned.world.creatures.get('c').effects.size > 0, 'a spell without a burn of its own applies the Pyromancy burn');
  const plain = hitWith('staff', 'mag_magic_missiles', {});
  assert.strictEqual(plain.world.creatures.get('c').effects.size, 0);
});

test('stunChance adds a stun rider to skill hits', () => {
  const stunned = hitWith('sword', 'war_crushing_blow', { stunChance: 1 });
  assert.ok(stunned.world.creatures.get('c')._stunnedUntil > 0, 'a sure stun lands');
  const none = hitWith('sword', 'war_crushing_blow', {});
  assert.ok(!(none.world.creatures.get('c')._stunnedUntil > 0), 'no node, no stun');
});

test('every skill rule is granted by some node, and the trade-off keystones pay a price', () => {
  const { PASSIVE_TREE_SPEC, RULE_KEYS } = require('../seeds/data/passiveTree.js');
  const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
  const tree = generatePassiveTree(PASSIVE_TREE_SPEC);
  const granted = new Set();
  for (const n of tree.nodes) for (const g of n.grants) if (g.type === 'rule') granted.add(g.rule);
  const newRules = ['strengthSkillDamage', 'dexteritySkillDamage', 'constitutionSkillDamage', 'intelligenceSkillDamage',
    'wisdomSkillDamage', 'charismaSkillDamage', 'skillDamageMult', 'lowLifeDamage', 'fullManaDamage', 'critChance',
    'critDamage', 'manaCostMult', 'staminaCostMult', 'skillCooldownMult', 'skillLeech', 'killHeal', 'stunChance',
    'dodgeChance', 'dodgeStamina', 'dodgeRiposte', 'reflectShare', 'aoeRadiusMult', 'manaPerWisdom'];
  for (const r of newRules) {
    assert.ok(RULE_KEYS[r], `${r} is registered`);
    assert.ok(granted.has(r), `${r} is granted by some node in the generated tree`);
  }
  const ks = PASSIVE_TREE_SPEC.keystones;
  const find = (sector, key) => ks[sector].find((k) => k.key === key);
  const rule = (k, r) => k.grants.find((g) => g.type === 'rule' && g.rule === r);
  const pays = (k) => k.grants.some((g) => g.type === 'resource' && g.value < 0);
  assert.ok(rule(find('intelligence', 'ks_int_glass_cannon'), 'manaCostMult').value > 1);
  assert.ok(pays(find('intelligence', 'ks_int_glass_cannon')));
  assert.ok(rule(find('constitution', 'ks_con_crimson_bargain'), 'lifeCostMultiplier').value > 1);
  assert.ok(rule(find('wisdom', 'ks_wis_ki_overflow'), 'manaCostMult').value > 1);
  assert.ok(pays(find('dexterity', 'ks_dex_deadly_precision')));
  assert.ok(pays(find('strength', 'ks_str_berserker')));
});

test('a dodge can pay stamina back and send part of the blow home (dodgeStamina, dodgeRiposte)', () => {
  const target = (rules) => ({ stats: { rules }, buffs: new Map(), maxHp: 100, hp: 100, stamina: 10, maxStamina: 40 });
  const src = { id: 'attacker' };
  try {
    sb.setRng(() => 0.1);
    const t = target({ dodgeChance: 0.5, dodgeStamina: 8, dodgeRiposte: 0.25 });
    assert.strictEqual(sb.mitigateIncoming(t, 40, 'physical', src), 0);
    assert.strictEqual(t.stamina, 18);
    assert.strictEqual(t._pendingReflect.length, 1);
    assert.strictEqual(t._pendingReflect[0].amount, 10);
    const full = target({ dodgeChance: 0.5, dodgeStamina: 100 });
    sb.mitigateIncoming(full, 40, 'physical', src);
    assert.strictEqual(full.stamina, 40, 'stamina is capped at the pool');
    sb.setRng(() => 0.9);
    const hit = target({ dodgeChance: 0.5, dodgeStamina: 8, dodgeRiposte: 0.25 });
    assert.strictEqual(sb.mitigateIncoming(hit, 40, 'physical', src), 40);
    assert.strictEqual(hit.stamina, 10, 'nothing happens when the blow lands');
    assert.strictEqual(hit._pendingReflect, undefined);
  } finally {
    sb.setRng(null);
  }
});
