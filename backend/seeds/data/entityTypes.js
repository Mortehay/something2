// The hostile creature catalog, as checked-in seed data.
//
// WHY THIS FILE EXISTS. Three of these four creatures are inserted by
// migration 1714440022000_elements.js, so a fresh database gets them for
// free. `Wolf` was different: it was authored by hand in the Entity Types
// admin and never existed in any migration. Migration 1714440003000 seeds
// only Tree/Stone/IceRock, so nothing in the repo could recreate it -- and
// when the dev Postgres volume was rebuilt, Wolf was gone for good while
// three separate migrations went on quietly referencing it:
//
//   1714440018000_create_loot.js:35    guarded cross-join -> inserted no drop rule
//   1714440022000_elements.js:37       UPDATE ... WHERE name='Wolf' -> matched nothing
//   1714440033000_entity_prompts.js:11 UPDATE ... WHERE name='Wolf' -> matched nothing
//
// plus `STARTER_BIOMES` listing it in Meadow and Deep Forest, which made
// `make seed-catalogs` rewrite a dangling creature reference on every run.
// Putting the creature catalog here closes that hole permanently: a creature
// a biome references is now a thing the repo can rebuild.
//
// EVERY WOLF FIELD BELOW IS RECOVERED FROM THE REPO, not invented:
//   hp / max_hp 12  -- docs/audits/2026-07-24/browser-run.md:244 records
//                      reverting Wolf to its original max_hp:12, and
//                      elements.js:37 shows max_hp was backfilled from hp.
//   resistances {}  -- elements.js:34 "Wolf stays the neutral baseline: no
//                      resistances, so every element works on it".
//   defense 0       -- same neutral-baseline note.
//   prompt          -- ENTITY_PROMPTS in 1714440033000_entity_prompts.js:11.
//   gold_min/max    -- the formula 1714440031000_gold_economy.js:29-30 would
//                      have applied to a hostile creature with hp 12:
//                      GREATEST(1, floor(12/10))=1 and floor(12/4)=3.
//                      SUPERSEDED (SOMET-155): now 0/0 so Wolf inherits its
//                      rung's range -- see the note on the field itself.
//   strength etc.   -- left at the column defaults (0). Wolf predates
//                      1714440005000_add_entity_stats.js, so it genuinely
//                      carried the defaults. Nothing reads them for
//                      creatures anyway: loadCreatureTypes
//                      (src/authority/creatures.js:47) selects only
//                      id/name/color/hp/defense/resistances/faction/gold.
//   color #c0392b   -- the value every Wolf test fixture in this repo uses.
//
// Slime/Skeleton/Bat are copied verbatim from elements.js:25-30 so this file
// is a faithful superset of the migration rather than a competing source of
// truth. Village Guard is deliberately absent: it is a structural village
// gate defender (faction 'guard', placed by insertVillageGuards), not a
// huntable overworld spawn, and the wild-spawn pool filters it out.
const HOSTILE_CREATURES = [
  // Retuned 2026-08-08 for P4 (SOMET-250): folded into the Beast line (Meadow, no primary
  // element) at the Line rung (hp 30, defense 3 -- template.js RUNGS.Line), per
  // docs/superpowers/specs/2026-08-08-p4-bestiary-design.md's "Legacy creature remapping"
  // section. Wolf has zero live placements today (see the file-header recovery story above --
  // it was gone from the database entirely until this file restored it), so this is a free
  // change: no live world_creatures row is affected by the stat jump from hp 12/def 0 to
  // hp 30/def 3.
  {
    name: 'Wolf',
    color: '#c0392b',
    walkable: true,
    spawn_tiles: [],
    chance: 0.1,
    hp: 30,
    max_hp: 30,
    defense: 3,
    resistances: {},
    prompt: 'a grey meadow wolf',
    // SOMET-155: zeroed so this creature INHERITS its rung's gold range.
    // The old value was derived from its pre-SOMET-250 hp (the
    // 1714440031000_gold_economy.js formula on hp 12/18/14/8); the P4 remap
    // above raised it to the Line rung (hp 30, defense 3) but left the gold
    // behind. loot.js's spawnDrops picks the TYPE range whenever its max > 0,
    // so a stale non-zero range here permanently outranks the rung and this
    // creature is paid less than the 288 identically-statted P4 rows that
    // (correctly) carry 0 and fall through to Line's 1-5. 0/0 is the same
    // "no range of my own" posture BESTIARY_P4_CREATURES uses.
    gold_min: 0,
    gold_max: 0,
    behavior_name: 'Line',
  },
  // Retuned 2026-08-08 for P4 (SOMET-250): folded into the Desert line (Arid Dunes, fire) at
  // the Line rung (hp 30, defense 3 -- template.js RUNGS.Line; resistance 0.55 --
  // derive.js PRIMARY_VALUE.Line), per
  // docs/superpowers/specs/2026-08-08-p4-bestiary-design.md's "Legacy creature remapping"
  // section. Slime has 4 live placements today, so this IS a live balance change: hp rises
  // from 18 to 30, defense from 0 to 3, and its resistance profile collapses from the old
  // two-key { fire: 0.6, physical: 0.3 } down to a single-element { fire: 0.55 } (Desert has
  // no secondary physical figure at the Line/primary tier -- that only applies at the
  // strong tier, see derive.js). Intentional, not a side effect.
  {
    name: 'Slime',
    color: '#27ae60',
    walkable: true,
    spawn_tiles: [],
    chance: 0.1,
    hp: 30,
    max_hp: 30,
    defense: 3,
    resistances: { fire: 0.55 },
    prompt: 'a translucent orange slime blob, baked by the desert sun',
    // SOMET-155: zeroed so this creature INHERITS its rung's gold range.
    // The old value was derived from its pre-SOMET-250 hp (the
    // 1714440031000_gold_economy.js formula on hp 12/18/14/8); the P4 remap
    // above raised it to the Line rung (hp 30, defense 3) but left the gold
    // behind. loot.js's spawnDrops picks the TYPE range whenever its max > 0,
    // so a stale non-zero range here permanently outranks the rung and this
    // creature is paid less than the 288 identically-statted P4 rows that
    // (correctly) carry 0 and fall through to Line's 1-5. 0/0 is the same
    // "no range of my own" posture BESTIARY_P4_CREATURES uses.
    gold_min: 0,
    gold_max: 0,
    behavior_name: 'Line',
  },
  // Retuned 2026-08-08 for P4 (SOMET-250): folded into the Undead line (Catacombs, ice) at
  // the Line rung (hp 30, defense 3 -- template.js RUNGS.Line; resistance 0.55 --
  // derive.js PRIMARY_VALUE.Line), per
  // docs/superpowers/specs/2026-08-08-p4-bestiary-design.md's "Legacy creature remapping"
  // section. Skeleton has 25 live placements today -- the biggest live-balance change of the
  // four: hp rises from 14 to 30, defense from 2 to 3, and its resistance profile collapses
  // from the old two-key { ice: 0.6, physical: 0.2 } down to a single-element { ice: 0.55 }
  // (the Line/primary tier has no secondary physical figure; that's a strong-tier-only
  // pattern, see derive.js). Undead already fit Skeleton thematically, so only the numbers
  // move -- the prompt stays close to its existing framing.
  {
    name: 'Skeleton',
    color: '#ecf0f1',
    walkable: true,
    spawn_tiles: [],
    chance: 0.1,
    hp: 30,
    max_hp: 30,
    defense: 3,
    resistances: { ice: 0.55 },
    prompt: 'an undead skeleton warrior, risen from the catacombs',
    // SOMET-155: zeroed so this creature INHERITS its rung's gold range.
    // The old value was derived from its pre-SOMET-250 hp (the
    // 1714440031000_gold_economy.js formula on hp 12/18/14/8); the P4 remap
    // above raised it to the Line rung (hp 30, defense 3) but left the gold
    // behind. loot.js's spawnDrops picks the TYPE range whenever its max > 0,
    // so a stale non-zero range here permanently outranks the rung and this
    // creature is paid less than the 288 identically-statted P4 rows that
    // (correctly) carry 0 and fall through to Line's 1-5. 0/0 is the same
    // "no range of my own" posture BESTIARY_P4_CREATURES uses.
    gold_min: 0,
    gold_max: 0,
    behavior_name: 'Line',
  },
  // Retuned 2026-08-08 for P4 (SOMET-250): folded into the Fungal line (Fungal Deep,
  // lightning) at the Line rung (hp 30, defense 3 -- template.js RUNGS.Line; resistance 0.55
  // -- derive.js PRIMARY_VALUE.Line), per
  // docs/superpowers/specs/2026-08-08-p4-bestiary-design.md's "Legacy creature remapping"
  // section. Bat has 12 live placements today, so this IS a live balance change: hp rises
  // from 8 to 30 (nearly 4x -- the weakest creature in the game gets substantially tougher)
  // and defense from 0 to 3; its resistance figure moves from the old single-key
  // { lightning: 0.5 } to { lightning: 0.55 }, a small increase already matching the old
  // single-element shape. Intentional, not a side effect.
  {
    name: 'Bat',
    color: '#8e44ad',
    walkable: true,
    spawn_tiles: [],
    chance: 0.1,
    hp: 30,
    max_hp: 30,
    defense: 3,
    resistances: { lightning: 0.55 },
    prompt: 'a small bat roosting in the fungal deep, crackling with static',
    // SOMET-155: zeroed so this creature INHERITS its rung's gold range.
    // The old value was derived from its pre-SOMET-250 hp (the
    // 1714440031000_gold_economy.js formula on hp 12/18/14/8); the P4 remap
    // above raised it to the Line rung (hp 30, defense 3) but left the gold
    // behind. loot.js's spawnDrops picks the TYPE range whenever its max > 0,
    // so a stale non-zero range here permanently outranks the rung and this
    // creature is paid less than the 288 identically-statted P4 rows that
    // (correctly) carry 0 and fall through to Line's 1-5. 0/0 is the same
    // "no range of my own" posture BESTIARY_P4_CREATURES uses.
    gold_min: 0,
    gold_max: 0,
    behavior_name: 'Line',
  },
];

// Drop rules the seeder must supply itself, keyed by creature and item name.
//
// ONLY Wolf is listed. Slime/Skeleton/Bat get their rules from migration
// 1714440024000_elements_creature_drops.js, which runs after elements.js has
// inserted them and therefore lands on a fresh database. Wolf's own rule
// (create_loot.js:31-36) is a guarded cross-join that runs at 1714440018000
// -- BEFORE this seeder could possibly have inserted Wolf -- so it matches
// nothing and Wolf would otherwise be a creature that dies yielding nothing.
// `tests/creature_drops_db.test.js:44` enforces that every creature has at
// least one drop rule, and restoring Wolf without this would break it.
//
// chance/min_qty/max_qty replicate create_loot.js:34 exactly.
//
// 2026-08-08 P4 remap (SOMET-250): checked all four drops against
// scripts/bestiary/dropMapping.js's pickDropItem() using each creature's new line/element at
// tier 'I' before leaving this list unchanged:
//   Wolf     (Beast, null, I)     -> suggests 'knife'.  Existing 'dagger' is an equally plain
//                                    melee weapon with no stronger thematic claim either way --
//                                    kept, per the file's own header example.
//   Skeleton (Undead, ice, I-II)  -> suggests 'frost staff' (elemental lines always map to
//                                    their staff). A staff reads as a spellcaster's weapon, not
//                                    a fit for an armed-and-armoured swordsman -- the existing
//                                    'short sword' (1714440024000_elements_creature_drops.js)
//                                    stays; it is the better match despite the element switch.
//   Bat      (Fungal, lightning, II) -> suggests 'storm staff'. A tiny non-tool-using bat
//                                    wielding a staff is a worse fit than its existing 'stone'
//                                    (sling ammo) -- kept.
//   Slime    (Desert, fire, I)    -> suggests 'flame staff'. A shapeless blob has no hands to
//                                    hold a staff; its existing 'leather-vest' ("what it
//                                    engulfed") stays a better fit than the element-staff
//                                    default -- kept.
// None of the three migration-seeded drops (Skeleton/Bat/Slime) are edited here: they were
// inserted by an already-applied migration this plan does not touch, and pickDropItem's
// suggestions did not improve on them anyway.
const CREATURE_DROPS = [
  { creature: 'Wolf', item: 'dagger', chance: 0.5, min_qty: 1, max_qty: 1 },
];

// The playable classes (SOMET-258). Here as well as in migration
// 1714440091000_playable_classes.js for exactly the reason this whole file
// exists: an entity type the repo cannot rebuild disappears when the Postgres
// volume is rebuilt, and characters.entity_type_id carries a foreign key to
// these three rows -- so losing them does not degrade gracefully the way a
// missing creature does, it orphans every character on the server.
//
// WARRIOR'S STATS ARE THE 'Player' ROW'S STATS (1714440006000), except its
// POOLS. Migration 1714440091000 derives the stats with a SELECT so the two
// cannot drift there; this file has to state them literally, so it IS a second
// source of truth. That is covered rather than hoped for:
// playable_classes_db.test.js asserts Warrior equals Player on every stat
// column and fails if either side moves.
//
// SOMET-486 broke the pools out of that clone. The three classes' base pools
// below are now the numbers the game actually plays with -- see migration
// 1714440509000's header for each number and why it is what it is. The pools
// here MUST equal that migration's CLASS_POOLS: the migration fixes an
// existing database, this file rebuilds a lost row, and a database that lost
// its class rows and got them back from a stale seeder would hand every new
// Mage 70 mana while the migration's databases give 150. The legacy 'Player'
// row keeps its old 50 mana; nothing in src/ reads it.
//
// is_creature is deliberately absent (defaults false): a class is not a
// spawnable creature, and the wild-spawn pool reads that flag.
const PLAYABLE_CLASSES = [
  {
    name: 'Warrior', color: '#b03a2e', walkable: true, spawn_tiles: [], chance: 0,
    strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 100, max_hp: 100, hp_regen_rate: 1, mana: 100, max_mana: 100, mana_regen_rate: 0.5,
  },
  {
    name: 'Ranger', color: '#1e8449', walkable: true, spawn_tiles: [], chance: 0,
    strength: 10, dexterity: 12, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 85, max_hp: 85, hp_regen_rate: 1, mana: 115, max_mana: 115, mana_regen_rate: 0.5,
  },
  {
    name: 'Mage', color: '#5b2c94', walkable: true, spawn_tiles: [], chance: 0,
    strength: 10, dexterity: 10, constitution: 10, intelligence: 12, wisdom: 10, charisma: 10,
    hp: 75, max_hp: 75, hp_regen_rate: 1, mana: 150, max_mana: 150, mana_regen_rate: 0.5,
  },
];

// Per-class starting gear, mirroring the migration's CLASS_LOADOUTS. Restoring
// the classes without these would leave a rebuilt volume handing every new
// character an empty inventory.
//
// There is no shield in item_types -- no off_hand item exists at all -- so the
// Warrior gets a one-handed sword and armour rather than sword-and-board.
const CLASS_LOADOUTS = [
  { class: 'Warrior', item: 'short sword', quantity: 1 },
  { class: 'Warrior', item: 'leather-vest', quantity: 1 },
  { class: 'Ranger', item: 'bow', quantity: 1 },
  { class: 'Ranger', item: 'arrow', quantity: 20 },
  { class: 'Ranger', item: 'leather-vest', quantity: 1 },
  { class: 'Mage', item: 'apprentice staff', quantity: 1 },
  { class: 'Mage', item: 'arcane-ward', quantity: 1 },
];

module.exports = { HOSTILE_CREATURES, CREATURE_DROPS, PLAYABLE_CLASSES, CLASS_LOADOUTS };
