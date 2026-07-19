// Ammo HUD resolution. Pure and canvas-free so it can be unit-tested under
// vitest's `node` env (there is no jsdom here — the render layer itself is
// only verified by the build plus a browser pass).

import { typeOf } from "./inventory.js";

// Total units of `ammoTypeId` the player holds.
//
// This MUST sum across every stack of that type, not read one row. Stacks are
// deliberately never merged server-side (see backend/src/authority/ammo.js:
// a player can hold two separate arrow stacks, and the spend path drains the
// oldest one first), so `items.find(...).quantity` reports only a fraction of
// what the player can actually shoot.
export function ammoCount(inventory, ammoTypeId) {
  if (!inventory || ammoTypeId == null) return 0;
  let total = 0;
  for (const it of inventory.items) {
    if (it.typeId !== ammoTypeId) continue;
    const q = Number(it.quantity);
    total += Number.isFinite(q) ? q : 0;
  }
  return total;
}

// The ammo type the equipped main-hand weapon consumes, or null when it needs
// none. `ammo_type_id == null` is the server's "this weapon is ammo-free"
// signal (all melee, staves, darts) — the HUD renders nothing at all then.
export function equippedAmmoTypeId(inventory) {
  if (!inventory) return null;
  const mainHandId = inventory.equipment ? inventory.equipment.main_hand : null;
  const weapon = mainHandId != null ? typeOf(inventory, mainHandId) : null;
  return weapon && weapon.ammo_type_id != null ? weapon.ammo_type_id : null;
}

// {typeId, name, count} for the HUD, or null when nothing should be drawn.
// A count of 0 still returns an object: "Arrows: 0" is exactly the state the
// player most needs to see.
export function resolveAmmoHud(inventory) {
  const typeId = equippedAmmoTypeId(inventory);
  if (typeId == null) return null;
  const type = inventory.types ? inventory.types.get(typeId) : null;
  return {
    typeId,
    name: type ? type.name : `#${typeId}`,
    count: ammoCount(inventory, typeId),
  };
}
