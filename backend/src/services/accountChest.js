// SOMET-310 -- the account chest ("bank"). Item storage shared by every
const { hasFreeSlot } = require('../authority/items');
// character on ONE account, reachable from the bank post beside every village
// merchant.
//
// This is trade.js's sibling, not part of it: trade moves items between a
// CHARACTER and a merchant and always involves gold, this moves items between
// a CHARACTER and an ACCOUNT and never touches gold at all (users.gold is
// already account-wide, so there is nothing for a gold vault to do). What it
// DOES borrow from trade.js is the shape of a safe transfer, and that shape is
// the point of this file:
//
//   * one transaction per direction, so the item is never in both tables and
//     never in neither, even mid-crash;
//   * the ownership predicate lives IN the DELETE (`AND character_id = $n` /
//     `AND user_id = $n`) rather than in a SELECT before it, so there is no
//     check-then-act window a second session can slip through;
//   * a refusal after the DELETE has run must ROLLBACK, never merely return.
//
// See migrations/1714440280000_account_items.js for why the capacity cap is a
// schema invariant instead of a COUNT(*).
const CHEST_CAPACITY = 40;

// Row -> wire shape. Both fetchChest and the two movers return items through
// this, for the same reason services/chests.js has mapChestRow: two differently
// shaped chest entries reaching the client from two code paths is a landmine
// for whatever reads them next.
function mapAccountItem(r) {
  return {
    id: r.id,
    slot: Number(r.slot),
    typeId: r.item_type_id,
    quantity: Number(r.quantity ?? 1),
    soulbound: r.soulbound === true,
  };
}

// Everything this ACCOUNT has stored, in slot order.
//
// Ordered by slot rather than deposited_at so the panel's item positions are
// stable across a deposit: slot is an occupancy token the service assigns, and
// the lowest-free-slot rule means a withdrawal from the middle leaves a hole
// the next deposit refills. Ordering by time would instead reshuffle every
// item after the hole, moving things under the player's cursor.
async function fetchChest(db, userId) {
  const r = await db.query(
    `SELECT id, slot, item_type_id, quantity, soulbound
       FROM account_items WHERE user_id = $1 ORDER BY slot ASC`,
    [userId],
  );
  return { items: r.rows.map(mapAccountItem), capacity: CHEST_CAPACITY };
}

// Postgres unique_violation. Two sessions of the SAME account depositing at the
// same instant can both compute the same lowest free slot; the UNIQUE
// (user_id, slot) constraint is what stops the second one, and this turns that
// into a refusal instead of a 500. chainOp already serializes a single socket's
// operations, so reaching this needs two live sessions on one account -- rare,
// but the whole reason the cap is a constraint rather than a count.
const UNIQUE_VIOLATION = '23505';

// Move one player_items row into the account chest.
//
// The three guards below all run BEFORE the DELETE and all exist because the
// DELETE has side effects that are invisible at this call site:
//
//  1. EQUIPPED. player_equipment.item_id references player_items ON DELETE
//     CASCADE with UNIQUE(item_id) (migration 1714440017000), so deleting an
//     equipped instance silently removes the paper-doll row too -- the item
//     would land in the chest and the character would be quietly unequipped,
//     with no error and nothing to undo it. Checked against THIS character's
//     equipment via character_id, the same ownership scope as the DELETE.
//
//  2. THE ITEM IS A STONE. stone_instances.player_item_id references
//     player_items ON DELETE CASCADE (1714440166000), and a stone's row is
//     where its accumulated XP/level lives. Depositing a stone would therefore
//     destroy that progression permanently -- account_items stores only
//     type/quantity/soulbound, so there is nothing to carry it in and nothing
//     to restore on withdraw. Refused for every stone, socketed or loose,
//     exactly as trade.js's sellItem refuses them and for the same reason:
//     a stone's identity is its instance row, and this transfer cannot preserve
//     one.
//
//  3. THE ITEM HOSTS A STONE. stone_instances.socketed_into_id references
//     player_items ON DELETE SET NULL, so depositing a socketed weapon does not
//     corrupt anything -- it silently pops the stone out into the character's
//     inventory while the weapon goes to the chest. Not damage, but not
//     something a player asked for either; refusing and naming the fix is the
//     honest move.
//
// Guard 2 is joined through player_items on character_id rather than looked up
// by itemId alone -- the same reason loot.js's dropItem does: an unscoped
// lookup would let a caller probe whether an id they do not own is a stone.
async function depositItem(pool, entry, userId, characterId, itemId) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const equipped = await client.query(
      'SELECT 1 FROM player_equipment WHERE item_id = $1 AND character_id = $2',
      [itemId, characterId],
    );
    if (equipped.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unequip it first' };
    }

    const isStone = await client.query(
      `SELECT 1 FROM stone_instances si
         JOIN player_items pi ON pi.id = si.player_item_id
        WHERE si.player_item_id = $1 AND pi.character_id = $2`,
      [itemId, characterId],
    );
    if (isStone.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'stones cannot be stored' };
    }

    const hostsStone = await client.query(
      `SELECT 1 FROM stone_instances si
         JOIN player_items host ON host.id = si.socketed_into_id
        WHERE si.socketed_into_id = $1 AND host.character_id = $2`,
      [itemId, characterId],
    );
    if (hostsStone.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unsocket the stone first' };
    }

    // The character_id predicate IS the ownership check: 0 rows means this
    // character does not hold that instance, whether because it belongs to
    // another character, another account, or nothing at all. A forged frame
    // carrying someone else's item id lands here and changes nothing.
    const del = await client.query(
      'DELETE FROM player_items WHERE id = $1 AND character_id = $2 RETURNING item_type_id, quantity, soulbound',
      [itemId, characterId],
    );
    if (del.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'you do not own that item' };
    }
    const row = del.rows[0];

    // Lowest free slot, chosen and claimed in ONE statement so no second
    // session can take it between the choosing and the claiming.
    //
    // LIMIT 1 over the ordered gap list rather than MIN(slot): with the chest
    // full, an aggregate returns one row holding NULL and the INSERT dies on
    // the NOT NULL constraint (a 500 dressed up as a bug), while this returns
    // zero rows and rowCount 0 reads as exactly what it is.
    //
    // soulbound is carried across, never defaulted -- see the migration header
    // for why laundering it would reopen SOMET-277.
    let ins;
    try {
      ins = await client.query(
        `INSERT INTO account_items (user_id, slot, item_type_id, quantity, soulbound)
         SELECT $1, s.slot, $2, $3, $4
           FROM generate_series(1, $5) AS s(slot)
          WHERE NOT EXISTS (
            SELECT 1 FROM account_items a WHERE a.user_id = $1 AND a.slot = s.slot
          )
          ORDER BY s.slot
          LIMIT 1
         RETURNING id, slot, item_type_id, quantity, soulbound`,
        [userId, row.item_type_id, Number(row.quantity) || 1, row.soulbound === true, CHEST_CAPACITY],
      );
    } catch (err) {
      await client.query('ROLLBACK');
      if (err && err.code === UNIQUE_VIOLATION) {
        return { ok: false, reason: 'chest was busy, try again' };
      }
      throw err;
    }
    if (ins.rowCount !== 1) {
      // The DELETE above already ran, so this MUST roll back: returning here
      // would leave the item deleted and unstored.
      await client.query('ROLLBACK');
      return { ok: false, reason: 'your chest is full' };
    }

    await client.query('COMMIT');

    // Keep the in-memory mirror in step with the DB the same way sellItem
    // does, so a later equip validates against fresh state rather than an
    // instance that no longer exists.
    p.inv.items = p.inv.items.filter((it) => it.id !== itemId);
    return { ok: true, itemId, stored: mapAccountItem(ins.rows[0]) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Move one account_items row back onto the calling CHARACTER.
//
// The exact mirror of depositItem, minus the guards -- none of them have an
// analogue on the way out. A stored item cannot be equipped (it is not on any
// character), cannot be a stone (deposit refuses them, so none can be in
// there), and cannot host one.
//
// SOMET-463: there IS a carry cap now (characters.inventory_slots), so a
// withdrawal into a full inventory is refused below, before the transaction
// opens. This comment previously said the opposite -- that player_items had
// no cap -- which was true when it was written and is not any more.
//
// The account_items row is DELETED and a fresh player_items row INSERTed, so
// the withdrawn instance has a new id. Nothing depends on the old one --
// account_items stores no per-instance state beyond the three columns carried
// across here.
async function withdrawItem(pool, entry, userId, characterId, accountItemId) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };

  // Refused before the transaction: the account_items row would otherwise be
  // DELETEd and re-INSERTed into a character that has nowhere to put it.
  if (!hasFreeSlot(p.inv, entry.world.weapons)) {
    return { ok: false, reason: 'Inventory full' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The user_id predicate IS the ownership check, and it is the ONLY thing
    // separating two players' chests -- the bank post itself is public. A
    // frame naming another account's stored row deletes nothing and returns
    // here.
    const del = await client.query(
      'DELETE FROM account_items WHERE id = $1 AND user_id = $2 RETURNING item_type_id, quantity, soulbound',
      [accountItemId, userId],
    );
    if (del.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'that item is not in your chest' };
    }
    const row = del.rows[0];

    const ins = await client.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       VALUES ($1, $2, $3, $4) RETURNING id, item_type_id, quantity`,
      [characterId, row.item_type_id, Number(row.quantity) || 1, row.soulbound === true],
    );

    await client.query('COMMIT');

    // soulbound is echoed from the row this transaction just wrote, not from
    // the INSERT's RETURNING, because it is the value that went IN. SOMET-316:
    // without it the withdrawn item would lose its `bound` marker the moment it
    // landed back in the inventory -- correct in the database, wrong on screen,
    // and wrong in the one place a player is most likely to be looking.
    const item = {
      id: ins.rows[0].id,
      typeId: ins.rows[0].item_type_id,
      quantity: Number(ins.rows[0].quantity ?? 1),
      soulbound: row.soulbound === true,
    };
    p.inv.items.push(item);
    return { ok: true, item };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { fetchChest, depositItem, withdrawItem, CHEST_CAPACITY, mapAccountItem };
