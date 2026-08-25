// The starting-kit backfill, as two statements plus the function that runs
// them, so migration 1714440515000 and the tests execute the SAME SQL.
//
// WHY THIS IS NOT WRITTEN INLINE IN THE MIGRATION. The guards below are the
// entire safety argument for a change that writes to live player property, and
// a test that re-typed them would be testing its own copy: it would stay green
// while the migration that actually ran on players' data said something else.
// This module is the one text. The migration calls it; every skip case in
// starting_loadout_worn_by_every_class_db.test.js calls it.
//
// Each guard, and the damage it prevents, is documented at length in
// migrations/1714440515000_backfill_worn_starting_kit.js. In short:
//
//   * the slot must be EMPTY            -- never strip gear a player chose
//   * the character must STILL HOLD it  -- pi.character_id = c.id, which after
//     the num_nonnulls(character_id, merchant_stock_id, account_item_id) = 1
//     CHECK means "not sold to a merchant, not in the account chest"
//   * the instance must be SOULBOUND    -- only grantStartingLoadout writes
//     that flag, so this is the granted instance and never a bought
//     replacement
//   * the instance must not be EQUIPPED elsewhere -- player_equipment.item_id
//     is UNIQUE, so this is a throw rather than a wrong row
//   * the item must be freely wearable  -- req_level 1, all six req_* zero
//   * the character must have CLAIMED its loadout
//
// Nothing here ever UPDATEs player_items.character_id: an item on a merchant's
// shelf or in the account chest is never pulled back onto the paper doll.

// PASS 1 -- wear it. DISTINCT ON collapses the pathological case of one class
// listing two instances for one slot; the created_at/id tie-break picks the
// oldest held instance, matching loadInventory's and consumeAmmo's ordering.
const EQUIP_SQL = `
  INSERT INTO player_equipment (character_id, slot, item_id)
  SELECT DISTINCT ON (c.id, cl.equip_slot) c.id, cl.equip_slot, pi.id
    FROM characters c
    JOIN class_loadouts cl ON cl.entity_type_id = c.entity_type_id
    JOIN item_types    it  ON it.id = cl.item_type_id
    JOIN player_items  pi  ON pi.character_id = c.id
                          AND pi.item_type_id = cl.item_type_id
   WHERE c.starting_loadout_granted_at IS NOT NULL
     AND cl.equip_slot IS NOT NULL
     AND pi.soulbound = true
     AND it.req_level = 1
     AND it.req_strength = 0 AND it.req_dexterity = 0 AND it.req_constitution = 0
     AND it.req_intelligence = 0 AND it.req_wisdom = 0 AND it.req_charisma = 0
     AND NOT EXISTS (SELECT 1 FROM player_equipment pe
                      WHERE pe.character_id = c.id AND pe.slot = cl.equip_slot)
     AND NOT EXISTS (SELECT 1 FROM player_equipment pe2 WHERE pe2.item_id = pi.id)
   ORDER BY c.id, cl.equip_slot, pi.created_at ASC, pi.id ASC
  ON CONFLICT (character_id, slot) DO NOTHING
`;

// PASS 2 -- socket it. A character reaches this pass holding a granted
// (soulbound) host weapon with NOTHING in its socket and NO stone of that type
// anywhere in its bag, and is handed one, soulbound, already inside the
// weapon: the same three facts grantStartingLoadout establishes for a
// character created today.
//
// "no stone of that type anywhere in the bag" is deliberately broader than
// "nothing in the socket". A Cultist who UNSOCKETED their starting stone made
// an explicit, destroy-roll-bearing choice; they are left as they chose and
// are not handed a second stone to sit beside the loose one. The narrower test
// would have duplicated it.
const SOCKET_SQL = `
  WITH targets AS (
    SELECT c.id AS character_id, cl.item_type_id AS stone_type_id, host.id AS host_item_id
      FROM characters c
      JOIN class_loadouts cl  ON cl.entity_type_id = c.entity_type_id
      JOIN player_items  host ON host.character_id = c.id
                             AND host.item_type_id = cl.socket_into_item_type_id
                             AND host.soulbound = true
     WHERE c.starting_loadout_granted_at IS NOT NULL
       AND cl.socket_into_item_type_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM stone_instances si
                        WHERE si.socketed_into_id = host.id)
       AND NOT EXISTS (SELECT 1 FROM player_items s
                        WHERE s.character_id = c.id AND s.item_type_id = cl.item_type_id)
  ), picked AS (
    SELECT DISTINCT ON (character_id, stone_type_id) character_id, stone_type_id, host_item_id
      FROM targets
     ORDER BY character_id, stone_type_id, host_item_id
  ), granted AS (
    INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
    SELECT character_id, stone_type_id, 1, true FROM picked
    RETURNING id, character_id, item_type_id
  )
  INSERT INTO stone_instances (player_item_id, socketed_into_id)
  SELECT granted.id, picked.host_item_id
    FROM granted
    JOIN picked ON picked.character_id = granted.character_id
               AND picked.stone_type_id = granted.item_type_id
`;

// Runs both passes and reports what each one actually wrote. `db` is anything
// with a `.query` -- a Pool, a client, or node-pg-migrate's own db handle.
//
// Order matters only in that the socket pass reads player_items, which the
// equip pass never changes; they are independent and either can be re-run.
async function backfillWornStartingKit(db) {
  const equipped = await db.query(EQUIP_SQL);
  const socketed = await db.query(SOCKET_SQL);
  return { equipped: equipped.rowCount, socketed: socketed.rowCount };
}

module.exports = { EQUIP_SQL, SOCKET_SQL, backfillWornStartingKit };
