// Client-side inventory mirror. The SERVER is authoritative for equip legality;
// canEquipClient only drives UI affordances (disabled slots), and must mirror
// the server rule in items.js canEquip.

export const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];
const HAND_SLOTS = ['main_hand', 'off_hand'];

export function createInventory() {
  return { types: new Map(), items: [], equipment: {} };
}

export function applyJoined(inv, msg) {
  inv.types = new Map((msg.itemTypes || []).map((t) => [t.id, t]));
  inv.items = (msg.items || []).map((i) => ({ id: i.id, typeId: i.typeId }));
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
  inv.items.push({ id: item.id, typeId: item.typeId });
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
