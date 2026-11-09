// frontend/src/games/something2/src/js/core/skillsData.js
// The 300 active combat skills across the 6 playable classes (data generated from the server).
import { SKILLS as GENERATED_SKILLS } from "./skillsCatalog.generated.js";
import { t, getLang } from "../i18n/i18n.js";

// The catalog itself is GENERATED from the server's (backend/seeds/data/skills.js) by
// scripts/generate-skills-catalog.mjs -- including each skill's element, attribute and
// projectile flag -- so the two cannot drift. Copied here so the client can reorder its
// own list without disturbing the shared objects' array.
export const SKILLS = GENERATED_SKILLS.map((s) => ({ ...s }));

putDruidFormsFirst(SKILLS);

export const SKILLS_BY_CLASS = {
  Warrior: SKILLS.filter(s => s.class === 'Warrior'),
  Mage: SKILLS.filter(s => s.class === 'Mage'),
  Monk: SKILLS.filter(s => s.class === 'Monk'),
  Cultist: SKILLS.filter(s => s.class === 'Cultist'),
  Archer: SKILLS.filter(s => s.class === 'Archer'),
  Druid: SKILLS.filter(s => s.class === 'Druid'),
};

export const SKILLS_BY_ID = new Map(SKILLS.map(s => [s.id, s]));

// SOMET-618. Every skill id on both sides is class-prefixed (war_, mag_,
// mnk_, cul_, arc_, dru_); `plague_globule` was the one bare exception, drawn
// from before the Cultist prefix convention was applied everywhere else, and
// it drifted from the backend's `cul_plague_globule` (which keys catalog_art,
// textures and the authority's skill lookups). The id itself was already
// renamed to the convention-correct `cul_plague_globule` (SOMET-571); this
// map exists only so a hotbar slot or an "unlocked skill" flag saved to a
// player's localStorage under the OLD bare id before that rename still
// resolves, instead of silently losing the assignment/ownership. Keyed by
// the retired id, valued by the current one -- never the reverse.
export const LEGACY_SKILL_ID_ALIASES = Object.freeze({
  plague_globule: 'cul_plague_globule',
});

// Resolves a possibly-stale skill id (one a player's browser may still be
// holding from before a rename) to the id the current catalog actually uses.
// An id that is neither a known alias nor a current id is returned as-is --
// callers that look it up in SKILLS_BY_ID will correctly find nothing.
export function canonicalizeSkillId(id) {
  return LEGACY_SKILL_ID_ALIASES[id] || id;
}

export function getSkillsForClass(className) {
  if (!className || className === 'all' || className === 'All') return SKILLS;
  return SKILLS_BY_CLASS[className] || [];
}

export function getSkillById(id) {
  return SKILLS_BY_ID.get(canonicalizeSkillId(id)) || null;
}

export function getSkillIndexInClass(skill) {
  if (!skill) return 0;
  const classList = SKILLS_BY_CLASS[skill.class] || [];
  const idx = classList.findIndex(s => s.id === skill.id);
  return idx >= 0 ? idx : 0;
}

export function getSkillPrice(skill) {
  if (!skill) return 250;
  if (typeof skill.price === 'number') return skill.price;
  const idx = getSkillIndexInClass(skill);
  // Progressive curve from 250 gold (early skill) to 10,000 gold (ultimate skill)
  const raw = 250 + (10000 - 250) * Math.pow(idx / 49, 1.25);
  return Math.round(raw / 25) * 25;
}

export function getSkillTier(skill) {
  if (!skill) return 1;
  if (typeof skill.tier === 'number') return skill.tier;
  const idx = getSkillIndexInClass(skill);
  if (idx < 10) return 1;
  if (idx < 20) return 2;
  if (idx < 30) return 3;
  if (idx < 40) return 4;
  return 5;
}

export function getSkillTierName(tier) {
  switch (tier) {
    case 1: return 'Novice';
    case 2: return 'Adept';
    case 3: return 'Expert';
    case 4: return 'Master';
    case 5: return 'Grandmaster';
    default: return 'Novice';
  }
}

export function getSkillTierNameUk(tier) {
  switch (tier) {
    case 1: return 'Початківець';
    case 2: return 'Адепт';
    case 3: return 'Експерт';
    case 4: return 'Майстер';
    case 5: return 'Грандмайстер';
    default: return 'Початківець';
  }
}

export function getSkillLevelReq(skill) {
  if (!skill) return 1;
  if (typeof skill.levelReq === 'number') return skill.levelReq;
  const idx = getSkillIndexInClass(skill);
  return Math.min(50, Math.max(1, Math.floor(idx * 1.02) + 1));
}

// Enrich each skill in SKILLS
for (const s of SKILLS) {
  s.price = getSkillPrice(s);
  s.tier = getSkillTier(s);
  s.levelReq = getSkillLevelReq(s);
}

export function getRequiredForm(skill) {
  if (!skill) return null;
  if (skill.requiredForm) return skill.requiredForm;
  if (skill.class !== 'Druid') return null;
  // Transformation skills don't require a form to cast -- they ACTIVATE the form
  if (isTransformationSkill(skill)) return null;

  const text = `${skill.id} ${skill.nameEn} ${skill.loreEn || skill.descEn} ${skill.loreUk || skill.descUk}`.toLowerCase();
  if (text.includes('[bear]') || text.includes('[ведмідь]') || skill.id.startsWith('dru_bear_') || text.includes('ursoc') || text.includes('grizzly')) return 'bear';
  if (text.includes('[hawk]') || text.includes('[яструб]') || skill.id.startsWith('dru_hawk_')) return 'hawk';
  if (text.includes('[wolf]') || text.includes('[вовк]') || skill.id.startsWith('dru_wolf_') || text.includes('feral_bite')) return 'wolf';
  return null;
}

export function isTransformationSkill(skill) {
  if (!skill) return null;
  if (skill.id === 'dru_bear_form') return 'bear';
  if (skill.id === 'dru_hawk_form') return 'hawk';
  if (skill.id === 'dru_wolf_form') return 'wolf';
  return null;
}

export function isDruidExclusiveSkill(skill) {
  if (!skill) return false;
  if (skill.class === 'Druid') {
    if (isTransformationSkill(skill) || getRequiredForm(skill)) return true;
  }
  return false;
}

export function resolveSkillVfx(skill) {
  if (!skill) return 'generic_slash';
  if (skill.vfx) return skill.vfx;
  const id = skill.id || '';
  const el = skill.element || (skill.class === 'Mage' ? 'fire' : (skill.class === 'Druid' ? 'lightning' : (skill.class === 'Cultist' ? 'shadow' : 'physical')));

  if (id.includes('beam') || id.includes('disintegrate') || id.includes('laser')) return 'arcane_beam';
  if (id.includes('wall_of_fire') || id.includes('fire_wall')) return 'fire_wall';
  if (id.includes('blast_wave') || id.includes('combustion')) return 'blast_wave';
  if (id.includes('mirror_image') || id.includes('clone')) return 'mirror_image';
  if (id.includes('temporal_warp') || id.includes('time_warp')) return 'temporal_warp';
  if (id.includes('prismatic')) return 'prismatic_burst';
  if (id.includes('polymorph')) return 'polymorph';
  if (id.includes('ball_lightning')) return 'ball_lightning';
  if (id.includes('gravity') || id.includes('singularity') || id.includes('black_hole')) return 'gravity_singularity';
  if (id.includes('blink') || id.includes('teleport') || id.includes('shadow_step')) return 'blink_flash';

  if (id.includes('barrage')) return 'barrage_shot';
  if (id.includes('rain_of_arrows') || id.includes('volley')) return 'rain_of_arrows';
  if (id.includes('poison_dart') || id.includes('venom')) return 'poison_dart';
  if (id.includes('caltrop')) return 'caltrops';
  if (id.includes('shuriken')) return 'shuriken';

  if (id.includes('scythe')) return 'scythe_sweep';
  if (id.includes('blood')) return 'blood_surge';
  if (id.includes('skull')) return 'skull_bolt';

  if (id.includes('holy_cross')) return 'holy_cross';
  if (id.includes('hammer')) return 'hammer_smash';
  if (id.includes('tornado') || id.includes('cyclone')) return 'tornado';
  if (id.includes('seed')) return 'nature_seed';

  if (id.includes('fireball') || id.includes('flame_orb') || id.includes('pyro')) return 'fireball_blast';
  if (id.includes('flame') || id.includes('fire') || id.includes('incinerat')) return 'flame_wave';
  if (id.includes('meteor') || id.includes('volcan')) return 'meteor_impact';
  if (id.includes('combust') || id.includes('blast') || id.includes('ignit')) return 'combustion';

  if (id.includes('chain_lightning') || id.includes('chain')) return 'chain_lightning';
  if (id.includes('lightning') || id.includes('storm_bolt') || id.includes('thunder_strike')) return 'lightning_strike';
  if (id.includes('thunder') || id.includes('static_nova')) return 'thunder_clap';
  if (id.includes('storm') || id.includes('tempest')) return 'storm_burst';

  if (id.includes('frost_nova') || id.includes('ice_ring') || id.includes('freeze')) return 'frost_nova';
  if (id.includes('ice_shard') || id.includes('frost_bolt') || id.includes('icicle')) return 'ice_shard';
  if (id.includes('blizzard') || id.includes('ice_storm')) return 'blizzard_blast';
  if (id.includes('glacial') || id.includes('frost_spike') || id.includes('piercing_cold')) return 'glacial_spike';

  if (id.includes('holy_pillar') || id.includes('pillar_of_light') || id.includes('sunbeam')) return 'holy_pillar';
  if (id.includes('smite') || id.includes('divine_blade') || id.includes('radiant_strike')) return 'divine_smite';
  if (id.includes('holy_nova') || id.includes('consecrat') || id.includes('blessing')) return 'holy_nova';
  if (id.includes('judgment') || id.includes('ray_of_light') || id.includes('radiant_beam')) return 'judgment_ray';

  if (id.includes('shadow_vortex') || id.includes('abyss')) return 'shadow_vortex';
  if (id.includes('void_bolt') || id.includes('shadow_bolt') || id.includes('dark_orb')) return 'void_bolt';
  if (id.includes('drain') || id.includes('siphon') || id.includes('life_tap')) return 'soul_drain';
  if (id.includes('curse') || id.includes('decay') || id.includes('agony') || id.includes('plague')) return 'curse_blast';

  if (id.includes('entangling') || id.includes('roots') || id.includes('nature') || id.includes('thorn')) return 'entangling_roots';
  if (id.includes('maul') || id.includes('swipe') || id.includes('bear')) return 'bear_maul';
  if (id.includes('bite') || id.includes('shred') || id.includes('wolf')) return 'wolf_bite';
  if (id.includes('talon') || id.includes('swoop') || id.includes('hawk')) return 'hawk_talon';

  if (id.includes('whirlwind') || id.includes('spin')) return 'whirlwind';
  if (id.includes('crush') || id.includes('slam') || id.includes('smash')) return 'crushing_blow';
  if (id.includes('shield')) return 'shield_slam';
  if (id.includes('cleave') || id.includes('sweep')) return 'cleave';
  if (id.includes('thrust') || id.includes('pierce') || id.includes('lunge')) return 'piercing_thrust';
  if (id.includes('stab') || id.includes('backstab') || id.includes('assassin') || id.includes('shadowstep')) return 'backstab';

  if (skill.type === 'magic' || skill.type === 'buff' || skill.type === 'debuff') {
    if (el === 'fire') return 'combustion';
    if (el === 'lightning') return 'lightning_strike';
    if (el === 'ice') return 'frost_nova';
    if (el === 'holy') return 'holy_pillar';
    if (el === 'shadow') return 'shadow_vortex';
    return 'spark_arcane';
  }

  if (skill.type === 'melee') {
    return 'slash_heavy';
  }

  return 'generic_slash';
}

// The line the skill card prints next to the damage icon. Everything comes from the
// catalog (the server's numbers, generated onto each skill): `units` is one cast's
// damage in average-weapon hits of the skill's level and `hits` how many blows it
// splits into. It used to regex the description for a percentage and special-case
// ids, and so printed numbers that were never the server's.
const fmt = (n) => String(Math.round(n * 10) / 10);

export function resolveSkillDamage(skill, playerPools = null) {
  if (!skill) return { base: 0, hits: 0, text: t("{n} Damage", { n: 12 }) };
  if (skill.type === 'buff') {
    // The two buffs whose card shows the live amount for THIS character: an instant
    // heal or mana restore. The percent is read off the generated sentence, which is
    // built from the server's table ("Heals 30% of max life at once.").
    const en = skill.descEn || '';
    const heal = en.match(/Heals ([0-9]+)% of max life at once/);
    if (heal) {
      const pct = parseInt(heal[1], 10);
      const maxHp = (playerPools && (playerPools.maxHp != null ? playerPools.maxHp : playerPools.hp)) || null;
      return { base: 0, hits: 0, text: maxHp ? t("Heal +{pct}% HP (+{n} HP)", { pct, n: Math.max(1, Math.round(maxHp * pct / 100)) }) : t("Heal +{pct}% HP", { pct }) };
    }
    const mana = en.match(/Restores ([0-9]+)% of max mana at once/);
    if (mana) {
      const pct = parseInt(mana[1], 10);
      const maxMana = (playerPools && (playerPools.maxMana != null ? playerPools.maxMana : playerPools.mana)) || null;
      return { base: 0, hits: 0, text: maxMana ? t("Restores +{pct} MP (+{n} MP)", { pct: `${pct}%`, n: Math.max(1, Math.round(maxMana * pct / 100)) }) : t("Restores +{pct} MP", { pct: `${pct}%` }) };
    }
    return { base: 0, hits: 0, text: t("Buff / Utility") };
  }
  const units = Number(skill.units);
  const hits = Math.max(1, Number(skill.hits) || 1);
  if (!(units > 0)) return { base: 0, hits: 0, text: t("Curse / Debuff") };
  if (skill.channeled) {
    // `units` is one tick; the client ticks four times a second.
    return { base: units, hits, text: t("{n}x weapon damage per second", { n: fmt(units * 4) }) };
  }
  if (hits > 1) {
    return { base: units / hits, hits, text: t("{hits} x {n}x weapon damage", { hits, n: fmt(units / hits) }) };
  }
  return { base: units, hits: 1, text: t("{n}x weapon damage", { n: fmt(units) }) };
}

// The description to show in the player's language. Generated from the data
// (seeds/data/skillDescriptions.js), so it is already in both languages and is NOT
// run through the dictionary.
export function skillDescription(skill) {
  if (!skill) return '';
  return getLang() === 'uk' ? (skill.descUk || skill.descEn || '') : (skill.descEn || skill.descUk || '');
}

// The druid's shapes open the class: they take the first three druid slots (level 1,
// no attributes) and the skills that used to open it move to the shapes' old slots.
const DRUID_FORM_IDS = ['dru_bear_form', 'dru_hawk_form', 'dru_wolf_form'];
function putDruidFormsFirst(list) {
  const first = [];
  list.forEach((s, i) => { if (s.class === 'Druid' && first.length < 3) first.push(i); });
  ['dru_bear_form', 'dru_hawk_form', 'dru_wolf_form'].forEach((id, k) => {
    const at = list.findIndex((s) => s.id === id);
    if (at > first[k]) { const t = list[first[k]]; list[first[k]] = list[at]; list[at] = t; }
  });
}

// Story gates for gems. A gem past the early game also needs a landmark boss
// quest done (on top of its level and attributes); the late, rare ones are
// "secret" - invisible in the merchant until those conditions are met.
// Quest KEYS (seeds/data/questsData.js); the client resolves titles for messages.
const GEM_GATE_QUESTS = [
  { minLvl: 52, quest: 'act4_primordial_sovereign' },
  { minLvl: 40, quest: 'act3_nether_behemoth' },
  { minLvl: 28, quest: 'act2_obsidian_drake' },
  { minLvl: 16, quest: 'act1_sunspire_reliquary' },
];
function gemQuestGate(reqLvl) {
  const g = GEM_GATE_QUESTS.find((x) => reqLvl >= x.minLvl);
  return g ? [g.quest] : [];
}

export function enrichSkillGems(list) {
  const classCounters = {};
  for (const s of list) {
    const cls = s.class || 'Warrior';
    classCounters[cls] = (classCounters[cls] || 0) + 1;
    const idx = classCounters[cls]; // 1..50
    
    // Level requirement curve: Level 1 to 50
    // Starter skills (1..3) require Level 1 so players can immediately use them!
    let reqLvl;
    if (idx <= 3) reqLvl = 1;
    else if (idx <= 10) reqLvl = 2 + (idx - 4) * 2; // 2, 4, 6, 8, 10, 12, 14
    else if (idx <= 25) reqLvl = 16 + Math.floor((idx - 11) * 1.5); // 16..37
    else reqLvl = 38 + Math.floor((idx - 26) * 0.9); // 38..60

    s.reqLvl = reqLvl;
    s.isGem = true;

    // Gem Color & 6-Attribute Requirements (Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma)
    // Starting skills have gentle requirements (5-6 primary attribute) that starting characters with 10 stats fulfill easily.
    if (cls === 'Warrior') {
      s.gemColor = 'red';
      s.reqStr = idx <= 3 ? 5 + idx : Math.round(6 + reqLvl * 0.5);
      s.reqCon = idx <= 3 ? 4 + idx : Math.round(4 + reqLvl * 0.35);
      s.reqDex = idx <= 3 ? 2 : Math.round(2 + reqLvl * 0.15);
      s.reqInt = 0;
      s.reqWis = 0;
      s.reqCha = 0;
      s.reqWeapon = s.type === 'melee' ? 'melee' : (s.type === 'magic' ? 'melee' : 'any');
    } else if (cls === 'Archer') {
      s.gemColor = 'green';
      s.reqDex = idx <= 3 ? 5 + idx : Math.round(6 + reqLvl * 0.5);
      // Same as the server (backend/seeds/data/skills.js): no Wisdom, more Constitution.
      s.reqWis = 0;
      s.reqCon = idx <= 3 ? 3 : Math.round(3 + reqLvl * 0.3);
      s.reqStr = 0;
      s.reqInt = 0;
      s.reqCha = 0;
      const isDagger = s.id.includes('knife') || s.id.includes('dagger') || s.id.includes('stab') || s.id.includes('shadow_step');
      const isBow = s.id.includes('arrow') || s.id.includes('shot') || s.id.includes('barrage') || s.id.includes('snipe') || s.id.includes('volley') || s.id.includes('strafe') || s.id.includes('quiver');
      s.reqWeapon = isBow ? 'bow' : (isDagger ? 'dagger' : (s.type === 'melee' ? 'dagger' : (s.type === 'buff' ? 'any' : 'bow')));
    } else if (cls === 'Mage') {
      s.gemColor = 'blue';
      s.reqInt = idx <= 3 ? 5 + idx : Math.round(6 + reqLvl * 0.5);
      s.reqWis = idx <= 3 ? 4 + idx : Math.round(4 + reqLvl * 0.35);
      s.reqCon = idx <= 3 ? 2 : Math.round(2 + reqLvl * 0.15);
      s.reqStr = 0;
      s.reqDex = 0;
      s.reqCha = 0;
      s.reqWeapon = s.type === 'buff' ? 'any' : 'staff_wand';
    } else if (cls === 'Cultist') {
      s.gemColor = 'purple';
      s.reqCha = idx <= 3 ? 5 + idx : Math.round(5 + reqLvl * 0.45);
      s.reqInt = idx <= 3 ? 5 + idx : Math.round(5 + reqLvl * 0.4);
      s.reqCon = idx <= 3 ? 3 : Math.round(3 + reqLvl * 0.3);
      s.reqStr = 0;
      s.reqDex = 0;
      s.reqWis = 0;
      s.reqWeapon = s.type === 'buff' ? 'any' : (s.type === 'melee' ? 'dagger' : 'staff_wand');
    } else if (cls === 'Monk') {
      s.gemColor = 'orange';
      s.reqDex = idx <= 3 ? 5 + idx : Math.round(5 + reqLvl * 0.4);
      s.reqWis = idx <= 3 ? 5 + idx : Math.round(5 + reqLvl * 0.4);
      s.reqStr = idx <= 3 ? 3 : Math.round(3 + reqLvl * 0.25);
      s.reqCon = idx <= 3 ? 3 : Math.round(3 + reqLvl * 0.25);
      s.reqInt = 0;
      s.reqCha = 0;
      s.reqWeapon = s.type === 'buff' ? 'any' : 'unarmed';
    } else if (cls === 'Druid') {
      s.gemColor = 'hybrid';
      // Charisma is the Druid's main attribute: her gems are gated by it (and
      // scale with it, see playerStats charismaMult), with a little CON and WIS.
      s.reqCha = idx <= 3 ? 5 + idx : Math.round(5 + reqLvl * 0.5);
      s.reqCon = idx <= 3 ? 3 : Math.round(3 + reqLvl * 0.25);
      s.reqWis = idx <= 3 ? 3 : Math.round(3 + reqLvl * 0.2);
      s.reqStr = 0;
      s.reqDex = 0;
      s.reqInt = 0;
      const isTransform = s.id.includes('form') || s.id.includes('shapeshift') || s.id.includes('bear') || s.id.includes('wolf') || s.id.includes('hawk');
      s.reqWeapon = isTransform ? 'any' : (s.type === 'magic' ? 'staff_wand' : 'any');
      // The three shapes are the druid's opening skills: no attribute needed.
      if (DRUID_FORM_IDS.includes(s.id)) { s.reqStr = 0; s.reqDex = 0; s.reqCon = 0; s.reqWis = 0; s.reqCha = 0; }
    }

    // Gem Price in Gold for Gem Merchant (Starter gems 100g; subsequent gems scaled up from 350g to 7000g)
    const basePrice = Math.max(100, Math.round(100 + reqLvl * 25 + (idx - 1) * 30));
    s.gemPrice = idx === 1 ? 100 : Math.round(basePrice * 2.5);
    // The three druid shapes cost the same.
    if (DRUID_FORM_IDS.includes(s.id)) s.gemPrice = 100;

    // Gem Tags
    const tags = [];
    if (s.reqStr > 0) tags.push('Strength');
    if (s.reqDex > 0) tags.push('Dexterity');
    if (s.reqCon > 0) tags.push('Constitution');
    if (s.reqInt > 0) tags.push('Intelligence');
    if (s.reqWis > 0) tags.push('Wisdom');
    if (s.reqCha > 0) tags.push('Charisma');

    if (s.type === 'melee') tags.push('Attack', 'Melee');
    else if (s.type === 'magic') tags.push('Spell');
    else if (s.type === 'buff') tags.push('Buff', 'Aura');
    else if (s.type === 'debuff') tags.push('Curse', 'Debuff');

    if (s.reqWeapon === 'bow') tags.push('Bow');
    if (s.reqWeapon === 'staff_wand') tags.push('Staff/Wand');
    if (s.reqWeapon === 'unarmed') tags.push('Martial');

    s.gemTags = tags;
    s.reqQuests = gemQuestGate(reqLvl);
    s.secretGem = idx >= 31;
  }
}

enrichSkillGems(SKILLS);

export function getWeaponCategory(item) {
  if (!item || item === 'unarmed') return 'unarmed';
  const n = (typeof item === 'string' ? item : (item.name || '')).toLowerCase();
  if (n === 'unarmed' || !n) return 'unarmed';
  if (n.includes('bow') || n.includes('arbalest') || n.includes('sling') || n.includes('dart') || (typeof item === 'object' && item.ammo_type_id)) {
    return 'bow';
  }
  if (n.includes('staff') || n.includes('wand') || n.includes('magic-bolt') || n.includes('scepter')) {
    return 'staff_wand';
  }
  if (n.includes('dagger') || n.includes('knife')) {
    return 'dagger';
  }
  if (n.includes('sword') || n.includes('blade') || n.includes('spear') || n.includes('halberd') ||
      n.includes('scythe') || n.includes('club') || n.includes('stick') || n.includes('quarterstaff') ||
      n.includes('morning star') || n.includes('pike') || n.includes('axe') || n.includes('mace') ||
      n.includes('hammer') || n.includes('flail') || n.includes('cleaver')) {
    return 'melee';
  }
  if (typeof item === 'object' && item.category === 'weapon') {
    return item.kind === 'projectile' ? 'staff_wand' : 'melee';
  }
  return 'unarmed';
}

export function isWeaponCompatible(reqWeapon, weaponCategory) {
  if (!reqWeapon || reqWeapon === 'any') return true;
  if (reqWeapon === 'unarmed') return weaponCategory === 'unarmed' || weaponCategory === 'melee' || weaponCategory === 'dagger';
  if (reqWeapon === 'melee') return weaponCategory === 'melee' || weaponCategory === 'dagger';
  if (reqWeapon === 'bow') return weaponCategory === 'bow';
  if (reqWeapon === 'staff_wand') return weaponCategory === 'staff_wand';
  if (reqWeapon === 'dagger') return weaponCategory === 'dagger';
  return true;
}

export function getWeaponRequirementName(reqWeapon) {
  if (reqWeapon === 'bow') return 'Bow / Crossbow';
  if (reqWeapon === 'melee') return 'Melee Weapon (Sword, Axe, Spear)';
  if (reqWeapon === 'staff_wand') return 'Staff or Wand';
  if (reqWeapon === 'dagger') return 'Dagger or Knife';
  if (reqWeapon === 'unarmed') return 'Unarmed or Fists/Quarterstaff';
  return 'Any Weapon';
}

function getStatValue(prog, fullKey, shortKey) {
  if (!prog) return 0;
  let val = 0;
  if (prog.sources && prog.sources[fullKey]) {
    const s = prog.sources[fullKey];
    const sum = (Number(s.base) || 0) + (Number(s.tree) || 0) + (Number(s.gear) || 0);
    if (sum > val) val = sum;
  }
  if (prog[fullKey] != null && !isNaN(Number(prog[fullKey])) && Number(prog[fullKey]) > val) {
    val = Number(prog[fullKey]);
  }
  if (prog[shortKey] != null && !isNaN(Number(prog[shortKey])) && Number(prog[shortKey]) > val) {
    val = Number(prog[shortKey]);
  }
  if (prog.stats) {
    if (prog.stats[fullKey] != null && !isNaN(Number(prog.stats[fullKey])) && Number(prog.stats[fullKey]) > val) {
      val = Number(prog.stats[fullKey]);
    }
    if (prog.stats[shortKey] != null && !isNaN(Number(prog.stats[shortKey])) && Number(prog.stats[shortKey]) > val) {
      val = Number(prog.stats[shortKey]);
    }
  }
  const baseKey = `base${fullKey.charAt(0).toUpperCase() + fullKey.slice(1)}`;
  if (prog[baseKey] != null && !isNaN(Number(prog[baseKey])) && Number(prog[baseKey]) > val) {
    val = Number(prog[baseKey]);
  }
  return val;
}

// How a gem presents to a player:
//   unlocked   already owned
//   available  level, attributes and story gates are met - it can be obtained
//   locked     known, but something is missing (req.message says what)
//   hidden     a sealed slot: a secret gem whose story gate is closed, or one
//              far beyond the player's level - not listed at all
// Weapon fit is an equip-time condition, not an availability one.
export const GEM_REVEAL_LEVELS_AHEAD = 10;
export function gemVisibility(gem, req, owned, playerLevel = 1) {
  if (owned) return 'unlocked';
  if (!gem || !req) return 'locked';
  const obtainable = req.levelOk && req.strOk && req.dexOk && req.conOk && req.intOk && req.wisOk && req.chaOk && req.questsOk;
  if (obtainable) return 'available';
  if (gem.secretGem && !req.questsOk) return 'hidden';
  if ((gem.reqLvl || 1) > (Number(playerLevel) || 1) + GEM_REVEAL_LEVELS_AHEAD) return 'hidden';
  return 'locked';
}

export function checkGemRequirements(gem, playerProgression, equippedWeapon, ctx = null) {
  if (!gem) return { ok: true, errors: [] };
  const lvl = playerProgression?.level ?? playerProgression?.lvl ?? 1;
  const str = getStatValue(playerProgression, 'strength', 'str');
  const dex = getStatValue(playerProgression, 'dexterity', 'dex');
  const con = getStatValue(playerProgression, 'constitution', 'con');
  const int = getStatValue(playerProgression, 'intelligence', 'int');
  const wis = getStatValue(playerProgression, 'wisdom', 'wis');
  const cha = getStatValue(playerProgression, 'charisma', 'cha');

  const weaponCategory = getWeaponCategory(equippedWeapon);
  const weaponOk = isWeaponCompatible(gem.reqWeapon, weaponCategory);
  const levelOk = lvl >= (gem.reqLvl || 1);
  const strOk = str >= (gem.reqStr || 0);
  const dexOk = dex >= (gem.reqDex || 0);
  const conOk = con >= (gem.reqCon || 0);
  const intOk = int >= (gem.reqInt || 0);
  const wisOk = wis >= (gem.reqWis || 0);
  const chaOk = cha >= (gem.reqCha || 0);

  const errors = [];
  if (!weaponOk) {
    errors.push(t("Requires {weapon} (Equipped: {equipped})", { weapon: t(getWeaponRequirementName(gem.reqWeapon)), equipped: equippedWeapon?.name ? t(equippedWeapon.name) : t("Unarmed") }));
  }
  if (!levelOk) {
    errors.push(t("Requires Level {need} (You are Level {have})", { need: gem.reqLvl, have: lvl }));
  }
  if (!strOk) {
    errors.push(t("Requires {need} Strength (You have {have})", { need: gem.reqStr, have: str }));
  }
  if (!dexOk) {
    errors.push(t("Requires {need} Dexterity (You have {have})", { need: gem.reqDex, have: dex }));
  }
  if (!conOk) {
    errors.push(t("Requires {need} Constitution (You have {have})", { need: gem.reqCon, have: con }));
  }
  if (!intOk) {
    errors.push(t("Requires {need} Intelligence (You have {have})", { need: gem.reqInt, have: int }));
  }
  if (!wisOk) {
    errors.push(t("Requires {need} Wisdom (You have {have})", { need: gem.reqWis, have: wis }));
  }
  if (!chaOk) {
    errors.push(t("Requires {need} Charisma (You have {have})", { need: gem.reqCha, have: cha }));
  }

  // Story requirements. Only enforced when the caller knows the player's
  // completed quests (ctx.completedQuests); questTitles maps key -> title.
  const needQuests = Array.isArray(gem.reqQuests) ? gem.reqQuests : [];
  const doneQuests = ctx && ctx.completedQuests
    ? (ctx.completedQuests instanceof Set ? ctx.completedQuests : new Set(ctx.completedQuests))
    : null;
  const missingQuests = doneQuests ? needQuests.filter((k) => !doneQuests.has(k)) : [];
  const questsOk = missingQuests.length === 0;
  for (const k of missingQuests) {
    const title = (ctx.questTitles && ctx.questTitles[k]) || k;
    errors.push(t("Requires completing quest \"{title}\"", { title: t(title) }));
  }
  // One readable line naming everything that is missing.
  const missing = [];
  if (!levelOk) missing.push(t("Level {n}", { n: gem.reqLvl }));
  for (const [ok, need, name] of [[strOk, gem.reqStr, "{n} Strength"], [dexOk, gem.reqDex, "{n} Dexterity"], [conOk, gem.reqCon, "{n} Constitution"],
    [intOk, gem.reqInt, "{n} Intelligence"], [wisOk, gem.reqWis, "{n} Wisdom"], [chaOk, gem.reqCha, "{n} Charisma"]]) {
    if (!ok) missing.push(t(name, { n: need }));
  }
  const questNames = missingQuests.map((k) => `"${t((ctx.questTitles && ctx.questTitles[k]) || k)}"`);
  let message = '';
  if (missing.length || questNames.length) {
    const list = missing.join(", ");
    const quests = questNames.join(", ");
    const many = questNames.length > 1;
    if (!questNames.length) message = t("Requires {list}", { list });
    else if (!missing.length) message = many ? t("Requires completing quests {quests}", { quests }) : t("Requires completing quest {quests}", { quests });
    else message = many ? t("Requires {list} and completing quests {quests}", { list, quests }) : t("Requires {list} and completing quest {quests}", { list, quests });
  }

  return {
    ok: errors.length === 0,
    weaponOk,
    questsOk,
    missingQuests,
    message,
    levelOk,
    strOk,
    dexOk,
    conOk,
    intOk,
    wisOk,
    chaOk,
    lvl,
    str,
    dex,
    con,
    int,
    wis,
    cha,
    weaponCategory,
    reqWeaponName: getWeaponRequirementName(gem.reqWeapon),
    errors,
  };
}



// --- Skill damage preview (mirror of backend authority/skillBalance.js) --------
// The server owns the real number; the catalog carries what the preview needs, both
// generated from seeds/data/skillSpec.js so there is no second formula here:
//   cast    one cast's damage with the level's AVERAGE weapon (a channel: one tick)
//   hitRef  that average weapon's hit at the skill's level
//   hits    blows per cast
// A share of the cast (the weapon scaling: melee 15%, magic 10%, curse 5%) comes from
// the weapon actually held instead of the average one:
//   total = cast x (1 - share) + weaponDamage x (cast / hitRef) x share
// A parity test pins this to the server. Stat, element and crit multipliers are
// applied on top by the server.
const WEAPON_SCALING_BY_TYPE_PREVIEW = { melee: 0.15, magic: 0.10, debuff: 0.05 };
const DEFAULT_WEAPON_SCALING_PREVIEW = 0.10;

export function skillBaseDamage(skill) {
  const hits = Math.max(1, Number(skill.hits) || 1);
  return { base: (Number(skill.cast) || 0) / hits, hits };
}

export function skillWeaponScaling(skill) {
  const own = Number(skill && skill.weaponScaling);
  if (skill && skill.weaponScaling != null && Number.isFinite(own) && own >= 0) return own;
  const byType = skill && WEAPON_SCALING_BY_TYPE_PREVIEW[skill.type];
  return byType != null ? byType : DEFAULT_WEAPON_SCALING_PREVIEW;
}

// null for a skill that does no damage (a buff) or a skill without catalog numbers.
// `weaponDamage` is the equipped weapon's damage, 0/undefined with nothing in hand.
// base / perHit: damage of one blow with that weapon; total: the whole cast.
export function skillDamagePreview(skill, weaponDamage = 0) {
  if (!skill || skill.type === 'buff') return null;
  const cast = Number(skill.cast);
  const hitRef = Number(skill.hitRef);
  if (!(cast > 0) || !(hitRef > 0)) return null;
  const hits = Math.max(1, Number(skill.hits) || 1);
  const wd = Number(weaponDamage);
  const weapon = Number.isFinite(wd) && wd > 0 ? wd : 0;
  const scaling = skillWeaponScaling(skill);
  const total = cast * (1 - scaling) + weapon * (cast / hitRef) * scaling;
  return { base: total / hits, hits, scaling, weaponDamage: weapon, bonus: total - cast, total, perHit: total / hits };
}

// --- Skill synergies and Druid forms (mirror of backend authority/skillSynergy.js) ---
// The server decides; this lets a tooltip name what a skill pairs with and lets
// the hotbar know which forms a skill needs. A parity test pins both copies.
export const SYNERGY_TAG_RULES = [
  ['ice', /frost|ice|blizzard|freez|chill|glaci|snow|deep_comet/],
  ['fire', /fire|flame|ignite|ember|meteor|combustion|immolat|scorch|dragons_breath|explosive|solar/],
  ['lightning', /lightning|storm|thunder|static|shock|discharge|overload|spark|heavenly|cyclone/],
  ['poison', /poison|venom|plague|neurotox|rot|spore|ivy|swarm|toxic|insect/],
  ['bleed', /bleed|blood|rend|rip|slit|gouge|wound|maim|hemophilia|vein|mangle|scythe|bite|heartseeker|throat|stab/],
  ['control', /root|entangl|hibernate|paraly|hamstring|trip|_net|slow|silence|polymorph|bash|stun|taunt|lock|block|disorient|cripple|constrict|vine|trap|sand|blind|pressure_point|off_balance|winded|gravity|singularity|temporal/],
  ['mark', /mark|expose|vulnerab|sunder|weaken|eagle_eye|brand/],
  ['shadow', /shadow|abyssal|void|dark|curse|black_|death|umbral|soul/],
];

export const SYNERGIES = [
  { name: 'Shatter', from: ['ice'], to: ['fire', 'melee'], mult: 1.30 },
  { name: 'Thermal Shock', from: ['fire'], to: ['ice'], mult: 1.25 },
  { name: 'Conduction', from: ['lightning'], to: ['melee'], mult: 1.25 },
  { name: 'Catalyst', from: ['poison'], to: ['fire', 'lightning'], mult: 1.30 },
  { name: 'Ambush', from: ['control'], to: ['melee', 'bleed'], mult: 1.30 },
  { name: 'Exploit Weakness', from: ['curse', 'mark'], to: ['melee', 'magic'], mult: 1.20 },
  { name: 'Empowered Strike', from: ['buff'], to: ['melee'], mult: 1.15 },
  { name: 'Blood Poisoning', from: ['bleed'], to: ['poison', 'shadow'], mult: 1.25 },
  { name: 'Eclipse', from: ['shadow'], to: ['lightning', 'fire'], mult: 1.20 },
];

const synergyTagCache = new Map();
export function skillTags(skill) {
  if (!skill) return new Set();
  const hit = synergyTagCache.get(skill.id);
  if (hit) return hit;
  const tags = new Set();
  if (skill.type) tags.add(skill.type);
  if (skill.element && typeof skill.element === 'string') tags.add(skill.element);
  const name = String(skill.id || '').replace(/^[a-z]{3}_/, '');
  for (const [tag, re] of SYNERGY_TAG_RULES) if (re.test(name)) tags.add(tag);
  if (skill.type === 'debuff') tags.add('curse');
  synergyTagCache.set(skill.id, tags);
  return tags;
}

// { primes: [{ name, mult, to: [...] }], finishes: [{ name, mult, from: [...] }] }:
// the synergies this skill starts (its tags are a `from`) and completes (its tags
// are a `to`), for a tooltip. A buff only primes.
export function synergyHints(skill) {
  const tags = skillTags(skill);
  const primes = [];
  const finishes = [];
  for (const s of SYNERGIES) {
    if (s.from.some((t) => tags.has(t))) primes.push({ name: s.name, mult: s.mult, to: s.to });
    if (skill && skill.type !== 'buff' && s.to.some((t) => tags.has(t))) finishes.push({ name: s.name, mult: s.mult, from: s.from });
  }
  return { primes, finishes };
}

const FORM_SKILL_OVERRIDES = { dru_maul: 'bear', dru_ursocs_wrath: 'bear', dru_feral_bite: 'wolf' };
export const FORM_LABELS = { bear: 'Bear Form', hawk: 'Hawk Form', wolf: 'Wolf Form' };

// 'bear' | 'hawk' | 'wolf' for a skill that only works in that form, else null.
export function formOfSkill(skill) {
  if (!skill || skill.class !== 'Druid') return null;
  if (FORM_SKILL_OVERRIDES[skill.id]) return FORM_SKILL_OVERRIDES[skill.id];
  const m = /^dru_(bear|hawk|wolf)_(?!form$)/.exec(skill.id);
  return m ? m[1] : null;
}
