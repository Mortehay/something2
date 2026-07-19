import { describe, it, expect } from 'vitest';
import { ammoCount, equippedAmmoTypeId, resolveAmmoHud } from '../ammo.js';
import { createInventory, applyJoined } from '../inventory.js';

const ARROW = { id: 7, name: 'arrow', category: 'ammo', stackable: true, ammo_type_id: null };
const BOW = { id: 3, name: 'bow', category: 'weapon', kind: 'projectile', ammo_type_id: 7 };
const SWORD = { id: 1, name: 'sword', category: 'weapon', kind: 'melee', ammo_type_id: null };

function inv({ items = [], equipment = {} } = {}) {
  return applyJoined(createInventory(), {
    itemTypes: [ARROW, BOW, SWORD],
    items,
    equipment,
  });
}

describe('ammoCount', () => {
  it('sums quantity across EVERY stack of the type, not just the first', () => {
    // The whole point: stacks are never merged server-side, so a player can
    // hold several arrow rows at once.
    const i = inv({ items: [
      { id: 10, typeId: 7, quantity: 12 },
      { id: 11, typeId: 7, quantity: 30 },
      { id: 12, typeId: 7, quantity: 1 },
    ] });
    expect(ammoCount(i, 7)).toBe(43);
  });

  it('ignores stacks of other types', () => {
    const i = inv({ items: [
      { id: 10, typeId: 7, quantity: 5 },
      { id: 11, typeId: 9, quantity: 99 },
    ] });
    expect(ammoCount(i, 7)).toBe(5);
  });

  it('is 0 when the player holds none, and 0 for a null type', () => {
    expect(ammoCount(inv(), 7)).toBe(0);
    expect(ammoCount(inv({ items: [{ id: 1, typeId: 7, quantity: 3 }] }), null)).toBe(0);
  });

  it('treats a missing quantity as one unit rather than dropping the stack', () => {
    const i = inv({ items: [{ id: 10, typeId: 7 }, { id: 11, typeId: 7, quantity: 4 }] });
    expect(ammoCount(i, 7)).toBe(5);
  });
});

describe('equippedAmmoTypeId', () => {
  it('is the main-hand weapon ammo type', () => {
    const i = inv({ items: [{ id: 20, typeId: 3, quantity: 1 }], equipment: { main_hand: 20 } });
    expect(equippedAmmoTypeId(i)).toBe(7);
  });

  it('is null for an ammo-free weapon and for an empty main hand', () => {
    const melee = inv({ items: [{ id: 21, typeId: 1, quantity: 1 }], equipment: { main_hand: 21 } });
    expect(equippedAmmoTypeId(melee)).toBeNull();
    expect(equippedAmmoTypeId(inv())).toBeNull();
  });
});

describe('resolveAmmoHud', () => {
  it('names the ammo type and reports the summed count', () => {
    const i = inv({
      items: [
        { id: 20, typeId: 3, quantity: 1 },
        { id: 10, typeId: 7, quantity: 6 },
        { id: 11, typeId: 7, quantity: 6 },
      ],
      equipment: { main_hand: 20 },
    });
    expect(resolveAmmoHud(i)).toEqual({ typeId: 7, name: 'arrow', count: 12 });
  });

  it('still reports an empty stack (0) rather than hiding the line', () => {
    const i = inv({ items: [{ id: 20, typeId: 3, quantity: 1 }], equipment: { main_hand: 20 } });
    expect(resolveAmmoHud(i)).toEqual({ typeId: 7, name: 'arrow', count: 0 });
  });

  it('is null when the weapon needs no ammo, so the HUD draws nothing', () => {
    const i = inv({ items: [{ id: 21, typeId: 1, quantity: 1 }], equipment: { main_hand: 21 } });
    expect(resolveAmmoHud(i)).toBeNull();
  });
});

describe('inventory quantity plumbing', () => {
  it('carries quantity through applyJoined (it used to be dropped)', () => {
    const i = inv({ items: [{ id: 10, typeId: 7, quantity: 25 }] });
    expect(i.items[0].quantity).toBe(25);
  });
});
