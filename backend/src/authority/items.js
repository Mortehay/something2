// Character-scoped item layer: the generalized item catalog plus a character's
// inventory and paper-doll equipment. Inventory/equipment are keyed by
// character_id (SOMET-257 re-keyed them off user_id) and are independent of
// any world. Gold is the exception and stays on users -- it is account-wide.

const { isCompatible, stoneKind, rollDestroy } = require('../services/stones.js');

const DEFAULT_WEAPON_NAME = 'dagger';
const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

function num(v) { return v == null ? null : Number(v); }

// Load the whole item catalog (weapons + armor) keyed by id.
async function loadItemTypes(pool) {
  const r = await pool.query(
    `SELECT id, name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
            range, projectile_speed, projectile_radius, pierce, mana_cost, stamina_cost, element,
            defense, resistances, stackable, ammo_type_id, aoe_radius, vfx, knockback
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
      stackable: row.stackable === true,
      ammo_type_id: num(row.ammo_type_id),
      aoe_radius: num(row.aoe_radius),
      // Effect-name bindings per moment, e.g. { attack: 'sweep_arc' }.
      // Normalized to null so `weapon.vfx` is never undefined downstream.
      vfx: row.vfx || null,
      // SOMET-253 Task 9. This is the SECOND loader (server.js's real
      // per-request query is the first, at loadItemTypes' own call site
      // below) -- P2a's creature-behavior inertness trap was exactly this
      // shape: a column added to the schema but missing from an explicit
      // SELECT list, so world.attack's `w.knockback > 0` check silently read
      // undefined forever despite a correct migration and correct world.js.
      knockback: Number(row.knockback ?? 0),
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

// The reserved currency item type's id, resolved by name from the loaded
// catalog. null if the migration that seeds it hasn't run.
function resolveGoldItemTypeId(itemTypes) {
  for (const t of itemTypes.values()) if (t.name === 'gold') return t.id;
  return null;
}

// A character's owned instances + their paper-doll, both character-scoped.
//
// Hydrates each host item's socketedStoneTypeId cache from stone_instances at
// LOAD time, not just from live socketStone/unsocketStone writes during the
// session (Task 4). Without this, a character who joins (or reconnects) with
// an already-socketed weapon -- which is every migration-converted magic
// weapon, plus anything socketed and left socketed across a previous session
// -- would have an empty in-memory cache despite the DB truthfully recording
// a socketed stone, and combat's activeWeaponType (items.js) would silently
// treat the weapon as bare (plain physical, per the "replace semantics"
// design) until the player happened to touch the socket UI again. Scoped to
// this character via the host_pi join predicate, matching every other
// ownership check in this file.
async function loadInventory(pool, characterId) {
  const ir = await pool.query(
    'SELECT id, item_type_id, quantity FROM player_items WHERE character_id = $1 ORDER BY created_at ASC, id ASC',
    [characterId],
  );
  const er = await pool.query(
    'SELECT slot, item_id FROM player_equipment WHERE character_id = $1',
    [characterId],
  );
  const sr = await pool.query(
    `SELECT si.socketed_into_id AS host_id, stone_pi.item_type_id AS stone_type_id
       FROM stone_instances si
       JOIN player_items stone_pi ON stone_pi.id = si.player_item_id
       JOIN player_items host_pi ON host_pi.id = si.socketed_into_id
      WHERE host_pi.character_id = $1 AND si.socketed_into_id IS NOT NULL`,
    [characterId],
  );
  const equipment = {};
  for (const row of er.rows) equipment[row.slot] = row.item_id;
  const items = ir.rows.map((r) => ({ id: r.id, typeId: r.item_type_id, quantity: Number(r.quantity ?? 1) }));
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const row of sr.rows) {
    const hostItem = byId.get(row.host_id);
    if (hostItem) hostItem.socketedStoneTypeId = row.stone_type_id;
  }
  return { items, equipment };
}

// Grant the starter set, once per CHARACTER, ever. F-013 (P0): this used to be
// gated on "the account currently owns zero items" (a SELECT against
// player_items), which a player can re-enter at will by selling or dropping
// the starter items and reconnecting — the join handler saw an empty
// inventory and granted a fresh set every time. Confirmed live, twice: sell
// the dagger+vest to a merchant and reconnect for free gold (0 -> 21 -> 42),
// or drop them and reconnect for a free duplicate pair.
//
// Gated instead on starting_loadout_granted_at, a fact about the character
// rather than a snapshot of current ownership, via a single conditional
// UPDATE ... WHERE ... IS NULL RETURNING. This is a single statement
// specifically so two concurrent joins on the same fresh character cannot both
// read "not granted yet" before either writes: Postgres takes the row lock on
// the first UPDATE that reaches it, the second blocks until that transaction
// commits, then re-evaluates the WHERE clause against the now-committed row
// and affects zero rows. The winner grants; the loser sees rowCount 0 and
// skips — no read-then-write race window exists to lose.
//
// What SOMET-258 changed is only WHERE the flag lives and WHAT is granted: the
// flag moved from users to characters (the loadout is class-dependent, so a
// second character must get its own), and the item list moved from a hardcoded
// STARTING_LOADOUT array to the class_loadouts table keyed by the character's
// entity_type_id. `character` is { id, entityTypeId } -- the shape
// services/characters.js#ownedCharacter returns.
async function grantStartingLoadout(pool, character, itemTypes) {
  const claim = await pool.query(
    `UPDATE characters SET starting_loadout_granted_at = now()
      WHERE id = $1 AND starting_loadout_granted_at IS NULL
      RETURNING id`,
    [character.id],
  );
  if (claim.rowCount === 0) return false;
  const rows = await pool.query(
    'SELECT item_type_id, quantity FROM class_loadouts WHERE entity_type_id = $1 ORDER BY id ASC',
    [character.entityTypeId],
  );
  for (const row of rows.rows) {
    // The fk on class_loadouts already guarantees the item type exists in the
    // database. This guard is about the in-memory catalog the world was built
    // from, which can legitimately predate a catalog change.
    if (!itemTypes.has(row.item_type_id)) continue;
    await pool.query(
      'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1, $2, $3)',
      [character.id, row.item_type_id, row.quantity],
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
// "Combat integration -- replace semantics" (design doc): a socketed SPELL
// stone (element set) supplies the "spell" -- element, mana_cost, damage,
// cooldown, per 1714440167000_convert_magic_weapons_to_stones.js's own
// authoritative enumeration of exactly which fields are spell-relevant vs.
// weapon mechanics. A socketed BUFF stone (stat_bonus_*, no element) never
// touches attack resolution. Everything else -- kind, reach, arc_width,
// range, projectile_*, pierce, stamina_cost, knockback, vfx, ammo_type_id,
// aoe_radius -- is weapon mechanics and always comes from the weapon's own
// item_types row, never the stone's: returning the stone's row wholesale
// (as opposed to merging just the spell fields onto the weapon) would zero
// out a socketed weapon's reach/damage/cooldown and misroute melee weapons
// into the projectile branch (stone rows carry no `kind`).
//
// With nothing eligible socketed, the weapon's own baked-in element/mana_cost
// columns are vestigial (left in place by the conversion migration for that
// migration to read from, not for combat to read from any more) -- the
// weapon attacks as plain physical at zero mana cost. This is a real
// behavior change from pre-socket baked-in magic, called out explicitly in
// the design doc: it only matters once a player unsockets a converted
// weapon's spell stone and leaves the weapon bare.
function activeWeaponType(inv, itemTypes, defaultWeaponId) {
  const itemId = inv.equipment.main_hand;
  if (itemId) {
    const item = findItem(inv, itemId);
    const type = item ? itemTypes.get(item.typeId) : null;
    if (type && type.category === 'weapon') {
      const stoneType = item.socketedStoneTypeId != null ? itemTypes.get(item.socketedStoneTypeId) : null;
      if (stoneType && stoneType.element != null) {
        return {
          ...type,
          element: stoneType.element,
          mana_cost: stoneType.mana_cost,
          damage: stoneType.damage,
          cooldown: stoneType.cooldown,
        };
      }
      if (type.element !== 'physical' || type.mana_cost) {
        return { ...type, element: 'physical', mana_cost: 0 };
      }
      return type;
    }
  }
  return itemTypes.get(defaultWeaponId) || null;
}

// Equip with write-through. Clears any slot the instance currently occupies and,
// for a two-handed weapon, the off hand.
async function equip(pool, characterId, inv, itemTypes, itemId, slot) {
  const check = canEquip(inv, itemTypes, itemId, slot);
  if (!check.ok) return check;

  const type = itemTypes.get(findItem(inv, itemId).typeId);
  const toClear = [];
  for (const s of SLOTS) if (inv.equipment[s] === itemId && s !== slot) toClear.push(s);
  if (slot === 'main_hand' && type.two_handed && inv.equipment.off_hand) toClear.push('off_hand');

  for (const s of toClear) {
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1 AND slot = $2', [characterId, s]);
    delete inv.equipment[s];
  }
  await pool.query(
    `INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)
     ON CONFLICT (character_id, slot) DO UPDATE SET item_id = $3`,
    [characterId, slot, itemId],
  );
  inv.equipment[slot] = itemId;
  return { ok: true };
}

async function unequip(pool, characterId, inv, slot) {
  if (!SLOTS.includes(slot)) return { ok: false, reason: 'unknown slot' };
  await pool.query('DELETE FROM player_equipment WHERE character_id = $1 AND slot = $2', [characterId, slot]);
  delete inv.equipment[slot];
  return { ok: true };
}

// Socket/unsocket. NOTE these deliberately do NOT mirror equip/unequip's
// shape above -- equip/unequip (read in full before writing this) are plain
// sequential pool.query calls with no transaction, because each is a single
// idempotent write (DELETE, or INSERT ... ON CONFLICT DO UPDATE) and
// ownership is checked purely in-memory via findItem(inv, itemId). Socketing
// has a real multi-step check-then-act shape (ownership + already-socketed +
// host-occupancy + compatibility, THEN one write) backed by a DB-level
// invariant (stone_instances' partial unique index on socketed_into_id), so
// this instead mirrors sellItem/openChest/chestLoot in this same directory:
// one checked-out client, explicit BEGIN/COMMIT/ROLLBACK, and the
// character_id predicate on every SELECT/UPDATE as the actual authoritative
// ownership check (FOR UPDATE locks the row for the duration of the
// transaction, same as openChest's guard-check/CAS).

// Socket a stone into a host item. Ownership of BOTH instances is checked
// against characterId via the DB predicate (never trust a client-supplied
// pair blindly) -- the partial unique index on stone_instances.socketed_into_id
// is the DB-level backstop; this also checks explicitly first for a clean
// error message rather than surfacing a raw constraint violation to the
// caller. On success, also writes inv's in-memory record for the host item so
// a later action in the same session (canEquip, a second socket attempt, and
// eventually combat's activeWeaponType) sees the change without a reload --
// same reason claimItem/dropItem/sellItem push/filter p.inv.items in place.
async function socketStone(pool, characterId, inv, stonePlayerItemId, hostPlayerItemId, itemTypes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stoneRow = await client.query(
      `SELECT pi.item_type_id, si.socketed_into_id
         FROM player_items pi JOIN stone_instances si ON si.player_item_id = pi.id
        WHERE pi.id = $1 AND pi.character_id = $2 FOR UPDATE`,
      [stonePlayerItemId, characterId],
    );
    if (stoneRow.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'stone not found' }; }
    if (stoneRow.rows[0].socketed_into_id != null) {
      await client.query('ROLLBACK'); return { ok: false, reason: 'stone is already socketed' };
    }

    const hostRow = await client.query(
      'SELECT item_type_id FROM player_items WHERE id = $1 AND character_id = $2 FOR UPDATE',
      [hostPlayerItemId, characterId],
    );
    if (hostRow.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'host item not found' }; }

    const occupant = await client.query(
      'SELECT 1 FROM stone_instances WHERE socketed_into_id = $1', [hostPlayerItemId],
    );
    if (occupant.rowCount > 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'host already has a socketed stone' }; }

    const stoneTypeId = stoneRow.rows[0].item_type_id;
    const stoneType = itemTypes.get(stoneTypeId);
    const hostType = itemTypes.get(hostRow.rows[0].item_type_id);
    if (!stoneType || !hostType || !isCompatible(stoneKind(stoneType), hostType.category)) {
      await client.query('ROLLBACK'); return { ok: false, reason: 'stone is not compatible with this item' };
    }

    await client.query('UPDATE stone_instances SET socketed_into_id = $1 WHERE player_item_id = $2',
      [hostPlayerItemId, stonePlayerItemId]);
    await client.query('COMMIT');

    const hostItem = findItem(inv, hostPlayerItemId);
    if (hostItem) hostItem.socketedStoneTypeId = stoneTypeId;
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Unsocket. Requires an explicit confirm flag -- checked BEFORE any query, so
// a client that forgot it costs nothing. On a destroy roll, deletes the
// stone's own player_items row (stone_instances cascades via ON DELETE
// CASCADE). On survival, clears socketed_into_id only -- the stone's row,
// xp and level are untouched. Either way the host item's in-memory cache
// entry is cleared: the stone no longer occupies it.
async function unsocketStone(pool, characterId, inv, stonePlayerItemId, { confirm, rng = Math.random } = {}) {
  if (!confirm) return { ok: false, reason: 'unsocketing requires explicit confirmation' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stoneRow = await client.query(
      `SELECT si.socketed_into_id FROM player_items pi
         JOIN stone_instances si ON si.player_item_id = pi.id
        WHERE pi.id = $1 AND pi.character_id = $2 AND si.socketed_into_id IS NOT NULL FOR UPDATE`,
      [stonePlayerItemId, characterId],
    );
    if (stoneRow.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'stone not found or not socketed' }; }
    const hostPlayerItemId = stoneRow.rows[0].socketed_into_id;

    const destroyed = rollDestroy(rng);
    if (destroyed) {
      await client.query('DELETE FROM player_items WHERE id = $1', [stonePlayerItemId]);
    } else {
      await client.query('UPDATE stone_instances SET socketed_into_id = NULL WHERE player_item_id = $1', [stonePlayerItemId]);
    }
    await client.query('COMMIT');

    if (destroyed) inv.items = inv.items.filter((it) => it.id !== stonePlayerItemId);
    const hostItem = findItem(inv, hostPlayerItemId);
    if (hostItem) delete hostItem.socketedStoneTypeId;

    return { ok: true, destroyed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  loadItemTypes, resolveDefaultWeaponId, resolveGoldItemTypeId, DEFAULT_WEAPON_NAME, SLOTS, loadInventory,
  grantStartingLoadout, canEquip, mitigation, activeWeaponType, equip, unequip, socketStone, unsocketStone,
};
