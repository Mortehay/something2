const test = require('node:test');
const assert = require('node:assert');
const sb = require('../src/authority/skillBalance.js');

const SKILL = { id: 'x_test', type: 'melee', reqLvl: 1, cooldown: 1 }; // baseDamageOf -> 6

test('total = skill base + weapon damage x scaling (the 10 + 50 x 10% = 15 example)', () => {
  const skill = { ...SKILL, id: 'arc_barrage' }; // multi-hit, base 4 per hit
  assert.strictEqual(sb.skillHitDamage(skill, 0).base, 4);
  const plain = sb.baseDamageOf(SKILL).base;
  const r = sb.skillHitDamage({ ...SKILL, weaponScaling: 0.1 }, 50);
  assert.strictEqual(r.base, plain + 5);
  assert.strictEqual(r.bonus, 5);
});

test('a multi-hit skill spreads the weapon share across its hits', () => {
  const barrage = { ...SKILL, id: 'arc_barrage', weaponScaling: 0.1 }; // 4 x 5 hits
  const r = sb.skillHitDamage(barrage, 100);
  assert.strictEqual(r.hits, 5);
  assert.strictEqual(r.bonus, 10);
  assert.ok(Math.abs(r.base * r.hits - (4 * 5 + 10)) < 1e-9, 'the whole cast gets the bonus once');
});

test('no weapon (or damage 0 / junk) adds nothing', () => {
  const plain = sb.baseDamageOf(SKILL).base;
  for (const w of [0, null, undefined, -5, NaN, 'abc']) assert.strictEqual(sb.skillHitDamage(SKILL, w).base, plain);
});

test('scaling depends on the skill type, with an optional per-skill override', () => {
  assert.strictEqual(sb.DEFAULT_WEAPON_SCALING, 0.1);
  assert.strictEqual(sb.weaponScalingOf({ type: 'melee' }), 0.15);
  assert.strictEqual(sb.weaponScalingOf({ type: 'magic' }), 0.1);
  assert.strictEqual(sb.weaponScalingOf({ type: 'debuff' }), 0.05);
  assert.strictEqual(sb.weaponScalingOf({ type: 'whatever' }), 0.1);
  assert.strictEqual(sb.weaponScalingOf({ weaponScaling: 0.25 }), 0.25);
  assert.strictEqual(sb.weaponScalingOf({ weaponScaling: 0 }), 0);
  assert.strictEqual(sb.weaponScalingOf({ weaponScaling: -1, type: 'magic' }), 0.1);
  assert.strictEqual(sb.skillHitDamage({ ...SKILL, weaponScaling: 0 }, 80).bonus, 0);
});

test('hit counts are unchanged by the weapon', () => {
  assert.strictEqual(sb.skillHitDamage({ ...SKILL, id: 'arc_barrage' }, 100).hits, 5);
});

// --- through World.castSkill: the weapon is read at cast time ----------------
const { World } = require('../src/authority/world.js');

function setup(weaponDamage, equipped) {
  const map = { isWalkable: () => true, width: 2000, height: 2000, decorations: [] };
  const sword = { id: 7, name: 'sword', category: 'weapon', kind: 'melee', damage: weaponDamage, cooldown: 0.5, reach: 90 };
  const world = new World(map, new Map([[7, sword]]), 7);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100, strength: 100, dexterity: 100, constitution: 100,
    intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {},
    sources: {},
  };
  const inv = equipped ? { items: [{ id: 'w1', typeId: 7 }], equipment: { main_hand: 'w1' } } : { items: [], equipment: {} };
  world.addPlayer('u', { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, stats);
  const player = world.getPlayer('u');
  player.stamina = 100; player.mana = 100; player.maxMana = 100;
  world.creatures.creatures.set('c', {
    id: 'c', name: 'Goblin', x: 140, y: 100, width: 48, height: 48, hp: 100000, maxHp: 100000,
    effects: new Map(), mit: { defense: 0, resists: {} },
  });
  return { world, player };
}

function hit(weaponDamage, equipped) {
  const { world } = setup(weaponDamage, equipped);
  const res = world.castSkill('u', 'war_crushing_blow', 140, 100, 1, 0);
  assert.strictEqual(res.ok, true);
  return 100000 - world.creatures.get('c').hp;
}

test('a stronger equipped weapon makes the same skill hit harder; no weapon adds nothing', () => {
  const bare = hit(0, false);
  const weak = hit(20, true);
  const strong = hit(400, true);
  assert.ok(bare > 0);
  assert.ok(weak >= bare, 'a weapon never reduces the hit');
  assert.ok(strong > weak, 'more weapon damage, more skill damage');
  // 400 * 10% = 40 extra before the shared multipliers.
  assert.ok(strong - bare >= 30, `expected a clear bonus, got ${strong - bare}`);
});

test('unequipping the weapon drops the bonus on the very next cast', () => {
  const { world, player } = setup(400, true);
  assert.strictEqual(world.castSkill('u', 'war_crushing_blow', 140, 100, 1, 0).ok, true);
  const first = 100000 - world.creatures.get('c').hp;
  player.inv.equipment.main_hand = null;
  player._skillReadyAt = new Map();
  world.creatures.get('c').hp = 100000;
  assert.strictEqual(world.castSkill('u', 'war_crushing_blow', 140, 100, 1, 0).ok, true);
  const second = 100000 - world.creatures.get('c').hp;
  assert.ok(second < first, `unarmed (${second}) should hit softer than armed (${first})`);
});

test('a Druid skill is multiplied by its CHA, not meleeMult/spellMult', () => {
  const hitWith = (mods) => {
    const { world } = setup(0, false);
    const p = world.getPlayer('u');
    Object.assign(p.stats, mods);
    p.mana = 100; p.maxMana = 100;
    world.creatures.get('c').hp = 100000;
    const res = world.castSkill('u', 'dru_thorn_staff_strike', 140, 100, 1, 0);
    assert.strictEqual(res.ok, true, `cast ok: ${res.reason} ${res.error}`);
    return 100000 - world.creatures.get('c').hp;
  };
  const plain = hitWith({ meleeMult: 1, spellMult: 1, charisma: 30, strength: 5, intelligence: 5 });
  const strong = hitWith({ meleeMult: 1, spellMult: 1, charisma: 90, strength: 5, intelligence: 5 });
  const meleeOnly = hitWith({ meleeMult: 3, spellMult: 3, charisma: 30, strength: 100, intelligence: 100 });
  assert.ok(strong > plain * 1.5, `CHA tripled: ${plain} -> ${strong}`);
  assert.strictEqual(meleeOnly, plain, 'STR/INT no longer move a Druid skill');
});

test('every class\'s skills scale with that class\'s main attribute, 5% per point above base', () => {
  const C = require('../src/services/progressionConstants.js');
  const stats = { strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5, meleeMult: 1, spellMult: 1 };
  const cases = [
    ['Warrior', 'strength'], ['Mage', 'intelligence'], ['Archer', 'dexterity'],
    ['Monk', 'wisdom'], ['Cultist', 'constitution'], ['Druid', 'charisma'],
  ];
  assert.deepStrictEqual(Object.keys(C.CLASS_MAIN_STAT).sort(), cases.map((c) => c[0]).sort());
  for (const [cls, main] of cases) {
    for (const type of ['melee', 'magic']) {
      const skill = { class: cls, type };
      assert.strictEqual(sb.skillStatMult(stats, skill), 1, `${cls} ${type} at base`);
      assert.strictEqual(sb.skillStatMult({ ...stats, [main]: 25 }, skill), 2, `${cls} ${type}: +20 ${main} doubles it`);
      for (const other of Object.keys(stats).filter((k) => k !== main && /^(strength|dexterity|constitution|intelligence|wisdom|charisma)$/.test(k))) {
        assert.strictEqual(sb.skillStatMult({ ...stats, [other]: 100 }, skill), 1, `${cls} ${type}: ${other} does not move it`);
      }
    }
  }
});

test('a class with no main attribute keeps the older STR-for-melee, INT-for-the-rest split', () => {
  const stats = { meleeMult: 2, spellMult: 3 };
  assert.strictEqual(sb.skillStatMult(stats, { class: 'Nobody', type: 'melee' }), 2);
  assert.strictEqual(sb.skillStatMult(stats, { class: 'Nobody', type: 'magic' }), 3);
  assert.strictEqual(sb.skillStatMult(null, null), 1);
});

// --- life-cost skills take the tree's lifeCostMultiplier ---------------------
test('a Cultist skill pays its HP cost times lifeCostMultiplier, rounded up', () => {
  const cost = (lifeCostMultiplier) => {
    const { world, player } = setup(0, false);
    player.stats.lifeCostMultiplier = lifeCostMultiplier;
    player.hp = 500; player.maxHp = 500;
    const before = player.hp;
    const res = world.castSkill('u', 'cul_bone_armor', 140, 100, 1, 0);
    assert.strictEqual(res.ok, true, `cast ok: ${res.reason} ${res.error}`);
    return before - player.hp;
  };
  const full = cost(1);
  assert.strictEqual(full, 30, 'cul_bone_armor costs its authored 30 HP at multiplier 1');
  assert.strictEqual(cost(0.5), Math.ceil(full * 0.5));
  assert.ok(cost(0.85) < full, 'Blood Pact makes it cheaper');
  assert.strictEqual(cost(undefined), full, 'a missing multiplier means no discount, never no cost');
});

test('skillLifeCostFor: multiplier only, no mana->life ratio, never free', () => {
  const { skillLifeCostFor } = require('../src/services/lifeCost.js');
  assert.strictEqual(skillLifeCostFor(20, 1), 20);
  assert.strictEqual(skillLifeCostFor(20, 0.9), 18);
  assert.strictEqual(skillLifeCostFor(3, 0.1), 1);
  assert.strictEqual(skillLifeCostFor(0, 0.5), 0);
  assert.strictEqual(skillLifeCostFor(20, NaN), 20);
  assert.strictEqual(skillLifeCostFor(20, -1), 20);
});

// --- Mage skills carry their own element --------------------------------------
test('Mage skills are typed by element, so ice/lightning/arcane nodes reach them', () => {
  const { getSkillById } = require('../seeds/data/skills.js');
  const el = (id) => sb.skillElementOf(getSkillById(id));
  assert.strictEqual(el('mag_fireball'), 'fire');
  assert.strictEqual(el('mag_frostbolt'), 'ice');
  assert.strictEqual(el('mag_chain_lightning'), 'lightning');
  assert.strictEqual(el('mag_arcane_beam'), 'arcane');
});

// --- damaging skills are hasted by a share of the weapon haste ----------------
test('skill cooldowns take SKILL_HASTE_SHARE of the weapon haste, damaging skills only', () => {
  const { derivePlayerStats } = require('../src/services/playerStats.js');
  const C = require('../src/services/progressionConstants.js');
  const base = derivePlayerStats({});
  assert.deepStrictEqual(base.skillCooldownMult, { melee: 1, spell: 1 });
  const fast = derivePlayerStats({ dexterity: 5 + 100 }); // far past the floor
  const floor = C.MIN_COOLDOWN_MULT;
  const expected = Math.round((1 - (1 - floor) * C.SKILL_HASTE_SHARE) * 10000) / 10000;
  assert.strictEqual(fast.skillCooldownMult.melee, expected);
  assert.strictEqual(fast.skillCooldownMult.spell, expected);
  assert.strictEqual(sb.skillCooldownMultOf(fast, { type: 'melee' }), expected);
  assert.strictEqual(sb.skillCooldownMultOf(fast, { type: 'magic' }), expected);
  assert.strictEqual(sb.skillCooldownMultOf(fast, { type: 'buff' }), 1);
  assert.strictEqual(sb.skillCooldownMultOf(fast, { type: 'debuff' }), 1);
  assert.strictEqual(sb.skillCooldownMultOf(null, { type: 'melee' }), 1);
  // a channelled skill keeps its fixed gap
  assert.strictEqual(sb.minGapMs({ channeled: true, cooldown: 4 }, 0.5), sb.minGapMs({ channeled: true, cooldown: 4 }));
  assert.ok(sb.minGapMs({ cooldown: 4 }, 0.5) < sb.minGapMs({ cooldown: 4 }));
  // the speed rule for the skill's kind is honoured, and the floor still bounds it
  const hawk = derivePlayerStats({ dexterity: 5 + 20, rules: { attackSpeedMult: 1.5, castSpeedMult: 1 } });
  assert.ok(hawk.skillCooldownMult.melee < hawk.skillCooldownMult.spell, 'melee skills use attackSpeedMult');
  const absurd = derivePlayerStats({ rules: { attackSpeedMult: 100 } });
  assert.strictEqual(absurd.skillCooldownMult.melee, expected);
});

// --- the tree's shape rules reach skills --------------------------------------
function worldWith(weaponName, rules = {}, statOverrides = {}) {
  const map = { isWalkable: () => true, width: 4000, height: 4000, decorations: [] };
  const weapon = { id: 9, name: weaponName, category: 'weapon', kind: weaponName === 'bow' ? 'projectile' : 'melee', damage: 0, cooldown: 0.5, reach: 90 };
  const world = new World(map, new Map([[9, weapon]]), 9);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100, strength: 100, dexterity: 100, constitution: 100,
    intelligence: 100, wisdom: 100, charisma: 100,
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

test('meleeReachBonus lengthens a melee skill, and a negative one shortens it', () => {
  const cast = (rules, distance) => {
    const { world, p, cx, cy } = worldWith('sword', rules);
    addDummy(world, 'c', cx + distance, cy);
    assert.strictEqual(world.castSkill('u', 'war_crushing_blow', cx + distance, cy, 1, 0).ok, true);
    return lost(world, 'c');
  };
  assert.strictEqual(cast({}, 170), 0, 'out of the 104px base reach');
  assert.ok(cast({ meleeReachBonus: 100 }, 170) > 0, 'Cleaving Reach puts it in range');
  assert.ok(cast({}, 90) > 0);
  assert.strictEqual(cast({ meleeReachBonus: -200 }, 90), 0, 'a shortened swing no longer reaches 90px');
  assert.ok(cast({ meleeReachBonus: -200 }, 40) > 0, 'but is floored at MIN_MELEE_REACH, never a swing that reaches nothing');
});

test('meleeArcBonus widens a melee skill past the front 135 degrees', () => {
  const cast = (rules) => {
    const { world, cx, cy } = worldWith('sword', rules);
    addDummy(world, 'c', cx - 70, cy); // directly BEHIND an eastward swing
    assert.strictEqual(world.castSkill('u', 'war_crushing_blow', cx + 100, cy, 1, 0).ok, true);
    return lost(world, 'c');
  };
  assert.strictEqual(cast({}), 0);
  assert.ok(cast({ meleeArcBonus: 4 }) > 0, 'Whirlwind-style arc covers behind');
});

test('meleeDamageMult is the price a melee skill pays for its shape, and only melee', () => {
  const hit = (rules) => {
    const { world, cx, cy } = worldWith('sword', rules);
    addDummy(world, 'c', cx + 60, cy);
    world.castSkill('u', 'war_crushing_blow', cx + 60, cy, 1, 0);
    return lost(world, 'c');
  };
  const full = hit({});
  assert.ok(full > 4, `baseline ${full}`);
  assert.ok(hit({ meleeDamageMult: 0.5 }) < full * 0.6, 'halved');
  // a spell is not a swing
  const spell = (rules) => {
    const { world, cx, cy } = worldWith('staff', rules);
    addDummy(world, 'c', cx + 100, cy);
    world.castSkill('u', 'mag_fireball', cx + 100, cy, 1, 0);
    return lost(world, 'c');
  };
  assert.strictEqual(spell({ meleeDamageMult: 0.5 }), spell({}));
});

test('meleeWaveShare leaves a lingering wave behind a melee skill', () => {
  const none = worldWith('sword', {});
  addDummy(none.world, 'c', none.cx + 60, none.cy);
  none.world.castSkill('u', 'war_crushing_blow', none.cx + 60, none.cy, 1, 0);
  assert.strictEqual(none.world.waves.length, 0);

  const some = worldWith('sword', { meleeWaveShare: 0.25 });
  addDummy(some.world, 'c', some.cx + 60, some.cy);
  some.world.castSkill('u', 'war_crushing_blow', some.cx + 60, some.cy, 1, 0);
  assert.strictEqual(some.world.waves.length, 1);
  const wave = some.world.waves[0];
  const direct = lost(some.world, 'c');
  assert.ok(Math.abs(wave.damage - direct * 0.25) <= direct * 0.05, `wave ${wave.damage} ~ 25% of ${direct}`);
  assert.strictEqual(wave.element, 'physical');
  const before = some.world.creatures.get('c').hp;
  some.world.now += 1000;
  some.world._tickWaves(1);
  assert.ok(some.world.creatures.get('c').hp < before, 'the wave keeps damaging the ground');
});

test('projectileCount adds hits to fired skills only', () => {
  const hit = (weapon, skillId, rules) => {
    const { world, cx, cy } = worldWith(weapon, rules);
    addDummy(world, 'c', cx + 150, cy);
    const res = world.castSkill('u', skillId, cx + 150, cy, 1, 0);
    assert.strictEqual(res.ok, true, `${skillId}: ${res.reason} ${res.error}`);
    return lost(world, 'c');
  };
  const one = hit('bow', 'arc_aimed_shot', {});
  const three = hit('bow', 'arc_aimed_shot', { projectileCount: 2 });
  assert.ok(Math.abs(three - one * 3) <= 3, `1 arrow ${one}, 3 arrows ${three}`);
  // a non-fired spell is unmoved
  assert.strictEqual(hit('staff', 'mag_frost_nova', { projectileCount: 2 }), hit('staff', 'mag_frost_nova', {}));
});

// --- every skill names its attribute ------------------------------------------
test('every skill carries a valid attribute, the class main one unless overridden', () => {
  const { SKILLS } = require('../seeds/data/skills.js');
  const C = require('../src/services/progressionConstants.js');
  for (const s of SKILLS) {
    assert.ok(C.STAT_KEYS.includes(s.attribute), `${s.id} has attribute ${s.attribute}`);
  }
  const overridden = SKILLS.filter((s) => s.attribute !== C.CLASS_MAIN_STAT[s.class]);
  assert.deepStrictEqual(overridden.map((s) => s.id).sort(),
    ['arc_explosive_arrow', 'arc_frost_arrow', 'arc_lightning_arrow', 'arc_starfall_arrow']);
  assert.ok(overridden.every((s) => s.attribute === 'intelligence'));
});

test('a skill grows with ITS attribute, not its class\'s', () => {
  const { getSkillById } = require('../seeds/data/skills.js');
  const stats = { strength: 5, dexterity: 5, constitution: 5, intelligence: 25, wisdom: 5, charisma: 5 };
  assert.strictEqual(sb.skillStatMult(stats, getSkillById('arc_frost_arrow')), 2, 'elemental arrow: INT');
  assert.strictEqual(sb.skillStatMult(stats, getSkillById('arc_aimed_shot')), 1, 'plain arrow: DEX');
  assert.strictEqual(sb.skillStatMult(stats, { class: 'Archer', attribute: 'nonsense' }), 1, 'a bad attribute falls back to the class one');
});

test('Cultist skills are arcane, so arcane nodes (not physical ones) boost them', () => {
  const { SKILLS } = require('../seeds/data/skills.js');
  for (const s of SKILLS.filter((k) => k.class === 'Cultist')) assert.strictEqual(sb.skillElementOf(s), 'arcane', s.id);
  assert.strictEqual(sb.skillElementOf({ class: 'Cultist', type: 'magic' }), 'arcane');
});
