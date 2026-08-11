// Ejects a socketed stone when its HOST item's player_items row is deleted.
//
// stone_instances.socketed_into_id has its own FK to player_items with
// ON DELETE SET NULL (1714440166000_stone_instances.js), so deleting the
// host's row already nulls this column at the database level -- verified
// directly against Postgres (including through a WITH-clause DELETE, the
// exact shape dropItem uses) before writing this file. This function exists
// as an explicit, tested, same-transaction guarantee that does not depend on
// a reader knowing that FK exists or trusting it survives a future schema
// change; it is a same-statement no-op whenever the FK has already done the
// work, and a real UPDATE only if that FK were ever altered or dropped.
//
// Takes the caller's own checked-out transaction client (or a pool for a
// single-statement caller) -- this MUST run in the same transaction as the
// host's DELETE, never after, or a crash between the two would leave the
// exact dangling socketed_into_id this exists to prevent.
async function ejectSocketedStone(client, hostPlayerItemId) {
  await client.query(
    'UPDATE stone_instances SET socketed_into_id = NULL WHERE socketed_into_id = $1',
    [hostPlayerItemId],
  );
}

module.exports = { ejectSocketedStone };
