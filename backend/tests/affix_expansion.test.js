// The expanded affix catalog (Path of Exile as the model): item families, prefixes and suffixes with a cap, groups,
// tiers, rules that reach combat, spell levels and trigger affixes. Offline: the catalog module is the pool.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NEW_AFFIXES, TRIGGER_AFFIXES, LEGACY, MAX_PER_PLACEMENT, ramp, composedName, tierOf, ILVLS,
} = require('../seeds/data/affixTypes.js');
const {
  itemTags, eligibleAffixes, rollItemInstance, sampleAffixes, affixValue, rollTier, AFFIX_COUNT_RANGE,
} = require('../src/authority/affixes.js');
const { RULE_COMBINE } = require('../src/services/statComposition.js');
const { gearEntry, equippedAffixGrants, withGearAffixes } = require('../src/services/gearAffixes.js');
const { composeStats } = require('../src/services/statComposition.js');
const skillLeveling = require('../src/services/skillLeveling.js');

const ALL = [...NEW_AFFIXES, ...TRIGGER_AFFIXES];

// The catalog as the loaded pool has it (what server.js selects from affix_types).
let nextId = 100;
const POOL = ALL.map((a) => ({
  id: nextId += 1, key: a.key, label: a.label, kind: 'buff', effect: a.effect,
  min_value: a.tiers[0].min, max_value: a.tiers[a.tiers.length - 1].max, min_item_level: a.tiers[0].ilvl, max_item_level: null,
  allowed_slots: a.slots, allowed_tags: a.tags, min_rarity: a.rarity, weight: a.weight, placement: a.placement, group_key: a.group,
}));
const byKey = (k) => POOL.find((p) => p.key === k);

function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const T = {
  sword: { category: 'weapon', slot: 'main_hand', kind: 'melee', two_handed: false, name: 'iron-sword' },
  greatsword: { category: 'weapon', slot: 'main_hand', kind: 'melee', two_handed: true, name: 'two-handed sword' },
  quarterstaff: { category: 'weapon', slot: 'main_hand', kind: 'melee', two_handed: true, name: 'iron-quarterstaff' },
  bow: { category: 'weapon', slot: 'main_hand', kind: 'projectile', two_handed: true, name: 'runed-bow' },
  crossbow: { category: 'weapon', slot: 'main_hand', kind: 'projectile', two_handed: true, name: 'steel-crossbow' },
  sling: { category: 'weapon', slot: 'main_hand', kind: 'projectile', two_handed: false, name: 'sling' },
  staff: { category: 'weapon', slot: 'main_hand', kind: 'projectile', two_handed: true, name: 'obsidian-staff' },
  wand: { category: 'weapon', slot: 'main_hand', kind: 'projectile', two_handed: false, name: 'iron-wand' },
  scepter: { category: 'weapon', slot: 'main_hand', kind: 'projectile', two_handed: false, name: 'astral-scepter' },
  vest: { category: 'armor', slot: 'chest', kind: null, two_handed: false, name: 'vest' },
  ring: { category: 'armor', slot: 'ring1', kind: null, two_handed: false, name: 'iron band' },
  shield: { category: 'armor', slot: 'off_hand', kind: null, two_handed: false, name: 'buckler' },
};

// ---------------------------------------------------------------- the catalog is sound

test('the catalog: unique keys and labels, valid effects, sane tiers', () => {
  const keys = ALL.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate key');
  assert.equal(new Set(ALL.map((a) => a.label)).size, ALL.length, 'duplicate label');
  assert.ok(ALL.length >= 40, `expected a rich catalog, got ${ALL.length}`);
  const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];
  const TAGS = ['melee_weapon', 'ranged_weapon', 'caster_weapon', 'weapon', 'armor', 'ring'];
  const TYPES = ['stat', 'resource', 'damage', 'resist', 'rule', 'trigger'];
  for (const a of ALL) {
    assert.ok(['prefix', 'suffix'].includes(a.placement), `${a.key}: placement`);
    // A suffix reads "of X", a prefix does not: the item name is built from that.
    assert.equal(/^of\b/i.test(a.label), a.placement === 'suffix', `${a.key}: label "${a.label}" vs ${a.placement}`);
    assert.ok(TYPES.includes(a.effect.type), `${a.key}: effect type`);
    assert.ok(/\{v\}/.test(a.effect.text), `${a.key}: tooltip text needs {v}`);
    for (const s of a.slots) assert.ok(SLOTS.includes(s), `${a.key}: slot ${s}`);
    for (const t of a.tags) assert.ok(TAGS.includes(t), `${a.key}: tag ${t}`);
    assert.ok(['blue', 'yellow', 'foxy'].includes(a.rarity), `${a.key}: rarity`);
    assert.ok(a.weight > 0);
    assert.ok(a.tiers.length >= 2, `${a.key}: tiers`);
    let prevIlvl = 0;
    a.tiers.forEach((t) => {
      assert.ok(t.ilvl > prevIlvl, `${a.key}: tier item levels must ascend`);
      assert.ok(t.min <= t.max && t.min > 0, `${a.key}: tier range`);
      prevIlvl = t.ilvl;
    });
    assert.deepEqual(a.effect.tiers, a.tiers, `${a.key}: the tiers travel inside the effect`);
  }
});

test('every rule affix names a rule combat knows, and converts to a sane rule value at both ends of its range', () => {
  const MAX = { product: [0.5, 2], sum: [0, 50], min: [0, 1] };
  for (const a of ALL.filter((x) => x.effect.type === 'rule')) {
    const mode = RULE_COMBINE[a.effect.rule];
    assert.ok(mode, `${a.key}: ${a.effect.rule} is not in RULE_COMBINE`);
    for (const v of [a.tiers[0].min, a.tiers[a.tiers.length - 1].max]) {
      const out = gearEntry({ label: a.label, effect: a.effect, value: v }).value;
      assert.ok(Number.isFinite(out), `${a.key}@${v}`);
      assert.ok(out >= MAX[mode][0] && out <= MAX[mode][1], `${a.key}@${v} -> ${out} outside ${MAX[mode]}`);
      if (mode === 'product') {
        // A "more" rule is above 1, a "less" (cost, cooldown) below it, and never a free lunch: the floor is respected.
        assert.ok(out > 0.5 && out !== 1, `${a.key}@${v} -> ${out}`);
      }
    }
  }
});

test('every trigger affix is understood by the engine at its best and worst roll', () => {
  const { triggerOf } = require('../src/authority/triggers.js');
  for (const a of TRIGGER_AFFIXES) {
    for (const v of [a.tiers[0].min, a.tiers[a.tiers.length - 1].max]) {
      const t = triggerOf({ key: a.key, label: a.label, value: v, effect: a.effect });
      assert.ok(t, `${a.key}@${v} is not a runnable trigger`);
      assert.ok(t.chance > 0 && t.chance <= 1, `${a.key}: chance ${t.chance}`);
      if (a.effect.action === 'restore') assert.ok(t.magnitude > 0 && t.magnitude < 0.5);
      if (a.effect.action === 'buff') assert.ok(t.cooldownMs > 0, `${a.key}: a buff trigger needs a cooldown`);
    }
  }
});

test('the original twelve keep their rows and gain a placement; the catalog covers the examples that were asked for', () => {
  assert.equal(Object.keys(LEGACY).length, 12);
  for (const v of Object.values(LEGACY)) assert.ok(['prefix', 'suffix'].includes(v.placement));
  const has = (k) => assert.ok(byKey(k), `missing ${k}`);
  // Melee/bows: attack speed and physical damage. Bows/crossbows: projectiles and projectile speed.
  ['of_celerity', 'of_the_hawk', 'brutal', 'of_the_volley', 'of_the_gale', 'piercing'].forEach(has);
  // Staves and magic weapons: area of effect, spell level, elemental damage.
  ['sweeping', 'sagacious', 'blazing', 'glacial', 'thundering', 'eldritch'].forEach(has);
  // General: global crit, life, triggers.
  ['of_the_assassin', 'stalwart', 'of_embers', 'of_the_harvest', 'of_the_turtle'].forEach(has);
});

// ---------------------------------------------------------------- item families

test('weapons and armour fall into the families the affixes are written against', () => {
  const tags = (t) => [...itemTags(t)].sort();
  assert.ok(itemTags(T.sword).has('melee_weapon'));
  assert.ok(itemTags(T.quarterstaff).has('melee_weapon'), 'a quarterstaff is melee, whatever its name says');
  assert.ok(!itemTags(T.quarterstaff).has('caster_weapon'));
  for (const k of ['bow', 'crossbow', 'sling']) assert.ok(itemTags(T[k]).has('ranged_weapon'), k);
  for (const k of ['staff', 'wand', 'scepter']) assert.ok(itemTags(T[k]).has('caster_weapon'), k);
  assert.ok(!itemTags(T.staff).has('ranged_weapon'));
  assert.ok(itemTags(T.greatsword).has('two_handed') && itemTags(T.sword).has('one_handed'));
  assert.deepEqual(tags(T.vest), ['armor', 'chest']);
  assert.deepEqual(tags(T.ring), ['armor', 'ring', 'ring1']);
  assert.equal(itemTags(null).size, 0);
});

test('an affix only rolls on the families it is for', () => {
  const on = (item, rarity = 'foxy') => new Set(eligibleAffixes(POOL, { itemLevel: 90, rarity, slot: item.slot, tags: itemTags(item) }).map((a) => a.key));
  // A bow gets projectile affixes, never melee ones or caster ones.
  const bow = on(T.bow);
  for (const k of ['of_the_volley', 'of_the_gale', 'piercing', 'of_the_hawk', 'brutal']) assert.ok(bow.has(k), `bow ${k}`);
  for (const k of ['of_celerity', 'jagged', 'sweeping', 'sagacious', 'blazing', 'of_the_savant']) assert.ok(!bow.has(k), `bow must not get ${k}`);
  // A sword: melee speed, reach, physical; no projectiles, no spell levels.
  const sword = on(T.sword);
  for (const k of ['of_celerity', 'jagged', 'brutal', 'of_stunning']) assert.ok(sword.has(k), `sword ${k}`);
  for (const k of ['of_the_volley', 'piercing', 'sagacious', 'sweeping', 'of_the_hawk']) assert.ok(!sword.has(k), `sword must not get ${k}`);
  // A staff: area, spell level, elements, cast speed, projectile speed; not physical damage or melee speed.
  const staff = on(T.staff);
  for (const k of ['sweeping', 'sagacious', 'blazing', 'thundering', 'of_the_savant', 'of_the_gale']) assert.ok(staff.has(k), `staff ${k}`);
  for (const k of ['brutal', 'of_celerity', 'jagged', 'of_the_volley']) assert.ok(!staff.has(k), `staff must not get ${k}`);
  // Armour never gets weapon affixes; weapons never get armour-only ones.
  const vest = on(T.vest);
  for (const k of ['stalwart', 'of_regeneration', 'of_the_salamander', 'of_thorns', 'of_the_turtle']) assert.ok(vest.has(k), `vest ${k}`);
  for (const k of ['brutal', 'of_celerity', 'of_the_volley', 'of_precision', 'of_embers']) assert.ok(!vest.has(k), `vest must not get ${k}`);
  assert.ok(!on(T.sword).has('stalwart'));
});

test('a pool with no item to judge by behaves exactly as it did before tags existed', () => {
  const noTags = eligibleAffixes(POOL, { itemLevel: 90, rarity: 'foxy', slot: 'main_hand' });
  assert.ok(noTags.some((a) => a.key === 'of_the_volley') && noTags.some((a) => a.key === 'of_celerity'));
});

// ---------------------------------------------------------------- prefixes, suffixes, groups

test('an item never carries more than three prefixes or three suffixes, nor two of a group, nor a repeat', () => {
  const rng = seeded(7);
  for (const item of Object.values(T)) {
    for (let n = 0; n < 150; n += 1) {
      const r = rollItemInstance({ itemType: item, itemLevel: 100, rarity: 'foxy', affixPool: POOL }, rng);
      const rows = r.affixes.map((a) => POOL.find((p) => p.id === a.affixTypeId));
      assert.ok(rows.length <= 2 * MAX_PER_PLACEMENT, `${item.name}: ${rows.length} affixes`);
      assert.ok(rows.filter((x) => x.placement === 'prefix').length <= MAX_PER_PLACEMENT, `${item.name} prefixes`);
      assert.ok(rows.filter((x) => x.placement === 'suffix').length <= MAX_PER_PLACEMENT, `${item.name} suffixes`);
      assert.equal(new Set(rows.map((x) => x.key)).size, rows.length, 'a key repeated');
      const groups = rows.map((x) => x.group_key).filter(Boolean);
      assert.equal(new Set(groups).size, groups.length, `${item.name}: two of one group ${groups}`);
    }
  }
});

test('a foxy item fills up: six affixes where the catalog has enough for the item', () => {
  const rng = seeded(11);
  let full = 0;
  for (let n = 0; n < 60; n += 1) {
    const r = rollItemInstance({ itemType: T.staff, itemLevel: 100, rarity: 'foxy', affixPool: POOL }, rng);
    if (r.affixes.length === 2 * MAX_PER_PLACEMENT) full += 1;
  }
  assert.ok(full >= 20, `only ${full}/60 foxy staves came out with six affixes`);
});

test('the placement cap and group rule hold in sampleAffixes on their own', () => {
  const mk = (key, placement, group = null) => ({ key, placement, group_key: group, weight: 100 });
  const pool = [mk('p1', 'prefix'), mk('p2', 'prefix'), mk('p3', 'prefix'), mk('p4', 'prefix'), mk('s1', 'suffix'), mk('g1', 'suffix', 'x'), mk('g2', 'suffix', 'x')];
  for (let seed = 1; seed <= 40; seed += 1) {
    const out = sampleAffixes(pool, 7, seeded(seed));
    assert.ok(out.filter((a) => a.placement === 'prefix').length <= 3);
    assert.ok(out.filter((a) => a.group_key === 'x').length <= 1);
    assert.ok(out.length <= 3 + 2, `got ${out.length}`);
  }
  // Rows without a placement are only unique, not capped (the pre-expansion behaviour).
  const old = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, weight: 10 }));
  assert.equal(sampleAffixes(old, 9, seeded(3)).length, 9);
});

// ---------------------------------------------------------------- tiers

test('tiers follow item level: a low item never rolls a high tier, a high one rolls them all', () => {
  const brutal = byKey('brutal');
  const tiers = brutal.effect.tiers;
  const topAt = (lvl) => { const rng = seeded(9); return Math.max(...Array.from({ length: 600 }, () => affixValue(brutal, lvl, 'yellow', rng))); };
  assert.ok(topAt(5) <= tiers[0].max + 1e-9, 'an item level 5 stays in tier 5');
  assert.ok(topAt(25) <= tiers[1].max + 1e-9);
  assert.ok(topAt(100) > tiers[3].max, 'an item level 100 reaches the top tiers');
  const rng = seeded(4);
  for (let i = 0; i < 200; i += 1) {
    const v = affixValue(brutal, 100, 'blue', rng);
    assert.ok(v >= tiers[0].min && v <= tiers[4].max);
  }
});

test('better tiers are rarer, and a foxy item leans toward them', () => {
  const tiers = byKey('brutal').effect.tiers;
  const share = (rarity) => {
    const rng = seeded(5);
    let top = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) if (rollTier(tiers, 100, rarity, rng) === tiers[4]) top += 1;
    return top / n;
  };
  const blue = share('blue');
  const foxy = share('foxy');
  assert.ok(blue < 0.2, `top tier is ${blue} of blue rolls`);
  assert.ok(foxy > 0.35, `top tier is only ${foxy} of foxy rolls`);
  assert.ok(foxy > 2 * blue);
});

test('whole-number effects roll whole numbers; the rest keep two decimals; and tierOf reads a roll back', () => {
  const rng = seeded(6);
  for (let i = 0; i < 100; i += 1) {
    assert.ok(Number.isInteger(affixValue(byKey('jagged'), 100, 'yellow', rng)));
    assert.ok(Number.isInteger(affixValue(byKey('of_the_volley'), 100, 'yellow', rng)));
    assert.ok(Number.isInteger(affixValue(byKey('stalwart'), 100, 'yellow', rng)));
    const v = affixValue(byKey('of_precision'), 100, 'yellow', rng);
    assert.equal(Math.round(v * 100) / 100, v);
  }
  const t = byKey('brutal').effect.tiers;
  assert.equal(tierOf(t, t[4].max), 1);
  assert.equal(tierOf(t, t[0].min), 5);
  assert.equal(tierOf(t, t[2].min), 3);
  assert.equal(tierOf(null, 5), null);
  assert.equal(tierOf([], 5), null);
});

test('the original, untiered affixes roll exactly as before (level scale, foxy x1.25)', () => {
  const legacy = { id: 1, key: 'of_might', min_value: 1, max_value: 12, min_item_level: 1, effect: { type: 'stat', stat: 'strength' } };
  assert.equal(affixValue(legacy, 1, 'blue', () => 0), 1);
  assert.equal(affixValue(legacy, 1, 'blue', () => 1), 12);
  assert.equal(affixValue(legacy, 51, 'blue', () => 1), 18);
  assert.equal(affixValue(legacy, 1, 'foxy', () => 1), 15);
});

test('ramp interpolates the tiers linearly and keeps min <= max', () => {
  assert.deepEqual(ramp([4, 8], [34, 45]).map((t) => t.ilvl), ILVLS);
  const r = ramp([4, 8], [34, 45]);
  assert.deepEqual([r[0].min, r[0].max, r[4].min, r[4].max], [4, 8, 34, 45]);
  for (const t of r) assert.ok(t.min <= t.max);
  assert.deepEqual(ramp([1, 1], [5, 5], { int: true }).map((t) => t.min), [1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------- composition: the affixes change the game

test('a rule affix is rolled in player units and composed into the rule combat reads', () => {
  const celerity = byKey('of_celerity');
  const inv = {
    equipment: { main_hand: 'w' },
    items: [{ id: 'w', typeId: 1, affixes: [
      { key: 'of_celerity', label: 'of Celerity', value: 12, effect: celerity.effect },
      { key: 'of_precision', label: 'of Precision', value: 4, effect: byKey('of_precision').effect },
      { key: 'of_focus', label: 'of Focus', value: 10, effect: byKey('of_focus').effect },
      { key: 'sagacious', label: 'Sagacious', value: 2, effect: byKey('sagacious').effect },
      { key: 'of_the_volley', label: 'of the Volley', value: 1, effect: byKey('of_the_volley').effect },
    ] }],
  };
  const gear = equippedAffixGrants(inv);
  const composed = composeStats({ base: { strength: 5 }, passives: [], gear });
  assert.equal(composed.rules.attackSpeedMult, 1.12, '+12% attack speed is the multiplier 1.12');
  assert.equal(composed.rules.critChance, 0.04);
  assert.equal(composed.rules.skillCooldownMult, 0.9, '-10% cooldown is 0.90');
  assert.equal(composed.rules.spellLevelBonus, 2);
  assert.equal(composed.rules.projectileCount, 1);
});

test('rule gear stacks with the passive tree through the same combine rules', () => {
  const gear = [
    gearEntry({ label: 'a', effect: byKey('of_celerity').effect, value: 10 }),
    gearEntry({ label: 'b', effect: byKey('of_celerity').effect, value: 6 }),
  ];
  const tree = [{ type: 'rule', rule: 'attackSpeedMult', value: 1.08 }];
  const composed = composeStats({ base: {}, passives: tree, gear });
  assert.equal(composed.rules.attackSpeedMult, 1.24, 'x1.08 tree + 10% + 6% gear add as the passive tree does');
});

test('a trigger affix adds nothing to the stat sheet', () => {
  const inv = { equipment: { head: 'h' }, items: [{ id: 'h', typeId: 1, affixes: [
    { key: 'of_the_harvest', label: 'of the Harvest', value: 5, effect: byKey('of_the_harvest').effect },
    { key: 'of_embers', label: 'of Embers', value: 10, effect: byKey('of_embers').effect },
  ] }] };
  assert.deepEqual(equippedAffixGrants(inv), []);
});

test('item names are assembled from the first prefix and suffix', () => {
  const a = [{ label: 'Brutal' }, { label: 'of Celerity' }, { label: 'Vicious' }, { label: 'of Precision' }];
  assert.equal(composedName('Iron Sword', a), 'Brutal Iron Sword of Celerity');
  assert.equal(composedName('Iron Sword', [{ label: 'of Might' }]), 'Iron Sword of Might');
  assert.equal(composedName('Iron Sword', [{ label: 'Flaming' }]), 'Flaming Iron Sword');
  assert.equal(composedName('Iron Sword', []), 'Iron Sword');
  assert.equal(composedName('Iron Sword', null), 'Iron Sword');
});

// ---------------------------------------------------------------- spell levels

test('each extra spell level is worth more than a bought one, and nothing is free', () => {
  const cfg = skillLeveling.SKILL_LEVELING_CONFIG;
  assert.ok(cfg.bonusLevelPower > cfg.powerPerLevel, 'a level from gear beats a bought level');
  assert.equal(skillLeveling.bonusLevelMultiplier(0), 1);
  assert.equal(skillLeveling.bonusLevelMultiplier(3), Math.round((1 + 3 * cfg.bonusLevelPower) * 10000) / 10000);
  for (const bad of [-4, NaN, undefined, 'x']) assert.equal(skillLeveling.bonusLevelMultiplier(bad), 1);
  assert.equal(skillLeveling.bonusLevelMultiplier(2.9), skillLeveling.bonusLevelMultiplier(2));
  assert.throws(() => skillLeveling.buildSkillLevelingConfig({ bonusLevelPower: -1 }), /bonusLevelPower/);
});

test('combat reads spellLevelBonus for spells only', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/world.js'), 'utf8');
  assert.match(src, /skill\.type === 'magic' \? Math\.max\(0, Math\.floor\(rules\.spellLevelBonus/);
  assert.match(src, /skillLeveling\.bonusLevelMultiplier\(spellBonus\)/);
});

test('the rolling counts are unchanged, so existing drops balance as before', () => {
  assert.deepEqual(AFFIX_COUNT_RANGE, { white: [0, 0], blue: [1, 1], yellow: [3, 6], foxy: [3, 9] });
});
