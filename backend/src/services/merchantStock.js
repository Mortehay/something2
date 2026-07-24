// Merchant stock: a village's base catalog (seller_user_id IS NULL — infinite,
// never expires) plus player buyback rows (seller_user_id set — one instance
// each, expiring after BUYBACK_DAYS at the price they were sold for).

const SELL_FRACTION = 0.5;
const BUYBACK_DAYS = 3;

function sellPriceFor(value) {
  const v = Number(value) || 0;
  return Math.max(0, Math.floor(v * SELL_FRACTION));
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

// Lazily sweep expired buyback rows, then read the shop.
async function fetchShop(pool, villageId) {
  await pool.query(
    'DELETE FROM merchant_stock WHERE village_id = $1 AND expires_at IS NOT NULL AND expires_at < now()',
    [villageId],
  );
  const r = await pool.query(
    `SELECT id, item_type_id, price, quantity, seller_user_id FROM merchant_stock
      WHERE village_id = $1 AND (expires_at IS NULL OR expires_at > now())
      ORDER BY seller_user_id NULLS FIRST, created_at ASC`,
    [villageId],
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
  seedBaseCatalog, seedItemAcrossVillages, fetchShop, insertBuyback,
};
