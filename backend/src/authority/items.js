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
            range, projectile_speed, projectile_radius, pierce, mana_cost, element,
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

module.exports = { loadItemTypes, resolveDefaultWeaponId, DEFAULT_WEAPON_NAME, SLOTS, loadInventory, grantStartingLoadout, STARTING_LOADOUT };
