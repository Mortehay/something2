'use strict';

// The server's rules for skills: how often one may be cast, how hard it hits, and
// what a buff really does. world.castSkill used to read all three off the skill's
// description text (the first "NN%" became the damage, the word "HP" made a buff a
// 25% heal) and trusted the client for cooldowns. Everything here is explicit data.

// ---- cooldowns -------------------------------------------------------------
// The client enforces `cooldown || 1` seconds; the server now enforces the same, a
// little loose so a message delayed by the network is not refused. A channelled
// skill ticks every 250 ms on the client; the floor stops a modified client casting
// it faster than that.
const COOLDOWN_SLACK = 0.85;
const CHANNEL_GAP_MS = 200;

function minGapMs(skill) {
  if (skill.channeled) return CHANNEL_GAP_MS;
  return Math.round((Number(skill.cooldown) || 1) * 1000 * COOLDOWN_SLACK);
}

// Refuses when the skill is still cooling down; otherwise stamps the next ready time.
function takeCooldown(p, skill, now) {
  if (!p._skillReadyAt) p._skillReadyAt = new Map();
  const readyAt = p._skillReadyAt.get(skill.id) || 0;
  if (now < readyAt) return false;
  p._skillReadyAt.set(skill.id, now + minGapMs(skill));
  return true;
}

// ---- damage ----------------------------------------------------------------
// Hand-tuned multi-hit skills: damage per hit and number of hits.
const MULTI_HIT = {
  arc_barrage: { base: 4, hits: 5 },
  arc_fan_of_knives: { base: 6, hits: 6 },
  mag_magic_missiles: { base: 6, hits: 5 },
  mag_meteor_shower: { base: 14, hits: 4 },
  arc_rain_of_arrows: { base: 5, hits: 10 },
  arc_volley: { base: 5, hits: 10 },
  war_flurry_of_steel: { base: 5, hits: 4 },
  war_twin_slash: { base: 8, hits: 2 },
};

// Every other damaging skill: grows with the level it unlocks at, and with how long
// it is on cooldown (a 30 s skill is a big hit, a 1 s skill is a small one).
// A channelled skill hits every tick, so each tick is a fraction of that.
function baseDamageOf(skill) {
  const multi = MULTI_HIT[skill.id]
    || (/multishot|triple/.test(skill.id) ? { base: 8, hits: 3 } : null);
  if (multi) return { base: multi.base, hits: multi.hits };
  const lvl = Number(skill.reqLvl) || 1;
  const cd = Math.max(1, Number(skill.cooldown) || 1);
  let d = (6 + lvl * 0.12) * (1 + 0.45 * Math.log(cd));
  if (skill.channeled) d *= 0.6;
  return { base: Math.max(4, Math.min(30, Math.round(d))), hits: 1 };
}

// ---- life leech ------------------------------------------------------------
// Heals a share of one cast's damage, once per cast, and never more than a small
// slice of max HP: a channel drains many times a second.
const LEECH_SKILL_SHARE = 0.35;
const LEECH_CAP_FRACTION = 0.01;
const LEECH_SKILL_RE = /soul_drain|sacrificial|siphon|leech|blood_harvest/;

function leechHeal(p, skill, damage) {
  let share = LEECH_SKILL_RE.test(skill.id) ? LEECH_SKILL_SHARE : 0;
  if (p._buffMods && p._buffMods.leech) share = Math.max(share, p._buffMods.leech);
  if (share <= 0) return 0;
  const cap = Math.max(3, Math.round((p.maxHp || 100) * LEECH_CAP_FRACTION));
  return Math.min(cap, Math.max(1, Math.round(damage * share)));
}


// ---- weapons ---------------------------------------------------------------
// A weapon family adds one mechanic that suits it. The family is the last word of
// the item name ("iron-mace", "Steel Dagger"); a bare fixture name like "bow" has
// no family, so test weapons stay deterministic.
//   stun  { chance, ms }  a landed hit may stun the target
//   crit  chance          a swing or shot may be a critical hit
const WEAPON_TRAITS = {
  mace: { stun: { chance: 0.2, ms: 1000 } },
  quarterstaff: { stun: { chance: 0.1, ms: 600 } },
  dagger: { crit: 0.15 },
  bow: { crit: 0.10 },
  crossbow: { crit: 0.08 },
};
const FAMILY_RE = /[-_ ](mace|quarterstaff|dagger|crossbow|bow)$/i;

function weaponTraits(w) {
  if (!w || typeof w.name !== 'string') return null;
  const m = FAMILY_RE.exec(w.name);
  return m ? WEAPON_TRAITS[m[1].toLowerCase()] : null;
}

// The on-hit statuses a weapon adds to the tree's own (a plain array or null).
function weaponHitStatuses(w, base) {
  const t = weaponTraits(w);
  if (!t || !t.stun) return base || null;
  return [...(base || []), { status: 'stun', chance: t.stun.chance, ms: t.stun.ms }];
}

// ---- randomness and crits --------------------------------------------------
let rng = Math.random;
function setRng(fn) { rng = typeof fn === 'function' ? fn : Math.random; }
function roll() { return rng(); }

const BASE_CRIT_DMG = 1.5;

// The damage multiplier of one outgoing hit: 1, or the crit multiplier. Chance comes
// from the weapon family and the running buffs; a skill that is "guaranteed" (the
// first strike out of stealth, Elemental Focus charges) always crits.
function rollCrit(p, opts = {}) {
  const m = p._buffMods;
  let forced = false;
  if (p._stealthed) {
    forced = true;
    p._stealthed = false;
    removeBuff(p, 'arc_camouflage');
  }
  if (!forced && opts.spell && m && m.critNext > 0) {
    for (const b of p.buffs.values()) {
      if (b.fx && b.fx.critNext > 0) { b.fx.critNext -= 1; if (b.fx.critNext <= 0) removeBuff(p, b.id); break; }
    }
    forced = true;
  }
  if (!forced) {
    const fam = opts.weapon ? weaponTraits(opts.weapon) : null;
    const chance = Math.min(1, ((fam && fam.crit) || 0) + (m ? m.crit : 0));
    if (chance <= 0 || rng() >= chance) return 1;
  }
  return BASE_CRIT_DMG + (m ? m.critDmg : 0);
}

// ---- buffs -----------------------------------------------------------------
// What each buff skill does, as data. Fields:
//   dur        seconds the buff lasts
//   dealt      x outgoing damage            taken       x damage taken
//   takenMagic x damage taken from non-physical elements
//   lowHpTaken x damage taken while under 30% HP
//   speed      x movement speed             atk         x attack / cast rate
//   manaRegen  x mana regeneration          leech       share of skill damage healed
//   hot        max-HP fraction healed per second for the duration
//   heal       max-HP fraction healed at once (healFlat: a flat amount)
//   mana       max-mana fraction restored at once (manaShield: share of damage paid from mana)
//   absorbPts  damage soaked before it reaches life (a pool)
//   absorbHits hits negated outright (absorbMagicOnly: non-physical hits only)
//   hpFloor    life cannot fall below 1       physImmune  physical hits do nothing
//   ccImmune   no stun, no slow               curseImmune no burn, no charm
//   crit       + crit chance                  critDmg     + crit damage multiplier
//   critNext   the next N spells always crit  nextMult    the next spell hits x as hard
//   dodge/parry chance to avoid a hit         counter     damage thrown back at what you dodged
//   reflect    share of any hit sent back     reflectPhys share of a physical hit sent back
//   hpMult     x max HP while it lasts        reach       x melee reach
//   stealth    monsters do not notice you; the first attack out of it crits
//   sniper     +10% damage per second standing still (cap +50%)
//   stackAtk   +attack rate per swing (up to maxStacks, gone after 4 s idle)
//   aura       { dps, radius, element } damages everything near you every second
//   revive     max-HP fraction you come back with when killed (once)
//   form       a druid shape; only one at a time, recast to leave it
//   formOnly   the timed part only applies while in a form
//   trap / mark / transfuse   handled by the world (it needs the creatures)
// A buff skill with no entry here is accepted and listed, but does nothing.
const FORM_DUR = 7200;
const BUFFS = {
  war_battle_shout: { dur: 20, dealt: 1.2 },
  war_shield_wall: { dur: 8, taken: 0.7 },
  war_iron_will: { dur: 5, ccImmune: true },
  war_bloodlust_stance: { dur: 30, stackAtk: 0.03, maxStacks: 10 },
  war_colossus_stance: { dur: 15, hpMult: 1.3, reach: 1.25 },
  war_unstoppable: { dur: 1, heal: 0.1 },
  war_last_stand: { dur: 4, hpFloor: true },
  war_steel_tempering: { dur: 30, taken: 0.85 },
  war_duelist_focus: { dur: 12, parry: 0.25, crit: 0.1, critDmg: 0.5 },
  war_banner_of_victory: { dur: 35, hot: 0.02 },
  mag_mana_shield: { dur: 30, manaShield: 0.7 },
  mag_ice_armor: { dur: 30, taken: 0.85 },
  mag_immolation_aura: { dur: 20, aura: { dps: 8, radius: 150, element: 'fire' } },
  mag_haste: { dur: 10, speed: 1.35, atk: 1.35 },
  mag_arcane_brilliance: { dur: 30, dealt: 1.25 },
  mag_mana_surge: { dur: 1, mana: 0.4 },
  mag_elemental_focus: { dur: 30, critNext: 3 },
  mag_spell_ward: { dur: 30, absorbHits: 2, absorbMagicOnly: true },
  mag_ethereal_form: { dur: 3.5, physImmune: true },
  mag_empower_elements: { dur: 15, dealt: 1.3 },
  mnk_fast_mana_aura: { dur: 30, manaRegen: 2 },
  mnk_jade_body: { dur: 10, takenMagic: 0.6 },
  mnk_drunken_brawler_stance: { dur: 30, dodge: 0.35, counter: 12 },
  mnk_inner_peace: { dur: 3, hot: 0.1 },
  mnk_tiger_stance: { dur: 30, speed: 1.25, atk: 1.3 },
  mnk_touch_of_life: { dur: 1, heal: 0.3 },
  mnk_diamond_skin: { dur: 20, absorbPts: 500 },
  mnk_zen_focus: { dur: 8, ccImmune: true },
  mnk_wind_blessing: { dur: 15, speed: 1.2 },
  mnk_karma_redirection: { dur: 10, reflect: 0.5 },
  cul_blood_pact: { dur: 60, dealt: 1.25, taken: 0.9 },
  cul_bone_armor: { dur: 30, absorbHits: 3 },
  cul_fanatic_frenzy: { dur: 12, atk: 'lowhp' },
  cul_vampiric_embrace: { dur: 15, leech: 0.3 },
  cul_undead_resilience: { dur: 60, lowHpTaken: 0.5 },
  cul_dark_blessing: { dur: 30, curseImmune: true },
  cul_martyrdom_aura: { dur: 60, dealt: 'missing' },
  cul_life_transfusion: { dur: 1, transfuse: 0.2 },
  cul_abyssal_cloak: { dur: 15, speed: 1.4 },
  cul_blood_rebirth: { dur: 600, revive: 0.4 },
  arc_rapid_fire: { dur: 8, atk: 1.7 },
  arc_eagle_eye: { dur: 20, crit: 0.2, range: 256 },
  arc_camouflage: { dur: 6, stealth: true },
  arc_cheetah_stride: { dur: 12, speed: 1.45 },
  arc_bear_trap: { dur: 1, trap: 'bear' },
  arc_explosive_trap: { dur: 1, trap: 'explosive' },
  arc_tar_trap: { dur: 1, trap: 'tar' },
  arc_hunters_instinct: { dur: 1, mark: { radius: 380, ms: 20000, vuln: 0.15 } },
  arc_tailwind_aura: { dur: 60, speed: 1.15, dodge: 0.15 },
  arc_sniper_stance: { dur: 30, sniper: true },
  dru_primal_metamorphosis: { dur: 20, healFlat: 180, dealt: 1.3, speed: 1.35, formOnly: true },
  dru_bear_form: { dur: FORM_DUR, form: 'bear', hpMult: 1.6, taken: 0.5 },
  dru_hawk_form: { dur: FORM_DUR, form: 'hawk', speed: 1.45, dodge: 0.35 },
  dru_wolf_form: { dur: FORM_DUR, form: 'wolf', atk: 1.35, crit: 0.25 },
  dru_mark_of_the_wild: { dur: 1800, dealt: 1.15, hpMult: 1.15 },
  dru_barkskin: { dur: 10, taken: 0.7 },
  dru_rejuvenation: { dur: 12, hot: 0.03 },
  dru_tranquility: { dur: 6, hot: 0.06 },
  dru_thorns_aura: { dur: 60, reflectPhys: 0.2 },
  dru_natures_swiftness: { dur: 30, nextMult: 2 },
  dru_healing_touch: { dur: 1, heal: 0.3 },
};

const LOW_HP = 0.3;
const SNIPER_STEP = 0.1;
const SNIPER_CAP = 0.5;
const BLOODLUST_IDLE_MS = 4000;

function hasForm(p) {
  if (!p.buffs) return false;
  for (const b of p.buffs.values()) if (b.fx && b.fx.form) return true;
  return false;
}

// Dynamic values need the caster's state at cast time.
function resolveEffects(p, spec) {
  const fx = { ...spec };
  const maxHp = p.maxHp || 100;
  if (fx.atk === 'lowhp') fx.atk = 1 + Math.max(0, Math.min(1, 1 - p.hp / maxHp));
  if (fx.dealt === 'missing') {
    // +15% for every 20% of life missing.
    fx.dealt = 1 + 0.15 * Math.floor(Math.max(0, 1 - p.hp / maxHp) / 0.2 + 1e-9);
  }
  if (fx.stackAtk) fx.stacks = 0;
  return fx;
}

// Rebuild the multipliers the hot paths read (debuffDamageMult, playerSpeedMult,
// applyAttackCooldown, castSkill, applyDamage). Null when no buff is running.
function refreshBuffMods(p) {
  if (!p.buffs || p.buffs.size === 0) { p._buffMods = null; return; }
  const m = {
    dealt: 1, speed: 1, atk: 1, manaRegen: 1, leech: 0, crit: 0, critDmg: 0, critNext: 0,
    avoid: 0, reflect: 0, reflectPhys: 0, counter: 0, reach: 1, nextMult: 1, range: 0,
  };
  let keep = 1;
  for (const b of p.buffs.values()) {
    const e = b.fx;
    if (!e) continue;
    if (e.dealt) m.dealt *= e.dealt;
    if (e.speed) m.speed *= e.speed;
    if (e.atk) m.atk *= e.atk;
    if (e.stackAtk) m.atk *= 1 + e.stackAtk * (e.stacks || 0);
    if (e.sniper) m.dealt *= 1 + Math.min(SNIPER_CAP, SNIPER_STEP * (p._stillSec || 0));
    if (e.manaRegen) m.manaRegen *= e.manaRegen;
    if (e.leech) m.leech = Math.max(m.leech, e.leech);
    if (e.crit) m.crit += e.crit;
    if (e.critDmg) m.critDmg += e.critDmg;
    if (e.critNext) m.critNext += e.critNext;
    if (e.dodge) keep *= 1 - e.dodge;
    if (e.parry) keep *= 1 - e.parry;
    if (e.counter) m.counter = Math.max(m.counter, e.counter);
    if (e.reflect) m.reflect = Math.max(m.reflect, e.reflect);
    if (e.reflectPhys) m.reflectPhys = Math.max(m.reflectPhys, e.reflectPhys);
    if (e.reach) m.reach *= e.reach;
    if (e.nextMult) m.nextMult *= e.nextMult;
    if (e.range) m.range += e.range;
  }
  m.avoid = 1 - keep;
  p._buffMods = m;
}

// Drops a buff and undoes what it did to the caster.
function removeBuff(p, id) {
  const b = p.buffs && p.buffs.get(id);
  if (!b) return;
  p.buffs.delete(id);
  const e = b.fx;
  if (e && e.hpAdd) {
    p._buffHpAdd = Math.max(0, (p._buffHpAdd || 0) - e.hpAdd);
    p.maxHp = Math.max(1, p.maxHp - e.hpAdd);
    if (p.hp > p.maxHp) p.hp = p.maxHp;
  }
  if (e && e.stealth) p._stealthed = false;
  refreshBuffMods(p);
}

// A buff skill was cast: its instant restores, then the timed effect. Returns the
// spec when the world has more to do (trap, mark, transfuse), else null.
function castBuff(p, skill, now) {
  const spec = BUFFS[skill.id];
  if (!spec) return null;
  if (!p.buffs) p.buffs = new Map();
  const maxHp = p.maxHp || 100;

  // A druid shape is a toggle: casting the one you wear takes it off, casting
  // another swaps.
  if (spec.form) {
    const wasThis = p.buffs.has(skill.id);
    for (const [id, b] of [...p.buffs]) if (b.fx && b.fx.form) removeBuff(p, id);
    if (wasThis) return null;
  }
  if (p.buffs.has(skill.id)) removeBuff(p, skill.id);

  if (spec.heal) p.hp = Math.min(p.maxHp, p.hp + Math.round(maxHp * spec.heal));
  if (spec.healFlat) p.hp = Math.min(p.maxHp, p.hp + spec.healFlat);
  if (spec.mana) {
    const maxMana = p.maxMana || 100;
    p.mana = Math.min(maxMana, p.mana + Math.round(maxMana * spec.mana));
  }
  if (spec.formOnly && !hasForm(p)) return null;

  if (spec.dur <= 1 && !spec.hot && !spec.stealth && !spec.hpMult) {
    // Instant effects leave no timed buff behind.
    return spec.trap || spec.mark || spec.transfuse ? spec : null;
  }

  const fx = resolveEffects(p, spec);
  if (fx.hpMult) {
    fx.hpAdd = Math.round(p.maxHp * (fx.hpMult - 1));
    p.maxHp += fx.hpAdd;
    p.hp += fx.hpAdd;
    p._buffHpAdd = (p._buffHpAdd || 0) + fx.hpAdd;
  }
  if (fx.stealth) p._stealthed = true;
  const durMs = spec.dur * 1000;
  p.buffs.set(skill.id, {
    id: skill.id,
    nameUk: skill.nameUk,
    nameEn: skill.nameEn,
    icon: skill.icon || '✨',
    iconColor: skill.iconColor || '#fbbf24',
    startedAt: now,
    durationMs: durMs,
    expiresAt: now + durMs,
    fx,
  });
  refreshBuffMods(p);
  return spec.trap || spec.mark || spec.transfuse ? spec : null;
}

// A buff skill with no entry registers a plain timed marker, as before.
function castUnknownBuff(p, skill, now) {
  if (BUFFS[skill.id]) return false;
  if (!p.buffs) p.buffs = new Map();
  const durSec = Number(skill.duration) || (skill.cooldown ? Math.max(8, Math.min(45, skill.cooldown * 1.5)) : 20);
  p.buffs.set(skill.id, {
    id: skill.id,
    nameUk: skill.nameUk,
    nameEn: skill.nameEn,
    icon: skill.icon || '✨',
    iconColor: skill.iconColor || '#fbbf24',
    startedAt: now,
    durationMs: durSec * 1000,
    expiresAt: now + durSec * 1000,
  });
  return true;
}

// A swing or a cast was made: Bloodlust stacks, a spell uses up Nature's Swiftness.
function noteAction(p, now) {
  if (!p.buffs || p.buffs.size === 0) return;
  let changed = false;
  for (const b of p.buffs.values()) {
    const e = b.fx;
    if (e && e.stackAtk) {
      e.stacks = Math.min(e.maxStacks || 10, (e.stacks || 0) + 1);
      e.lastAt = now;
      changed = true;
    }
  }
  if (changed) refreshBuffMods(p);
}

// The multiplier of the caster's next spell (Nature's Swiftness); consumes it.
function takeSpellMult(p) {
  if (!p._buffMods || p._buffMods.nextMult <= 1) return 1;
  const mult = p._buffMods.nextMult;
  for (const [id, b] of [...p.buffs]) if (b.fx && b.fx.nextMult) removeBuff(p, id);
  return mult;
}

// ---- running buffs ---------------------------------------------------------
// Called every tick for each entity (stepEffects). Drops expired buffs and pays out
// the over-time effects; only a player has a `buffs` map.
function tickBuffs(target, dtMs, now) {
  if (!target.buffs || target.buffs.size === 0) { target._stillSec = 0; return; }
  const dt = dtMs / 1000;
  let dirty = false;

  // How long the player has been standing still (Sniper Stance).
  if (target._lastPos && target._lastPos.x === target.x && target._lastPos.y === target.y) {
    target._stillSec = (target._stillSec || 0) + dt;
  } else {
    target._stillSec = 0;
    target._lastPos = { x: target.x, y: target.y };
  }

  for (const [bid, b] of [...target.buffs]) {
    if (now >= b.expiresAt) { removeBuff(target, bid); continue; }
    const e = b.fx;
    if (!e) continue;
    if (e.hot && target.hp > 0 && target.hp < target.maxHp) {
      target.hp = Math.min(target.maxHp, target.hp + target.maxHp * e.hot * dt);
    }
    if (e.stacks > 0 && now - (e.lastAt || 0) > BLOODLUST_IDLE_MS) { e.stacks = 0; dirty = true; }
    if (e.sniper) dirty = true;
  }
  const extra = target._buffMods && target._buffMods.manaRegen - 1;
  if (extra > 0 && target.stats && target.mana < target.maxMana) {
    target.mana = Math.min(target.maxMana, target.mana + target.stats.manaRegen * extra * dt);
  }
  if (dirty) refreshBuffMods(target);
}

// ---- incoming damage -------------------------------------------------------
// After defense and resistance, through the target's buffs. Returns the damage that
// reaches life. Mutates mana and the absorb pools; queues damage to send back
// (reflect, counter) on target._pendingReflect for the world to deliver.
function mitigateIncoming(target, final, element, source) {
  if (!target.buffs || target.buffs.size === 0) return final;
  const physical = element === 'physical';
  const m = target._buffMods;

  if (m && source) {
    if (m.reflect > 0 || (physical && m.reflectPhys > 0)) {
      const share = Math.max(m.reflect, physical ? m.reflectPhys : 0);
      (target._pendingReflect || (target._pendingReflect = [])).push({ source, amount: final * share, element });
    }
    if (m.avoid > 0 && rng() < m.avoid) {
      if (m.counter > 0) {
        (target._pendingReflect || (target._pendingReflect = [])).push({ source, amount: m.counter, element: 'physical' });
      }
      return 0;
    }
  }

  const lowHp = target.maxHp > 0 && target.hp / target.maxHp < LOW_HP;
  let dmg = final;
  for (const b of target.buffs.values()) {
    const e = b.fx;
    if (!e) continue;
    if (e.physImmune && physical) return 0;
    if (e.taken) dmg *= e.taken;
    if (e.takenMagic && !physical) dmg *= e.takenMagic;
    if (e.lowHpTaken && lowHp) dmg *= e.lowHpTaken;
  }
  for (const [bid, b] of [...target.buffs]) {
    const e = b.fx;
    if (!e || dmg <= 0) continue;
    if (e.absorbHits > 0 && (!e.absorbMagicOnly || !physical)) {
      e.absorbHits -= 1;
      if (e.absorbHits <= 0) removeBuff(target, bid);
      dmg = 0;
      continue;
    }
    if (e.absorbPts > 0) {
      const soaked = Math.min(e.absorbPts, dmg);
      e.absorbPts -= soaked;
      dmg -= soaked;
      if (e.absorbPts <= 0) removeBuff(target, bid);
    }
    if (e.manaShield > 0 && target.mana > 0) {
      // The shield pays the share it can; mana that runs dry stops absorbing.
      const wanted = dmg * e.manaShield;
      const paid = Math.min(wanted, target.mana);
      target.mana -= paid;
      dmg -= paid;
    }
  }
  return dmg;
}

function hasHpFloor(target) {
  if (!target.buffs || target.buffs.size === 0) return false;
  for (const b of target.buffs.values()) if (b.fx && b.fx.hpFloor) return true;
  return false;
}

// True when the target wears a buff with the given flag (ccImmune, curseImmune).
function hasBuffFlag(target, flag) {
  if (!target || !target.buffs || target.buffs.size === 0) return false;
  for (const b of target.buffs.values()) if (b.fx && b.fx[flag]) return true;
  return false;
}

// Blood Rebirth: a player killed while wearing it comes back. Returns the share of
// max HP to return with, or 0.
function takeRevive(p) {
  if (!p.buffs) return 0;
  for (const [id, b] of [...p.buffs]) {
    if (b.fx && b.fx.revive) { const r = b.fx.revive; removeBuff(p, id); return r; }
  }
  return 0;
}

// Buffs that damage everything around the player each second (Immolation Aura).
function auraOf(p) {
  if (!p.buffs || p.buffs.size === 0) return null;
  for (const b of p.buffs.values()) if (b.fx && b.fx.aura) return b.fx.aura;
  return null;
}

module.exports = {
  COOLDOWN_SLACK, CHANNEL_GAP_MS, LEECH_SKILL_SHARE, LEECH_CAP_FRACTION,
  BUFFS, MULTI_HIT, LOW_HP, WEAPON_TRAITS, BASE_CRIT_DMG, FORM_DUR,
  minGapMs, takeCooldown, baseDamageOf, leechHeal,
  weaponTraits, weaponHitStatuses, setRng, roll, rollCrit,
  castBuff, castUnknownBuff, refreshBuffMods, removeBuff, noteAction, takeSpellMult,
  tickBuffs, mitigateIncoming, hasHpFloor, hasBuffFlag, takeRevive, auraOf, hasForm,
};
