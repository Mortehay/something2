// Account-scoped item layer: the generalized item catalog plus a user's
// inventory and paper-doll equipment. Inventory/equipment are keyed by
// user_id and are independent of any world.

const DEFAULT_WEAPON_NAME = 'dagger';
const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

function num(v) { return v == null ? null : Number(v); }

// Load the whole item catalog (weapons + armor) keyed by id.
async function loadItemTypes(pool) {
  const r = await pool.query(
    `SELECT id, name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
            range, projectile_speed, projectile_radius, pierce, mana_cost, stamina_cost, element,
            defense, resistances
     FROM item_types ORDER BY id ASC`,
  );
  const m = new Map();
  for (const row of r.rows) {
    m.set(row.id, {
      id: row.id,
      name: row.name,
      category: row.category,
      slot: row.slot ?? null,
      two_handed: row.two_handed === true,
      kind: row.kind ?? null,
      damage: Number(row.damage ?? 0),
      cooldown: Number(row.cooldown ?? 0),
      reach: num(row.reach),
      arc_width: num(row.arc_width),
      range: num(row.range),
      projectile_speed: num(row.projectile_speed),
      projectile_radius: num(row.projectile_radius),
      pierce: num(row.pierce),
      mana_cost: Number(row.mana_cost ?? 0),
      stamina_cost: Number(row.stamina_cost ?? 0),
      element: row.element ?? null,
      defense: Number(row.defense ?? 0),
      resistances: row.resistances || {},
    });
  }
  return m;
}

// The default active weapon: the dagger, else the first WEAPON (never armor).
function resolveDefaultWeaponId(mapById) {
  let firstWeapon = null;
  for (const [id, t] of mapById) {
    if (t.category !== 'weapon') continue;
    if (t.name === DEFAULT_WEAPON_NAME) return id;
    if (firstWeapon === null) firstWeapon = id;
  }
  return firstWeapon;
}

const STARTING_LOADOUT = ['dagger', 'leather-vest'];

// A user's owned instances + their paper-doll, both account-wide.
async function loadInventory(pool, userId) {
  const ir = await pool.query(
    'SELECT id, item_type_id FROM player_items WHERE user_id = $1 ORDER BY created_at ASC, id ASC',
    [userId],
  );
  const er = await pool.query(
    'SELECT slot, item_id FROM player_equipment WHERE user_id = $1',
    [userId],
  );
  const equipment = {};
  for (const row of er.rows) equipment[row.slot] = row.item_id;
  return { items: ir.rows.map((r) => ({ id: r.id, typeId: r.item_type_id })), equipment };
}

// Grant the starter set to a user who owns nothing. Idempotent: a user with
// any item is left alone. Returns whether anything was granted.
async function grantStartingLoadout(pool, userId, itemTypes) {
  const existing = await pool.query('SELECT id FROM player_items WHERE user_id = $1 LIMIT 1', [userId]);
  if (existing.rows.length) return false;
  const byName = new Map();
  for (const t of itemTypes.values()) byName.set(t.name, t.id);
  for (const name of STARTING_LOADOUT) {
    const typeId = byName.get(name);
    if (typeId == null) continue; // catalog missing this type -> skip, don't crash
    await pool.query(
      'INSERT INTO player_items (user_id, item_type_id) VALUES ($1, $2)',
      [userId, typeId],
    );
  }
  return true;
}

const HAND_SLOTS = ['main_hand', 'off_hand'];

function findItem(inv, itemId) { return inv.items.find((it) => it.id === itemId) || null; }

// Pure legality check. Returns {ok:true} or {ok:false, reason}.
function canEquip(inv, itemTypes, itemId, slot) {
  if (!SLOTS.includes(slot)) return { ok: false, reason: 'unknown slot' };
  const item = findItem(inv, itemId);
  if (!item) return { ok: false, reason: 'you do not own that item' };
  const type = itemTypes.get(item.typeId);
  if (!type) return { ok: false, reason: 'unknown item type' };

  if (type.category === 'weapon') {
    if (!HAND_SLOTS.includes(slot)) return { ok: false, reason: 'weapons go in a hand slot' };
    if (slot === 'off_hand' && type.two_handed) return { ok: false, reason: 'two-handed weapon needs the main hand' };
    if (slot === 'off_hand') {
      const mh = inv.equipment.main_hand;
      const mhType = mh ? itemTypes.get((findItem(inv, mh) || {}).typeId) : null;
      if (mhType && mhType.two_handed) return { ok: false, reason: 'a two-handed weapon is equipped' };
    }
    return { ok: true };
  }

  // armor: must go in its own slot
  if (type.slot !== slot) return { ok: false, reason: `that item goes in ${type.slot}` };
  return { ok: true };
}

// Sum equipped ARMOR defense and merge resistances per element.
function mitigation(inv, itemTypes) {
  let defense = 0;
  const resistances = {};
  for (const slot of SLOTS) {
    const itemId = inv.equipment[slot];
    if (!itemId) continue;
    const item = findItem(inv, itemId);
    if (!item) continue;
    const type = itemTypes.get(item.typeId);
    if (!type || type.category !== 'armor') continue;
    defense += type.defense || 0;
    for (const [el, v] of Object.entries(type.resistances || {})) {
      resistances[el] = (resistances[el] || 0) + v;
    }
  }
  return { defense, resistances };
}

// The item type driving attacks: whatever is in main_hand, else the default.
function activeWeaponType(inv, itemTypes, defaultWeaponId) {
  const itemId = inv.equipment.main_hand;
  if (itemId) {
    const item = findItem(inv, itemId);
    const type = item ? itemTypes.get(item.typeId) : null;
    if (type && type.category === 'weapon') return type;
  }
  return itemTypes.get(defaultWeaponId) || null;
}

// Equip with write-through. Clears any slot the instance currently occupies and,
// for a two-handed weapon, the off hand.
async function equip(pool, userId, inv, itemTypes, itemId, slot) {
  const check = canEquip(inv, itemTypes, itemId, slot);
  if (!check.ok) return check;

  const type = itemTypes.get(findItem(inv, itemId).typeId);
  const toClear = [];
  for (const s of SLOTS) if (inv.equipment[s] === itemId && s !== slot) toClear.push(s);
  if (slot === 'main_hand' && type.two_handed && inv.equipment.off_hand) toClear.push('off_hand');

  for (const s of toClear) {
    await pool.query('DELETE FROM player_equipment WHERE user_id = $1 AND slot = $2', [userId, s]);
    delete inv.equipment[s];
  }
  await pool.query(
    `INSERT INTO player_equipment (user_id, slot, item_id) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, slot) DO UPDATE SET item_id = $3`,
    [userId, slot, itemId],
  );
  inv.equipment[slot] = itemId;
  return { ok: true };
}

async function unequip(pool, userId, inv, slot) {
  if (!SLOTS.includes(slot)) return { ok: false, reason: 'unknown slot' };
  await pool.query('DELETE FROM player_equipment WHERE user_id = $1 AND slot = $2', [userId, slot]);
  delete inv.equipment[slot];
  return { ok: true };
}

module.exports = { loadItemTypes, resolveDefaultWeaponId, DEFAULT_WEAPON_NAME, SLOTS, loadInventory, grantStartingLoadout, STARTING_LOADOUT, canEquip, mitigation, activeWeaponType, equip, unequip };
