// Merchant transactions. Gold moves through guarded atomic UPDATEs (never a
// read-modify-write), ownership is enforced by the SQL predicate, and the
// in-memory inventory/wallet are kept in step so a later equip validates
// against fresh state.

const { sellPriceFor, insertBuyback, BUYBACK_DAYS } = require('../services/merchantStock');
const { ejectSocketedStone } = require('../services/stoneEject');
const { hasFreeSlot } = require('./items');

async function buyStock(pool, entry, userId, characterId, stockId, villageId) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };

  // Before the transaction, so a full inventory never debits gold and never
  // consumes a buyback row. The ROLLBACK below would undo both, but a check
  // that relies on rollback to stay correct is one refactor away from not
  // being -- and this one has to hold in front of a money movement.
  if (!hasFreeSlot(p.inv, entry.world.weapons)) {
    return { ok: false, reason: 'Inventory full' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // village_id + world_id scope this locked read to the merchant the
    // caller was actually gated against (server.js's "no merchant nearby"
    // check resolves a specific village and must be the ONLY village whose
    // stock this call can touch — F-019 / SOMET-199). The expires_at
    // predicate closes the same gap fetchShop only sweeps lazily: a lapsed
    // buyback row must stop being purchasable the instant it expires, not
    // whenever someone next opens that village's shop.
    const sr = await client.query(
      'SELECT id, item_type_id, price, seller_user_id, village_id FROM merchant_stock WHERE id = $1 AND village_id = $2 AND world_id = $3 AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE',
      [stockId, villageId, entry.worldId],
    );
    if (sr.rows.length !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'that item is no longer for sale' };
    }
    const stock = sr.rows[0];

    // SOMET-280: fetchShop no longer LISTS another player's buyback row, but a
    // list filter is not an authorization check -- a crafted `buy` frame
    // carries a raw stockId and never goes near fetchShop. This is the half
    // that actually enforces it.
    //
    // Runs on the row the SELECT ... FOR UPDATE above already locked, inside
    // the same transaction, so there is no check-then-act window: the row
    // cannot change seller (or be deleted and re-created under this id)
    // between the check and the DELETE below. A pre-check outside the
    // transaction would have exactly that race.
    //
    // seller_user_id IS NULL is the infinite base catalog and stays public --
    // only a seller-owned row is restricted, and only to the ACCOUNT that
    // sold it (see fetchShop's header for why user, not character).
    //
    // Deliberately reuses the 'no longer for sale' wording rather than
    // "belongs to another player": to a legitimate client this row does not
    // exist, and a distinct message would confirm to a prober that a given id
    // is a live row someone else owns.
    if (stock.seller_user_id != null && Number(stock.seller_user_id) !== Number(userId)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'that item is no longer for sale' };
    }

    const price = Number(stock.price) || 0;

    // Overdraft-safe: the WHERE guard makes "not enough gold" a 0-row result
    // rather than a negative balance.
    const gr = await client.query(
      'UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold',
      [userId, price],
    );
    if (gr.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not enough gold' };
    }
    const gold = Number(gr.rows[0].gold) || 0;

    // SOMET-484: a buyback row may be HOLDING the very instance that was sold
    // (see the 1714440512000 migration header for why the merchant holds it
    // rather than snapshotting it). Hand that same row back to the buyer --
    // its rarity, its item_level and its player_item_affixes rows are never
    // read, never copied and therefore cannot be dropped.
    //
    // Keyed off merchant_stock_id, not off `stock`: rowCount is the whole
    // branch. 1 means this stock row was holding an instance and the buyer now
    // owns it; 0 means it was not, which covers BOTH the infinite base catalog
    // AND every buyback row sold before this migration existed -- those still
    // mint a fresh instance from the type below, exactly as they always did.
    //
    // The stock row was locked FOR UPDATE above, so no concurrent buy can move
    // the same instance twice, and `player_items_merchant_stock_unique` makes
    // "one instance per stock row" a schema fact rather than an assumption.
    //
    // Both holder columns move in ONE statement because
    // player_items_one_holder_check forbids a row with neither holder (and one
    // with both): there is no instant at which this instance is ownerless.
    const moved = await client.query(
      `UPDATE player_items SET character_id = $2, merchant_stock_id = NULL
        WHERE merchant_stock_id = $1
        RETURNING id, item_type_id, quantity, rarity, item_level, soulbound`,
      [stockId, characterId],
    );

    let row;
    if (moved.rowCount === 1) {
      row = moved.rows[0];
    } else {
      const ins = await client.query(
        `INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1, $2, 1)
         RETURNING id, item_type_id, quantity, rarity, item_level, soulbound`,
        [characterId, stock.item_type_id],
      );
      row = ins.rows[0];
    }

    // Read AFTER the move, and from the instance's OWN id rather than from the
    // stock row: for a moved instance these are the rows that just changed
    // hands, and for a freshly minted one it is correctly empty. Joined to
    // affix_types so the in-memory push below carries `key` and `effect` --
    // see that push for why a bare id list would leave the item inert.
    const affr = await client.query(
      `SELECT pia.affix_type_id, at.key, pia.value, at.effect
         FROM player_item_affixes pia
         JOIN affix_types at ON at.id = pia.affix_type_id
        WHERE pia.player_item_id = $1
        ORDER BY pia.idx`,
      [row.id],
    );

    // A base-catalog row (seller_user_id NULL) is infinite stock; a buyback row is
    // one specific instance and is consumed.
    //
    // MUST run after the UPDATE above: player_items.merchant_stock_id is ON
    // DELETE CASCADE, so deleting the stock row while it still held the
    // instance would destroy the very item the buyer just paid for. The
    // UPDATE has already set merchant_stock_id to NULL, so this DELETE has
    // nothing left to cascade to.
    if (stock.seller_user_id != null) {
      const del = await client.query('DELETE FROM merchant_stock WHERE id = $1', [stockId]);
      if (del.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'that item is no longer for sale' };
      }
    }

    await client.query('COMMIT');

    p.gold = gold;
    // SOMET-484: the in-memory copy carries the rolled identity, mirroring
    // claimItem (loot.js). equipRequirements#gearStatGrants reads THIS object
    // rather than the database, so an entry pushed without its affixes would
    // make a just-bought-back item grant nothing until the next reconnect --
    // the schema-live/play-inert failure this epic has now shipped repeatedly.
    const item = {
      id: row.id,
      typeId: row.item_type_id,
      quantity: Number(row.quantity) || 1,
      rarity: row.rarity || 'white',
      itemLevel: Number(row.item_level ?? 1),
      soulbound: row.soulbound === true,
      affixes: affr.rows.map((a) => ({
        affixTypeId: a.affix_type_id, key: a.key, value: Number(a.value), effect: a.effect,
      })),
    };
    p.inv.items.push(item);
    return { ok: true, gold, item };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function sellItem(pool, entry, userId, characterId, villageId, itemId) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };
  if (Object.values(p.inv.equipment).includes(itemId)) {
    return { ok: false, reason: 'unequip it first' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Guard (Critical #1, SOMET-245 final review): stone_instances.player_
    // item_id is ON DELETE CASCADE, and no acquisition path (buyStock
    // included) ever recreates a stone_instances row once one is gone -- the
    // conversion migration (Task 2) is the only writer in the whole branch.
    // Selling a stone (socketed or loose) would CASCADE-delete its
    // stone_instances row (xp/level gone), and a buyback-and-repurchase of
    // the exact same physical item afterward could never be socketed again
    // (socketStone joins player_items to stone_instances and would report
    // 'stone not found' forever). Must run BEFORE the DELETE below, in the
    // SAME transaction: checking after would find nothing (the CASCADE has
    // already fired by then). unsocketStone is the only sanctioned way to
    // part a stone from its host.
    //
    // Joined against player_items on character_id (same ownership predicate
    // the DELETE below uses), not a bare lookup by itemId alone -- see
    // loot.js's dropItem for why: an unscoped check would let a caller probe
    // whether an itemId they don't even own happens to be a stone.
    const stoneCheck = await client.query(
      `SELECT 1 FROM stone_instances si
         JOIN player_items pi ON pi.id = si.player_item_id
        WHERE si.player_item_id = $1 AND pi.character_id = $2`,
      [itemId, characterId],
    );
    if (stoneCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unsocket it first' };
    }

    // SOMET-484: this used to be a DELETE ... RETURNING. It is now a locking
    // SELECT, because the instance is no longer destroyed -- it is HANDED to
    // the merchant further down (see the 1714440512000 migration header). The
    // reordering is forced by player_items_one_holder_check: an instance must
    // name a character OR a merchant_stock row at every instant, so it cannot
    // be detached before the buyback row it will be attached to exists, and
    // that row's price depends on the item_type_id read here.
    //
    // FOR UPDATE is what replaces the DELETE's atomicity, and it is not
    // weaker: the row is locked from here until COMMIT, so no concurrent
    // sell, drop or chest deposit can move the same instance, and the three
    // refusals below still evaluate against a row nothing else can change.
    // A concurrent DELETE blocks on this lock, then re-evaluates its own
    // `character_id = ...` predicate against the committed row and matches
    // nothing. There is no check-then-act window.
    //
    // The character_id predicate IS the ownership check.
    const del = await client.query(
      'SELECT item_type_id, quantity, soulbound FROM player_items WHERE id = $1 AND character_id = $2 FOR UPDATE',
      [itemId, characterId],
    );
    if (del.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'you do not own that item' };
    }
    const itemTypeId = del.rows[0].item_type_id;

    // SOMET-484 backstop. `unequip it first` at the top of this function reads
    // p.inv.equipment, an IN-MEMORY mirror, and that was tolerable only
    // because the DELETE this SELECT replaced cascaded any surviving
    // player_equipment row away (ON DELETE CASCADE). An UPDATE cascades
    // nothing, so a stale or bypassed mirror would now leave a paper-doll row
    // pointing at an item sitting on a merchant's shelf -- equipped by a
    // character who no longer owns it. This is the same refusal, made against
    // the database, inside the transaction that already holds the row's lock.
    const equipped = await client.query('SELECT 1 FROM player_equipment WHERE item_id = $1', [itemId]);
    if (equipped.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unequip it first' };
    }

    // SOMET-277: the starting loadout is granted per CHARACTER but gold is
    // per ACCOUNT (users.gold), so "sell the granted gear, delete the
    // character, create another" was an unbounded faucet that the
    // characters.starting_loadout_granted_at flag cannot see -- the flag dies
    // with the character. Granted instances are marked soulbound at grant
    // time (items.js's grantStartingLoadout) and refuse to become gold here.
    //
    // Read off the locking SELECT above: it is the same row, held under FOR
    // UPDATE for the rest of this transaction, so there is no check-then-act
    // window at all -- exactly the shape the stacked-quantity refusal below
    // also uses. Nothing has been mutated yet, but this still ROLLBACKs rather
    // than merely returning: a client checked out of the pool inside an open
    // BEGIN is not rolled back by release(), so returning without it would
    // hand the next borrower a transaction holding this row's lock.
    //
    // Per-INSTANCE, never per item TYPE: an identical short sword looted from
    // a creature or bought from a merchant carries soulbound = false and
    // sells for its full value. That distinction is the entire point of the
    // column.
    //
    // Message names the concrete cause because grantStartingLoadout is the
    // only writer of soulbound today; if a second source of bound items ever
    // appears it should generalize to "this item is bound to you".
    if (del.rows[0].soulbound === true) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'starting gear cannot be sold' };
    }

    // Same transaction as the handover below, so a crash between the two is
    // impossible, not just unlikely -- a dangling socketed_into_id can never
    // be observed even mid-crash. Only reached once ownership is confirmed
    // (rowCount === 1): running this before that check would key off an
    // itemId the caller might not even own, risking ejecting a stone out of
    // a DIFFERENT player's item that merely shares this id in a forged
    // request.
    //
    // SOMET-484 made this load-bearing in a way it was not before. The host
    // instance is no longer DELETEd, so stone_instances' ON DELETE CASCADE no
    // longer fires and this call is now the ONLY thing that parts a socketed
    // stone from a sold weapon. Without it the stone -- which stays with the
    // seller, it was never sold -- would keep pointing at an item sitting on a
    // merchant's shelf.
    await ejectSocketedStone(client, itemId);

    // Nothing in this codebase currently grants a player_items row with
    // quantity > 1 (grep confirms it: trade.js's own buy INSERT hardcodes 1,
    // items.js/index.js's grants take the column default of 1, and
    // claimItem only ever copies a world_items quantity that spawnDrops
    // itself always inserts as 1 — F-022 / SOMET-202). If a stack ever DID
    // appear, the code below would price and pay for exactly ONE unit while
    // handing the whole row to the merchant — silently costing the seller
    // every unit but one. Refuse instead of risking that.
    const quantity = Number(del.rows[0].quantity) || 1;
    if (quantity !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'cannot sell a stacked item' };
    }

    const vr = await client.query('SELECT value FROM item_types WHERE id = $1', [itemTypeId]);
    const value = vr.rows.length ? Number(vr.rows[0].value) || 0 : 0;
    // The SELLER's own priceMult, never the default and never another
    // player's -- p was resolved from userId above, so this is the same
    // player the DELETE just proved owns the item. See progressionConstants
    // .js SELL_FRACTION_MAX for why this can never reach or exceed 1.0.
    const price = sellPriceFor(value, p.stats.priceMult);

    const gr = await client.query(
      'UPDATE users SET gold = gold + $2 WHERE id = $1 RETURNING gold',
      [userId, price],
    );
    const gold = gr.rows.length ? Number(gr.rows[0].gold) || 0 : p.gold;

    const stockRow = await insertBuyback(
      client, entry.worldId, villageId, itemTypeId, price, userId, BUYBACK_DAYS,
    );

    // SOMET-484: HAND the instance to the merchant instead of destroying it.
    // The old DELETE took player_item_affixes with it (ON DELETE CASCADE) and
    // buyStock then built a white base item from item_type_id alone, so every
    // sell-and-buy-back laundered a rolled item into a plain one. Moving the
    // row means rarity, item_level and the affix rows are never read, never
    // written and never copied -- there is no carry path that can be
    // incomplete.
    //
    // One statement sets both holder columns because
    // player_items_one_holder_check forbids a row naming neither (and one
    // naming both): the instance goes straight from the character to the
    // merchant with no ownerless instant in between.
    //
    // The `character_id = $3` predicate is redundant against the FOR UPDATE
    // lock taken above and kept anyway: it makes rowCount a real assertion
    // rather than a formality, so if a future edit ever moves the lock or
    // drops it, this fails loudly instead of silently handing over an item
    // the seller does not own.
    const handover = await client.query(
      `UPDATE player_items SET character_id = NULL, merchant_stock_id = $2
        WHERE id = $1 AND character_id = $3`,
      [itemId, stockRow.id, characterId],
    );
    if (handover.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'you do not own that item' };
    }

    await client.query('COMMIT');

    p.gold = gold;
    p.inv.items = p.inv.items.filter((it) => it.id !== itemId);
    return { ok: true, gold, price };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { buyStock, sellItem };
