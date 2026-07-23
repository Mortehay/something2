// Merchant transactions. Gold moves through guarded atomic UPDATEs (never a
// read-modify-write), ownership is enforced by the SQL predicate, and the
// in-memory inventory/wallet are kept in step so a later equip validates
// against fresh state.

const { sellPriceFor, insertBuyback, BUYBACK_DAYS } = require('../services/merchantStock');

async function buyStock(pool, entry, userId, stockId) {
  const p = entry.world.getPlayer(userId);
  if (!p) return { ok: false, reason: 'no player' };

  const sr = await pool.query(
    'SELECT id, item_type_id, price, seller_user_id, village_id FROM merchant_stock WHERE id = $1',
    [stockId],
  );
  if (sr.rows.length !== 1) return { ok: false, reason: 'that item is no longer for sale' };
  const stock = sr.rows[0];
  const price = Number(stock.price) || 0;

  // Overdraft-safe: the WHERE guard makes "not enough gold" a 0-row result
  // rather than a negative balance.
  const gr = await pool.query(
    'UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold',
    [userId, price],
  );
  if (gr.rowCount !== 1) return { ok: false, reason: 'not enough gold' };
  const gold = Number(gr.rows[0].gold) || 0;

  const ins = await pool.query(
    'INSERT INTO player_items (user_id, item_type_id, quantity) VALUES ($1, $2, 1) RETURNING id, item_type_id, quantity',
    [userId, stock.item_type_id],
  );
  const row = ins.rows[0];

  // A base-catalog row (seller_user_id NULL) is infinite stock; a buyback row is
  // one specific instance and is consumed.
  if (stock.seller_user_id != null) {
    await pool.query('DELETE FROM merchant_stock WHERE id = $1', [stockId]);
  }

  p.gold = gold;
  const item = { id: row.id, typeId: row.item_type_id, quantity: Number(row.quantity) || 1 };
  if (p.inv) p.inv.items.push(item);
  return { ok: true, gold, item };
}

async function sellItem(pool, entry, userId, villageId, itemId) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };
  if (Object.values(p.inv.equipment).includes(itemId)) {
    return { ok: false, reason: 'unequip it first' };
  }

  // The user_id predicate IS the ownership check.
  const del = await pool.query(
    'DELETE FROM player_items WHERE id = $1 AND user_id = $2 RETURNING item_type_id, quantity',
    [itemId, userId],
  );
  if (del.rowCount !== 1) return { ok: false, reason: 'you do not own that item' };
  const itemTypeId = del.rows[0].item_type_id;

  const vr = await pool.query('SELECT value FROM item_types WHERE id = $1', [itemTypeId]);
  const value = vr.rows.length ? Number(vr.rows[0].value) || 0 : 0;
  const price = sellPriceFor(value);

  const gr = await pool.query(
    'UPDATE users SET gold = gold + $2 WHERE id = $1 RETURNING gold',
    [userId, price],
  );
  const gold = gr.rows.length ? Number(gr.rows[0].gold) || 0 : p.gold;

  await insertBuyback(pool, entry.worldId, villageId, itemTypeId, price, userId, BUYBACK_DAYS);

  p.gold = gold;
  p.inv.items = p.inv.items.filter((it) => it.id !== itemId);
  return { ok: true, gold, price };
}

module.exports = { buyStock, sellItem };
