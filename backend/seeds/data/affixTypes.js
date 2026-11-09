// The item affix catalog, v2. Path of Exile 1 is the model: an item's identity comes from WHICH modifiers it
// rolled, so most of them only roll on the kinds of item they make sense on, they come as prefixes and
// suffixes (at most three of each), they have tiers that unlock with item level, and two modifiers of the same
// family never share an item.
//
// Only the NEW affixes live here. The twelve original ones (of Might, of the Bear, Flaming...) stay in the
// database exactly as migration 1714440507000 made them; LEGACY below only gives them a placement and a group.
//
// What an entry means
//   placement   'prefix' | 'suffix'. An item rolls at most MAX_PER_PLACEMENT of each (authority/affixes.js).
//   tags        item tags it may roll on, ANY of them (authority/affixes.js#itemTags). [] = any item. Weapon families:
//                 melee_weapon   swords, axes, maces, daggers, spears, staves (quarter/halberd...)
//                 ranged_weapon  bows, crossbows, slings, darts
//                 caster_weapon  staves, wands, scepters
//               Armour/jewellery: armor, ring, plus its slot name.
//   slots       allowed_slots, as before ([] = any slot)
//   group       one affix per group on an item (two "attack speed" modifiers never meet)
//   tiers       [{ ilvl, min, max }] ascending by item level; an item rolls a tier it has the level for, and the
//               value inside it. Shown as T1 (best) .. Tn.
//   effect      what it does, in the shapes the stat composition already understands:
//                 stat / resource / damage / resist            value is added as is
//                 rule  { rule, base, scale }                   the composed rule gets base + value * scale
//                       (so an attack speed roll of 12 is the multiplier 1.12; a cooldown roll of 8 is 0.92)
//                 trigger { on, chance, ... }                   fires on a combat event (see authority/triggers.js)
//               effect.text is the tooltip line; {v} is the rolled value. effect.int rounds the roll to a whole number.
//
// The rules a `rule` affix names are the very ones the passive tree grants, consumed by the same combat code
// (RULE_COMBINE in services/statComposition.js), so a bow's "+N% attack speed" and a tree node's are one mechanic.

const MAX_PER_PLACEMENT = 3;

const ILVLS = [1, 20, 40, 60, 80];

// Five tiers, interpolated linearly from the lowest tier's range to the highest's.
function ramp(low, high, { ilvls = ILVLS, dp = 1, int = false } = {}) {
  const n = ilvls.length;
  const round = (v) => (int ? Math.round(v) : Math.round(v * 10 ** dp) / 10 ** dp);
  return ilvls.map((ilvl, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    const min = round(low[0] + (high[0] - low[0]) * t);
    const max = Math.max(min, round(low[1] + (high[1] - low[1]) * t));
    return { ilvl, min, max };
  });
}

// A few discrete steps (a whole extra projectile, a spell level): [[ilvl, min, max], ...].
const steps = (list) => list.map(([ilvl, min, max]) => ({ ilvl, min, max }));

const rule = (name, text, { base = 0, scale = 0.01, int = false } = {}) => ({ type: 'rule', rule: name, base, scale, int, text });
const dmg = (element, text) => ({ type: 'damage', element, text });
const res = (element, text) => ({ type: 'resist', element, text });
const pool = (name, text, extra = {}) => ({ type: 'resource', pool: name, text, ...extra });

const MELEE = ['melee_weapon'];
const RANGED = ['ranged_weapon'];
const CASTER = ['caster_weapon'];
const MAINHAND = ['main_hand'];
const BODY = ['chest', 'head', 'hands', 'feet'];
const JEWEL = ['ring1', 'ring2'];

// Rules whose rolls read better as decimals (a crit chance of 2.8%, 4.1 life per second); everything else rolls whole numbers.
const DECIMAL_RULES = new Set(['critChance', 'skillLeech', 'killHeal', 'hpRegen', 'manaRegen', 'staminaRegen', 'dodgeChance', 'stunChance']);

// { key, label, placement, effect, tiers, tags, slots, rarity, weight, group }
const def = (key, label, placement, effect, tiers, o = {}) => {
  const whole = effect.type === 'rule' ? !DECIMAL_RULES.has(effect.rule) : true;
  const rounded = whole
    ? tiers.map((t) => ({ ...t, min: Math.max(1, Math.round(t.min)), max: Math.max(1, Math.round(t.min), Math.round(t.max)) }))
    : tiers;
  const eff = { ...effect, ...(whole ? { int: true } : {}), tiers: rounded };
  return {
    key, label, placement, effect: eff, tiers: rounded,
    tags: o.tags || [], slots: o.slots || [], rarity: o.rarity || 'blue', weight: o.weight || 100, group: o.group || null,
  };
};

const ATTR_SKILL = [
  ['mighty', 'Mighty', 'strengthSkillDamage', 'Strength'],
  ['nimble', 'Nimble', 'dexteritySkillDamage', 'Dexterity'],
  ['hardy', 'Hardy', 'constitutionSkillDamage', 'Constitution'],
  ['brilliant', 'Brilliant', 'intelligenceSkillDamage', 'Intelligence'],
  ['serene', 'Serene', 'wisdomSkillDamage', 'Wisdom'],
  ['charismatic', 'Charismatic', 'charismaSkillDamage', 'Charisma'],
];

const RESISTS = [
  ['of_the_salamander', 'of the Salamander', 'fire', 'Fire'],
  ['of_the_yeti', 'of the Yeti', 'ice', 'Cold'],
  ['of_the_stormward', 'of the Stormward', 'lightning', 'Lightning'],
  ['of_the_veil', 'of the Veil', 'arcane', 'Arcane'],
  ['of_the_bulwark', 'of the Bulwark', 'physical', 'Physical'],
];

const ELEMENTAL = [
  ['blazing', 'Blazing', 'fire', 'Fire'],
  ['glacial', 'Glacial', 'ice', 'Cold'],
  ['thundering', 'Thundering', 'lightning', 'Lightning'],
  ['eldritch', 'Eldritch', 'arcane', 'Arcane'],
];

const NEW_AFFIXES = [
  // ---- weapons: damage -------------------------------------------------------------------------------
  def('brutal', 'Brutal', 'prefix', dmg('physical', '+{v}% Physical Damage'), ramp([4, 8], [34, 45]),
    { tags: [...MELEE, ...RANGED], slots: MAINHAND, group: 'phys_damage' }),
  ...ELEMENTAL.map(([key, label, el, name]) => def(key, label, 'prefix', dmg(el, `+{v}% ${name} Damage`), ramp([4, 8], [34, 46]),
    { tags: CASTER, slots: MAINHAND, group: `${el}_damage` })),
  def('vicious', 'Vicious', 'prefix', rule('critDamage', '+{v}% Critical Damage'), ramp([8, 12], [40, 55]),
    { slots: MAINHAND, group: 'crit_damage', weight: 80 }),
  def('jagged', 'Jagged', 'prefix', rule('meleeReachBonus', '+{v} Weapon Reach', { scale: 1, int: true }), ramp([3, 6], [18, 28], { int: true }),
    { tags: MELEE, slots: MAINHAND, weight: 60 }),
  def('piercing', 'Piercing', 'prefix', rule('pierceBonus', 'Projectiles pierce +{v} Targets', { scale: 1, int: true }),
    steps([[15, 1, 1], [55, 2, 2]]), { tags: RANGED, slots: MAINHAND, rarity: 'yellow', weight: 40, group: 'pierce' }),
  def('sweeping', 'Sweeping', 'prefix', rule('aoeRadiusMult', '+{v}% Area of Effect', { base: 1 }), ramp([4, 6], [20, 28]),
    { tags: CASTER, slots: [...MAINHAND, 'off_hand'], group: 'aoe' }),
  def('sagacious', 'Sagacious', 'prefix', rule('spellLevelBonus', '+{v} to Level of all Spells', { scale: 1, int: true }),
    steps([[20, 1, 1], [45, 1, 2], [70, 2, 3]]), { tags: CASTER, slots: MAINHAND, rarity: 'yellow', weight: 25, group: 'spell_level' }),

  // ---- weapons: speed, projectiles, crits --------------------------------------------------------------
  def('of_celerity', 'of Celerity', 'suffix', rule('attackSpeedMult', '+{v}% Attack Speed', { base: 1 }), ramp([3, 5], [16, 20]),
    { tags: MELEE, slots: MAINHAND, group: 'attack_speed' }),
  def('of_the_hawk', 'of the Hawk', 'suffix', rule('castSpeedMult', '+{v}% Attack Speed', { base: 1 }), ramp([3, 5], [16, 20]),
    { tags: RANGED, slots: MAINHAND, group: 'attack_speed' }),
  def('of_the_savant', 'of the Savant', 'suffix', rule('castSpeedMult', '+{v}% Cast Speed', { base: 1 }), ramp([3, 5], [16, 20]),
    { tags: CASTER, slots: MAINHAND, group: 'attack_speed' }),
  def('of_the_volley', 'of the Volley', 'suffix', rule('projectileCount', '+{v} Additional Projectiles', { scale: 1, int: true }),
    steps([[30, 1, 1], [65, 2, 2]]), { tags: RANGED, slots: MAINHAND, rarity: 'yellow', weight: 20, group: 'projectile_count' }),
  def('of_the_gale', 'of the Gale', 'suffix', rule('projectileSpeedMult', '+{v}% Projectile Speed', { base: 1 }), ramp([6, 10], [28, 40]),
    { tags: [...RANGED, ...CASTER], slots: MAINHAND, weight: 70 }),
  def('of_precision', 'of Precision', 'suffix', rule('critChance', '+{v}% Critical Chance'), ramp([1, 1.5], [5, 7]),
    { slots: MAINHAND, group: 'crit_chance' }),
  def('of_stunning', 'of Stunning', 'suffix', rule('stunChance', '+{v}% Chance to Stun'), ramp([1, 2], [6, 9]),
    { tags: MELEE, slots: MAINHAND, weight: 50 }),
  def('of_the_leech', 'of the Leech', 'suffix', rule('skillLeech', '{v}% of Skill Damage Leeched as Life'), ramp([1, 1.5], [4, 6]),
    { slots: [...MAINHAND, ...JEWEL], rarity: 'yellow', weight: 50, group: 'leech' }),
  def('of_the_slayer', 'of the Slayer', 'suffix', rule('killHeal', '+{v}% of Maximum Life on Kill'), ramp([0.2, 0.4], [1, 2]),
    { slots: [...MAINHAND, 'chest'], rarity: 'yellow', weight: 50, group: 'kill_heal' }),

  // ---- armour and jewellery: general ------------------------------------------------------------------
  def('stalwart', 'Stalwart', 'prefix', pool('hp', '+{v} Maximum Life', { int: true }), ramp([8, 16], [110, 150], { int: true }),
    { slots: [...BODY, 'off_hand'], group: 'life' }),
  def('of_the_assassin', 'of the Assassin', 'suffix', rule('critChance', '+{v}% Global Critical Chance'), ramp([0.5, 1], [3, 4]),
    { slots: ['head', 'hands', ...JEWEL], rarity: 'yellow', weight: 70, group: 'crit_chance' }),
  def('of_regeneration', 'of Regeneration', 'suffix', rule('hpRegen', '+{v} Life Regeneration per Second', { scale: 1 }), ramp([0.4, 0.8], [3.5, 5]),
    { slots: BODY, group: 'life_regen' }),
  def('of_recovery', 'of Recovery', 'suffix', rule('manaRegen', '+{v} Mana Regeneration per Second', { scale: 1 }), ramp([0.6, 1], [4, 6]),
    { slots: ['head', 'off_hand', ...JEWEL], group: 'mana_regen' }),
  def('of_endurance', 'of Endurance', 'suffix', rule('staminaRegen', '+{v} Stamina Regeneration per Second', { scale: 1 }), ramp([0.8, 1.5], [5, 8]),
    { slots: ['feet', 'hands', 'chest'], group: 'stamina_regen' }),
  def('of_evasion', 'of Evasion', 'suffix', rule('dodgeChance', '+{v}% Chance to Dodge'), ramp([1, 1.5], [6, 9]),
    { slots: ['head', 'hands', 'feet'], weight: 70 }),
  def('of_thorns', 'of Thorns', 'suffix', rule('reflectShare', 'Reflects {v}% of Damage Taken'), ramp([2, 3], [8, 11]),
    { slots: ['chest', 'off_hand'], weight: 50, group: 'reflect' }),
  def('of_the_beast', 'of the Beast', 'suffix', rule('formPower', 'Shapeshift forms {v}% stronger'), ramp([2, 4], [10, 14]),
    { slots: [...JEWEL, 'chest', 'hands'], rarity: 'yellow', weight: 40, group: 'form_power' }),
  ...RESISTS.map(([key, label, el, name]) => def(key, label, 'suffix', res(el, `+{v}% ${name} Resistance`), ramp([4, 8], [26, 34]),
    { slots: [...BODY, 'off_hand'], group: `resist_${el}` })),

  // ---- armour and jewellery: build-defining -------------------------------------------------------------
  ...ATTR_SKILL.map(([key, label, name, attr]) => def(key, label, 'prefix', rule(name, `+{v}% Damage with ${attr} Skills`), ramp([2, 3], [10, 14]),
    { slots: [...JEWEL, 'off_hand'], rarity: 'yellow', weight: 60, group: 'attribute_skill_damage' })),
  def('empowered', 'Empowered', 'prefix', rule('fullManaDamage', '+{v}% Damage at Full Mana'), ramp([4, 6], [24, 32]),
    { slots: [...JEWEL, 'off_hand'], rarity: 'yellow', weight: 50, group: 'conditional_damage' }),
  def('desperate', 'Desperate', 'prefix', rule('lowLifeDamage', '+{v}% Damage at Low Life'), ramp([4, 6], [24, 32]),
    { slots: [...JEWEL, 'off_hand'], rarity: 'yellow', weight: 50, group: 'conditional_damage' }),
  def('of_focus', 'of Focus', 'suffix', rule('skillCooldownMult', '-{v}% Skill Cooldown', { base: 1, scale: -0.01 }), ramp([2, 3], [9, 12]),
    { slots: [...JEWEL, 'off_hand'], rarity: 'yellow', weight: 50, group: 'cooldown' }),
  def('of_economy', 'of Economy', 'suffix', rule('manaCostMult', '-{v}% Mana Cost', { base: 1, scale: -0.01 }), ramp([2, 3], [9, 12]),
    { slots: ['head', 'off_hand', ...JEWEL], weight: 60, group: 'cost' }),
  def('of_the_marathon', 'of the Marathon', 'suffix', rule('staminaCostMult', '-{v}% Stamina Cost', { base: 1, scale: -0.01 }), ramp([2, 3], [9, 12]),
    { slots: ['hands', 'feet'], weight: 60, group: 'cost' }),
  def('of_the_martyr', 'of the Martyr', 'suffix', rule('lifeCostMultiplier', '-{v}% Life Cost', { base: 1, scale: -0.01 }), ramp([2, 3], [9, 12]),
    { slots: ['chest', ...JEWEL], weight: 40, group: 'cost' }),
];

// Trigger affixes (authority/triggers.js): they fire on a combat event. Added by a separate migration so a database
// that already has the rest gets them too. "valueIs" says what the rolled number means: the chance of it happening
// (percent), or its size (percent of the pool); the other half is fixed in the effect.
const trigger = (on, action, text, extra) => ({ type: 'trigger', on, action, text, ...extra });
const buff = (id, nameEn, nameUk, icon, iconColor, ms, fx) => ({ id, nameEn, nameUk, icon, iconColor, ms, fx });

const TRIGGER_AFFIXES = [
  // Enemies you hit may catch fire / chill / shock. Rolled value = the chance, per hit.
  def('of_embers', 'of Embers', 'suffix', trigger('hit', 'status', '{v}% chance to Ignite on Hit', { valueIs: 'chance', status: 'burn' }),
    ramp([3, 5], [12, 18]), { slots: MAINHAND, group: 'hit_status', weight: 70 }),
  def('of_the_frost_touch', 'of the Frost Touch', 'suffix', trigger('hit', 'status', '{v}% chance to Chill on Hit', { valueIs: 'chance', status: 'chill' }),
    ramp([3, 5], [12, 18]), { slots: MAINHAND, group: 'hit_status', weight: 70 }),
  def('of_the_storm_touch', 'of the Storm Touch', 'suffix', trigger('hit', 'status', '{v}% chance to Shock on Hit', { valueIs: 'chance', status: 'shock' }),
    ramp([2, 4], [8, 12]), { slots: MAINHAND, group: 'hit_status', rarity: 'yellow', weight: 40 }),

  // Killing a creature. Rolled value = the size (restore) or the chance (buff).
  def('of_the_harvest', 'of the Harvest', 'suffix', trigger('kill', 'restore', 'Killing a creature restores {v}% of Maximum Mana', { valueIs: 'magnitude', pool: 'mana' }),
    ramp([1, 2], [5, 8]), { slots: ['head', 'off_hand', ...JEWEL], group: 'kill_restore', weight: 60 }),
  def('of_the_hunter', 'of the Hunter', 'suffix', trigger('kill', 'restore', 'Killing a creature restores {v}% of Maximum Stamina', { valueIs: 'magnitude', pool: 'stamina' }),
    ramp([1, 2], [5, 8]), { slots: ['hands', 'feet', ...JEWEL], group: 'kill_restore', weight: 60 }),
  def('of_vengeance', 'of Vengeance', 'suffix',
    trigger('kill', 'buff', '{v}% chance on Kill to gain Fury: +15% damage for 6s', {
      valueIs: 'chance', cooldownMs: 3000, buff: buff('trg_fury', 'Fury', 'Лють', '🔥', '#f97316', 6000, { dealt: 1.15 }),
    }), ramp([8, 12], [30, 40]), { slots: [...MAINHAND, ...JEWEL], group: 'kill_buff', rarity: 'yellow', weight: 40 }),

  // Being hit. Rolled value = the chance; a cooldown keeps it from becoming permanent.
  def('of_the_turtle', 'of the Turtle', 'suffix',
    trigger('hurt', 'buff', '{v}% chance when Hit to gain Ward: -25% damage taken for 4s', {
      valueIs: 'chance', cooldownMs: 8000, buff: buff('trg_ward', 'Ward', 'Захисний покров', '🛡️', '#60a5fa', 4000, { taken: 0.75 }),
    }), ramp([6, 9], [20, 28]), { slots: ['chest', 'off_hand'], group: 'hurt_buff', rarity: 'yellow', weight: 40 }),
  def('of_the_phoenix', 'of the Phoenix', 'suffix',
    trigger('hurt', 'heal', '{v}% chance when Hit to restore 8% of Maximum Life', { valueIs: 'chance', magnitude: 0.08, cooldownMs: 10000 }),
    ramp([4, 6], [14, 20]), { slots: ['chest', 'head'], group: 'hurt_heal', rarity: 'yellow', weight: 40 }),
];

// The twelve original affixes: what they were before placement and groups existed. They also get a lower weight:
// at 100 each, the six plain stat suffixes alone outweighed the whole new catalog and every item came out as "of
// Might" again, which is exactly the sameness this expansion is about.
const LEGACY = {
  of_might: { placement: 'suffix', weight: 35 }, of_grace: { placement: 'suffix', weight: 35 }, of_vigor: { placement: 'suffix', weight: 35 },
  of_insight: { placement: 'suffix', weight: 35 }, of_clarity: { placement: 'suffix', weight: 35 }, of_presence: { placement: 'suffix', weight: 35 },
  of_the_bear: { placement: 'suffix', group: 'life', weight: 50 }, of_the_well: { placement: 'suffix', group: 'mana_regen', weight: 50 },
  flaming: { placement: 'prefix', group: 'fire_damage', weight: 40 }, freezing: { placement: 'prefix', group: 'ice_damage', weight: 40 },
  warded: { placement: 'prefix', group: 'resist_arcane', weight: 50 }, cursed: { placement: 'prefix' },
};

// An item's name, assembled from its first prefix and first suffix: "Brutal Iron Sword of Celerity".
// `affixes` carry { key, label }; prefix/suffix is read from the label ("of ..." is a suffix), so the
// same function names an item on the server and in the tooltip.
function composedName(baseName, affixes) {
  const labels = (affixes || []).map((a) => a && a.label).filter(Boolean);
  const prefix = labels.find((l) => !/^of\b/i.test(l));
  const suffix = labels.find((l) => /^of\b/i.test(l));
  return [prefix, baseName, suffix].filter(Boolean).join(' ');
}

// How good a roll is, 1 = best tier. null for an affix without tiers (the originals).
function tierOf(tiers, value) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const v = Number(value);
  let idx = 0;
  for (let i = 0; i < tiers.length; i += 1) if (v >= tiers[i].min - 1e-9) idx = i;
  return tiers.length - idx;
}

module.exports = { NEW_AFFIXES, TRIGGER_AFFIXES, LEGACY, MAX_PER_PLACEMENT, ramp, composedName, tierOf, ILVLS };
