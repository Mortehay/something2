// Respec compliance (SOMET-478, progression epic T10).
//
// After a respec (or any other event that lowers a character's stats), gear
// that no longer meets its requirements must not stay live in the combat path
// and must not be deleted. It is unequipped -- the player_items row is
// untouched, only the player_equipment row goes.
//
// WHY THE CAPACITY RULE IS WHAT IT IS. The spec says "auto-unequipped into the
// backpack; if the backpack has no room the respec is refused". In THIS schema
// an equipped item is already a player_items row and items.js#usedSlots
// (authority/items.js) counts every non-currency row whether it is equipped or
// not -- the inventory panel draws equipped items in the same grid
// (inventoryPanel.js#visibleItems). So unequipping is capacity-NEUTRAL: it
// moves nothing between two pools, it clears a paper-doll pointer.
//
// Refusing on "not enough free slots" would therefore be an unreachable branch
// dressed up as a safety check. The condition that IS real, and is the one
// this enforces, is an ALREADY over-capacity backpack: usedSlots > capacity.
// That state is reachable (an admin lowering characters.inventory_slots, which
// the column's CHECK (inventory_slots > 0) permits down to 1) and it is
// precisely the state in which a returned item has no representable home. In
// every other state -- including exactly AT capacity -- the unequip is safe
// and proceeds.
//
// `db` is a checked-out client inside the CALLER's transaction, never the bare
// pool: the respec's gold debit, stat reset and this unequip must stand or
// fall together, exactly as progressionStore#respec already does for the first
// two.

const { SLOTS, usedSlots, capacityOf } = require('../authority/items.js');
const { illegalEquipped } = require('../authority/equipRequirements.js');

// Rebuild the inv shape the pure helpers expect, straight from the database.
// Deliberately not read off a live world: a respec is an HTTP action and the
// character may not be connected at all.
async function loadInvForCompliance(db, characterId) {
  const ir = await db.query(
    'SELECT id, item_type_id FROM player_items WHERE character_id = $1 ORDER BY created_at ASC, id ASC',
    [characterId],
  );
  const er = await db.query('SELECT slot, item_id FROM player_equipment WHERE character_id = $1', [characterId]);
  const sr = await db.query(
    `SELECT si.socketed_into_id AS host_id, si.player_item_id AS stone_item_id,
            stone_pi.item_type_id AS stone_type_id
       FROM stone_instances si
       JOIN player_items stone_pi ON stone_pi.id = si.player_item_id
       JOIN player_items host_pi ON host_pi.id = si.socketed_into_id
      WHERE host_pi.character_id = $1 AND si.socketed_into_id IS NOT NULL`,
    [characterId],
  );
  const cr = await db.query('SELECT inventory_slots FROM characters WHERE id = $1', [characterId]);

  const items = ir.rows.map((r) => ({ id: r.id, typeId: r.item_type_id, quantity: 1 }));
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const row of sr.rows) {
    const host = byId.get(row.host_id);
    if (host) {
      host.socketedStoneTypeId = row.stone_type_id;
      host.socketedStoneItemId = row.stone_item_id;
    }
  }
  const equipment = {};
  for (const row of er.rows) equipment[row.slot] = row.item_id;
  return {
    items,
    equipment,
    capacity: cr.rows.length ? Number(cr.rows[0].inventory_slots) : undefined,
  };
}

async function enforceEquipRequirements(db, characterId, itemTypes, base, level) {
  const inv = await loadInvForCompliance(db, characterId);
  const bad = illegalEquipped(inv, itemTypes, base, level);
  if (bad.length === 0) return { ok: true, unequipped: [] };

  const wouldUnequip = bad.map((b) => ({ slot: b.slot, itemId: b.itemId, name: b.name }));
  if (usedSlots(inv, itemTypes) > capacityOf(inv)) {
    return {
      ok: false,
      reason: 'your backpack is over its carry limit -- make room before respeccing',
      wouldUnequip,
    };
  }

  // Whitelisted against SLOTS rather than interpolated: these strings came
  // from a catalog row, and the same discipline progressionStore#allocateStat
  // applies to a stat key applies here.
  const slots = wouldUnequip.map((u) => u.slot).filter((s) => SLOTS.includes(s));
  await db.query(
    'DELETE FROM player_equipment WHERE character_id = $1 AND slot = ANY($2::text[])',
    [characterId, slots],
  );
  return { ok: true, unequipped: wouldUnequip };
}

module.exports = { enforceEquipRequirements, loadInvForCompliance };
