// What each extra build VALUES, in the units path.mjs scores nodes with. See path.mjs for the scoring.
//   stat:   points per attribute point          pool:   points per 10 points of hp / mana / stamina
//   damage: points per % elemental damage       resist: points per % resistance
//   rule:   points per "percent-like" unit of the rule (see RULE_POINTS)
//   must:   node keys the route is forced through (a build's signature keystones)
// The numbers are tuned by looking at what the route picks (`make build-guides` prints a digest); they are
// a way to say "this build cares about crit and attribute damage, not about hp regeneration".

const ALL_RESIST = (n) => ({ physical: n, fire: n, ice: n, lightning: n, arcane: n });

export const WEIGHTS = {
  // ---- Warrior (main stat: strength) --------------------------------------------------------------
  warrior_bulwark: {
    startKey: 'start-strength',
    stat: { strength: 1.0, constitution: 1.0, dexterity: 0.15, default: 0.04 },
    pool: { hp: 1.0, stamina: 0.4, mana: 0 },
    damage: { physical: 0.25, default: 0.02 },
    resist: ALL_RESIST(1.0),
    rule: {
      hpRegen: 6, regenLifeShare: 4, staminaRegen: 2, staminaCostMult: 1.5, reflectShare: 3,
      dodgeChance: 1, killHeal: 20, strengthSkillDamage: 2, constitutionSkillDamage: 1, meleeReachBonus: 0.15,
    },
    must: [],
  },
  warrior_executioner: {
    startKey: 'start-strength',
    stat: { strength: 2.0, dexterity: 0.7, constitution: 0.5, default: 0.03 },
    pool: { hp: 0.4, stamina: 0.5, mana: 0 },
    damage: { physical: 1.1, default: 0.05 },
    resist: ALL_RESIST(0.1),
    rule: {
      critChance: 5, critDamage: 3, strengthSkillDamage: 5, dexteritySkillDamage: 2, lowLifeDamage: 2,
      attackSpeedMult: 3, skillCooldownMult: 4, staminaCostMult: 1.5, skillDamageMult: 1.2, stunChance: 1,
      staminaRegen: 1, cooldownFloor: 0,
    },
    must: ['strength-r3-3-13'],          // Unbreakable: +20 STR and +100 life, the way into the inner STR ring
  },

  // ---- Mage (main stat: intelligence) -------------------------------------------------------------
  mage_missiles: {
    startKey: 'start-intelligence',
    stat: { intelligence: 1.2, wisdom: 0.4, dexterity: 0.2, default: 0.03 },
    pool: { mana: 0.7, hp: 0.15, stamina: 0 },
    damage: { arcane: 1.3, fire: 0.3, ice: 0.3, lightning: 0.3, physical: 0.02 },
    resist: ALL_RESIST(0.15),
    rule: {
      castSpeedMult: 3, projectileCount: 30, projectileSpeedMult: 1, intelligenceSkillDamage: 5, critChance: 3,
      critDamage: 2, manaCostMult: 2, manaRegen: 2.5, skillCooldownMult: 3, fullManaDamage: 2.5, pierceBonus: 8,
      manaPerWisdom: 1,
    },
    must: [],
  },
  mage_storm: {
    startKey: 'start-intelligence',
    stat: { intelligence: 1.2, wisdom: 0.5, dexterity: 0.3, default: 0.03 },
    pool: { mana: 0.7, hp: 0.15, stamina: 0 },
    damage: { lightning: 1.6, arcane: 0.35, fire: 0.3, ice: 0.3, physical: 0.02 },
    resist: { lightning: 0.8, default: 0.15 },
    rule: {
      castSpeedMult: 3, aoeRadiusMult: 3, intelligenceSkillDamage: 5, stunChance: 3, critChance: 2.5, critDamage: 2,
      manaCostMult: 2, manaRegen: 2.5, skillCooldownMult: 3.5, projectileSpeedMult: 0.5,
    },
    status: { shock: 3 },
    must: ['intelligence-r2-4-8'],       // Storm Caller: +20% lightning damage, and your hits shock
  },

  // ---- Monk (main stat: wisdom) -------------------------------------------------------------------
  monk_fist: {
    startKey: 'start-wisdom',
    stat: { wisdom: 2.0, strength: 0.7, dexterity: 0.7, constitution: 0.35, default: 0.03 },
    pool: { hp: 0.4, mana: 0.45, stamina: 0.1 },
    damage: { physical: 0.8, default: 0.08 },
    resist: ALL_RESIST(0.2),
    rule: {
      attackSpeedMult: 3, critChance: 3, dodgeChance: 3, dodgeRiposte: 5, meleeReachBonus: 0.2, wisdomSkillDamage: 5,
      manaPerWisdom: 3, manaRegen: 1.2, meleeWaveShare: 8, hpRegen: 1.5, skillCooldownMult: 3, strengthSkillDamage: 1.5,
      dexteritySkillDamage: 1.5, critDamage: 2,
    },
    must: [],
  },
  monk_guardian: {
    startKey: 'start-wisdom',
    stat: { wisdom: 2.0, constitution: 0.9, intelligence: 0.3, default: 0.03 },
    pool: { hp: 0.8, mana: 0.6, stamina: 0.1 },
    damage: { default: 0.1 },
    resist: ALL_RESIST(0.9),
    rule: {
      hpRegen: 6, manaRegen: 3, regenLifeShare: 8, auraLeech: 8, auraRadius: 0.5, manaPerWisdom: 4,
      wisdomSkillDamage: 3, dodgeChance: 1, reflectShare: 4, killHeal: 10, constitutionSkillDamage: 2,
    },
    must: [],
  },

  // ---- Cultist (main stat: constitution; spells cost life) ---------------------------------------
  cultist_bone: {
    startKey: 'start-constitution',
    stat: { constitution: 1.2, intelligence: 0.45, charisma: 0.15, default: 0.03 },
    pool: { hp: 0.8, mana: 0.05, stamina: 0 },
    damage: { arcane: 0.7, physical: 0.35, default: 0.1 },
    resist: ALL_RESIST(0.35),
    rule: {
      constitutionSkillDamage: 5, lifeCostMultiplier: 4, skillLeech: 6, killHeal: 25, aoeRadiusMult: 3, critChance: 2,
      hpRegen: 5, regenLifeShare: 3, skillCooldownMult: 3, lowLifeDamage: 1.5, cooldownFloor: 0, castSpeedMult: 1,
    },
    must: [],
  },
  cultist_curse: {
    startKey: 'start-constitution',
    stat: { constitution: 1.0, charisma: 0.5, wisdom: 0.3, intelligence: 0.2, default: 0.03 },
    pool: { hp: 0.7, mana: 0.05, stamina: 0 },
    damage: { default: 0.15 },
    resist: ALL_RESIST(0.6),
    rule: {
      lifeCostMultiplier: 3, skillLeech: 8, killHeal: 15, regenLifeShare: 8, hpRegen: 8, skillCooldownMult: 4,
      lowLifeDamage: 3, stunChance: 2, constitutionSkillDamage: 3, charismaSkillDamage: 2, auraLeech: 4,
    },
    status: { shock: 1, chill: 1.5, burn: 1 },
    must: [],
  },

  // ---- Archer (main stat: dexterity) --------------------------------------------------------------
  archer_sniper: {
    startKey: 'start-dexterity',
    stat: { dexterity: 1.2, strength: 0.3, constitution: 0.2, default: 0.03 },
    pool: { stamina: 0.5, hp: 0.15, mana: 0 },
    damage: { physical: 0.7, default: 0.05 },
    resist: ALL_RESIST(0.1),
    rule: {
      critChance: 5, critDamage: 4, dexteritySkillDamage: 5, projectileSpeedMult: 1.5, pierceBonus: 10,
      skillCooldownMult: 2.5, staminaRegen: 1.5, staminaCostMult: 2.5, dodgeChance: 0.5, attackSpeedMult: 2,
      skillDamageMult: 1,
    },
    must: [],
  },
  archer_venom: {
    startKey: 'start-dexterity',
    stat: { dexterity: 1.0, constitution: 0.7, intelligence: 0.1, default: 0.03 },
    pool: { stamina: 0.7, hp: 0.5, mana: 0 },
    damage: { physical: 0.45, default: 0.05 },
    resist: ALL_RESIST(0.3),
    rule: {
      aoeRadiusMult: 3, skillCooldownMult: 4.5, staminaCostMult: 3, staminaRegen: 3, dodgeChance: 3, projectileCount: 25,
      projectileSpeedMult: 0.5, dexteritySkillDamage: 4, critChance: 1.5, stunChance: 3, hpRegen: 3, killHeal: 10,
    },
    status: { chill: 1, shock: 1 },
    must: [],
  },

  // ---- Druid (main stat: charisma; forms scale with "form power") ---------------------------------
  druid_wolf: {
    startKey: 'start-charisma',
    stat: { charisma: 1.6, strength: 0.4, dexterity: 0.3, constitution: 0.5, default: 0.03 },
    pool: { hp: 0.35, mana: 0.3, stamina: 0.15 },
    damage: { physical: 0.7, default: 0.05 },
    resist: ALL_RESIST(0.2),
    rule: {
      formPower: 6, attackSpeedMult: 4, critChance: 3, critDamage: 2, charismaSkillDamage: 5, dodgeChance: 1,
      hpRegen: 2, skillCooldownMult: 3, manaRegen: 1, manaCostMult: 1, regenLifeShare: 2,
    },
    must: ['charisma-r3-3-13', 'charisma-r3-2-19', 'charisma-r3-1-10'],  // Menagerie, Primal Form Mastery, Wolf Aspect
  },
  druid_moon: {
    startKey: 'start-charisma',
    stat: { charisma: 2.2, intelligence: 0.5, wisdom: 0.4, default: 0.03 },
    pool: { mana: 0.7, hp: 0.15, stamina: 0 },
    damage: { arcane: 0.9, lightning: 0.6, fire: 0.3, ice: 0.3, physical: 0.02 },
    resist: ALL_RESIST(0.2),
    rule: {
      castSpeedMult: 3, manaRegen: 2.5, manaCostMult: 2, charismaSkillDamage: 6, critChance: 2.5, critDamage: 2,
      aoeRadiusMult: 2.5, skillCooldownMult: 3, hpRegen: 1.5, regenLifeShare: 4, formPower: 0,
    },
    must: [],
  },
};
