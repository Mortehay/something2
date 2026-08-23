// Character-scoped item layer: the generalized item catalog plus a character's
// inventory and paper-doll equipment. Inventory/equipment are keyed by
// character_id (SOMET-257 re-keyed them off user_id) and are independent of
// any world. Gold is the exception and stays on users -- it is account-wide.

const { isCompatible, stoneKind, rollDestroy } = require('../services/stones.js');

const DEFAULT_WEAPON_NAME = 'dagger';
const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

function num(v) { return v == null ? null : Number(v); }

// Load the whole item catalog (weapons + armor) keyed by id.
//
// `catalogs` (SOMET-329, from authority/catalogs.js) is optional. When given,
// a row's projectile_shape_id / impact_behavior_id RESOLVE into the concrete
// numbers combat already reads, here at load time -- so nothing downstream
// learns the catalogs exist and the client still never needs them. Omitted
// (every existing test, any caller that predates slice B), the raw columns are
// used exactly as before.
async function loadItemTypes(pool, catalogs = null) {
  const r = await pool.query(
    `SELECT id, name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
            range, projectile_speed, projectile_radius, pierce, mana_cost, stamina_cost, element,
            defense, resistances, stackable, ammo_type_id, aoe_radius, vfx, knockback,
            stat_bonus_stat, stat_bonus_amount, attack_origin,
            projectile_shape_id, impact_behavior_id, stone_mode, bonus_damage,
            req_level, req_strength, req_dexterity, req_constitution,
            req_intelligence, req_wisdom, req_charisma, item_level, tier
     FROM item_types ORDER BY id ASC`,
  );
  const shapes = catalogs && catalogs.projectileShapes ? catalogs.projectileShapes : null;
  const behaviors = catalogs && catalogs.impactBehaviors ? catalogs.impactBehaviors : null;
  const m = new Map();
  for (const row of r.rows) {
    // SOMET-329. Resolved ONCE here, not at each read: combat reads
    // projectile_radius/pierce/aoe_radius on the hot path (every shot), and a
    // catalog lookup per read would also give two call sites the chance to
    // disagree about which wins.
    const shape = shapes && row.projectile_shape_id != null
      ? shapes.get(row.projectile_shape_id) : null;
    const behavior = behaviors && row.impact_behavior_id != null
      ? behaviors.get(row.impact_behavior_id) : null;
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
      // A named shape SUPPLIES the radius; with no shape the hand-tuned
      // column stays authoritative, so every weapon authored before slice B
      // is untouched.
      projectile_radius: shape ? shape.radius : num(row.projectile_radius),
      pierce: behavior && behavior.pierceDefault != null ? behavior.pierceDefault : num(row.pierce),
      mana_cost: Number(row.mana_cost ?? 0),
      stamina_cost: Number(row.stamina_cost ?? 0),
      element: row.element ?? null,
      defense: Number(row.defense ?? 0),
      resistances: row.resistances || {},
      stackable: row.stackable === true,
      ammo_type_id: num(row.ammo_type_id),
      // A behaviour that does not detonate must not blast, whatever radius the
      // row happens to carry -- otherwise picking `pierce` on a weapon that
      // once had an aoe_radius would leave it silently still exploding, which
      // is the exact "the dropdown lied" failure this slice exists to stop.
      aoe_radius: behavior && !behavior.detonates ? null : num(row.aoe_radius),
      // SOMET-343: WHERE a detonating shot goes off. 'contact' (the default,
      // and today's behaviour for every existing weapon) means the first
      // contact of any kind; 'max_range' means it flies through contacts and
      // detonates only when its distance runs out. Null = contact.
      detonate_at: behavior && behavior.detonates ? behavior.detonateAt : null,
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
      // Magic Stones (SOMET-245) Task 6 prerequisite fix: these two columns
      // were added to the schema by Task 1 (1714440165000_stone_item_type.js)
      // but never selected/mapped here, so every in-memory item-type object
      // had stat_bonus_stat/stat_bonus_amount permanently undefined regardless
      // of the DB row -- the exact same "column added to the schema but
      // missing from an explicit SELECT list" shape the `knockback` comment
      // above already documents for P2a. Left as raw values (null passthrough,
      // Number(...) for the amount) rather than defaulted to 0/'' -- callers
      // (stoneBonuses.js's socketedBuffStones) test `stat_bonus_stat != null`
      // to distinguish a buff stone from a spell stone, and a coerced '' or 0
      // would make every stone look like a buff stone.
      stat_bonus_stat: row.stat_bonus_stat ?? null,
      stat_bonus_amount: row.stat_bonus_amount == null ? null : Number(row.stat_bonus_amount),
      // SOMET-326: the THIRD instance of the trap the two comments above
      // document. Null passthrough, never defaulted to a string --
      // attackOrigin.js's resolveAttackOrigin distinguishes "unauthored"
      // (fall to the kind default) from an authored name, and a coerced ''
      // would take the same branch as junk rather than the default branch.
      attack_origin: row.attack_origin ?? null,
      // SOMET-329: carried so the admin can round-trip the selection. Combat
      // never reads these -- it reads the resolved values above.
      projectile_shape_id: num(row.projectile_shape_id),
      impact_behavior_id: num(row.impact_behavior_id),
      // SOMET-332. Defaulted to 'replace' rather than passed through: the
      // column is NOT NULL in the schema, but this loader is also fed by test
      // fixtures and by any catalog snapshot predating the column, and a stone
      // whose mode read `undefined` would fall through activeWeaponType's
      // augment check into the replace branch -- silently overwriting the
      // host weapon, which is the exact behaviour augment exists to avoid.
      stone_mode: row.stone_mode === 'augment' ? 'augment' : 'replace',
      bonus_damage: num(row.bonus_damage),
      // SOMET-478: the FOURTH instance of the trap the three comments above
      // document, and this one was caught by a red test rather than in review.
      // The migration and equipRequirements.js were both correct while the
      // gate stayed completely inert, because req_level never made it out of
      // this SELECT list and every in-memory type read `undefined`.
      //
      // Defaulted to the IDENTITY values (the same ones the migration gives
      // the columns), not to 0/null: this loader is also fed by fixtures and
      // by catalog snapshots predating the migration, and an item whose
      // requirements read as undefined must be equippable by everyone rather
      // than by nobody.
      req_level: Number(row.req_level ?? 1),
      req_strength: Number(row.req_strength ?? 0),
      req_dexterity: Number(row.req_dexterity ?? 0),
      req_constitution: Number(row.req_constitution ?? 0),
      req_intelligence: Number(row.req_intelligence ?? 0),
      req_wisdom: Number(row.req_wisdom ?? 0),
      req_charisma: Number(row.req_charisma ?? 0),
      item_level: Number(row.item_level ?? 1),
      tier: Number(row.tier ?? 1),
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
    'SELECT id, item_type_id, quantity, soulbound FROM player_items WHERE character_id = $1 ORDER BY created_at ASC, id ASC',
    [characterId],
  );
  const er = await pool.query(
    'SELECT slot, item_id FROM player_equipment WHERE character_id = $1',
    [characterId],
  );
  const sr = await pool.query(
    `SELECT si.socketed_into_id AS host_id, si.player_item_id AS stone_item_id,
            stone_pi.item_type_id AS stone_type_id
       FROM stone_instances si
       JOIN player_items stone_pi ON stone_pi.id = si.player_item_id
       JOIN player_items host_pi ON host_pi.id = si.socketed_into_id
      WHERE host_pi.character_id = $1 AND si.socketed_into_id IS NOT NULL`,
    [characterId],
  );
  const equipment = {};
  for (const row of er.rows) equipment[row.slot] = row.item_id;
  // SOMET-316: `soulbound` rides the join snapshot so the client can MARK a
  // bound item while it is still being carried. It was absent before, which
  // left the account chest panel able to label a stored item `bound` and
  // unable to label the very same item in the Carrying tab beside it.
  //
  // DISPLAY ONLY, and it has to stay that way: every rule that actually reads
  // this flag -- sellItem's refusal (trade.js), dropItem's (loot.js) -- runs
  // server-side against the row, never against this copy. A stale or forged
  // value here can mislead a player's own panel and can authorize nothing.
  //
  // This is the only loader that can emit a true value. grantStartingLoadout
  // is the sole writer of soulbound = true, and every other path that hands
  // the client an item INSERTs a fresh row that takes the column default
  // (buy, chest-open, and claimItem -- see loot.js:428 for why dropping a
  // bound item is refused rather than laundered).
  const items = ir.rows.map((r) => ({
    id: r.id,
    typeId: r.item_type_id,
    quantity: Number(r.quantity ?? 1),
    soulbound: r.soulbound === true,
  }));
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const row of sr.rows) {
    const hostItem = byId.get(row.host_id);
    if (hostItem) {
      hostItem.socketedStoneTypeId = row.stone_type_id;
      // Magic Stones (SOMET-245) Task 7: the stone's OWN player_items.id,
      // distinct from socketedStoneTypeId (the stone's CATALOG type, used to
      // resolve its element/mana_cost/damage/cooldown). Stone XP is written
      // against stone_instances.player_item_id, which is this instance id,
      // never the type id -- without caching it here too, a hit landed by a
      // weapon loaded at join time (rather than socketed live this session)
      // would have no instance id to award XP against.
      hostItem.socketedStoneItemId = row.stone_item_id;
    }
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
  // SOMET-79: one transaction, as the spec always said.
  //
  // The DOUBLE-grant this was filed for is already impossible without it --
  // the conditional claim below only matches while
  // starting_loadout_granted_at IS NULL, so of two simultaneous joins exactly
  // one gets rowCount 1 and the other returns false. That is not the risk
  // that remains.
  //
  // What remains is a PARTIAL grant: the claim commits on its own, and if the
  // process dies (or the pool drops) part-way through the insert loop, the
  // character is permanently marked as having received a loadout it only
  // half has -- and the claim is precisely what stops it ever being retried.
  // Wrapping the claim and the inserts together makes the grant all-or-nothing,
  // so a crash rolls the claim back too and the next join grants cleanly.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `UPDATE characters SET starting_loadout_granted_at = now()
        WHERE id = $1 AND starting_loadout_granted_at IS NULL
        RETURNING id`,
      [character.id],
    );
    if (claim.rowCount === 0) { await client.query('ROLLBACK'); return false; }
    const rows = await client.query(
      'SELECT item_type_id, quantity FROM class_loadouts WHERE entity_type_id = $1 ORDER BY id ASC',
      [character.entityTypeId],
    );
    for (const row of rows.rows) {
      // The fk on class_loadouts already guarantees the item type exists in the
      // database. This guard is about the in-memory catalog the world was built
      // from, which can legitimately predate a catalog change.
      if (!itemTypes.has(row.item_type_id)) continue;
      // SOMET-277: soulbound = true, on the INSTANCE. The per-character flag
      // this function claims above closes the sell-then-RECONNECT exploit but
      // not sell-then-DELETE-the-character: the flag dies with the character,
      // the gold (users.gold, account-wide) does not. Binding the granted
      // instances is what makes the loadout non-monetizable, and doing it per
      // instance rather than per item TYPE is what keeps a looted or bought
      // short sword worth its full 32. See 1714440174000_soulbound_items.js.
      // Written inside this same transaction as the claim, so a grant is
      // still all-or-nothing -- there is no path that inserts a granted row
      // and leaves it unbound.
      await client.query(
        'INSERT INTO player_items (character_id, item_type_id, quantity, soulbound) VALUES ($1, $2, $3, true)',
        [character.id, row.item_type_id, row.quantity],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Carry limit. ONE definition of "how full is this inventory", called by every
// path that inserts into player_items; a second implementation is exactly how
// two paths end up disagreeing about whether a player is full.
//
// Counts ROWS (stacks), not summed quantity: a stack of 40 arrows occupies one
// slot, which is what the panel draws. Currency is excluded -- gold is a wallet
// number, not a carried stack. An item whose type is missing from the in-memory
// catalog still counts: the row exists in the database, and skipping it would
// turn an unknown type into free carrying capacity.
const DEFAULT_INVENTORY_SLOTS = 48;

function usedSlots(inv, itemTypes) {
  let n = 0;
  for (const it of (inv && inv.items) || []) {
    const t = itemTypes ? itemTypes.get(it.typeId) : null;
    if (t && t.category === 'currency') continue;
    n += 1;
  }
  return n;
}

// The cap rides the inventory object (server.js attaches it from the character
// row at join). The fallback is for a caller holding an inventory that predates
// that attach -- a missing cap must read as the default, never as unlimited.
function capacityOf(inv) {
  const c = Number(inv && inv.capacity);
  return Number.isInteger(c) && c > 0 ? c : DEFAULT_INVENTORY_SLOTS;
}

function freeSlots(inv, itemTypes) {
  return Math.max(0, capacityOf(inv) - usedSlots(inv, itemTypes));
}

function hasFreeSlot(inv, itemTypes) {
  return freeSlots(inv, itemTypes) > 0;
}

const HAND_SLOTS = ['main_hand', 'off_hand'];

function findItem(inv, itemId) { return inv.items.find((it) => it.id === itemId) || null; }

// Pure legality check. Returns {ok:true} or {ok:false, reason}.
//
// `req` (SOMET-478, T10) is the requirement context: { level, base } where
// `base` is the character's non-gear stat bundle. It is OPTIONAL and null
// means "skip the level/stat gate" -- canEquip is also called from pure
// fixtures and from the client-side mirror, neither of which holds a
// progression row. world.setEquipment ALWAYS supplies a real one, and
// item_requirements_db.test.js asserts a refusal THROUGH setEquipment so a
// dropped thread fails loudly rather than silently ungating every item.
//
// The gate runs LAST, after the slot/category rules, so the message a player
// sees names the first thing actually wrong with the request rather than a
// stat requirement on an item that could never go in that slot anyway.
function canEquip(inv, itemTypes, itemId, slot, req = null) {
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
    return requirementGate(inv, itemTypes, itemId, type, req);
  }

  // armor: must go in its own slot
  if (type.slot !== slot) return { ok: false, reason: `that item goes in ${type.slot}` };
  return requirementGate(inv, itemTypes, itemId, type, req);
}

// Split out so the two branches above cannot drift on WHICH stats the gate
// runs against. `excludeItemId: itemId` is the circularity rule: the candidate
// contributes nothing to the stats its own requirements are judged against.
//
// The require is INSIDE the function on purpose. equipRequirements.js requires
// SLOTS from this module, so a top-level require here would be a cycle
// resolved to a half-initialised module.
function requirementGate(inv, itemTypes, itemId, type, req) {
  if (!req) return { ok: true };
  // eslint-disable-next-line global-require
  const { effectiveStatsFor, meetsRequirements } = require('./equipRequirements.js');
  const stats = effectiveStatsFor(inv, itemTypes, req.base, { excludeItemId: itemId });
  return meetsRequirements(type, req.level, stats);
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
      // SOMET-332 -- AUGMENT mode. Checked BEFORE the replace branch below,
      // because an augment stone also has a non-null element and would
      // otherwise fall straight into it and overwrite the host's spell fields,
      // which is precisely the behaviour augment exists to avoid.
      //
      // The host weapon is returned UNCHANGED except for one added field: its
      // damage, cooldown, mana_cost and element are all still its own. The
      // augment is a rider the damage sites apply as a SECOND packet, never a
      // merge -- blending it into `damage` here would make the bonus be
      // mitigated by the weapon's element rather than its own.
      if (stoneType && stoneType.stone_mode === 'augment'
          && stoneType.element != null && stoneType.bonus_damage > 0) {
        return {
          ...type,
          augment: {
            element: stoneType.element,
            bonusDamage: stoneType.bonus_damage,
            // Slice B's impact behaviour, carried so an augment can make a
            // shot detonate. null for every melee augment.
            impactBehaviorId: stoneType.impact_behavior_id ?? null,
          },
          // TRAP 1 (the ticket's own review checklist). world.js gates stone
          // XP on `w.stoneItemId != null`, and before this line only the
          // replace branch set it -- so an augment stone would have landed
          // every hit and never gained a single point of XP, with nothing
          // failing loudly. Same field, same meaning, same award path.
          stoneItemId: item.socketedStoneItemId ?? null,
        };
      }
      if (stoneType && stoneType.element != null) {
        return {
          ...type,
          element: stoneType.element,
          mana_cost: stoneType.mana_cost,
          damage: stoneType.damage,
          cooldown: stoneType.cooldown,
          // Magic Stones (SOMET-245) Task 7: the socketed stone's own
          // player_items.id (NOT its catalog type id, already merged above),
          // so a caller resolving the active weapon for combat -- world.js's
          // attack() -- can award XP to the exact stone instance that landed
          // the hit, without a second lookup keyed off the host item.
          // Explicit `?? null` rather than passthrough-undefined: a weapon
          // whose socket was hydrated by an older cache write that predates
          // this field would otherwise carry `undefined` here, which is
          // truthy-adjacent enough (`!= null` checks would still catch it,
          // but downstream code should never have to know the difference).
          stoneItemId: item.socketedStoneItemId ?? null,
        };
      }
      // Only allocate the physical-forcing copy for a weapon that actually
      // carries vestigial magic (a non-null, non-physical element or a
      // nonzero mana_cost) -- an ordinary weapon's element is already null,
      // which every consumer (damage.js's ELEMENTS fallback, effects.js's
      // ELEMENT_EFFECTS lookup) already treats identically to the string
      // 'physical', so returning it unchanged is a no-op transformation.
      // This function runs on the hot path (every player swing, per the
      // design doc's own performance note), and ordinary non-magic weapons
      // are the overwhelming majority of attacks -- worth not allocating for.
      if (type.mana_cost || (type.element != null && type.element !== 'physical')) {
        // Important #3 fix (SOMET-245 final review, corrected per a
        // re-review of the first fix -- see the user-directed correction
        // below). damage used to be left at the weapon's own magic-tuned
        // value here -- only element/mana_cost were neutralized. Per the
        // conversion migration's own authoritative split (1714440167000's
        // header comment: element, mana_cost, damage, cooldown together ARE
        // "the complete spell" -- but that split is about what the STONE
        // carries, not about what the bare weapon resets to), that left an
        // unsocketed magic weapon hitting with its full spell damage at ZERO
        // mana cost: a permanent, un-costed power buff. This is also the
        // ONLY state any magic weapon acquired after the one-time conversion
        // migration ran (bought from a merchant, dropped by a creature) can
        // ever be in -- stone content-seeding is explicitly out of scope
        // this slice, so such a weapon can never be socketed at all.
        //
        // damage falls back to DEFAULT_WEAPON_NAME's ('dagger') own damage
        // -- not an invented number: it is the SAME reference weapon this
        // function already falls back to wholesale a few lines down when no
        // weapon is equipped at all, so "an unsocketed magic weapon hits
        // like the game's own baseline ordinary weapon" is the one baseline
        // already meaningful in this file, not a new one invented here.
        // `baseline` guards the pathological case of a catalog with no
        // default weapon at all (should never happen -- dagger is always
        // seeded): damage is left unchanged rather than crash.
        //
        // cooldown is DELIBERATELY NOT touched here (first version of this
        // fix wrongly replaced it with the dagger's cooldown too -- caught
        // by a re-review against the live catalog and corrected per an
        // explicit user decision). Attack rate is weapon mechanics, the same
        // category as kind/reach/range/arc_width/projectile_*/aoe_radius,
        // all of which already correctly stay the weapon's own a few lines
        // below and a few lines above (the spell-stone merge branch) --
        // cooldown should never have been grouped with the spell fields on
        // THIS (bare-weapon) side of the split, only on the stone's own
        // side. Overriding it to the dagger's fast melee rate made the
        // original bug WORSE, not better: it kept the weapon's own
        // long-range/AoE mechanics (kind/range/aoe_radius untouched) while
        // giving it the dagger's 0.3s attack rate -- e.g. a bare archmage
        // staff (800 range, 110 aoe_radius, originally 1.1s cooldown) would
        // have become a free, ammo-less AoE weapon firing 3.7x/s, strictly
        // dominating the bow. Leaving cooldown as `type.cooldown` (the
        // weapon's own real, original attack rate) means damage still drops
        // to baseline (still strictly worse than the pre-fix "free spell"
        // state) but the weapon's attack RATE is exactly what it always was
        // for a physical weapon of that kind.
        const baseline = itemTypes.get(defaultWeaponId);
        return {
          ...type,
          element: 'physical',
          mana_cost: 0,
          damage: baseline ? baseline.damage : type.damage,
        };
      }
      return type;
    }
  }
  return itemTypes.get(defaultWeaponId) || null;
}

// Equip with write-through. Clears any slot the instance currently occupies and,
// for a two-handed weapon, the off hand.
async function equip(pool, characterId, inv, itemTypes, itemId, slot, req = null) {
  // SOMET-478: the requirement gate rides inside canEquip, so it is refused
  // BEFORE the in-memory mutation below -- the SOMET-77 snapshot/write-through
  // ordering is entered only on a legal equip and is otherwise untouched.
  const check = canEquip(inv, itemTypes, itemId, slot, req);
  if (!check.ok) return check;

  const type = itemTypes.get(findItem(inv, itemId).typeId);
  const toClear = [];
  for (const s of SLOTS) if (inv.equipment[s] === itemId && s !== slot) toClear.push(s);
  if (slot === 'main_hand' && type.two_handed && inv.equipment.off_hand) toClear.push('off_hand');

  // SOMET-77: mutate in memory FIRST, then write through, rolling back if the
  // write fails. This used to run the other way round, and 3b-2a introduced
  // the problem by making equip a DB write-through at all -- 3b-1's version
  // was synchronous in memory and therefore atomic by construction.
  //
  // `ws.on('message', async ...)` does not await the previous handler, so an
  // `attack` arriving while these queries are in flight read the OLD
  // equipment and resolved with the previous weapon. The `toClear` loop was
  // worse than the final assignment: it interleaved a DELETE with a delete
  // per slot, so a concurrent read could see a partially-cleared paper doll
  // -- neither the old loadout nor the new one.
  //
  // In-memory state is the single thing every concurrent reader consults, so
  // it moves in ONE synchronous step with no await inside it. The snapshot is
  // taken before that step and restored wholesale on failure, rather than
  // trying to undo field by field.
  const before = { ...inv.equipment };
  for (const s of toClear) delete inv.equipment[s];
  inv.equipment[slot] = itemId;

  try {
    for (const s of toClear) {
      await pool.query('DELETE FROM player_equipment WHERE character_id = $1 AND slot = $2', [characterId, s]);
    }
    await pool.query(
      `INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)
       ON CONFLICT (character_id, slot) DO UPDATE SET item_id = $3`,
      [characterId, slot, itemId],
    );
  } catch (err) {
    // Restore the whole map, not just `slot`: a DELETE may have already
    // committed before the throw, so the in-memory copy can differ from the
    // pre-call state in more than one place.
    inv.equipment = before;
    throw err;
  }
  return { ok: true };
}

async function unequip(pool, characterId, inv, slot) {
  if (!SLOTS.includes(slot)) return { ok: false, reason: 'unknown slot' };
  // Same ordering as equip above, for the same reason (SOMET-77): a concurrent
  // `attack` must never resolve against a weapon the player has already taken
  // off. Restores only if the write fails.
  const had = inv.equipment[slot];
  delete inv.equipment[slot];
  try {
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1 AND slot = $2', [characterId, slot]);
  } catch (err) {
    if (had !== undefined) inv.equipment[slot] = had;
    throw err;
  }
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
    // hostType.kind is threaded through for the augment rule (SOMET-332):
    // an augment stone is melee-only until projectiles.js applies its packet.
    if (!stoneType || !hostType || !isCompatible(stoneKind(stoneType), hostType.category, hostType.kind)) {
      await client.query('ROLLBACK'); return { ok: false, reason: 'stone is not compatible with this item' };
    }

    await client.query('UPDATE stone_instances SET socketed_into_id = $1 WHERE player_item_id = $2',
      [hostPlayerItemId, stonePlayerItemId]);
    await client.query('COMMIT');

    const hostItem = findItem(inv, hostPlayerItemId);
    if (hostItem) {
      hostItem.socketedStoneTypeId = stoneTypeId;
      // Task 7: cache the stone's own instance id alongside its type,
      // mirroring loadInventory's hydration above -- see that comment.
      hostItem.socketedStoneItemId = stonePlayerItemId;
    }
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A genuine concurrent race: two requests both pass the plain
    // (non-locking) `occupant` pre-check above before either commits, and
    // the LOSING request's own UPDATE hits the partial unique index
    // (stone_instances_socketed_into_unique, 1714440166000) instead. That
    // index is the real backstop for this exact condition -- the pre-check
    // above is only a fast, non-authoritative path to the same reason,
    // read-only and unlocked (see this function's header comment on why:
    // it isn't part of the two locked, joined rows). Catch ONLY this
    // specific constraint violation (23505 + the exact constraint name, not
    // any other unique-violation this function might theoretically hit) and
    // report it the same graceful shape the pre-check already uses for the
    // identical logical condition, rather than letting a raw Postgres error
    // escape as an unhandled-exception-shaped failure for the loser of a
    // real race. Review finding (SOMET-245 Task 8 follow-up): confirmed via
    // stones_integration_db.test.js's own "concurrent-looking" stress case
    // that a genuine race on this UPDATE previously surfaced exactly this
    // raw error.
    if (err.code === '23505' && err.constraint === 'stone_instances_socketed_into_unique') {
      return { ok: false, reason: 'host already has a socketed stone' };
    }
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
    if (hostItem) {
      delete hostItem.socketedStoneTypeId;
      delete hostItem.socketedStoneItemId; // Task 7: clear alongside the type cache
    }

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
  DEFAULT_INVENTORY_SLOTS, usedSlots, capacityOf, freeSlots, hasFreeSlot,
};
