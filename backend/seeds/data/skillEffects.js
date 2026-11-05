// backend/seeds/data/skillEffects.js
//
// What each damaging skill DOES besides its damage -- one table, three readers:
//   * the authority (world.castSkill) applies these effects to what a cast hits;
//   * the description generator writes the skill's text FROM them, so the text
//     can never promise something the server does not do;
//   * the client prints the generated text.
//
// WHY A TABLE. The old descriptions promised stuns, slows, bleeds, summons and
// dashes that the server never applied: of 239 damaging skills only blink, a
// pull and a few cone shapes did anything beyond damage, and all 60 "debuff"
// skills were plain damage. Descriptions were free text; the effects were not
// data. The original flavour text is kept on each skill as loreEn / loreUk; the
// description the player reads is now generated from this table.
//
// Every effect is a small object { k: kind, ... }. Durations `s` are seconds.
//
//   status on whoever the cast hits
//     stun {s, chance?}        cannot act or move (3 s immunity afterwards, bosses immune)
//     root {s}                 cannot move, can still attack
//     slow {pct, s}            moves pct% slower
//     silence {s}              cannot attack or cast, can move
//     weaken {pct, s}          deals pct% less damage (covers blind, disarm, -attack power)
//     vuln {pct, s}            takes pct% more damage (covers -resistance, marks)
//     sunder {pct, s}          armor reduced by pct% (creatures)
//     bleed|poison|burn {s}    damage over time (DOT_SHARE of the cast's damage, spread over s)
//     shock {}                 the existing shock rider (takes more damage, drains mana, interrupts)
//     fear {s}                 runs away
//     knockback {px}           shoved away from the caster
//     pull {px}                dragged toward the point of the cast
//   shaping the damage
//     hits is a separate map below (blows per cast)
//     pierce {pct}             ignores pct% of the target's armor
//     execute {below, bonus}   +bonus% damage to targets under `below`% hp
//     cond {when, bonus}       +bonus% damage when: far (distance), self_low_hp, full_mana, bleeding
//     chain {n}                also hits the n nearest others within 220 px
//     echo {s, pct}            the cast repeats s seconds later at pct% of the damage
//     zone {s}                 leaves a damaging area on the ground for s seconds
//   on the caster
//     lifesteal {pct}          heals pct% of damage dealt
//     selfheal {pct}           heals pct% of max life
//     mana {pct}               restores pct% of max mana on a hit
//     dash {px, dir}           moves the caster ('fwd' toward the aim, 'back' away)
//     cleanse {}               removes slows and roots from the caster
//     taunt {s}                enemies in range must attack the caster
//   allies
//     summon {kind, n, s}      n allies of `kind` fight for the caster for s seconds

const e = {
  stun: (s, chance) => ({ k: 'stun', s, ...(chance ? { chance } : {}) }),
  root: (s) => ({ k: 'root', s }),
  slow: (pct, s) => ({ k: 'slow', pct, s }),
  silence: (s) => ({ k: 'silence', s }),
  weaken: (pct, s) => ({ k: 'weaken', pct, s }),
  vuln: (pct, s) => ({ k: 'vuln', pct, s }),
  sunder: (pct, s) => ({ k: 'sunder', pct, s }),
  bleed: (s) => ({ k: 'bleed', s }),
  poison: (s) => ({ k: 'poison', s }),
  burn: (s) => ({ k: 'burn', s }),
  shock: () => ({ k: 'shock' }),
  fear: (s) => ({ k: 'fear', s }),
  knockback: (px) => ({ k: 'knockback', px }),
  pull: (px) => ({ k: 'pull', px }),
  pierce: (pct) => ({ k: 'pierce', pct }),
  execute: (below, bonus) => ({ k: 'execute', below, bonus }),
  cond: (when, bonus) => ({ k: 'cond', when, bonus }),
  chain: (n) => ({ k: 'chain', n }),
  echo: (s, pct) => ({ k: 'echo', s, pct }),
  zone: (s) => ({ k: 'zone', s }),
  lifesteal: (pct) => ({ k: 'lifesteal', pct }),
  selfheal: (pct) => ({ k: 'selfheal', pct }),
  mana: (pct) => ({ k: 'mana', pct }),
  dash: (px, dir) => ({ k: 'dash', px, dir }),
  cleanse: () => ({ k: 'cleanse' }),
  taunt: (s) => ({ k: 'taunt', s }),
  summon: (kind, n, s) => ({ k: 'summon', kind, n, s }),
};

// Blows per cast. The cast's TOTAL damage is split across them.
const HITS = {
  war_twin_slash: 2, war_berzerker_rampage: 3, war_flurry_of_steel: 4,
  mag_mana_blades: 2, mag_meteor_shower: 4, mag_magic_missiles: 5,
  mnk_twin_serpent_strike: 2, mnk_five_element_combo: 5,
  cul_bone_spear: 3,
  arc_fan_of_knives: 6, arc_barrage: 5, arc_rain_of_arrows: 10, arc_volley: 10, arc_scattershot: 5,
  dru_wolf_flurry: 4, dru_hawk_wind_slash: 2, dru_bear_frenzy: 5, dru_hawk_razor_feathers: 6,
};

const SKILL_EFFECTS = {
  // ---------------- Warrior: melee ----------------
  war_crushing_blow: [e.pierce(25)],
  war_whirlwind: [],
  war_hamstring_slash: [e.slow(40, 4)],
  war_shield_slam: [e.stun(2)],
  war_skull_splitter: [e.stun(3, 35)],
  war_bleeding_cleave: [e.bleed(6)],
  war_piercing_thrust: [],
  war_punishing_strike: [e.knockback(80)],
  war_twin_slash: [],
  war_ground_breaker: [e.knockback(120)],
  war_decapitate: [e.execute(25, 150)],
  war_flurry_of_steel: [],
  war_disarming_bash: [e.weaken(80, 2)],
  war_hilt_strike: [e.silence(2)],
  war_sweeping_strike: [e.knockback(200)],
  war_overpowering_smash: [e.pierce(50)],
  war_wave_cleaver: [e.sunder(30, 5)],
  war_berzerker_rampage: [],
  war_titanic_impact: [e.zone(3)],
  war_blood_harvest: [e.lifesteal(25)],
  // ---------------- Warrior: magic ----------------
  war_shockwave: [e.knockback(100)],
  war_flame_edge: [e.burn(4)],
  war_earth_stride: [e.dash(280, 'fwd')],
  war_ignite_blade: [e.burn(4)],
  war_thunder_strike: [e.chain(3)],
  war_stoneskin_burst: [e.knockback(100)],
  war_leap_slam: [e.dash(300, 'fwd'), e.stun(1)],
  war_windblade: [],
  war_frostforge_strike: [e.slow(40, 3)],
  war_war_avatar: [e.summon('warlord', 1, 15)],
  // ---------------- Warrior: debuff ----------------
  war_intimidating_roar: [e.weaken(25, 10)],
  war_sunder_armor: [e.sunder(35, 12)],
  war_tendon_rupture: [e.bleed(6)],
  war_taunt: [e.taunt(4), e.sunder(15, 4)],
  war_gouge: [e.weaken(30, 6)],
  war_demoralize: [e.slow(40, 8)],
  war_cracked_bones: [e.slow(50, 5)],
  war_terrifying_glare: [e.fear(2.5)],
  war_deep_wound: [e.bleed(8)],
  war_maim: [e.slow(35, 8)],

  // ---------------- Mage: melee ----------------
  mag_arcane_dagger: [],
  mag_combustion_touch: [e.burn(4)],
  mag_frost_rapier: [e.root(1.5)],
  mag_static_palm: [e.knockback(180)],
  mag_point_blank_burst: [e.knockback(150)],
  mag_mana_blades: [e.mana(5)],
  mag_staff_shock: [e.silence(2)],
  mag_mana_tap: [e.mana(10)],
  mag_arcane_sweep: [],
  mag_illusionary_jab: [e.dash(128, 'back')],
  // ---------------- Mage: magic ----------------
  mag_fireball: [e.burn(4)],
  mag_frostbolt: [e.slow(50, 3)],
  mag_chain_lightning: [e.chain(5)],
  mag_meteor_shower: [e.burn(4)],
  mag_frost_nova: [e.root(3)],
  mag_arcane_beam: [],
  mag_ball_lightning: [e.shock()],
  mag_blink: [e.dash(256, 'fwd')],
  mag_wall_of_fire: [e.zone(4), e.burn(4)],
  mag_blizzard: [e.slow(40, 2)],
  mag_magic_missiles: [],
  mag_gravity_singularity: [e.pull(190)],
  mag_thunderstorm: [e.shock()],
  mag_prismatic_burst: [e.burn(3), e.slow(30, 3)],
  mag_mirror_image: [e.summon('clone', 3, 12)],
  mag_disintegrate: [e.execute(30, 100)],
  mag_blast_wave: [e.knockback(150), e.stun(1)],
  mag_deep_comet: [e.stun(2)],
  mag_overload_discharge: [e.shock()],
  mag_temporal_warp: [e.selfheal(25)],
  // ---------------- Mage: debuff ----------------
  mag_arcane_vulnerability: [e.vuln(30, 10)],
  mag_deep_chill: [e.slow(60, 6)],
  mag_scorched_flesh: [e.vuln(40, 8), e.burn(8)],
  mag_silence: [e.silence(4)],
  mag_polymorph: [e.stun(5)],
  mag_static_charge: [e.shock()],
  mag_slow_field: [e.slow(70, 4)],
  mag_mana_burn: [e.mana(10)],
  mag_flash_blind: [e.weaken(80, 3)],
  mag_elemental_hex: [e.vuln(25, 12)],

  // ---------------- Monk: melee ----------------
  mnk_wind_palm: [e.knockback(120)],
  mnk_dragon_kick: [e.stun(1.5)],
  mnk_pressure_point_strike: [e.silence(2.5)],
  mnk_twin_serpent_strike: [e.mana(5)],
  mnk_tiger_claw: [e.sunder(30, 6), e.bleed(6)],
  mnk_five_element_combo: [],
  mnk_hundred_fists: [],
  mnk_falling_star: [e.dash(300, 'fwd')],
  mnk_mantis_strike: [e.weaken(40, 4)],
  mnk_dragon_tail_sweep: [e.stun(1)],
  mnk_iron_palm: [e.sunder(30, 5)],
  mnk_exploding_palm: [e.echo(2, 60)],
  mnk_crane_beak: [e.silence(2)],
  mnk_tidal_sweep: [e.slow(30, 3)],
  mnk_spinning_crane_kick: [],
  mnk_zen_strike: [e.cond('full_mana', 150)],
  mnk_joint_lock: [e.root(2), e.silence(2)],
  mnk_echo_palm: [e.echo(1, 100)],
  mnk_ego_crusher: [e.silence(1.5)],
  mnk_flowing_strike: [e.dash(140, 'fwd')],
  // ---------------- Monk: magic ----------------
  mnk_chi_wave: [e.chain(3)],
  mnk_jade_serpent_beam: [],
  mnk_sphere_of_harmony: [e.zone(2)],
  mnk_spirit_burst: [e.weaken(50, 3), e.knockback(100)],
  mnk_zen_bell_resonance: [e.zone(3)],
  mnk_mist_walk: [e.dash(240, 'fwd')],
  mnk_leaf_storm: [e.zone(3)],
  mnk_dragons_breath: [e.burn(3)],
  mnk_astral_projection: [e.summon('spirit', 1, 5)],
  mnk_heavenly_discharge: [e.shock()],
  // ---------------- Monk: debuff ----------------
  mnk_chakra_block: [e.silence(3)],
  mnk_paralysis_touch: [e.stun(3)],
  mnk_karmic_burden: [e.slow(40, 6)],
  mnk_winded: [e.slow(30, 6), e.silence(1)],
  mnk_spirit_blindness: [e.weaken(60, 5)],
  mnk_disorienting_palm: [e.fear(3)],
  mnk_weakened_flesh: [e.vuln(25, 10)],
  mnk_off_balance: [e.stun(1, 25)],
  mnk_echo_of_pain: [e.echo(4, 40)],
  mnk_muffle: [e.silence(4)],

  // ---------------- Cultist: melee ----------------
  cul_sacrificial_stab: [e.lifesteal(10)],
  cul_blood_scythe: [e.bleed(6)],
  cul_heartstopper: [e.stun(1)],
  cul_flesh_siphon_strike: [e.lifesteal(100)],
  cul_vein_ripper: [e.bleed(6), e.cond('bleeding', 80)],
  cul_spike_of_agony: [e.pierce(100)],
  cul_corpse_cleave: [],
  cul_martyrs_flail: [e.cond('self_low_hp', 100)],
  cul_vampiric_bite: [e.stun(1.5), e.lifesteal(30)],
  cul_defiled_strike: [e.weaken(25, 4)],
  // ---------------- Cultist: magic ----------------
  cul_blood_orb: [],
  cul_blood_lance: [],
  cul_blood_boil: [e.bleed(6)],
  cul_corpse_explosion: [],
  cul_sanguine_pool: [e.zone(3)],
  cul_bone_storm: [e.zone(4)],
  cul_shadow_grasp: [e.root(3)],
  cul_abyssal_beam: [],
  cul_summon_blood_golem: [e.summon('golem', 1, 20)],
  cul_plague_globule: [e.poison(6)],
  cul_soul_drain: [e.lifesteal(50)],
  cul_dark_star_fall: [],
  cul_circle_of_agony: [e.zone(5)],
  cul_bone_spear: [],
  cul_minion_sacrifice: [e.selfheal(30)],
  cul_death_decay: [e.zone(4), e.sunder(20, 5)],
  cul_black_sun: [],
  cul_tentacles_of_the_deep: [e.pull(120), e.root(1.5)],
  cul_wave_of_torment: [e.fear(2)],
  cul_final_rite: [],
  // ---------------- Cultist: debuff ----------------
  cul_curse_of_frailty: [e.weaken(35, 12)],
  cul_curse_of_doom: [e.echo(10, 200)],
  cul_curse_of_vulnerability: [e.vuln(40, 10)],
  cul_hemophilia: [e.bleed(10)],
  cul_black_plague: [e.poison(8), e.chain(3)],
  cul_mind_rot: [e.silence(2)],
  cul_shadow_veil: [e.weaken(50, 6)],
  cul_curse_of_aging: [e.slow(45, 8)],
  cul_horror_of_the_void: [e.fear(3)],
  cul_sacrificial_brand: [e.vuln(20, 10)],

  // ---------------- Archer: melee ----------------
  arc_kidney_strike: [e.stun(2)],
  arc_vault: [e.dash(192, 'back')],
  arc_fan_of_knives: [],
  arc_bow_bash: [e.knockback(180)],
  arc_shadowstep: [e.dash(280, 'fwd')],
  arc_hunters_trip: [e.root(2.5)],
  arc_throat_slit: [e.silence(3)],
  arc_tumble: [e.cleanse(), e.dash(120, 'fwd')],
  arc_disengage_slash: [e.dash(256, 'back')],
  arc_whirling_blades: [e.bleed(6)],
  arc_poison_shiv: [e.poison(6)],
  arc_pocket_sand: [e.weaken(70, 3)],
  arc_riposte_roll: [e.dash(100, 'back')],
  arc_chin_jab: [e.sunder(25, 5), e.silence(1.5)],
  arc_ambush_flurry: [],
  // ---------------- Archer: magic ----------------
  arc_aimed_shot: [e.cond('far', 40)],
  arc_barrage: [],
  arc_lightning_arrow: [e.chain(4), e.shock()],
  arc_explosive_arrow: [e.echo(1.5, 100)],
  arc_frost_arrow: [e.slow(50, 3)],
  arc_piercing_shot: [e.pierce(30)],
  arc_rain_of_arrows: [],
  arc_shadow_shot: [e.root(3)],
  arc_venom_arrow: [e.poison(6)],
  arc_ricochet_shot: [e.chain(4)],
  arc_gale_arrow: [e.pull(150)],
  arc_heartseeker: [e.cond('far', 100)],
  arc_scattershot: [],
  arc_marker_arrow: [e.vuln(30, 5)],
  arc_starfall_arrow: [e.zone(3)],
  // ---------------- Archer: debuff ----------------
  arc_hunters_mark: [e.vuln(20, 15)],
  arc_crippling_shot: [e.slow(60, 6)],
  arc_blinding_shot: [e.weaken(70, 4)],
  arc_rend_armor: [e.sunder(30, 10)],
  arc_neurotoxin: [e.slow(40, 6), e.poison(6)],
  arc_entangling_net: [e.root(3.5)],
  arc_expose_weakness: [e.vuln(25, 8)],
  arc_concussive_shot: [e.stun(2)],
  arc_enfeebling_poison: [e.weaken(25, 10), e.poison(6)],
  arc_preys_dread: [e.fear(2)],

  // ---------------- Druid: melee ----------------
  dru_bear_slam: [e.stun(1)],
  dru_wolf_flurry: [],
  dru_hawk_talon_strike: [e.weaken(50, 2)],
  dru_bear_charge: [e.dash(280, 'fwd'), e.knockback(80)],
  dru_wolf_pounce: [e.stun(2)],
  dru_hawk_feather_flurry: [e.zone(2)],
  dru_bear_mangle: [e.weaken(30, 6), e.bleed(6)],
  dru_wolf_throat_rip: [e.execute(30, 200)],
  dru_hawk_wind_slash: [],
  dru_bear_earth_stomp: [e.stun(2)],
  dru_wolf_rend: [e.sunder(20, 6)],
  dru_hawk_aerial_evade_strike: [e.dash(180, 'fwd')],
  dru_thorn_staff_strike: [e.poison(5)],
  dru_bear_frenzy: [e.lifesteal(15)],
  dru_wolf_pack_strike: [e.summon('wolf', 2, 8)],
  dru_hawk_razor_feathers: [],
  dru_ursocs_wrath: [e.zone(2), e.stun(1)],
  dru_maul: [e.stun(1)],
  dru_feral_bite: [e.bleed(6)],
  dru_hawk_dive_slash: [e.dash(200, 'fwd')],
  // ---------------- Druid: magic ----------------
  dru_wrath: [],
  dru_moonfire: [e.burn(12)],
  dru_starfall: [e.zone(3)],
  dru_summon_wolfpack: [e.summon('wolf', 2, 25)],
  dru_summon_treant: [e.summon('treant', 1, 25), e.taunt(4)],
  dru_cyclone: [],
  dru_storm_lightning: [e.shock()],
  dru_bramble_burst: [e.bleed(4)],
  dru_solar_beam: [e.burn(3)],
  // ---------------- Druid: debuff ----------------
  dru_entangling_roots: [e.root(5)],
  dru_hibernate: [e.stun(6)],
  dru_demoralizing_roar: [e.weaken(30, 10)],
  dru_poison_ivy: [e.poison(8)],
  dru_insect_swarm: [e.weaken(35, 8)],
  dru_rot_wood: [e.vuln(25, 10)],
  dru_spore_cloud: [e.fear(3)],
  dru_natures_curse: [e.vuln(40, 10)],
  dru_paralytic_spores: [e.slow(60, 4), e.stun(2)],
  dru_constricting_vines: [e.root(3), e.weaken(40, 3)],
};

// DOT damage (bleed / poison / burn) totals this share of ONE cast's damage, spread
// over its duration. A bleed is a rider on a hit, not a second hit.
const DOT_SHARE = 0.6;

// The allies a `summon` effect can make. `entity` is an existing creature type (the
// sim needs a catalog row to build one; there is no art for a treant or a golem yet,
// so those borrow the closest existing body). hpOwner / dmgHit: the ally's max life
// as a fraction of the OWNER's max life, and its damage per blow as a fraction of
// one average weapon hit at the skill's level. `reach` is the radius it fights in.
const SUMMON_KINDS = {
  wolf: { entity: 'Wolf', hpOwner: 0.35, dmgHit: 0.9, label: 'Spirit wolf' },
  treant: { entity: 'Skeleton', hpOwner: 1.2, dmgHit: 0.6, label: 'Treant' },
  golem: { entity: 'Skeleton', hpOwner: 1.0, dmgHit: 1.0, label: 'Blood golem' },
  warlord: { entity: 'Skeleton', hpOwner: 1.4, dmgHit: 1.6, label: 'Spectral warlord' },
  clone: { entity: 'Bat', hpOwner: 0.15, dmgHit: 0.5, label: 'Illusion' },
  spirit: { entity: 'Bat', hpOwner: 0.5, dmgHit: 1.2, label: 'Astral spirit' },
};

function effectsOf(id) { return SKILL_EFFECTS[id] || []; }
function hitsOf(id, fallback = 1) { return HITS[id] || fallback; }

module.exports = { SKILL_EFFECTS, HITS, DOT_SHARE, SUMMON_KINDS, effectsOf, hitsOf, e };
