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

// One base-catalog row per sellable catalog item. Idempotent per village only in
// the sense that callers seed once at village creation.
async function seedBaseCatalog(pool, worldId, villageId) {
  await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT $1, $2, id, value, NULL, NULL, 1
       FROM item_types
      WHERE category IN ('weapon','armor') AND value > 0`,
    [worldId, villageId],
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

module.exports = { SELL_FRACTION, BUYBACK_DAYS, sellPriceFor, seedBaseCatalog, fetchShop, insertBuyback };
