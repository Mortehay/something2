// Merchant stock: a village's base catalog (seller_user_id IS NULL — infinite,
// never expires) plus player buyback rows (seller_user_id set — one instance
// each, expiring after BUYBACK_DAYS at the price they were sold for).

const SELL_FRACTION = 0.5;
const BUYBACK_DAYS = 3;

// priceMult defaults to SELL_FRACTION so every existing caller (and the
// merchantStock.test.js literals) keeps behaving exactly as before A2.
// Charisma raises what the seller's OWN sale pays out (see trade.js
// sellItem); it is never a second, independent fraction -- priceMult IS the
// fraction, just supplied by playerStats.js instead of the module default.
function sellPriceFor(value, priceMult = SELL_FRACTION) {
  const v = Number(value) || 0;
  const m = Number(priceMult);
  const frac = Number.isFinite(m) ? m : SELL_FRACTION;
  return Math.max(0, Math.floor(v * frac));
}

function mapRow(r) {
  return {
    id: r.id,
    itemTypeId: r.item_type_id,
    price: Number(r.price) || 0,
    quantity: Number(r.quantity) || 1,
    sellerUserId: r.seller_user_id == null ? null : Number(r.seller_user_id),
  };
}

// One base-catalog row per sellable catalog item. The NOT EXISTS guard makes
// this safe to call more than once for the same village (village creation is
// still the only caller today, but seedItemAcrossVillages below shares this
// same "don't duplicate an existing base-catalog row" invariant, so both
// functions need it to stay correct together).
async function seedBaseCatalog(pool, worldId, villageId) {
  await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT $1, $2, id, value, NULL, NULL, 1
       FROM item_types
      WHERE category IN ('weapon','armor') AND value > 0
        AND NOT EXISTS (
          SELECT 1 FROM merchant_stock ms
           WHERE ms.village_id = $2 AND ms.item_type_id = item_types.id AND ms.seller_user_id IS NULL
        )`,
    [worldId, villageId],
  );
}

// SOMET-186 / F-006: seedBaseCatalog only ever ran at village creation, so an
// item type added afterward never reached any village that already existed --
// permanently, with no recovery short of deleting and recreating the village
// (which loses its buyback rows) or a manual SQL insert. Call this once, right
// after a weapon/armor item type is created, to backfill a base-catalog row
// for that one item type into every village that doesn't already have one.
// NOT EXISTS makes it safe to call redundantly (e.g. a retried request).
async function seedItemAcrossVillages(pool, itemTypeId) {
  await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT v.world_id, v.id, it.id, it.value, NULL, NULL, 1
       FROM villages v
       JOIN item_types it ON it.id = $1
      WHERE it.category IN ('weapon','armor') AND it.value > 0
        AND NOT EXISTS (
          SELECT 1 FROM merchant_stock ms
           WHERE ms.village_id = v.id AND ms.item_type_id = it.id AND ms.seller_user_id IS NULL
        )`,
    [itemTypeId],
  );
}

// SOMET-281: merchant_stock.price is a SNAPSHOT of item_types.value, taken
// when the base-catalog row is seeded. PUT /api/item-types never refreshed it,
// so raising an item's value left every village SELLING it at the old price
// while trade.js sellItem PAYS sellPriceFor(the NEW value) -- a catalog edit
// alone opened an unbounded buy-low/sell-high gold fountain.
//
// Only base-catalog rows (seller_user_id IS NULL) may be repriced. A buyback
// row's price is the price the seller was actually paid, and SOMET-156
// promises that player they can buy it back "at the same price they sold for";
// repricing it would either rob or gift a specific player. `seller_user_id IS
// NULL` is therefore load-bearing in BOTH statements below, not a filter for
// tidiness.
//
// value <= 0 means "not sold in shops" -- that is exactly the rule
// seedBaseCatalog/seedItemAcrossVillages apply when deciding what to stock --
// so dropping the value to 0 must REMOVE the base-catalog rows, not reprice
// them to 0 (which would hand out free gear). The reverse direction (0 -> a
// real price) is handled by the route calling seedItemAcrossVillages, which
// already re-seeds only what qualifies.
//
// Returns the number of base-catalog rows changed.
async function repriceBaseCatalog(pool, itemTypeId, value) {
  const price = Number(value) || 0;
  if (price <= 0) {
    const del = await pool.query(
      `DELETE FROM merchant_stock
        WHERE item_type_id = $1 AND seller_user_id IS NULL`,
      [itemTypeId],
    );
    return del.rowCount || 0;
  }
  const upd = await pool.query(
    `UPDATE merchant_stock SET price = $2
      WHERE item_type_id = $1 AND seller_user_id IS NULL AND price <> $2`,
    [itemTypeId, price],
  );
  return upd.rowCount || 0;
}

// Lazily sweep expired buyback rows, then read the shop AS SEEN BY ONE PLAYER.
//
// SOMET-280: buyback used to be a shared shelf -- every buyback row in the
// village was listed to everyone, so another player could snipe the gear you
// had just sold, inside the 3-day window, with no notification to you. That
// contradicts SOMET-156's own acceptance wording ("the player can buy them
// back"). viewerUserId now scopes the buyback list to its seller; the base
// catalog (seller_user_id IS NULL) is public and unaffected.
//
// Scoped by USER, not by character, deliberately:
//   - merchant_stock.seller_user_id is a users.id FK; there is no character_id
//     column, so character scoping would need a schema change.
//   - The sale proceeds landed in users.gold, which is per ACCOUNT (SOMET-257
//     made inventory/progression per character, but NOT the wallet). The gold
//     a second character would spend buying the row back is the very gold the
//     first character's sale created. Scoping tighter than the wallet would be
//     inconsistent: same purse, different shelf.
//   - Character deletion would otherwise strand the row -- unreachable by
//     anyone until it expires -- while the account keeps the gold.
// So a player's second character DOES see (and may buy back) stock the first
// character sold. It never leaves the account that sold it.
//
// The sweep DELETE is intentionally NOT scoped to the viewer: an expired row
// is garbage regardless of who sold it, and whoever opens the shop next
// should clear it.
//
// Fails CLOSED on a missing viewerUserId: `seller_user_id = NULL` is never
// true, so a caller that forgets the argument sees an empty buyback list
// rather than everyone's.
async function fetchShop(pool, villageId, viewerUserId) {
  await pool.query(
    'DELETE FROM merchant_stock WHERE village_id = $1 AND expires_at IS NOT NULL AND expires_at < now()',
    [villageId],
  );
  const r = await pool.query(
    `SELECT id, item_type_id, price, quantity, seller_user_id FROM merchant_stock
      WHERE village_id = $1 AND (expires_at IS NULL OR expires_at > now())
        AND (seller_user_id IS NULL OR seller_user_id = $2)
      ORDER BY seller_user_id NULLS FIRST, created_at ASC`,
    [villageId, viewerUserId == null ? null : Number(viewerUserId)],
  );
  const rows = r.rows.map(mapRow);
  return {
    catalog: rows.filter((x) => x.sellerUserId == null),
    buyback: rows.filter((x) => x.sellerUserId != null),
  };
}

async function insertBuyback(pool, worldId, villageId, itemTypeId, price, sellerUserId, days = BUYBACK_DAYS) {
  const r = await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     VALUES ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 day'), 1)
     RETURNING id, item_type_id, price, quantity, seller_user_id`,
    [worldId, villageId, itemTypeId, price, sellerUserId, days],
  );
  return r.rows[0];
}

module.exports = {
  SELL_FRACTION, BUYBACK_DAYS, sellPriceFor,
  seedBaseCatalog, seedItemAcrossVillages, repriceBaseCatalog, fetchShop, insertBuyback,
};
