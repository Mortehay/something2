/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-479 (progression epic, Group D / T11). Seeds the 150-row base gear
// ladder so a fresh database has an equippable item in all eight paper-doll
// slots from the moment it exists. Before this, five of the eight slots
// (off_hand, hands, feet, ring1, ring2) had ZERO items in the whole catalog.
//
// This migration REQUIRES the generator rather than inlining 150 literal rows.
// That is a deliberate trade with a real cost: editing seeds/data/gearLadder.js
// later changes what a FRESH database gets here while leaving already-migrated
// databases untouched, because a run migration is never re-run. The mitigation
// is scripts/seed-gear-ladder.js -- the same upsert, runnable on demand -- and
// the fact that upsertGearLadder never overwrites an existing name, so running
// it twice is a no-op. This mirrors scripts/seed-catalogs.js's contract, which
// is how every other catalog in this repo already works.
const { generateGearLadder, upsertGearLadder } = require('../seeds/generateGearLadder.js');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');

exports.up = async (pgm) => {
  const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
  await upsertGearLadder(pgm.db, rows);
};

// Deletes only rows this ladder created, and only ones nobody owns or
// references. A ladder item that has reached a player, an account stash, a
// drop table or a merchant buyback is LEFT IN PLACE -- the same posture the
// item-types DELETE route takes (index.js's blocking-reference list). A lossy
// rollback that cascades away someone's gear is worse than a rollback that
// leaves rows behind.
//
// account_items and behavior_drops are in the list because their foreign keys
// are ON DELETE CASCADE: without a guard, rolling back would silently delete a
// player's stashed ring rather than refusing to.
exports.down = async (pgm) => {
  const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
  await pgm.db.query(
    `DELETE FROM item_types it
      WHERE it.name = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM player_items pi WHERE pi.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM account_items ai WHERE ai.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM creature_drops cd WHERE cd.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM behavior_drops bd WHERE bd.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM chest_loot cl WHERE cl.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM class_loadouts clo WHERE clo.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM merchant_stock ms WHERE ms.item_type_id = it.id)`,
    [rows.map((r) => r.name)],
  );
};
