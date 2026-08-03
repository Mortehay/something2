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
  {
    name: 'Wolf',
    color: '#c0392b',
    walkable: true,
    spawn_tiles: [],
    chance: 0.1,
    hp: 12,
    max_hp: 12,
    defense: 0,
    resistances: {},
    prompt: 'a grey forest wolf',
    gold_min: 1,
    gold_max: 3,
  },
  {
    name: 'Slime',
    color: '#27ae60',
    walkable: true,
    spawn_tiles: [],
    chance: 0.1,
    hp: 18,
    max_hp: 18,
    defense: 0,
    resistances: { fire: 0.6, physical: 0.3 },
    prompt: 'a translucent green slime blob',
    gold_min: 1,
    gold_max: 4,
  },
  {
    name: 'Skeleton',
    color: '#ecf0f1',
    walkable: true,
    spawn_tiles: [],
    chance: 0.1,
    hp: 14,
    max_hp: 14,
    defense: 2,
    resistances: { ice: 0.6, physical: 0.2 },
    prompt: 'an undead skeleton warrior',
    gold_min: 1,
    gold_max: 3,
  },
  {
    name: 'Bat',
    color: '#8e44ad',
    walkable: true,
    spawn_tiles: [],
    chance: 0.1,
    hp: 8,
    max_hp: 8,
    defense: 0,
    resistances: { lightning: 0.5 },
    prompt: 'a small brown cave bat',
    gold_min: 1,
    gold_max: 2,
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
const CREATURE_DROPS = [
  { creature: 'Wolf', item: 'dagger', chance: 0.5, min_qty: 1, max_qty: 1 },
];

module.exports = { HOSTILE_CREATURES, CREATURE_DROPS };
