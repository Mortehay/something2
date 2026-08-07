// Per-rung drop rules, as checked-in seed data (SOMET-253 Task 7).
//
// A floor, not a full authoring surface: mirrors CREATURE_DROPS in
// entityTypes.js. Every row here is inserted directly by migration
// 1714440086000_behavior_drops.js on a fresh database (all eleven rungs
// already exist by the time that migration runs -- unlike Wolf's drop rule,
// there is no chicken-and-egg problem here). This file exists so
// `make seed-catalogs` can RESTORE a rung's baseline drop if it is ever
// missing (a dev-volume rebuild that replays only some migrations, an admin
// action against a future behavior-drops admin surface, etc.) without a new
// migration for every such repair -- the same role CREATURE_DROPS plays for
// creature_drops.
//
// Values replicate 1714440086000_behavior_drops.js's DROPS array exactly.
// Guard is deliberately absent: a village guard is not a purse, same call as
// its gold_min/gold_max both staying 0 in 1714440085000_behavior_auras.js.
const BEHAVIOR_DROPS = [
  { behavior: 'Swarm', item: 'stone', chance: 0.3, min_qty: 1, max_qty: 1 },
  { behavior: 'Skirmisher', item: 'dagger', chance: 0.25, min_qty: 1, max_qty: 1 },
  { behavior: 'Line', item: 'short sword', chance: 0.2, min_qty: 1, max_qty: 1 },
  { behavior: 'Ranged', item: 'bow', chance: 0.2, min_qty: 1, max_qty: 1 },
  { behavior: 'Caster', item: 'apprentice staff', chance: 0.15, min_qty: 1, max_qty: 1 },
  { behavior: 'Brute', item: 'club', chance: 0.2, min_qty: 1, max_qty: 1 },
  { behavior: 'Heavy', item: 'morning star', chance: 0.15, min_qty: 1, max_qty: 1 },
  { behavior: 'Champion', item: 'long sword', chance: 0.15, min_qty: 1, max_qty: 1 },
  { behavior: 'Apex', item: 'two-handed sword', chance: 0.1, min_qty: 1, max_qty: 1 },
  { behavior: 'Sentry', item: 'arrow', chance: 0.25, min_qty: 1, max_qty: 1 },
  { behavior: 'Lurker', item: 'knife', chance: 0.2, min_qty: 1, max_qty: 1 },
];

module.exports = { BEHAVIOR_DROPS };
