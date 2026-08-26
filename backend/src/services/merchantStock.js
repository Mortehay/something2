// Merchant stock: a village's base catalog (seller_user_id IS NULL — infinite,
// never expires) plus player buyback rows (seller_user_id set — one instance
// each, expiring after BUYBACK_DAYS at the price they were sold for).
// Only base (Tier 1) weapons & armor are sold in the merchant base catalog,
// tailored to the active character class. Higher tier gear drops from creatures in the wild.

const {
  HELD_INSTANCE_COLUMNS, heldInstanceJoin, withHeldInstance,
} = require('./heldInstance');

const SELL_FRACTION = 0.5;
const BUYBACK_DAYS = 3;

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

const CLASS_ITEM_KEYWORDS = {
  Warrior: ['blade', 'sword', 'axe', 'mace', 'spear', 'dagger', 'plate', 'helm', 'gauntlets', 'greaves', 'buckler', 'band', 'signet', 'short sword', 'long sword', 'two-handed sword', 'crude-blade', 'leather-vest'],
  Archer: ['bow', 'crossbow', 'dagger', 'spear', 'blade', 'arrow', 'quiver', 'hood', 'gloves', 'boots', 'robe', 'buckler', 'band', 'signet'],
  Mage: ['wand', 'staff', 'scepter', 'dagger', 'robe', 'hood', 'gloves', 'boots', 'focus', 'band', 'signet', 'magic-bolt'],
  Cultist: ['dagger', 'scepter', 'wand', 'staff', 'blade', 'knife', 'robe', 'hood', 'gloves', 'focus', 'band', 'signet'],
  Monk: ['quarterstaff', 'mace', 'spear', 'dagger', 'gloves', 'boots', 'robe', 'hood', 'focus', 'band', 'signet', 'stick', 'club'],
  Druid: ['staff', 'scepter', 'wand', 'dagger', 'bow', 'quarterstaff', 'robe', 'hood', 'gloves', 'boots', 'focus', 'band', 'signet'],
};

function isItemSuitedForClass(itemName, category, className) {
  if (!className || !CLASS_ITEM_KEYWORDS[className]) return true;
  if (category !== 'weapon' && category !== 'armor') return true;
  const n = (itemName || '').toLowerCase();
  const keywords = CLASS_ITEM_KEYWORDS[className];
  return keywords.some((kw) => n.includes(kw));
}

// One base-catalog row per sellable catalog item. Only base tier (tier 1 or un-tiered)
// items are placed in the merchant base catalog.
async function seedBaseCatalog(pool, worldId, villageId) {
  await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT $1, $2, id, value, NULL, NULL, 1
       FROM item_types
      WHERE category IN ('weapon','armor') AND value > 0
        AND (tier IS NULL OR tier = 1)
        AND NOT EXISTS (
          SELECT 1 FROM merchant_stock ms
           WHERE ms.village_id = $2 AND ms.item_type_id = item_types.id AND ms.seller_user_id IS NULL
        )`,
    [worldId, villageId],
  );
}

async function seedItemAcrossVillages(pool, itemTypeId) {
  await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT v.world_id, v.id, it.id, it.value, NULL, NULL, 1
       FROM villages v
       JOIN item_types it ON it.id = $1
      WHERE it.category IN ('weapon','armor') AND it.value > 0
        AND (it.tier IS NULL OR it.tier = 1)
        AND NOT EXISTS (
          SELECT 1 FROM merchant_stock ms
           WHERE ms.village_id = v.id AND ms.item_type_id = it.id AND ms.seller_user_id IS NULL
        )`,
    [itemTypeId],
  );
}

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
    `UPDATE merchant_stock
        SET price = $2
      WHERE item_type_id = $1 AND seller_user_id IS NULL`,
    [itemTypeId, price],
  );
  return upd.rowCount || 0;
}

// Fetches merchant catalog and buyback rows. Filters base items to Tier 1 and (if viewerClass specified)
// to items suited for the active character class.
async function fetchShop(pool, villageId, viewerUserId, viewerClass = null) {
  await pool.query(
    'DELETE FROM merchant_stock WHERE village_id = $1 AND expires_at IS NOT NULL AND expires_at < now()',
    [villageId],
  );
  const r = await pool.query(
    `SELECT ms.id, ms.item_type_id, ms.price, ms.quantity, ms.seller_user_id,
            it.name AS item_name, it.category AS item_category, it.tier AS item_tier,
            ${HELD_INSTANCE_COLUMNS}
       FROM merchant_stock ms
       LEFT JOIN item_types it ON it.id = ms.item_type_id
       ${heldInstanceJoin('merchant_stock')}
      WHERE ms.village_id = $1 AND (ms.expires_at IS NULL OR ms.expires_at > now())
        AND (ms.seller_user_id IS NULL OR ms.seller_user_id = $2)
        AND (ms.seller_user_id IS NOT NULL OR it.tier IS NULL OR it.tier <= 1)
      ORDER BY ms.seller_user_id NULLS FIRST, ms.created_at ASC`,
    [villageId, viewerUserId == null ? null : Number(viewerUserId)],
  );
  const rows = r.rows.map((row) => withHeldInstance(mapRow(row), row));
  const baseCatalog = rows.filter((x) => x.sellerUserId == null);
  const buyback = rows.filter((x) => x.sellerUserId != null);

  const filteredCatalog = viewerClass
    ? baseCatalog.filter((x) => {
        const raw = r.rows.find((itRow) => itRow.id === x.id);
        return isItemSuitedForClass(raw?.item_name, raw?.item_category, viewerClass);
      })
    : baseCatalog;

  return {
    catalog: filteredCatalog,
    buyback,
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
  sellPriceFor,
  seedBaseCatalog,
  seedItemAcrossVillages,
  repriceBaseCatalog,
  fetchShop,
  insertBuyback,
  isItemSuitedForClass,
  CLASS_ITEM_KEYWORDS,
  SELL_FRACTION,
  BUYBACK_DAYS,
};
