// Client-side inventory mirror. The SERVER is authoritative for equip legality;
// canEquipClient only drives UI affordances (disabled slots), and must mirror
// the server rule in items.js canEquip.

export const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];
const HAND_SLOTS = ['main_hand', 'off_hand'];

function qtyOf(item) {
  const q = Number(item && item.quantity);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

export function createInventory() {
  return { types: new Map(), items: [], equipment: {} };
}

export function applyJoined(inv, msg) {
  inv.types = new Map((msg.itemTypes || []).map((t) => [t.id, t]));
  // `quantity` is always sent and always a number (see authority/items.js);
  // it is carried through here because the ammo HUD sums it across stacks.
  // Defaulted to 1 rather than dropped so an older/partial frame degrades to
  // "one unit" instead of silently contributing 0 to that sum.
  inv.items = (msg.items || []).map((i) => ({ id: i.id, typeId: i.typeId, quantity: qtyOf(i) }));
  inv.equipment = { ...(msg.equipment || {}) };
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
}

export function removeItem(inv, itemId) {
  inv.items = inv.items.filter((it) => it.id !== itemId);
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
