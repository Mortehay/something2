// Slice 3b3c added three creatures (Slime, Skeleton, Bat) and no drop rules,
// so `creature_drops` still held exactly one row — Wolf's dagger, from
// 1714440018000_create_loot.js. spawnChunkCreatures picks uniformly from the
// creature list, so from that slice onward roughly three quarters of every
// newly generated chunk's creatures died dropping nothing at all. Before the
// slice, every creature dropped something; this restores that invariant.
//
// A NEW migration rather than an edit to 1714440022000: that one has already
// run everywhere, and node-pg-migrate will not re-run it.
//
// Same guarded cross-join posture as the Wolf rule it mirrors: each INSERT
// selects from entity_types × item_types by NAME, so a missing creature or a
// renamed item inserts zero rows instead of failing the migration.
//
// The drops are chosen against the creature's own profile, so what a corpse
// yields reads as coming from the thing that died:
//
//   Bat      (8 HP, no defense)  — the weakest thing in the world, and not a
//                                  tool user. It yields `stone`: sling ammo,
//                                  the cheapest line in the catalog. Lowest
//                                  chance of the three.
//   Skeleton (14 HP, defense 2)  — an armed, armoured humanoid; the one
//                                  creature for which carrying a martial
//                                  weapon needs no explanation. Yields a
//                                  `short sword`.
//   Slime    (18 HP)             — the tankiest, so it pays the best. It has
//                                  no weapon archetype of its own, so what it
//                                  yields is what it engulfed: a
//                                  `leather-vest`, at Wolf's own 0.5.
//
// Chances stay in the band Wolf established (0.5) rather than introducing a
// new rarity tier this slice has no balance data for. Quantities stay at 1:
// rollDrops emits one world_item per unit, and one-per-kill is the existing
// contract (see loot.js's note on quantity).
const DROPS = [
  { creature: 'Slime', item: 'leather-vest', chance: 0.5 },
  { creature: 'Skeleton', item: 'short sword', chance: 0.4 },
  { creature: 'Bat', item: 'stone', chance: 0.35 },
];

exports.up = (pgm) => {
  for (const d of DROPS) {
    pgm.sql(`
      INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
      SELECT et.id, it.id, ${d.chance}, 1, 1
      FROM entity_types et, item_types it
      WHERE et.name = '${d.creature}' AND it.name = '${d.item}'
    `);
  }
};

exports.down = (pgm) => {
  // Scoped to exactly the (creature, item) pairs inserted above — a blanket
  // `DELETE ... WHERE entity_type_id IN (...)` would also take out any rule a
  // later migration or an operator added for these creatures.
  for (const d of DROPS) {
    pgm.sql(`
      DELETE FROM creature_drops cd
      USING entity_types et, item_types it
      WHERE cd.entity_type_id = et.id AND cd.item_type_id = it.id
        AND et.name = '${d.creature}' AND it.name = '${d.item}'
    `);
  }
};
