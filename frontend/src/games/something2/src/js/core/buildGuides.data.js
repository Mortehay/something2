// Build guides for the in-game guide panel (data only, no imports).
// Source: docs/builds.md (design) + passive_nodes. Passive steps are stable node keys, never DB ids.
// Each class lists the 150-point passive path in take order, start node excluded.

export const BUILD_GUIDES = {
  "Warrior": {
    "className": "Warrior",
    "name": "Steel Whirl",
    "summary": "A one-handed melee fighter whose main damage is the auto-attack, boosted by STR and capped at the cooldown floor, plus short 360-degree bursts of Flurry of Steel.",
    "playstyle": "Hold the attack button on your target and tap Flurry of Steel for 2-4 channel ticks at a time; long channels get expensive fast. Keep Battle Shout and Steel Tempering up before hard fights. Tankiness comes from tree HP and two always-on defensive layers.",
    "stats": [
      {
        "stat": "STR",
        "why": "Double value: multiplies every weapon hit and every Warrior skill, and gates weapon tiers. Plan: STR 358 at 150 points."
      },
      {
        "stat": "DEX",
        "why": "+3% speed per point until the cooldown floor (0.40, or 0.35 with Fleet). Plan: DEX 45 at 30 points, 84 at 150."
      },
      {
        "stat": "CON",
        "why": "+10 HP per point, +0.1 HP/s, and a gem requirement (up to 22). Plan: CON 163 for 2266 HP."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "war_flurry_of_steel",
        "name": "Flurry of Steel",
        "unlock": "Lv 17 · quest act1_sunspire_reliquary · 2138 g",
        "why": "Core 360-degree burst for 4 stamina per tick. Use it in short 2-4 tick bursts."
      },
      {
        "slot": 2,
        "skillId": "war_twin_slash",
        "name": "Twin Slash",
        "unlock": "Lv 12 · 1600 g",
        "why": "Cheap single-target filler: 2 hits for 14 stamina on a 2 s cooldown."
      },
      {
        "slot": 3,
        "skillId": "war_windblade",
        "name": "Windblade",
        "unlock": "Lv 39 · quest act2_obsidian_drake · 4713 g",
        "why": "Your only ranged poke, paid from the otherwise idle mana pool (14 mana, 3 s cooldown, range 320)."
      },
      {
        "slot": 4,
        "skillId": "war_sunder_armor",
        "name": "Sunder Armor",
        "unlock": "Lv 52 · quest act4_primordial_sovereign (secret gem) · 6575 g",
        "why": "AoE hit for 11 stamina that also shreds armor by 35% for 12 s. Open a pack with it, then hit the weakened targets."
      },
      {
        "slot": 5,
        "skillId": "war_battle_shout",
        "name": "Battle Shout",
        "unlock": "Lv 42 · quest act3_nether_behemoth (secret gem) · 5125 g",
        "why": "The only damage buff: x1.2 damage for 20 s on a 30 s cooldown (about 67% uptime)."
      },
      {
        "slot": 6,
        "skillId": "war_steel_tempering",
        "name": "Steel Tempering",
        "unlock": "Lv 48 · quest act3_nether_behemoth (secret gem) · 6025 g",
        "why": "-15% damage taken for 30 s on a 30 s cooldown: a near-permanent defensive layer."
      },
      {
        "slot": 7,
        "skillId": "war_colossus_stance",
        "name": "Colossus Stance",
        "unlock": "Lv 46 · quest act3_nether_behemoth (secret gem) · 5675 g",
        "why": "+30% max HP and x1.25 reach for 15 s (50 s cooldown). Use on bosses and dense packs."
      },
      {
        "slot": 8,
        "skillId": "war_bloodlust_stance",
        "name": "Bloodlust Stance",
        "unlock": "Lv 45 · quest act3_nether_behemoth (secret gem) · 5538 g",
        "why": "Up to +30% attack speed for 20 stamina. Useful only below the speed cap; swap for Unstoppable (L47) later."
      },
      {
        "slot": 9,
        "skillId": "war_last_stand",
        "name": "Last Stand",
        "unlock": "Lv 47 · quest act3_nether_behemoth (secret gem) · 5888 g",
        "why": "Emergency button: HP cannot drop below 1 for 4 s (120 s cooldown)."
      }
    ],
    "earlySkills": [
      {
        "skillId": "war_crushing_blow",
        "name": "Crushing Blow",
        "level": 1,
        "note": "Starter trio (100 g). Needs only 1-2 STR from the first minor nodes."
      },
      {
        "skillId": "war_whirlwind",
        "name": "Whirlwind",
        "level": 1,
        "note": "Channeled 360-degree hit for 5 stamina per tick; use it until Flurry of Steel replaces it."
      },
      {
        "skillId": "war_hamstring_slash",
        "name": "Hamstring Slash",
        "level": 1,
        "note": "Third starter skill. L1-11 plan: Whirlwind + Crushing Blow + Hamstring Slash."
      },
      {
        "skillId": "war_punishing_strike",
        "name": "Punishing Strike",
        "level": 10,
        "note": "Next melee upgrade before Twin Slash."
      }
    ],
    "passives": {
      "startKey": "start-strength",
      "steps": [
        {
          "key": "strength-r1-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r1-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r1-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r1-0-7",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r1-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r2-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-22",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-21",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-20",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-13",
          "label": "Unbreakable — +20 STR and +100 maximum life",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-3-14",
          "label": "Martial Mastery",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-15",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "strength-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-19",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r4-3-1",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-18",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-23",
          "label": "Charge",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-22",
          "label": "Apostasy",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-24",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-5",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-20",
          "label": "Unflagging",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-6",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-14",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-13",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-12",
          "label": "Ox Blood",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-11",
          "label": "Paragon",
          "kind": "greater"
        },
        {
          "key": "strength-r4-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-19",
          "label": "Reckless Swing — +25% physical damage, -10% ice resistance",
          "kind": "keystone"
        },
        {
          "key": "strength-r4-2-2",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-1",
          "label": "Second Wind",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-5",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-6",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-7",
          "label": "Apotheosis",
          "kind": "notable"
        },
        {
          "key": "clu_str_afterimage-hub",
          "label": "Afterimage",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-3",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "strength-r3-3-2",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-7",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "strength-r3-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r2-4-8",
          "label": "Iron Hide — +140 maximum life and +1.2 HP regen/s",
          "kind": "keystone"
        },
        {
          "key": "strength-r2-4-7",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "strength-r2-4-6",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "strength-r3-3-8",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-9",
          "label": "Apotheosis",
          "kind": "notable"
        },
        {
          "key": "strength-r3-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-30",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-1",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-0",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-36",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "strength-r3-2-35",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "strength-r3-0-12",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-11",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-10",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-9",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-7",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r2-1-27",
          "label": "Executioner — +15% physical damage and +12 melee reach",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-1-21",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-29",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-28",
          "label": "Edge",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-27",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-26",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "strength-r3-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-8",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-3",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-2",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-5",
          "label": "Apotheosis",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Fleet — your cooldown floor drops from 0.40 to 0.35",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-11",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "dexterity-r2-4-8",
          "label": "Windrunner — +15 DEX, +40 max stamina, +5 stamina regen/s",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-3-14",
          "label": "Marksman's Mastery",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-15",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-6",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-14",
          "label": "Wellspring",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-13",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-12",
          "label": "Null Field",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-11",
          "label": "Paragon",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-7",
          "label": "Broad Study",
          "kind": "notable"
        },
        {
          "key": "clu_str_afterimage-sat0",
          "label": "Lingering Edge",
          "kind": "notable"
        },
        {
          "key": "clu_str_afterimage-sat1",
          "label": "Slow Burn",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-21",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-29",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-28",
          "label": "Edge",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-27",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-26",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r2-1-27",
          "label": "Pain Ward — +10% physical and +10% fire resistance, +1.2 HP regen/s",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-7",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-9",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-10",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-11",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-12",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Crimson Bargain — every skill hits 40% harder, but costs 30% more life",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-1-36",
          "label": "Polymath",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-8",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-8",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-17",
          "label": "Kindling",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-16",
          "label": "Callus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-15",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-0",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-1",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-2",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-6",
          "label": "Wind (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-7",
          "label": "Wind (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-8",
          "label": "Charge",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-9",
          "label": "Wind (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Wolf Aspect — +15 STR, +15 CHA, +12% physical damage, forms 12% stronger",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-0-3",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-4",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-5",
          "label": "Sinew (CON)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-1-27",
          "label": "Bear Aspect — +20 STR, +120 HP, +1.5 HP regen/s, +5% physical resistance, forms 12% stronger",
          "kind": "keystone"
        },
        {
          "key": "strength-r1-2-13",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "strength-r1-2-14",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "strength-r1-2-15",
          "label": "Unflagging",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-15",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-23",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-22",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-21",
          "label": "Honed",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "STR 27, 116 HP, 118 mana. Still all minor nodes on the way to Unbreakable (point 12)."
        },
        {
          "points": 30,
          "summary": "STR 95, DEX 45, CON 37, 554 HP. Martial Mastery (+10% STR skill damage) and several Ascendance/Paragon nodes taken; attack interval about x0.45."
        },
        {
          "points": 60,
          "summary": "STR 199, CON 57, 966 HP. Reckless Swing, Afterimage and Iron Hide taken: physical damage +44%."
        },
        {
          "points": 100,
          "summary": "STR 321, DEX 80, CON 83, 1258 HP. Executioner, Fleet and Windrunner taken; cooldown floor 0.35."
        },
        {
          "points": 150,
          "summary": "STR 358, DEX 84, CON 163, 2266 HP, 235 stamina. Pain Ward, Crimson Bargain and the Wolf/Bear Aspect stat nodes taken."
        }
      ],
      "keystones": [
        {
          "key": "strength-r3-3-13",
          "label": "Unbreakable — +20 STR and +100 maximum life",
          "atStep": 12,
          "note": "+20 STR and +100 HP; the entry to the inner STR ring at point 12. No drawback."
        },
        {
          "key": "strength-r3-3-14",
          "label": "Martial Mastery",
          "atStep": 13,
          "note": "+10% damage to all STR skills."
        },
        {
          "key": "strength-r3-2-19",
          "label": "Reckless Swing — +25% physical damage, -10% ice resistance",
          "atStep": 38,
          "note": "+25% physical damage but -10% ice resistance. Skip it if you fight ice bosses."
        },
        {
          "key": "clu_str_afterimage-hub",
          "label": "Afterimage",
          "atStep": 44,
          "note": "Melee wave worth 15% of swing damage per second (+5% from each of two satellites). No drawback."
        },
        {
          "key": "strength-r2-4-8",
          "label": "Iron Hide — +140 maximum life and +1.2 HP regen/s",
          "atStep": 50,
          "note": "+140 HP and +1.2 HP/s regen. No drawback."
        },
        {
          "key": "strength-r2-1-27",
          "label": "Executioner — +15% physical damage and +12 melee reach",
          "atStep": 71,
          "note": "+15% physical damage and +12 reach. No drawback."
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Fleet — your cooldown floor drops from 0.40 to 0.35",
          "atStep": 89,
          "note": "Cooldown floor 0.35: the fastest attack and cooldown cap."
        },
        {
          "key": "dexterity-r2-4-8",
          "label": "Windrunner — +15 DEX, +40 max stamina, +5 stamina regen/s",
          "atStep": 92,
          "note": "+15 DEX, +40 stamina and +5 stamina regen."
        },
        {
          "key": "constitution-r2-1-27",
          "label": "Pain Ward — +10% physical and +10% fire resistance, +1.2 HP regen/s",
          "atStep": 111,
          "note": "+10% physical and fire resistance, +1.2 HP/s regen."
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Crimson Bargain — every skill hits 40% harder, but costs 30% more life",
          "atStep": 123,
          "note": "x1.4 skill damage. Its life-cost penalty does nothing for a Warrior, so it is a pure bonus."
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Wolf Aspect — +15 STR, +15 CHA, +12% physical damage, forms 12% stronger",
          "atStep": 139,
          "note": "Taken only as a STR/HP source on the path; its form power is useless for Warrior (replace with Ascendance if you prefer)."
        },
        {
          "key": "charisma-r2-1-27",
          "label": "Bear Aspect — +20 STR, +120 HP, +1.5 HP regen/s, +5% physical resistance, forms 12% stronger",
          "atStep": 143,
          "note": "Taken only as a STR/HP source (+20 STR, +120 HP); its form power is not needed."
        }
      ]
    },
    "gear": [
      "Weapon: a one-handed STR blade: sword (reach 85), axe (more damage per hit) or blade. Tier 2+ weapons cost no stamina.",
      "Weapon tiers by STR: iron 8, steel 16, tempered 26, runed 36, obsidian 48, astral 62, void 78, dragon 96, mythic 116.",
      "Skip two-handed weapons (two-handed sword, halberd, scythe): they are old tier-1 gear costing 15-18 stamina per swing.",
      "Armour: STR plate (helm, plate, gauntlets, buckler) plus CON greaves. Armour reduces every hit by a flat amount.",
      "Rings need CHA; with CHA 44 you can wear up to a runed band (36). Good affixes: of_might, of_the_bear, of_vigor."
    ],
    "weaknesses": [
      "Only 190 mana at 150 points: Windblade runs dry after a few casts, so do not rely on magic skills.",
      "No ranged attack or mobility. Fight up close; Colossus Stance (reach x1.25) and the Cleaving Reach cluster help.",
      "-10% ice resistance if you take Reckless Swing.",
      "Stamina is your only real resource (235 pool, 25/s regen): avoid long Flurry channels.",
      "No dependable crowd control of your own beyond a few stuns and slows on skills; Iron Will (L44) gives 5 s status immunity if needed. Bosses are immune to stun, root, silence and fear."
    ]
  },
  "Mage": {
    "className": "Mage",
    "name": "Frost-Fire Cadence",
    "summary": "A ranged caster with two extra projectiles, alternating ice and fire to trigger Shatter and Thermal Shock, protected by Mana Shield and Blink.",
    "playstyle": "Open with Elemental Focus, then alternate Frostbolt and Fireball so every pair triggers a synergy, finish with Magic Missiles and use Blizzard on packs. Keep Mana Shield up all the time and Blink away from danger.",
    "stats": [
      {
        "stat": "INT",
        "why": "Multiplies every Mage skill (+5% per point), adds 10 mana per point and 0.5 mana/s regen. Plan: INT 392."
      },
      {
        "stat": "WIS",
        "why": "+0.5 mana/s per point; gems need about 22. The plan reaches WIS 73, which is plenty."
      },
      {
        "stat": "DEX",
        "why": "First a path to Deadeye and Volley, then speed: DEX 96 reaches the 0.35 floor with Fleet."
      },
      {
        "stat": "CON",
        "why": "Only about 10 for gems and some HP, since Mage starts at 75 HP. Plan: 724 HP."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "mag_frostbolt",
        "name": "Frostbolt",
        "unlock": "Lv 17 · quest act1_sunspire_reliquary · 2138 g",
        "why": "Cheap ice bolt (20 mana, 1.5 s). With +2 projectiles it hits 3 times. Starts the Shatter synergy."
      },
      {
        "slot": 2,
        "skillId": "mag_fireball",
        "name": "Fireball",
        "unlock": "Lv 16 · quest act1_sunspire_reliquary · 2000 g",
        "why": "Fire AoE bolt, also 3 hits. Finishes Shatter and primes Thermal Shock; alternate with Frostbolt."
      },
      {
        "slot": 3,
        "skillId": "mag_magic_missiles",
        "name": "Magic Missiles",
        "unlock": "Lv 31 · quest act2_obsidian_drake · 3688 g",
        "why": "Multi-hit: 7 hits with the extra projectiles for 22 mana. Best damage per mana among single-target spells."
      },
      {
        "slot": 4,
        "skillId": "mag_blizzard",
        "name": "Blizzard",
        "unlock": "Lv 29 · quest act2_obsidian_drake · 3488 g",
        "why": "Channeled ice AoE at the cursor, 6 mana per tick. Your regen sustains it indefinitely."
      },
      {
        "slot": 5,
        "skillId": "mag_blink",
        "name": "Blink",
        "unlock": "Lv 26 · quest act1_sunspire_reliquary · 3150 g",
        "why": "The only real movement skill: about 260 px forward on a 4 s cooldown. Saves a fragile mage."
      },
      {
        "slot": 6,
        "skillId": "mag_mana_shield",
        "name": "Mana Shield",
        "unlock": "Lv 42 · quest act3_nether_behemoth (secret gem) · 5125 g",
        "why": "70% of incoming damage is paid from mana. It costs 25 mana to cast and lasts 30 s: recast as it ends, and never run it on an empty pool."
      },
      {
        "slot": 7,
        "skillId": "mag_empower_elements",
        "name": "Empower Elements",
        "unlock": "Lv 50 · quest act3_nether_behemoth (secret gem) · 6300 g",
        "why": "x1.3 damage for 15 s (30 s cooldown); stacks with Arcane Brilliance."
      },
      {
        "slot": 8,
        "skillId": "mag_arcane_brilliance",
        "name": "Arcane Brilliance",
        "unlock": "Lv 46 · quest act3_nether_behemoth (secret gem) · 5675 g",
        "why": "x1.25 damage for 30 s (60 s cooldown): cast it for boss windows, not on cooldown."
      },
      {
        "slot": 9,
        "skillId": "mag_elemental_focus",
        "name": "Elemental Focus",
        "unlock": "Lv 47 · quest act3_nether_behemoth (secret gem) · 5888 g",
        "why": "The next 3 spells always crit. Cast it before Magic Missiles or Frostbolt."
      }
    ],
    "earlySkills": [
      {
        "skillId": "mag_arcane_dagger",
        "name": "Arcane Dagger",
        "level": 1,
        "note": "First skill (100 g). Melee-type, but you must hold a staff or wand."
      },
      {
        "skillId": "mag_frost_rapier",
        "name": "Frost Rapier",
        "level": 1,
        "note": "Second starter skill; also needs a staff or wand in hand."
      },
      {
        "skillId": "mag_mana_blades",
        "name": "Mana Blades",
        "level": 6,
        "note": "Last early melee-type skill; your ranged damage until L16 is the wand auto-attack."
      }
    ],
    "passives": {
      "startKey": "start-intelligence",
      "steps": [
        {
          "key": "intelligence-r1-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-22",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-21",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-20",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-13",
          "label": "Transcendence — +25 WIS and +18 INT",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-3-11",
          "label": "Thick Skin",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-3-10",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-9",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-6",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-14",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-1-13",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-12",
          "label": "Ox Blood",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-1-11",
          "label": "Paragon",
          "kind": "greater"
        },
        {
          "key": "intelligence-r1-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-7",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-27",
          "label": "Deadeye — +20 DEX and +1 Extra Arrow",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-1-10",
          "label": "Cryomancy — +20% ice damage, and your hits chill",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r2-1-28",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-2-0",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-22",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-21",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-20",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-19",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-3-1",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "intelligence-r4-3-0",
          "label": "Null Field",
          "kind": "notable"
        },
        {
          "key": "intelligence-r4-2-24",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "intelligence-r3-3-13",
          "label": "Arcane Conduit — +15 INT, +35 max mana, +3.0 mana regen/s",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-3-14",
          "label": "Arcane Mastery",
          "kind": "greater"
        },
        {
          "key": "intelligence-r3-3-5",
          "label": "Broad Study",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-3-2",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-7",
          "label": "Second Discipline",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-21",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-22",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-23",
          "label": "Hunter's Reflexes",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-24",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-25",
          "label": "Hardy",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-9",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-8",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-13",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "clu_dex_volley-hub",
          "label": "Volley",
          "kind": "greater"
        },
        {
          "key": "intelligence-r4-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-2",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-1",
          "label": "Second Wind",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-5",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-6",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "intelligence-r4-2-3",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-3-15",
          "label": "Kindling",
          "kind": "notable"
        },
        {
          "key": "intelligence-r4-2-18",
          "label": "Frostbite",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-1-27",
          "label": "Pyromancy — +20% fire damage, and your hits burn",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-1-21",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-29",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-28",
          "label": "Edge",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-27",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-1-26",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "intelligence-r1-3-16",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-4-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-4-1",
          "label": "Broad Study",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-1-28",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-2-0",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-2-30",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-1",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-0",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-2-36",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-2-35",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "intelligence-r3-2-19",
          "label": "Glass Cannon — every skill hits 35% harder and costs 25% more mana, -80 max life",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-1-25",
          "label": "Hardy",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-1-9",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-1-16",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-1-15",
          "label": "Jarring Blows",
          "kind": "notable"
        },
        {
          "key": "intelligence-r4-1-14",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "intelligence-r2-4-8",
          "label": "Storm Caller — +20% lightning damage, and your hits shock",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r2-4-9",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-4-10",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-4-11",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-4-12",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-0-7",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-9",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-10",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-11",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-12",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Fleet — your cooldown floor drops from 0.40 to 0.35",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-2-19",
          "label": "Phantom Step — 15% chance to dodge a blow outright, +20 max stamina",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-2-31",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-2-32",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-0-12",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-11",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-10",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-3-3",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-3-4",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-3-5",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-3-2",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-3-1",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "intelligence-r4-2-20",
          "label": "Resonance",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-4-7",
          "label": "Callus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-4-6",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-2-19",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-2-18",
          "label": "Frostbite",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-3-1",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "wisdom-r4-2-20",
          "label": "Resonance",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-1-26",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-1-25",
          "label": "Great Sinew",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "INT 15, WIS 16, 262 mana, 91 HP. Twelve minor nodes lead to Transcendence at point 13."
        },
        {
          "points": 30,
          "summary": "INT 101, WIS 45, 1134 mana, 262 HP. Transcendence, Wanderer's Gift and Paragon taken; all gem requirements met."
        },
        {
          "points": 60,
          "summary": "INT 164, DEX 57, 1841 mana. Deadeye, Cryomancy, Arcane Conduit and Arcane Mastery taken (+1 projectile, +20% ice)."
        },
        {
          "points": 100,
          "summary": "INT 275, 2963 mana, 553 HP. Volley (second extra projectile) and Pyromancy taken; fire and ice damage +28%."
        },
        {
          "points": 150,
          "summary": "INT 392, DEX 96, 4145 mana, 724 HP. Glass Cannon, Storm Caller, Fleet and Phantom Step taken; cooldown floor 0.35."
        }
      ],
      "keystones": [
        {
          "key": "wisdom-r3-3-13",
          "label": "Transcendence — +25 WIS and +18 INT",
          "atStep": 13,
          "note": "+25 WIS and +18 INT; the entry point at point 13. No drawback."
        },
        {
          "key": "dexterity-r2-1-27",
          "label": "Deadeye — +20 DEX and +1 Extra Arrow",
          "atStep": 38,
          "note": "+20 DEX and +1 projectile. No drawback."
        },
        {
          "key": "intelligence-r3-1-10",
          "label": "Cryomancy — +20% ice damage, and your hits chill",
          "atStep": 39,
          "note": "+20% ice damage and chill status. No drawback."
        },
        {
          "key": "intelligence-r3-3-13",
          "label": "Arcane Conduit — +15 INT, +35 max mana, +3.0 mana regen/s",
          "atStep": 51,
          "note": "+15 INT, +35 mana and +3 mana/s regen. No drawback."
        },
        {
          "key": "intelligence-r3-3-14",
          "label": "Arcane Mastery",
          "atStep": 52,
          "note": "+10% damage to INT skills."
        },
        {
          "key": "clu_dex_volley-hub",
          "label": "Volley",
          "atStep": 65,
          "note": "Second +1 projectile, for +2 total: single-hit spells hit three times."
        },
        {
          "key": "intelligence-r2-1-27",
          "label": "Pyromancy — +20% fire damage, and your hits burn",
          "atStep": 82,
          "note": "+20% fire damage and burn status. No drawback."
        },
        {
          "key": "intelligence-r3-2-19",
          "label": "Glass Cannon — every skill hits 35% harder and costs 25% more mana, -80 max life",
          "atStep": 104,
          "note": "x1.35 skill damage, but -80 max HP and +25% mana cost. Offset by Mana Shield; Crimson Bargain is the alternative."
        },
        {
          "key": "intelligence-r2-4-8",
          "label": "Storm Caller — +20% lightning damage, and your hits shock",
          "atStep": 111,
          "note": "+20% lightning damage and shock status. No drawback."
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Fleet — your cooldown floor drops from 0.40 to 0.35",
          "atStep": 129,
          "note": "Cooldown floor 0.35."
        },
        {
          "key": "dexterity-r3-2-19",
          "label": "Phantom Step — 15% chance to dodge a blow outright, +20 max stamina",
          "atStep": 131,
          "note": "+15% dodge and +20 stamina. No drawback."
        }
      ]
    },
    "gear": [
      "Weapon: a wand (1H, needs INT) or staff (2H). Tiered wands and staves have no element, so their auto-attack scales with STR, not INT.",
      "Fix that with a replace-stone (stone_of_*) in the weapon: it supplies element, damage and cooldown, and the attack then scales with INT.",
      "Armour: robes (INT), hoods (DEX), focus off-hand (WIS) and arcane-ward helm (+30% arcane resistance). Robes give about half the defence of plate.",
      "Rings need CHA (Mage has 11), so only an iron band is realistic. Good affixes: of_the_well, of_insight, of_the_bear."
    ],
    "weaknesses": [
      "Only 724 HP at 150 points, and the shield depends on mana: avoid fights with an empty pool, for example right after a respawn.",
      "Low physical defence and 18% dodge: keep your distance, use Blink on cooldown, and keep Ethereal Form (L49) in reserve.",
      "Glass Cannon mana cost stacks additively with any future mana-cost nodes.",
      "Every skill from L16 is behind act quest gates (act1 for L16-27, act2 for L28-39, act3 for L40-51).",
      "Crowd control is short: Frost Nova roots for 3 s, Polymorph stuns for 5 s, Frostbolt slows. Bosses are immune to stun and root."
    ]
  },
  "Monk": {
    "className": "Monk",
    "name": "Flow of Chi",
    "summary": "A semi-magical fighter powered by a huge mana pool: channeled Spinning Crane Kick and Jade Serpent Beam never run dry, and the start node turns mana regen into life.",
    "playstyle": "Start fights with Fast Mana Aura and keep Tiger Stance up. Move in short steps between bursts of Spinning Crane Kick; pausing over 0.6 s resets the channel ramp and keeps costs low. Use Jade Serpent Beam on bosses.",
    "stats": [
      {
        "stat": "WIS",
        "why": "Multiplies all Monk skills (+5% per point), adds 0.12 mana/s regen and, with Ki Overflow, +2 max mana per point. Plan: WIS 366."
      },
      {
        "stat": "DEX",
        "why": "Gem requirement up to 24 and +3% speed per point. Plan: DEX 45."
      },
      {
        "stat": "STR",
        "why": "Gem requirement of about 15 on every Monk skill. Plan: STR 23."
      },
      {
        "stat": "CON",
        "why": "Gem requirement of about 15 and your HP source (1725 HP at 150 points). Plan: CON 137."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "mnk_spinning_crane_kick",
        "name": "Spinning Crane Kick",
        "unlock": "Lv 22 · quest act1_sunspire_reliquary · 2675 g",
        "why": "360-degree channel for 4 mana per tick; your regen sustains it even at full channel ramp. Main AoE."
      },
      {
        "slot": 2,
        "skillId": "mnk_jade_serpent_beam",
        "name": "Jade Serpent Beam",
        "unlock": "Lv 32 · quest act2_obsidian_drake · 3825 g",
        "why": "Ranged channeled cone, range 400. For single targets and kiting."
      },
      {
        "slot": 3,
        "skillId": "mnk_flowing_strike",
        "name": "Flowing Strike",
        "unlock": "Lv 29 · quest act2_obsidian_drake · 3488 g",
        "why": "Filler: 15 base damage for 8 mana on a 2 s cooldown, the best single-target melee value."
      },
      {
        "slot": 4,
        "skillId": "mnk_spirit_burst",
        "name": "Spirit Burst",
        "unlock": "Lv 35 · quest act2_obsidian_drake · 4163 g",
        "why": "Radial burst around the cursor: 20 base damage for 19 mana (4 s cooldown)."
      },
      {
        "slot": 5,
        "skillId": "mnk_dragons_breath",
        "name": "Dragon's Breath",
        "unlock": "Lv 39 · quest act2_obsidian_drake · 4713 g",
        "why": "Cone burst for groups: 22 base damage for 20 mana (4 s cooldown)."
      },
      {
        "slot": 6,
        "skillId": "mnk_tiger_stance",
        "name": "Tiger Stance",
        "unlock": "Lv 46 · quest act3_nether_behemoth (secret gem) · 5675 g",
        "why": "+25% move speed and x1.3 attack speed for 30 s. Keep it on; the attack speed part only helps below the cap."
      },
      {
        "slot": 7,
        "skillId": "mnk_fast_mana_aura",
        "name": "Fast Mana Aura",
        "unlock": "Lv 42 · quest act3_nether_behemoth (secret gem) · 5125 g",
        "why": "Doubles mana regen for 30 s for 12 mana. Refresh every 30 s."
      },
      {
        "slot": 8,
        "skillId": "mnk_diamond_skin",
        "name": "Diamond Skin",
        "unlock": "Lv 47 · quest act3_nether_behemoth (secret gem) · 5888 g",
        "why": "Absorbs 500 damage for 20 s (30 mana, 40 s cooldown): a wall against big hits."
      },
      {
        "slot": 9,
        "skillId": "mnk_touch_of_life",
        "name": "Touch of Life",
        "unlock": "Lv 47 · quest act3_nether_behemoth (secret gem) · 5813 g",
        "why": "Instant heal for 30% of max HP (35 mana, 10 s cooldown)."
      }
    ],
    "earlySkills": [
      {
        "skillId": "mnk_wind_palm",
        "name": "Wind Palm",
        "level": 1,
        "note": "First skill (100 g): 8 mana, 2 s cooldown."
      },
      {
        "skillId": "mnk_twin_serpent_strike",
        "name": "Twin Serpent Strike",
        "level": 2,
        "note": "Restores mana on hit."
      },
      {
        "skillId": "mnk_hundred_fists",
        "name": "Hundred Fists",
        "level": 8,
        "note": "360-degree channel; replaced by Spinning Crane Kick at L22."
      },
      {
        "skillId": "mnk_mantis_strike",
        "name": "Mantis Strike",
        "level": 12,
        "note": "Mid-early melee skill before the L22 channel."
      }
    ],
    "passives": {
      "startKey": "start-wisdom",
      "steps": [
        {
          "key": "wisdom-r1-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-7",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-22",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-21",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-20",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-13",
          "label": "Transcendence — +25 WIS and +18 INT",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-3-11",
          "label": "Thick Skin",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-3-10",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-9",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-3-8",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-3",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-7",
          "label": "Second Discipline",
          "kind": "notable"
        },
        {
          "key": "wisdom-r1-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-8",
          "label": "Focus (CON)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-0-14",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-18",
          "label": "Vigour (CON)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-17",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-16",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-8",
          "label": "Hawk Aspect — +20 DEX, +40 max stamina, +4 stamina regen/s, +8% attack speed, forms 12% stronger",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-3-8",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-9",
          "label": "Second Discipline",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-2-19",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-3-1",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-10",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-11",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-13",
          "label": "Menagerie — Aspect of the Wild (+25 CHA, +15 CON, +30 max mana, +2.0 mana regen/s, forms 15% stronger)",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r4-3-0",
          "label": "Null Field",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-2-24",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-3-14",
          "label": "Inner Mastery",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-6",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-14",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-13",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-12",
          "label": "Ox Blood",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-11",
          "label": "Paragon",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-1-27",
          "label": "Inner Flame — +20 WIS",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r3-1-21",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-29",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-28",
          "label": "Edge",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-27",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-26",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-8",
          "label": "Meditation — +70 max mana, +2.0 mana regen/s, +5% life share from mana regen",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-3-14",
          "label": "Wild Mastery",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-15",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-2-19",
          "label": "Ki Overflow — +30% skill damage while mana is nearly full, +2 max mana per WIS, skills cost 15% more mana",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r4-2-2",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-2-1",
          "label": "Second Wind",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-2-5",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-2-6",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "wisdom-r4-2-3",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "charisma-r1-0-7",
          "label": "Focus (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-6",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-5",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-4",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-3",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-2",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-1",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-0",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Crimson Bargain — every skill hits 40% harder, but costs 30% more life",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r2-1-28",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-2-0",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-9",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-10",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-11",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-12",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-2-30",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-1",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-0",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-2-36",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-2-35",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-12",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-11",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-10",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-9",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-36",
          "label": "Polymath",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-8",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-7",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-6",
          "label": "Thick Skin",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-5",
          "label": "Apostasy",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-1-25",
          "label": "Hardy",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-1-9",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-1-16",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-1-15",
          "label": "Jarring Blows",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-1-14",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "wisdom-r4-1-13",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "clu_wis_clarity-hub",
          "label": "Clarity",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-2-15",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-23",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-22",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-21",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-30",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-1",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-0",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-36",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-35",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "wisdom-r2-4-9",
          "label": "Callus",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-10",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "wisdom-r2-4-11",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-12",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "wisdom-r2-4-13",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-3",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-4",
          "label": "Overflowing Spirit",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-8",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-17",
          "label": "Kindling",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-16",
          "label": "Callus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-15",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-2-31",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-2-32",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "wisdom-r1-3-6",
          "label": "Second Wind",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-3-14",
          "label": "Economy of Motion",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-3-13",
          "label": "Economy of Motion",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-3-12",
          "label": "Overflowing Spirit",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-22",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-23",
          "label": "Quick Hands",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "WIS 27, 106 HP, 128 mana, 21 mana/s regen. All minor nodes on the way to Transcendence (point 12)."
        },
        {
          "points": 30,
          "summary": "WIS 62, DEX 35, CON 22, 349 HP. Transcendence and Hawk Aspect taken; +40 stamina, attack speed +8%."
        },
        {
          "points": 60,
          "summary": "WIS 206, CON 41, 774 mana, 142 mana/s regen. Menagerie, Inner Mastery, Inner Flame and Meditation taken."
        },
        {
          "points": 100,
          "summary": "WIS 280, CON 70, 959 HP. Ki Overflow (+30% damage at 80%+ mana) and Crimson Bargain (x1.4) taken."
        },
        {
          "points": 150,
          "summary": "WIS 366, CON 137, 1725 HP, 1566 mana, 224 mana/s regen; 25% of regenerated mana returns as life. Clarity and Quick Hands taken."
        }
      ],
      "keystones": [
        {
          "key": "wisdom-r3-3-13",
          "label": "Transcendence — +25 WIS and +18 INT",
          "atStep": 12,
          "note": "+25 WIS and +18 INT; entry into the WIS core at point 12. No drawback."
        },
        {
          "key": "charisma-r2-4-8",
          "label": "Hawk Aspect — +20 DEX, +40 max stamina, +4 stamina regen/s, +8% attack speed, forms 12% stronger",
          "atStep": 29,
          "note": "+20 DEX, +40 stamina, +8% attack speed. Taken as a DEX source; no drawback."
        },
        {
          "key": "charisma-r3-3-13",
          "label": "Menagerie — Aspect of the Wild (+25 CHA, +15 CON, +30 max mana, +2.0 mana regen/s, forms 15% stronger)",
          "atStep": 37,
          "note": "CHA/CON, +30 mana and +2 mana/s regen. Taken for the stats on the path; no drawback."
        },
        {
          "key": "wisdom-r3-3-14",
          "label": "Inner Mastery",
          "atStep": 40,
          "note": "+10% damage to WIS skills."
        },
        {
          "key": "wisdom-r2-1-27",
          "label": "Inner Flame — +20 WIS",
          "atStep": 52,
          "note": "+20 WIS. No drawback."
        },
        {
          "key": "wisdom-r2-4-8",
          "label": "Meditation — +70 max mana, +2.0 mana regen/s, +5% life share from mana regen",
          "atStep": 59,
          "note": "+70 mana, +2 mana/s and +5% life share. No drawback."
        },
        {
          "key": "wisdom-r3-2-19",
          "label": "Ki Overflow — +30% skill damage while mana is nearly full, +2 max mana per WIS, skills cost 15% more mana",
          "atStep": 68,
          "note": "+30% skill damage while mana is at 80% or more and +2 mana per WIS, for +15% mana cost. Your regen covers it."
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Crimson Bargain — every skill hits 40% harder, but costs 30% more life",
          "atStep": 87,
          "note": "x1.4 skill damage; the +30% life cost is free because Monk has no life-cost skills."
        },
        {
          "key": "clu_wis_clarity-hub",
          "label": "Clarity",
          "atStep": 122,
          "note": "+10% life share from mana regen."
        }
      ]
    },
    "gear": [
      "Weapon: a dagger (DEX, 0.45 cooldown, +15% crit chance) or bare hands (3 damage). A runed dagger (L55) fits the planned DEX 45.",
      "Do not use a quarterstaff: its name counts as a staff, and Monk skills accept only unarmed, melee or dagger weapons.",
      "Armour: a focus off-hand (WIS, the only gear matching your main stat), hood/boots/gloves (DEX), and robes (INT 63 fits up to tier 5).",
      "Good affixes: of_clarity (+WIS) and of_the_well (+mana on focus and rings)."
    ],
    "weaknesses": [
      "Auto-attack is weak (unarmed 3 damage x1.9 STR), so damage comes from skills that cost mana. Never let Fast Mana Aura lapse.",
      "No mobility: channels reach only 120 px and Jade Serpent Beam 400 px. Use Tiger Stance (+25% speed).",
      "Mid-sized HP pool (1725). Diamond Skin and Touch of Life help; Drunken Brawler Stance (L44) and Karma Redirection (L50) are alternatives.",
      "Gems from L22 to L47 sit behind the act 1-3 boss quests.",
      "Zen Strike deals +150% (250% in total) only at full mana, so open with it; Ki Overflow keeps the pool full."
    ]
  },
  "Cultist": {
    "className": "Cultist",
    "name": "Blood Atonement",
    "summary": "A life-powered caster: CON gives both skill damage and HP, spells cost a flat 15-50 HP, and leech plus Blood Pact keep you topped up.",
    "playstyle": "Spells cost fixed HP, which becomes trivial at 4000+ HP. Channel Soul Drain for healing and damage, add Bone Spear and Blood Lance for burst, and keep Blood Pact running. Use Bone Armor, Vampiric Embrace and Blood Rebirth as safety nets.",
    "stats": [
      {
        "stat": "CON",
        "why": "Double value: +10 HP per point and +5% skill damage (all 50 Cultist skills use CON). Plan: CON 390 for 4294 HP."
      },
      {
        "stat": "INT",
        "why": "Gem requirement up to 25; almost every Cultist skill needs INT. Plan: INT 28."
      },
      {
        "stat": "CHA",
        "why": "Gem requirement up to 28, and scepters need CHA (tier 6: 48, tier 7: 62). Plan: CHA 70."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "cul_soul_drain",
        "name": "Soul Drain",
        "unlock": "Lv 31 · quest act2_obsidian_drake · 3688 g",
        "why": "Leeching channel for 3 HP per tick; leech is 35% plus tree bonuses. Your main damage and survival skill."
      },
      {
        "slot": 2,
        "skillId": "cul_bone_spear",
        "name": "Bone Spear",
        "unlock": "Lv 35 · quest act2_obsidian_drake · 4163 g",
        "why": "Projectile: 15 base damage for 30 HP on a 2 s cooldown. Steady damage; the plan has no extra projectiles."
      },
      {
        "slot": 3,
        "skillId": "cul_blood_lance",
        "name": "Blood Lance",
        "unlock": "Lv 17 · quest act1_sunspire_reliquary · 2138 g",
        "why": "Projectile: 13 base damage for 35 HP (range 440). Your core until Soul Drain at L31."
      },
      {
        "slot": 4,
        "skillId": "cul_corpse_explosion",
        "name": "Corpse Explosion",
        "unlock": "Lv 20 · quest act1_sunspire_reliquary · 2475 g",
        "why": "Cheapest in HP: 15 HP on a 2 s cooldown, an AoE blast around the cursor."
      },
      {
        "slot": 5,
        "skillId": "cul_blood_boil",
        "name": "Blood Boil",
        "unlock": "Lv 19 · quest act1_sunspire_reliquary · 2338 g",
        "why": "AoE for packs: 18 base damage for 40 HP on a 5 s cooldown."
      },
      {
        "slot": 6,
        "skillId": "cul_blood_pact",
        "name": "Blood Pact",
        "unlock": "Lv 42 · quest act3_nether_behemoth (secret gem) · 5125 g",
        "why": "Costs a little life, lasts 60 s: x1.25 damage and x0.9 damage taken. Refresh once a minute."
      },
      {
        "slot": 7,
        "skillId": "cul_vampiric_embrace",
        "name": "Vampiric Embrace",
        "unlock": "Lv 45 · quest act3_nether_behemoth (secret gem) · 5538 g",
        "why": "30% leech for 15 s. It does not stack with Soul Drain, so use it under Bone Spear or Blood Lance."
      },
      {
        "slot": 8,
        "skillId": "cul_bone_armor",
        "name": "Bone Armor",
        "unlock": "Lv 43 · quest act3_nether_behemoth (secret gem) · 5263 g",
        "why": "Fully absorbs 3 hits (30 HP, 30 s cooldown)."
      },
      {
        "slot": 9,
        "skillId": "cul_blood_rebirth",
        "name": "Blood Rebirth",
        "unlock": "Lv 50 · quest act3_nether_behemoth (secret gem) · 6300 g",
        "why": "Revives you at 40% HP with a blast (180 s cooldown): death insurance."
      }
    ],
    "earlySkills": [
      {
        "skillId": "cul_sacrificial_stab",
        "name": "Sacrificial Stab",
        "level": 1,
        "note": "First skill (100 g): 15 HP, 1 s cooldown, 35% leech. Needs a dagger."
      },
      {
        "skillId": "cul_flesh_siphon_strike",
        "name": "Flesh Siphon Strike",
        "level": 2,
        "note": "Siphon leech skill for L1-15 dagger play."
      },
      {
        "skillId": "cul_vein_ripper",
        "name": "Vein Ripper",
        "level": 4,
        "note": "Dagger skill for L1-15. Never drop below the skill's HP cost: a cast needs at least 1 HP left."
      },
      {
        "skillId": "cul_vampiric_bite",
        "name": "Vampiric Bite",
        "level": 12,
        "note": "Last dagger skill before spells."
      },
      {
        "skillId": "cul_blood_orb",
        "name": "Blood Orb",
        "level": 16,
        "note": "First staff/wand spell; from L16 you must hold a staff or wand."
      }
    ],
    "passives": {
      "startKey": "start-constitution",
      "steps": [
        {
          "key": "constitution-r1-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-7",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-8",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-9",
          "label": "Second Discipline",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-10",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-11",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-0-0",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-1",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-2",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-6",
          "label": "Wind (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-14",
          "label": "Ox Blood (CHA)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-13",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-3-13",
          "label": "Blood Pact — life costs are reduced 15%",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-3-5",
          "label": "Apotheosis",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-19",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-3-1",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-3-0",
          "label": "Grounding",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-24",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r1-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-3",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-11",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-10",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-12",
          "label": "Grounding",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-11",
          "label": "Paragon (CHA)",
          "kind": "greater"
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Crimson Bargain — every skill hits 40% harder, but costs 30% more life",
          "kind": "keystone"
        },
        {
          "key": "constitution-r2-4-9",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-10",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-11",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-12",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-13",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-3",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-30",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-1",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-0",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-36",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-35",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-3-14",
          "label": "Sanguine Mastery",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Wolf Aspect — +15 STR, +15 CHA, +12% physical damage, forms 12% stronger",
          "kind": "keystone"
        },
        {
          "key": "constitution-r1-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-6",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-7",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-8",
          "label": "Fireproof",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-9",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-10",
          "label": "Vampiric Rite — skills heal 12% of the damage they deal, +2% max life per kill",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-1-11",
          "label": "Paragon",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-1-12",
          "label": "Ox Blood",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-14",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-2",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-1",
          "label": "Second Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-5",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-6",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-2-7",
          "label": "Apotheosis",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-19",
          "label": "Sanguine Rite — life costs are reduced a further 12%",
          "kind": "keystone"
        },
        {
          "key": "constitution-r4-2-3",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-20",
          "label": "Charge",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-21",
          "label": "Resonance",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-4",
          "label": "Sanguine Focus",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-10",
          "label": "Mending",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-9",
          "label": "Mending",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-14",
          "label": "Open Wounds",
          "kind": "minor"
        },
        {
          "key": "clu_con_bloodletting-hub",
          "label": "Bloodletting",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-2-20",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-21",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-13",
          "label": "Open Wounds",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-21",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-29",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-28",
          "label": "Edge",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-27",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-26",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-2-31",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-32",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-25",
          "label": "Hardy",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-9",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-16",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-15",
          "label": "Jarring Blows",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-1-14",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-1-13",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "clu_con_sanguine-hub",
          "label": "Sanguine Aura",
          "kind": "greater"
        },
        {
          "key": "clu_con_sanguine-sat0",
          "label": "Crimson Thirst",
          "kind": "notable"
        },
        {
          "key": "clu_con_sanguine-sat1",
          "label": "Deepening Thirst",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-1",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-2",
          "label": "Resonance",
          "kind": "notable"
        },
        {
          "key": "strength-r4-0-22",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-21",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-20",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-13",
          "label": "Unbreakable — +20 STR and +100 maximum life",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-14",
          "label": "Martial Mastery",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-15",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-12",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-11",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-10",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-3",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-2",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-1",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-3-4",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-5",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-5",
          "label": "Hardy",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-6",
          "label": "Blood Hunger",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-0-12",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-11",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-10",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-15",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-25",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-24",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-23",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-22",
          "label": "Resonance",
          "kind": "notable"
        },
        {
          "key": "clu_con_bloodletting-sat0",
          "label": "Red Harvest",
          "kind": "notable"
        },
        {
          "key": "constitution-r1-1-10",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-1",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-0",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-1-16",
          "label": "Sanguine Focus",
          "kind": "notable"
        },
        {
          "key": "clu_con_bloodletting-sat1",
          "label": "Feeding Frenzy",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-1-27",
          "label": "Pain Ward — +10% physical and +10% fire resistance, +1.2 HP regen/s",
          "kind": "keystone"
        },
        {
          "key": "constitution-r2-1-28",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-2-0",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "constitution-r1-2-9",
          "label": "Deep Reserve",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "CON 25, 350 HP, 3.0 HP/s regen. The start node already cuts life costs by 10%."
        },
        {
          "points": 30,
          "summary": "CON 79, CHA 27, 916 HP. Second Discipline, Renaissance and Blood Pact taken (gem stats met early)."
        },
        {
          "points": 60,
          "summary": "CON 152, CHA 62, 1662 HP. Crimson Bargain (x1.4 skill damage) taken; life cost multiplier x1.05."
        },
        {
          "points": 100,
          "summary": "CON 296, 3223 HP, 33 HP/s regen. Vampiric Rite and Sanguine Rite taken: 12% skill leech, life cost x0.93."
        },
        {
          "points": 150,
          "summary": "CON 390, STR 53, 4294 HP, 43.7 HP/s regen, 20% skill leech. Sanguine Aura, Unbreakable and Pain Ward taken."
        }
      ],
      "keystones": [
        {
          "key": "constitution-r3-3-9",
          "label": "Second Discipline",
          "atStep": 11,
          "note": "+8 CHA; the first gem-stat tax node."
        },
        {
          "key": "constitution-r3-3-11",
          "label": "Renaissance",
          "atStep": 13,
          "note": "+12 INT; the second gem-stat tax node."
        },
        {
          "key": "constitution-r3-3-13",
          "label": "Blood Pact — life costs are reduced 15%",
          "atStep": 21,
          "note": "-15% life costs. No drawback."
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Crimson Bargain — every skill hits 40% harder, but costs 30% more life",
          "atStep": 34,
          "note": "x1.4 skill damage but +30% life cost: a real penalty here, offset by the start node, Blood Pact and Sanguine Rite."
        },
        {
          "key": "constitution-r3-1-10",
          "label": "Vampiric Rite — skills heal 12% of the damage they deal, +2% max life per kill",
          "atStep": 62,
          "note": "12% skill leech and +2% HP on kill. No drawback."
        },
        {
          "key": "constitution-r3-2-19",
          "label": "Sanguine Rite — life costs are reduced a further 12%",
          "atStep": 77,
          "note": "-12% life costs. No drawback."
        },
        {
          "key": "clu_con_bloodletting-hub",
          "label": "Bloodletting",
          "atStep": 85,
          "note": "+1% HP on kill; the Bloodletting cluster adds leech satellites."
        },
        {
          "key": "clu_con_sanguine-hub",
          "label": "Sanguine Aura",
          "atStep": 106,
          "note": "Aura leech heals 2 HP/s per nearby enemy (up to 6). Weak, so it can be swapped for Great Sinew/Ascendance."
        },
        {
          "key": "strength-r3-3-13",
          "label": "Unbreakable — +20 STR and +100 maximum life",
          "atStep": 119,
          "note": "+20 STR and +100 HP; taken as a STR/DEX source."
        },
        {
          "key": "constitution-r2-1-27",
          "label": "Pain Ward — +10% physical and +10% fire resistance, +1.2 HP regen/s",
          "atStep": 147,
          "note": "+10% physical and fire resistance. No drawback."
        }
      ]
    },
    "gear": [
      "Weapon until L16: a dagger (skills for L1-15 require one). From L16 you need a staff or wand type; a scepter (CHA) is the most realistic choice.",
      "Scepters: obsidian scepter needs CHA 48 / L70, astral scepter CHA 62 / L90. Tiered scepters and wands cost no mana for auto-attacks.",
      "You must swap dagger and scepter by hand: L1-15 skills need a dagger, L16+ skills need a staff or wand.",
      "Armour: CON greaves (the only gear for your main stat); otherwise plate by STR, hoods by DEX, robes by INT within the plan's stats.",
      "Good affixes: of_vigor (+CON) and of_the_bear (+HP)."
    ],
    "weaknesses": [
      "L1-25 is fragile: at 110-350 HP every cast hurts. Rely on Sacrificial Stab and Flesh Siphon Strike (leech) early.",
      "Two weapon sets (dagger early, scepter or wand later) and two stat taxes (INT and CHA).",
      "Only 389 mana, and no good protection against crowd control.",
      "Sanguine Aura and similar nodes are weak (under 12 HP/s): replace them with CON and leech nodes.",
      "If your HP is below a skill's cost the cast fails; keep Bone Armor, Vampiric Embrace and Blood Rebirth ready."
    ]
  },
  "Archer": {
    "className": "Archer",
    "name": "Arrow Storm",
    "summary": "A ranged shooter with two extra-projectile nodes that multiply arrow hits and the auto-attack fan, with DEX for skills and speed and STR for bow damage.",
    "playstyle": "Use a dagger until L22, then a bow. Fire Barrage in short 2-4 tick bursts while standing still under Sniper Stance, keep Tailwind Aura on, and kite with Cheetah Stride. Venom Arrow and Rain of Arrows fill the gaps.",
    "stats": [
      {
        "stat": "DEX",
        "why": "Attribute of 46 of 50 Archer skills (+5% per point) and speed: the 0.38 floor is reached near DEX 60. Plan: DEX 287."
      },
      {
        "stat": "STR",
        "why": "Quirk: elementless bows scale their hits with STR, not DEX. Plan: STR 212 for x11.4 auto-attack damage."
      },
      {
        "stat": "CON",
        "why": "Gem requirement (up to 21 for the last skills) and your HP source. Plan: CON 103 for 1343 HP."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "arc_barrage",
        "name": "Barrage",
        "unlock": "Lv 25 · quest act1_sunspire_reliquary · 3013 g",
        "why": "Cone channel, 5 hits per tick (7 with projectiles) for 4 stamina. Use in short bursts."
      },
      {
        "slot": 2,
        "skillId": "arc_venom_arrow",
        "name": "Venom Arrow",
        "unlock": "Lv 35 · quest act2_obsidian_drake · 4163 g",
        "why": "Cheap arrow (18 stamina, 2 s cooldown), 3 hits with +2 projectiles. Best single-target damage per second."
      },
      {
        "slot": 3,
        "skillId": "arc_rain_of_arrows",
        "name": "Rain of Arrows",
        "unlock": "Lv 32 · quest act2_obsidian_drake · 3825 g",
        "why": "Multi-hit AoE around the cursor: 10 hits (12 with projectiles) for 28 stamina (7 s cooldown)."
      },
      {
        "slot": 4,
        "skillId": "arc_piercing_shot",
        "name": "Piercing Shot",
        "unlock": "Lv 31 · quest act2_obsidian_drake · 3688 g",
        "why": "Cone up to 560 px hitting every target: 17 base damage for 17 stamina."
      },
      {
        "slot": 5,
        "skillId": "arc_eagle_eye",
        "name": "Eagle Eye",
        "unlock": "Lv 43 · quest act3_nether_behemoth (secret gem) · 5263 g",
        "why": "+20% crit chance and +256 px range for 20 s (30 s cooldown)."
      },
      {
        "slot": 6,
        "skillId": "arc_sniper_stance",
        "name": "Sniper Stance",
        "unlock": "Lv 50 · quest act3_nether_behemoth (secret gem) · 6300 g",
        "why": "Standing still: +10% damage per second up to +50%. Ideal with the Barrage channel; needs a bow."
      },
      {
        "slot": 7,
        "skillId": "arc_tailwind_aura",
        "name": "Tailwind Aura",
        "unlock": "Lv 49 · quest act3_nether_behemoth (secret gem) · 6163 g",
        "why": "+15% move speed and +15% dodge for 60 s for 25 stamina. Keep it on."
      },
      {
        "slot": 8,
        "skillId": "arc_cheetah_stride",
        "name": "Cheetah Stride",
        "unlock": "Lv 45 · quest act3_nether_behemoth (secret gem) · 5538 g",
        "why": "+45% move speed for 12 s (25 s cooldown) for kiting and escape."
      },
      {
        "slot": 9,
        "skillId": "arc_expose_weakness",
        "name": "Expose Weakness",
        "unlock": "Lv 56 · quest act4_primordial_sovereign (secret gem) · 7200 g",
        "why": "AoE hit for 11 stamina that also makes targets take 25% more damage for 8 s. Cast it before Barrage."
      }
    ],
    "earlySkills": [
      {
        "skillId": "arc_fan_of_knives",
        "name": "Fan of Knives",
        "level": 1,
        "note": "Strongest early skill: 6 hits of 6 for 25 stamina, a melee-type arc. Needs a dagger."
      },
      {
        "skillId": "arc_whirling_blades",
        "name": "Whirling Blades",
        "level": 14,
        "note": "Dagger skill for the mid-early game."
      },
      {
        "skillId": "arc_poison_shiv",
        "name": "Poison Shiv",
        "level": 16,
        "note": "Dagger skill; the dagger must be in hand."
      },
      {
        "skillId": "arc_ambush_flurry",
        "name": "Ambush Flurry",
        "level": 22,
        "note": "Last dagger skill: a 360-degree channel."
      },
      {
        "skillId": "arc_aimed_shot",
        "name": "Aimed Shot",
        "level": 23,
        "note": "First bow skill; switch to a bow from L23. Needs no Wisdom: usable as soon as you wear a bow."
      }
    ],
    "passives": {
      "startKey": "start-dexterity",
      "steps": [
        {
          "key": "dexterity-r1-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-1-10",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-1-9",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-1-14",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-22",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-17",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-16",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-19",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-27",
          "label": "Deadeye — +20 DEX and +1 Extra Arrow",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-21",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-7",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-9",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-10",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-11",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-12",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-8",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-9",
          "label": "Second Discipline",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-3-10",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-11",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "dexterity-r2-1-26",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-4-8",
          "label": "Windrunner — +15 DEX, +40 max stamina, +5 stamina regen/s",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r2-4-7",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Fleet — your cooldown floor drops from 0.40 to 0.35",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-3-5",
          "label": "Apotheosis",
          "kind": "notable"
        },
        {
          "key": "dexterity-r1-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-8",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-9",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-3-10",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-11",
          "label": "Thick Skin",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-14",
          "label": "Marksman's Mastery",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-15",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-29",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-28",
          "label": "Edge",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-27",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-26",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-1-25",
          "label": "Hardy",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-9",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-8",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-13",
          "label": "Breadth",
          "kind": "minor"
        },
        {
          "key": "clu_dex_volley-hub",
          "label": "Volley",
          "kind": "greater"
        },
        {
          "key": "dexterity-r4-1-14",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-1-36",
          "label": "Polymath",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-2-0",
          "label": "Polymath",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-2-1",
          "label": "Quick Recovery",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-2-2",
          "label": "Second Discipline",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-2-3",
          "label": "Nimble Flow",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-2-8",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-2-4",
          "label": "Nimble Flow",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-3",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-7",
          "label": "Second Discipline",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-2-19",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-2-18",
          "label": "Kindling",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-2-23",
          "label": "Fireproof",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-2-22",
          "label": "Apostasy",
          "kind": "greater"
        },
        {
          "key": "dexterity-r4-2-24",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "dexterity-r4-3-1",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-2",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-7",
          "label": "Broad Study",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-3",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-4",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-5",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-6",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-7",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-9",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-10",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-15",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-16",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-17",
          "label": "Plating",
          "kind": "notable"
        },
        {
          "key": "strength-r3-2-18",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-19",
          "label": "Reckless Swing — +25% physical damage, -10% ice resistance",
          "kind": "keystone"
        },
        {
          "key": "strength-r4-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-13",
          "label": "Unbreakable — +20 STR and +100 maximum life",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "strength-r2-1-27",
          "label": "Executioner — +15% physical damage and +12 melee reach",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-3-14",
          "label": "Martial Mastery",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-15",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-19",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-20",
          "label": "Unflagging",
          "kind": "notable"
        },
        {
          "key": "strength-r4-3-1",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-18",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-23",
          "label": "Charge",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-22",
          "label": "Apostasy",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-24",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "dexterity-r2-4-6",
          "label": "Deadly Aim",
          "kind": "notable"
        },
        {
          "key": "clu_dex_deadeye-hub",
          "label": "Deadeye Focus",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-6",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-7",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-8",
          "label": "Fireproof",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-9",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-10",
          "label": "Deadly Precision — +12% crit chance and +35% crit damage, -50 max life",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-1-11",
          "label": "Paragon",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-1-12",
          "label": "Ox Blood",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-14",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "strength-r3-3-5",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "strength-r4-0-20",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-21",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-22",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-6",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-14",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-13",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-12",
          "label": "Ox Blood",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-11",
          "label": "Paragon",
          "kind": "greater"
        },
        {
          "key": "strength-r3-1-21",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-29",
          "label": "Temper",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-28",
          "label": "Edge",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-27",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-26",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "dexterity-r1-1-15",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-1-16",
          "label": "Marksman's Focus",
          "kind": "notable"
        },
        {
          "key": "dexterity-r2-1-25",
          "label": "Great Sinew",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-2-5",
          "label": "Apostasy",
          "kind": "greater"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "DEX 19, STR 10, 93 HP; attack interval x0.70 from the start node cooldown floor."
        },
        {
          "points": 30,
          "summary": "DEX 70, STR 22, CON 25, 325 HP. Deadeye taken (+1 projectile); CON for Barrage met."
        },
        {
          "points": 60,
          "summary": "DEX 149, STR 42, 413 HP. Windrunner, Fleet and Volley taken: +2 projectiles, cooldown floor 0.35."
        },
        {
          "points": 100,
          "summary": "DEX 195, STR 108, 673 HP. The STR block (Reckless Swing, Unbreakable, Executioner) taken: physical damage +44%."
        },
        {
          "points": 150,
          "summary": "DEX 287, STR 212, 1343 HP, 200 stamina. Deadly Aim, Deadeye Focus and Deadly Precision taken: about 19% crit chance, +45% crit damage."
        }
      ],
      "keystones": [
        {
          "key": "dexterity-r2-1-27",
          "label": "Deadeye — +20 DEX and +1 Extra Arrow",
          "atStep": 12,
          "note": "+20 DEX and +1 projectile. No drawback."
        },
        {
          "key": "dexterity-r2-4-8",
          "label": "Windrunner — +15 DEX, +40 max stamina, +5 stamina regen/s",
          "atStep": 32,
          "note": "+15 DEX, +40 stamina, +5 stamina regen. No drawback."
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Fleet — your cooldown floor drops from 0.40 to 0.35",
          "atStep": 34,
          "note": "Cooldown floor 0.35. No drawback."
        },
        {
          "key": "clu_dex_volley-hub",
          "label": "Volley",
          "atStep": 59,
          "note": "Second +1 projectile (+2 total)."
        },
        {
          "key": "strength-r3-2-19",
          "label": "Reckless Swing — +25% physical damage, -10% ice resistance",
          "atStep": 96,
          "note": "+25% physical damage but -10% ice resistance. Optional: it mostly boosts the auto-attack."
        },
        {
          "key": "strength-r3-3-13",
          "label": "Unbreakable — +20 STR and +100 maximum life",
          "atStep": 104,
          "note": "+20 STR and +100 HP. No drawback."
        },
        {
          "key": "strength-r2-1-27",
          "label": "Executioner — +15% physical damage and +12 melee reach",
          "atStep": 106,
          "note": "+15% physical damage and +12 reach. No drawback."
        },
        {
          "key": "clu_dex_deadeye-hub",
          "label": "Deadeye Focus",
          "atStep": 117,
          "note": "+4% crit chance."
        },
        {
          "key": "dexterity-r3-1-10",
          "label": "Deadly Precision — +12% crit chance and +35% crit damage, -50 max life",
          "atStep": 125,
          "note": "+12% crit chance and +35% crit damage, but -50 max HP."
        }
      ]
    },
    "gear": [
      "Weapon: a dagger until L22, then a bow (2H, cooldown 0.75) or crossbow (2H, cooldown 0.95, more damage). DEX requirement runs from 8 at tier 2 to 116 at tier 10.",
      "Bows have +10% crit built in, crossbows +8%. There is no ammunition. Sniper Stance requires a bow.",
      "Armour: hood, boots and gloves (DEX), all light. A two-handed bow leaves no off-hand.",
      "Rings need CHA (35 in the plan): steel band 16 or tempered band 26. Good affixes: of_grace (+DEX)."
    ],
    "weaknesses": [
      "Two weapons before L25 (dagger, then bow): keep both in your slots.",
      "Low HP (1343 at 150 points, minus 50 with Deadly Precision) so defence is evasion: Tailwind Aura (15% dodge), the Light Feet, Slipstream and Riposte nodes of the Dexterity sector (extra dodge, stamina back on a dodge, a dodged blow sent home) and Phantom Step. Rely on distance, Cheetah Stride and traps.",
      "Stamina is the arrow resource (200 pool, 31/s regen): burst Barrage in 2-4 ticks; Venom Arrow is cheap.",
      "Every Archer skill is a stamina skill now (the elemental arrows too), so stamina is the only pool to watch: burst Barrage and keep Slipstream or Windrunner for regen."
    ]
  },
  "Druid": {
    "className": "Druid",
    "name": "Shapeshifter",
    "summary": "Three forms with distinct roles: Wolf for damage, Hawk for speed and kiting, Bear for tanking. All form bonuses scale with tree form power.",
    "playstyle": "Enter Wolf Form, cast Primal Metamorphosis and Mark of the Wild, then alternate Wolf Bite and Wolf Rend. Swap to Hawk Form to move between packs or kite, and to Bear Form when HP drops under 40% or against heavy hitters. You do not have to press the form button: any wolf, hawk or bear skill puts you in its form inside the same cast. Spells can be cast in a form too, at 75% power, so you can fight as a beast and cast without changing shape.",
    "stats": [
      {
        "stat": "CHA",
        "why": "Attribute of all 50 Druid skills (+5% per point): the Druid's main stat. Plan: CHA 328."
      },
      {
        "stat": "CON",
        "why": "Gem requirement of 15 and your HP source. Plan: CON 199 for 2513 HP."
      },
      {
        "stat": "WIS",
        "why": "Gem requirement of 13. Plan: WIS 105."
      },
      {
        "stat": "INT",
        "why": "Raises your mana pool, which every form switch and skill uses. Plan: INT 64 for 815 mana."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "dru_wolf_form",
        "name": "Wolf Form",
        "unlock": "Lv 1 · 100 g",
        "why": "Damage form: +25% crit and x1.35 auto-attack speed (speed only below the cap). Scales with form power."
      },
      {
        "slot": 2,
        "skillId": "dru_hawk_form",
        "name": "Hawk Form",
        "unlock": "Lv 1 · 100 g",
        "why": "Speed form: x1.45 move speed and 35% dodge (up to 60% with form power). For travel and kiting."
      },
      {
        "slot": 3,
        "skillId": "dru_bear_form",
        "name": "Bear Form",
        "unlock": "Lv 1 · 100 g",
        "why": "Tank form: HP x1.6 and damage taken x0.5 (down to x0.2 at form power 0.6 and above). For bosses and emergencies."
      },
      {
        "slot": 4,
        "skillId": "dru_feral_bite",
        "name": "Wolf Bite",
        "unlock": "Lv 43 · quest act3_nether_behemoth (secret gem) · 5263 g",
        "why": "Best wolf skill: 15 base damage for 15 mana on a 2 s cooldown. Use Wolf Rend or Wolf Flurry before L43."
      },
      {
        "slot": 5,
        "skillId": "dru_wolf_rend",
        "name": "Wolf Rend",
        "unlock": "Lv 20 · quest act1_sunspire_reliquary · 2475 g",
        "why": "Cheapest wolf filler before L43 (14 mana, 2 s cooldown); keeps rotating with Wolf Bite."
      },
      {
        "slot": 6,
        "skillId": "dru_hawk_dive_slash",
        "name": "Hawk Dive Slash",
        "unlock": "Lv 44 · quest act3_nether_behemoth (secret gem) · 5400 g",
        "why": "Hawk's leap-and-strike (range 200, 11 mana): closes distance in Hawk Form."
      },
      {
        "slot": 7,
        "skillId": "dru_primal_metamorphosis",
        "name": "Primal Metamorphosis",
        "unlock": "Lv 35 · quest act2_obsidian_drake · 4163 g",
        "why": "Form-only: +180 HP, x1.3 damage and x1.35 speed for 20 s (20 s cooldown). Refused outside a form."
      },
      {
        "slot": 8,
        "skillId": "dru_mark_of_the_wild",
        "name": "Mark of the Wild",
        "unlock": "Lv 45 · quest act3_nether_behemoth (secret gem) · 5538 g",
        "why": "x1.1 damage and +10% max HP for 1800 s (60 s cooldown): refresh every half hour."
      },
      {
        "slot": 9,
        "skillId": "dru_thorns_aura",
        "name": "Thorns Aura",
        "unlock": "Lv 48 · quest act3_nether_behemoth (secret gem) · 6025 g",
        "why": "Reflects 20% of physical damage to attackers for 60 s (25 mana). Works in forms."
      }
    ],
    "earlySkills": [
      {
        "skillId": "dru_wolf_flurry",
        "name": "Wolf Flurry",
        "level": 4,
        "note": "Wolf skill; your damage before Wolf Rend and Wolf Bite."
      },
      {
        "skillId": "dru_hawk_wind_slash",
        "name": "Hawk Wind Slash",
        "level": 17,
        "note": "Hawk ranged slash with range 160."
      }
    ],
    "passives": {
      "startKey": "start-charisma",
      "steps": [
        {
          "key": "charisma-r1-0-4",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-5",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-6",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-7",
          "label": "Focus (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-8",
          "label": "Focus (CON)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-0-14",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-18",
          "label": "Vigour (CON)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-22",
          "label": "Insight (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-21",
          "label": "Insight (INT)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-20",
          "label": "Insight (DEX)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-19",
          "label": "Insight (STR)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-13",
          "label": "Menagerie — Aspect of the Wild (+25 CHA, +15 CON, +30 max mana, +2.0 mana regen/s, forms 15% stronger)",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-11",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-3-5",
          "label": "Apotheosis (CHA)",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-19",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-3-1",
          "label": "Ascendance (CHA)",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-0-17",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-16",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-8",
          "label": "Hawk Aspect — +20 DEX, +40 max stamina, +4 stamina regen/s, +8% attack speed, forms 12% stronger",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-3-14",
          "label": "Wild Mastery",
          "kind": "greater"
        },
        {
          "key": "charisma-r4-2-18",
          "label": "Primal Instinct",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-23",
          "label": "Charge",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-22",
          "label": "Apostasy",
          "kind": "greater"
        },
        {
          "key": "charisma-r4-2-24",
          "label": "Ascendance (CHA)",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-15",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-0-18",
          "label": "Vigour (WIS)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-17",
          "label": "Vigour (CON)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-16",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-15",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-14",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-13",
          "label": "Focus (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-19",
          "label": "Primal Form Mastery — +30 CHA, +10 WIS, +1.5 HP regen/s, +3.0 stamina regen/s, forms 25% stronger",
          "kind": "keystone"
        },
        {
          "key": "charisma-r1-0-3",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-2",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-1",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-0",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-8",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Crimson Bargain — every skill hits 40% harder, but costs 30% more life",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-3-8",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-9",
          "label": "Second Discipline",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-10",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-11",
          "label": "Renaissance",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-12",
          "label": "Wanderer's Gift",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-0-0",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-1",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-2",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-6",
          "label": "Wind (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-7",
          "label": "Wind (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-8",
          "label": "Charge",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-9",
          "label": "Wind (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Wolf Aspect — +15 STR, +15 CHA, +12% physical damage, forms 12% stronger",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-1-11",
          "label": "Paragon (CHA)",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-0-3",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-4",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-5",
          "label": "Sinew (CON)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-1-27",
          "label": "Bear Aspect — +20 STR, +120 HP, +1.5 HP regen/s, +5% physical resistance, forms 12% stronger",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-1-14",
          "label": "Ox Blood (CHA)",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-2",
          "label": "Discipline (WIS)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-1",
          "label": "Second Wind",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-5",
          "label": "Discipline (INT)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-6",
          "label": "Ascendance (CHA)",
          "kind": "greater"
        },
        {
          "key": "charisma-r4-2-7",
          "label": "Apotheosis (CHA)",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-13",
          "label": "Blood Pact — life costs are reduced 15%",
          "kind": "keystone"
        },
        {
          "key": "constitution-r4-0-19",
          "label": "Insight",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-19",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-3-1",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-3-0",
          "label": "Grounding",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-24",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-2-23",
          "label": "Fireproof",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-22",
          "label": "Apostasy",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-3-5",
          "label": "Apotheosis",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-14",
          "label": "Sanguine Mastery",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-3-15",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-10",
          "label": "Wild Bloom",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-17",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-16",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "clu_cha_beast_bond-hub",
          "label": "Wild Heart",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-1-21",
          "label": "Cross-Training",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-29",
          "label": "Temper (WIS)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-28",
          "label": "Edge",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-27",
          "label": "Great Sinew (CON)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-26",
          "label": "Ascendance (CHA)",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-2-20",
          "label": "Focus (INT)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-21",
          "label": "Ox Blood (CHA)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-22",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-23",
          "label": "Wild Focus",
          "kind": "notable"
        },
        {
          "key": "charisma-r2-4-9",
          "label": "Temper (DEX)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-10",
          "label": "Great Sinew (INT)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-0-6",
          "label": "Sinew (WIS)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-7",
          "label": "Focus (STR)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-8",
          "label": "Focus (DEX)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-36",
          "label": "Polymath",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-8",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-2-7",
          "label": "Sinew (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-6",
          "label": "Thick Skin",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-2-5",
          "label": "Apostasy",
          "kind": "greater"
        },
        {
          "key": "charisma-r2-4-7",
          "label": "Callus",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-6",
          "label": "Wild Focus",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-3-2",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-7",
          "label": "Broad Study",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-20",
          "label": "Thorn Hide",
          "kind": "notable"
        },
        {
          "key": "charisma-r2-4-11",
          "label": "Discipline (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-12",
          "label": "Great Sinew (CHA)",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-21",
          "label": "Thorn Hide",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-18",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-17",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-16",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-10",
          "label": "Mending",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-17",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-16",
          "label": "Brutality",
          "kind": "notable"
        },
        {
          "key": "charisma-r2-1-28",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-2-0",
          "label": "Mastery (CHA)",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-15",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-14",
          "label": "Vigour",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-13",
          "label": "Focus",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-2",
          "label": "Discipline",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-8",
          "label": "Polymath",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-7",
          "label": "Apotheosis",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-6",
          "label": "Ascendance",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-2-3",
          "label": "Mastery",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-0-0",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-1",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-2",
          "label": "Sinew",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-6",
          "label": "Wind",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-14",
          "label": "Honed",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-13",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-12",
          "label": "Ox Blood",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-11",
          "label": "Paragon",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-0-15",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-14",
          "label": "Vigour (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-13",
          "label": "Focus (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-30",
          "label": "Insight (WIS)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-1",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-0",
          "label": "Versatility",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-36",
          "label": "Great Sinew (CHA)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-2-35",
          "label": "Ascendance (CHA)",
          "kind": "greater"
        },
        {
          "key": "clu_cha_beast_bond-sat1",
          "label": "Thick Pelt",
          "kind": "notable"
        },
        {
          "key": "charisma-r1-1-10",
          "label": "Insight (CHA)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-2-1",
          "label": "Wind (INT)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-2-0",
          "label": "Wind (DEX)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-1-16",
          "label": "Wild Focus",
          "kind": "notable"
        },
        {
          "key": "charisma-r2-1-26",
          "label": "Dabbler",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-1-25",
          "label": "Great Sinew (CHA)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-3-16",
          "label": "Callus",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-17",
          "label": "Primal Instinct",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "CHA 18, CON 10, 156 HP, 173 mana. The start node gives +0.03 form power."
        },
        {
          "points": 30,
          "summary": "CHA 101, CON 47, 594 HP, 389 mana. Menagerie and Hawk Aspect taken; form power about 0.35."
        },
        {
          "points": 60,
          "summary": "CHA 203, CON 60, 780 HP, 509 mana. Primal Form Mastery, Crimson Bargain and Wolf Aspect taken; form power about 0.72 (Hawk dodge and Bear defence at their caps)."
        },
        {
          "points": 100,
          "summary": "CHA 267, CON 120, 1569 HP, 691 mana. Bear Aspect and Wild Heart taken; form power about 0.94."
        },
        {
          "points": 150,
          "summary": "CHA 328, CON 199, WIS 105, 2513 HP, 815 mana, 93 mana/s regen. Form power about 0.99; Bear Form HP x2.19."
        }
      ],
      "keystones": [
        {
          "key": "charisma-r3-3-13",
          "label": "Menagerie — Aspect of the Wild (+25 CHA, +15 CON, +30 max mana, +2.0 mana regen/s, forms 15% stronger)",
          "atStep": 12,
          "note": "+25 CHA, +15 CON, +30 mana, +2 mana/s and +0.15 form power. No drawback."
        },
        {
          "key": "charisma-r2-4-8",
          "label": "Hawk Aspect — +20 DEX, +40 max stamina, +4 stamina regen/s, +8% attack speed, forms 12% stronger",
          "atStep": 20,
          "note": "+20 DEX, +40 stamina, +8% attack speed and +0.12 form power. No drawback."
        },
        {
          "key": "charisma-r3-2-19",
          "label": "Primal Form Mastery — +30 CHA, +10 WIS, +1.5 HP regen/s, +3.0 stamina regen/s, forms 25% stronger",
          "atStep": 33,
          "note": "+30 CHA, +10 WIS, +0.25 form power: the biggest single form power jump. No drawback."
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Crimson Bargain — every skill hits 40% harder, but costs 30% more life",
          "atStep": 43,
          "note": "x1.4 skill damage; the life cost penalty does nothing here since Druid has no life-cost skills."
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Wolf Aspect — +15 STR, +15 CHA, +12% physical damage, forms 12% stronger",
          "atStep": 56,
          "note": "+15 STR, +15 CHA, +12% physical damage and +0.12 form power. No drawback."
        },
        {
          "key": "charisma-r2-1-27",
          "label": "Bear Aspect — +20 STR, +120 HP, +1.5 HP regen/s, +5% physical resistance, forms 12% stronger",
          "atStep": 61,
          "note": "+20 STR, +120 HP, +5% physical resistance and +0.12 form power. No drawback."
        },
        {
          "key": "clu_cha_beast_bond-hub",
          "label": "Wild Heart",
          "atStep": 82,
          "note": "+0.10 form power, bringing the total to about 0.99. Form power above 1.0 is wasted."
        }
      ]
    },
    "gear": [
      "Weapon: a scepter (1H, needs CHA; tier 4: 26 up to tier 10: 116) counts as a staff/wand, so Wrath and Moonfire also work in human form.",
      "For wolf-only play a mace (CON) or dagger (DEX) also works: form auto-attacks use the weapon in hand with the STR multiplier (x3.2).",
      "Rings (band, signet) need CHA, the only gear matching your main stat. Otherwise: greaves (CON), hood/boots/gloves (DEX), robes (INT).",
      "Good affixes: of_presence (+CHA) and of_the_bear (+HP). CHA also raises sell price: +2% per point, capped at CHA 25."
    ],
    "weaknesses": [
      "Spells cast in a form hit at 75% power: a pure mage build still wants human form for full damage (cast a spell skill after a form skill only if you accept the 25% loss).",
      "Mana (815) is spent on every form switch and skill; watch the pool after Hawk, Wolf and Bear swaps and Primal Metamorphosis.",
      "No mana regen aura like the Monk's Fast Mana Aura; Menagerie helps, and the Rejuvenation node (+2 mana/s) is an optional addition not in the plan.",
      "The secret gems from L43 to L48 sit behind act3_nether_behemoth; until then your damage is Wolf Rend and Wolf Flurry.",
      "Primal Metamorphosis needs a form: outside one it is refused and costs nothing."
    ]
  }
};
