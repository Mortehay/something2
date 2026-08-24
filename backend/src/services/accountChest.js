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
//   * the ownership predicate lives IN the statement that moves the row
//     (`AND character_id = $n` / `AND user_id = $n`) rather than in a SELECT
//     someone could act on later, so there is no check-then-act window a second
//     session can slip through;
//   * a refusal after anything has been written must ROLLBACK, never merely
//     return.
//
// SOMET-498 -- THE CHEST HOLDS THE INSTANCE.
//
// This file used to DELETE the `player_items` row on deposit and INSERT a fresh
// one from `item_type_id` on withdraw, which destroyed rarity, item level and
// every rolled affix on the round trip (`foxy`/88/[3.13, 11.5] went in, plain
// white/1/[] came out, under a new id). Depositing now MOVES the instance onto
// an `account_items` row and withdrawing moves it back: rarity, item_level and
// the `player_item_affixes` rows are never read, never written and never
// copied, so no carry path exists that could be incomplete. See
// migrations/1714440513000_chest_holds_the_instance.js for why a reference and
// not a jsonb snapshot, why the pointer lives on `player_items`, and why every
// pre-existing chest row was backfilled with an instance instead of leaving a
// mint-from-the-type fallback in withdrawItem.
//
// THE CONSEQUENCE FOR EVERY GUARD IN THIS FILE: an UPDATE cascades nothing. The
// three deposit guards below were all written against a DELETE whose foreign
// keys did work the guard did not have to do, and two of them are now the ONLY
// thing standing between a deposit and a corrupt row. Each says so at its own
// site.
//
// See migrations/1714440280000_account_items.js for why the capacity cap is a
// schema invariant instead of a COUNT(*).
const CHEST_CAPACITY = 40;

// Row -> wire shape. Both fetchChest and the two movers return items through
// this, for the same reason services/chests.js has mapChestRow: two differently
// shaped chest entries reaching the client from two code paths is a landmine
// for whatever reads them next.
//
// Reads `account_items`' own columns, NOT the held instance's. That is
// deliberate and it is not a second source of truth: depositItem writes these
// three from the instance in the same transaction that attaches it, nothing
// anywhere updates a stored instance (it belongs to no character, so no
// gameplay path can reach it), and the 1714440513000 down() reverts the schema
// by reading exactly these columns back. `chest rows mirror the instance they
// hold` in account_chest_instance_db.test.js is what keeps that true.
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

// The rolled identity of one instance, joined to the affix catalog.
//
// Joined to `affix_types` rather than returning bare ids because the value this
// feeds is pushed straight into the LIVE inventory, and
// equipRequirements#gearStatGrants reads `effect` off that object rather than
// querying. An id-only list would put a withdrawn item back in the player's
// hands granting nothing until their next reconnect -- the "correct in the
// database, inert in play" failure this epic has shipped repeatedly. `label`
// rides along for the same reason loadInventory carries it (SOMET-496): the
// Character tab lists gear modifiers by label and has no second query to look
// one up with.
//
// Deliberately the same column set, order and key names as loadInventory's
// jsonb_build_object, so the object a player holds after a withdrawal and the
// object they hold after reconnecting are the same object.
async function loadAffixes(client, playerItemId) {
  const r = await client.query(
    `SELECT pia.affix_type_id, at.key, at.label, pia.value, at.effect
       FROM player_item_affixes pia
       JOIN affix_types at ON at.id = pia.affix_type_id
      WHERE pia.player_item_id = $1
      ORDER BY pia.idx`,
    [playerItemId],
  );
  return r.rows.map((a) => ({
    affixTypeId: a.affix_type_id,
    key: a.key,
    label: a.label,
    value: Number(a.value),
    effect: a.effect,
  }));
}

// Move one player_items row into the account chest.
//
// ORDER: ownership first, then the three refusals, then the container, then the
// handover. Ownership moved to the FRONT in SOMET-498 because two of the
// refusals below are now unscoped -- see each one -- and an unscoped probe run
// before ownership is proven would let a caller learn facts about an item id
// they do not own.
async function depositItem(pool, entry, userId, characterId, itemId) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // SOMET-498: this was a `DELETE ... RETURNING` at the BOTTOM of the
    // function. It is now a locking SELECT at the top, because the instance is
    // no longer destroyed -- it is HANDED to the chest further down.
    //
    // FOR UPDATE is what replaces the DELETE's atomicity, and it is not weaker:
    // the row is locked from here until COMMIT, so no concurrent sell, drop or
    // second deposit can move the same instance, and every refusal below
    // evaluates against a row nothing else can change. A concurrent DELETE
    // blocks on this lock, then re-evaluates its own `character_id = ...`
    // predicate against the committed row and matches nothing.
    //
    // The character_id predicate IS the ownership check: 0 rows means this
    // character does not hold that instance, whether because it belongs to
    // another character, another account, or nothing at all. A forged frame
    // carrying someone else's item id lands here and changes nothing.
    const own = await client.query(
      `SELECT item_type_id, quantity, soulbound FROM player_items
        WHERE id = $1 AND character_id = $2 FOR UPDATE`,
      [itemId, characterId],
    );
    if (own.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'you do not own that item' };
    }
    const row = own.rows[0];

    // 1. EQUIPPED. player_equipment.item_id references player_items ON DELETE
    //    CASCADE with UNIQUE(item_id) (migration 1714440017000). Under the old
    //    DELETE that CASCADE was a safety net under this check: even a missed
    //    case merely unequipped the character silently. SOMET-498 removed the
    //    net -- an UPDATE cascades nothing -- so a paper-doll row that survived
    //    a deposit would now point at an item sitting in the chest, equipped by
    //    a character who does not own it, granting its stats forever.
    //
    //    UNSCOPED, unlike the pre-498 version which required `character_id =
    //    $2`. Any player_equipment row naming this instance must block the
    //    deposit, not merely one belonging to the depositing character:
    //    `player_equipment_item_unique` makes at most one such row exist, and
    //    the ownership SELECT above has already proven the caller owns the
    //    item, so this leaks nothing.
    const equipped = await client.query(
      'SELECT 1 FROM player_equipment WHERE item_id = $1',
      [itemId],
    );
    if (equipped.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unequip it first' };
    }

    // 2. THE ITEM IS A STONE. Refused, as before -- but the reason has
    //    CHANGED and the old one is now false, so it is restated rather than
    //    left to rot. Pre-498 the refusal existed because the DELETE would
    //    CASCADE stone_instances away (1714440166000) and destroy the stone's
    //    accumulated XP/level, which `account_items` had nowhere to carry.
    //    Since the chest now holds the instance itself, a deposited stone's
    //    stone_instances row would in fact survive intact and come back whole.
    //
    //    The refusal is kept anyway, and kept CONSERVATIVELY: letting stones
    //    into the chest is a gameplay change (a stone is a socketable, not
    //    ordinary gear, and nothing in the panel, the socket UI or the XP
    //    display has been designed for one living in the bank) and this ticket
    //    is a data-loss fix, not a feature. Removing this line is now a product
    //    decision rather than a correctness one; that is the whole delta.
    //
    //    Unscoped for the same reason as (1): ownership is already proven, and
    //    a stone owned by someone else that somehow names this instance must
    //    still block rather than slip through a character_id join.
    const isStone = await client.query(
      'SELECT 1 FROM stone_instances WHERE player_item_id = $1',
      [itemId],
    );
    if (isStone.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'stones cannot be stored' };
    }

    // 3. THE ITEM HOSTS A STONE. This is the guard SOMET-498 made load-bearing.
    //    stone_instances.socketed_into_id is ON DELETE SET NULL, so pre-498 a
    //    missed case merely popped the stone out into the character's inventory
    //    -- untidy, not damage, which is why the old comment called refusing
    //    "the honest move" rather than "the necessary one". ON DELETE SET NULL
    //    does not fire on an UPDATE. Without this refusal the stone would stay
    //    socketed into a weapon sitting in the chest while its own
    //    player_items row still belongs to the character, so loadInventory
    //    (whose socket join requires `host_pi.character_id = $1`) would show a
    //    loose stone that is secretly still socketed and cannot be socketed
    //    into anything else.
    //
    //    Unscoped, again deliberately: the pre-498 version joined the HOST on
    //    `character_id = $2`, which is trivially true here (we just proved it)
    //    -- what matters is whether ANY stone names this instance as its host.
    const hostsStone = await client.query(
      'SELECT 1 FROM stone_instances WHERE socketed_into_id = $1',
      [itemId],
    );
    if (hostsStone.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unsocket the stone first' };
    }

    // Lowest free slot, chosen and claimed in ONE statement so no second
    // session can take it between the choosing and the claiming.
    //
    // LIMIT 1 over the ordered gap list rather than MIN(slot): with the chest
    // full, an aggregate returns one row holding NULL and the INSERT dies on
    // the NOT NULL constraint (a 500 dressed up as a bug), while this returns
    // zero rows and rowCount 0 reads as exactly what it is.
    //
    // item_type_id / quantity / soulbound are copied from the instance this
    // transaction is about to attach, and then never touched again. They are
    // not a second source of truth about the item (see mapAccountItem): they
    // are what keeps `account_items.item_type_id -> item_types ON DELETE
    // CASCADE` reaching stored items, what 1714440506000's gear-ladder prune
    // reads, and what the 1714440513000 down() reverts the schema by.
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
      // Nothing has been moved yet, so this could merely return -- and must
      // not: a client checked out of the pool inside an open BEGIN is not
      // rolled back by release(), so returning would hand the next borrower a
      // transaction still holding this instance's FOR UPDATE lock.
      await client.query('ROLLBACK');
      return { ok: false, reason: 'your chest is full' };
    }

    // SOMET-498: HAND the instance to the chest instead of destroying it.
    //
    // Both holder columns move in ONE statement because
    // player_items_one_holder_check demands exactly one non-null holder at
    // every instant: there is no moment at which this instance is ownerless,
    // and no moment at which it is owned twice.
    //
    // The `character_id = $3` predicate is redundant against the FOR UPDATE
    // lock taken above and kept anyway: it makes rowCount a real assertion
    // rather than a formality, so if a future edit moves or drops the lock this
    // fails loudly instead of silently storing an item the caller does not own.
    const handover = await client.query(
      `UPDATE player_items SET character_id = NULL, account_item_id = $2
        WHERE id = $1 AND character_id = $3`,
      [itemId, ins.rows[0].id, characterId],
    );
    if (handover.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'you do not own that item' };
    }

    await client.query('COMMIT');

    // Keep the in-memory mirror in step with the DB the same way sellItem
    // does, so a later equip validates against fresh state rather than an
    // instance the character no longer holds.
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
// analogue on the way out. A stored item cannot be equipped (it is on no
// character, and player_equipment.item_id is unique), cannot be a stone
// (deposit refuses them, so none can be in there), and cannot host one.
//
// SOMET-463: there IS a carry cap now (characters.inventory_slots), so a
// withdrawal into a full inventory is refused below, before the transaction
// opens.
//
// SOMET-498: the withdrawn instance keeps its ID, its rarity, its item level
// and its affix rows, because it is the same row that was deposited -- nothing
// is rebuilt from the type. The ORDER of the two statements below is the whole
// safety property and is the first thing to check if this ever regresses:
// `player_items.account_item_id` is ON DELETE CASCADE, so deleting the
// container before detaching the instance would destroy the very item being
// withdrawn, silently, inside a transaction that then COMMITs.
async function withdrawItem(pool, entry, userId, characterId, accountItemId) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };

  // Refused before the transaction: the item would otherwise be moved onto a
  // character that has nowhere to put it.
  if (!hasFreeSlot(p.inv, entry.world.weapons)) {
    return { ok: false, reason: 'Inventory full' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The user_id predicate IS the ownership check, and it is the ONLY thing
    // separating two players' chests -- the bank post itself is public. A
    // frame naming another account's stored row matches nothing and returns
    // here.
    //
    // A locking SELECT rather than the pre-498 `DELETE ... RETURNING`: the
    // container must still exist while the instance is detached from it (the
    // detach's predicate is `account_item_id = $1`), so the DELETE has to come
    // last. FOR UPDATE holds the row against a concurrent second withdrawal of
    // the same slot for the rest of the transaction.
    const own = await client.query(
      'SELECT id FROM account_items WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [accountItemId, userId],
    );
    if (own.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'that item is not in your chest' };
    }

    // Detach FIRST. After this the container holds nothing and the DELETE below
    // has nothing to cascade to.
    const moved = await client.query(
      `UPDATE player_items SET character_id = $2, account_item_id = NULL
        WHERE account_item_id = $1
        RETURNING id, item_type_id, quantity, rarity, item_level, soulbound`,
      [accountItemId, characterId],
    );
    if (moved.rowCount !== 1) {
      // Every account_items row holds exactly one instance: the 1714440513000
      // backfill gave one to every row that predates it, and depositItem -- the
      // only writer -- always attaches one in the same transaction that creates
      // the container. So this is unreachable, and it REFUSES rather than
      // falling back to minting a fresh instance from item_type_id.
      //
      // That choice is the point. A mint-from-the-type fallback is exactly the
      // pre-498 bug, and it would sit here silently laundering rolled items
      // into white ones the moment this UPDATE stopped matching -- which is one
      // forgotten predicate away the next time a holder column is added. The
      // ROLLBACK leaves the container row intact, so a refusal costs the player
      // a retry and loses nothing.
      await client.query('ROLLBACK');
      return { ok: false, reason: 'that item cannot be withdrawn right now' };
    }
    const row = moved.rows[0];

    // Read AFTER the detach and off the instance's OWN id: these are the rows
    // that just changed hands. They were never copied and never rewritten, so
    // this is the same set, with the same values, that the deposit put in.
    const affixes = await loadAffixes(client, row.id);

    // Last, and only now safe. The `user_id` predicate is redundant against
    // the lock above and kept for the same reason the handover keeps its
    // character_id: rowCount is then an assertion rather than a formality.
    const del = await client.query(
      'DELETE FROM account_items WHERE id = $1 AND user_id = $2',
      [accountItemId, userId],
    );
    if (del.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'that item is not in your chest' };
    }

    await client.query('COMMIT');

    // The LIVE inventory, in the shape loadInventory produces -- same keys,
    // same order, same types. This object is what the panel colours by rarity
    // and what equipRequirements#gearStatGrants reads affix `effect` payloads
    // off; an entry pushed without them would leave a just-withdrawn item
    // rendering as plain white and granting nothing until the next reconnect.
    // It is also what `withdrawn` carries to the client, whose
    // inventory.js#addItem already reads `rarity` off it.
    const item = {
      id: row.id,
      typeId: row.item_type_id,
      quantity: Number(row.quantity ?? 1),
      soulbound: row.soulbound === true,
      rarity: row.rarity || 'white',
      itemLevel: Number(row.item_level ?? 1),
      affixes,
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
