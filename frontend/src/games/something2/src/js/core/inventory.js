// Client-side inventory mirror. The SERVER is authoritative for equip legality;
// canEquipClient only drives UI affordances (disabled slots), and must mirror
// the server rule in items.js canEquip.

export const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];
const HAND_SLOTS = ['main_hand', 'off_hand'];

function qtyOf(item) {
  const q = Number(item && item.quantity);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

// `ammoCounts` holds server-pushed authoritative ammo totals keyed by item
// type id, kept DELIBERATELY OUTSIDE `items`. An earlier version wrote the
// server's count back into `items` as a synthetic row with a fabricated id
// (`ammo:62`), and that id leaked straight into the inventory panel's click
// targets — so dropping a stack you had fired sent an id the server has never
// heard of and came back "drop failed". `items` holds real server instances
// and nothing else; anything the UI sends back on the wire therefore has an
// id the server issued. See core/ammo.js for how the two are reconciled.
export function createInventory() {
  return { types: new Map(), items: [], equipment: {}, ammoCounts: new Map() };
}

// Drop the server-pushed count cached for one item type.
//
// The rule this enforces: a pushed count is only ever a stand-in for a list
// of stacks the client has not been re-sent yet. The moment the server tells
// us something concrete about that type's stacks — a fresh join snapshot, a
// pickup, a drop — the item list is the better source and the cached number
// must go, or the HUD and the panel would render two different totals for the
// same arrows.
function forgetAmmoCount(inv, typeId) {
  if (inv.ammoCounts && typeId != null) inv.ammoCounts.delete(typeId);
}

export function applyJoined(inv, msg) {
  inv.types = new Map((msg.itemTypes || []).map((t) => [t.id, t]));
  // `quantity` is always sent and always a number (see authority/items.js);
  // it is carried through here because the ammo HUD sums it across stacks.
  // Defaulted to 1 rather than dropped so an older/partial frame degrades to
  // "one unit" instead of silently contributing 0 to that sum.
  inv.items = (msg.items || []).map((i) => ({ id: i.id, typeId: i.typeId, quantity: qtyOf(i) }));
  inv.equipment = { ...(msg.equipment || {}) };
  // A join snapshot is the whole truth about every stack the player holds, so
  // every cached ammo count is now stale by definition.
  inv.ammoCounts = new Map();
  return inv;
}

export function applyEquipment(inv, equipment) {
  inv.equipment = { ...(equipment || {}) };
  return inv;
}

export function typeOf(inv, itemId) {
  const item = inv.items.find((i) => i.id === itemId);
  return item ? inv.types.get(item.typeId) || null : null;
}

// Append a granted instance (from a pickup). Dedup by id: the server is the
// authority and may echo an instance the store already holds.
export function addItem(inv, item) {
  if (!item || item.id == null) return;
  if (inv.items.some((it) => it.id === item.id)) return;
  inv.items.push({ id: item.id, typeId: item.typeId, quantity: qtyOf(item) });
  forgetAmmoCount(inv, item.typeId);
}

export function removeItem(inv, itemId) {
  const gone = inv.items.find((it) => it.id === itemId);
  inv.items = inv.items.filter((it) => it.id !== itemId);
  if (gone) forgetAmmoCount(inv, gone.typeId);
}

export function canEquipClient(inv, itemId, slot) {
  if (!SLOTS.includes(slot)) return false;
  const type = typeOf(inv, itemId);
  if (!type) return false;
  if (type.category === 'weapon') {
    if (!HAND_SLOTS.includes(slot)) return false;
    if (slot === 'off_hand' && type.two_handed) return false;
    if (slot === 'off_hand') {
      const mh = typeOf(inv, inv.equipment.main_hand);
      if (mh && mh.two_handed) return false;
    }
    return true;
  }
  return type.slot === slot;
}
