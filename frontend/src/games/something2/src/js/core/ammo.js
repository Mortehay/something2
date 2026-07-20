// Ammo HUD resolution. Pure and canvas-free so it can be unit-tested under
// vitest's `node` env (there is no jsdom here — the render layer itself is
// only verified by the build plus a browser pass).

import { typeOf } from "./inventory.js";

// Total units of `ammoTypeId` derived from the item list — i.e. what the
// player's last real inventory snapshot says. `hudAmmoCount` below is what
// the HUD should render; this is the snapshot-derived half of it.
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

// Apply a server-pushed authoritative count for `ammoTypeId` — the 'ammo'
// frame after a successful shot, and the 'noammo' frame (count 0) when the
// server refuses one for lack of ammo.
//
// The server's number always wins: this does NOT merge with, add to, or diff
// against whatever the client currently believes.
//
// It is recorded in `inventory.ammoCounts`, NOT written into `inventory.items`.
// The previous version rebuilt the item list around a synthetic stack whose
// id was the string `ammo:<typeId>`, and that fabricated id propagated into
// the inventory panel's hit areas and back out over the wire — so after any
// successful shot, dropping your own arrows sent `{"type":"drop","itemId":
// "ammo:62"}` and the server answered "drop failed". The HUD needs a count;
// it must not forge an inventory row to get one. Keeping the two apart means
// no id the UI can act on is ever anything but a real server-issued instance.
//
// The cached number is dropped the instant a real snapshot describes that
// type's stacks again (see forgetAmmoCount in inventory.js), so the HUD total
// and the item-list total can never disagree.
//
// A previous bug in this project had the client mirror server-owned state
// after a send that never went out — this must only ever be called from a
// server frame handler, never from send().
export function applyAmmoCount(inventory, ammoTypeId, count) {
  if (!inventory || ammoTypeId == null) return;
  if (!inventory.ammoCounts) inventory.ammoCounts = new Map();
  const n = Number(count);
  inventory.ammoCounts.set(ammoTypeId, Number.isFinite(n) && n > 0 ? n : 0);
}

// The count the HUD should render: the server's pushed number when we hold
// one, otherwise the total summed off the item list. The pushed number is
// preferred only because it is strictly newer — a shot the server has
// resolved that the client has not been re-sent stacks for.
export function hudAmmoCount(inventory, ammoTypeId) {
  if (!inventory || ammoTypeId == null) return 0;
  const pushed = inventory.ammoCounts ? inventory.ammoCounts.get(ammoTypeId) : undefined;
  return pushed === undefined ? ammoCount(inventory, ammoTypeId) : pushed;
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
    count: hudAmmoCount(inventory, typeId),
  };
}
