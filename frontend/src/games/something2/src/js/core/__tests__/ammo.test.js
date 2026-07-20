import { describe, it, expect } from 'vitest';
import { ammoCount, hudAmmoCount, equippedAmmoTypeId, resolveAmmoHud, applyAmmoCount } from '../ammo.js';
import { createInventory, applyJoined, addItem, removeItem } from '../inventory.js';

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

describe('applyAmmoCount', () => {
  // Simulates the server's 'ammo' frame handler path: WorldAuthorityClient's
  // onAmmo calls this directly with the pushed {item_type_id, count}, and
  // the HUD must read back exactly that number afterward — the frame and the
  // HUD have to agree, not drift onto separate state.
  function withBow(items) {
    return inv({ items: [{ id: 20, typeId: 3, quantity: 1 }, ...items], equipment: { main_hand: 20 } });
  }

  it('makes the HUD read back exactly the pushed number, overriding every prior stack', () => {
    const i = withBow([
      { id: 10, typeId: 7, quantity: 12 },
      { id: 11, typeId: 7, quantity: 30 },
    ]);
    applyAmmoCount(i, 7, 41);
    expect(hudAmmoCount(i, 7)).toBe(41);
    expect(resolveAmmoHud(i).count).toBe(41);
  });

  it('is authoritative, not additive: it does not merge with the local total', () => {
    const i = withBow([{ id: 10, typeId: 7, quantity: 12 }]);
    applyAmmoCount(i, 7, 5); // server says 5, even though local math says 12 - 1 = 11
    expect(hudAmmoCount(i, 7)).toBe(5);
  });

  // THE DEFECT THIS REPLACED. The old implementation rewrote `items` around a
  // synthetic row with id `ammo:7`; that id reached the inventory panel's
  // click targets, so dropping a stack you had fired sent an id the server
  // had never issued and came back "drop failed". The HUD needs a number, and
  // it must not forge an inventory row to get one.
  it('never fabricates an inventory row: every item id stays one the server issued', () => {
    const i = withBow([
      { id: 10, typeId: 7, quantity: 12 },
      { id: 11, typeId: 7, quantity: 30 },
    ]);
    const idsBefore = i.items.map((it) => it.id);
    applyAmmoCount(i, 7, 41);
    expect(i.items.map((it) => it.id)).toEqual(idsBefore);
    for (const it of i.items) {
      expect(typeof it.id).toBe('number');
      expect(String(it.id)).not.toMatch(/^ammo:/);
    }
  });

  it('leaves the real stacks droppable: their ids survive a pushed count', () => {
    const i = withBow([{ id: 10, typeId: 7, quantity: 12 }]);
    applyAmmoCount(i, 7, 11);
    // What the panel would send on "drop selected" is still the real id.
    const stack = i.items.find((it) => it.typeId === 7);
    expect(stack).toBeTruthy();
    expect(stack.id).toBe(10);
  });

  it('leaves stacks of other types untouched', () => {
    const i = withBow([{ id: 10, typeId: 7, quantity: 12 }]);
    applyAmmoCount(i, 7, 9);
    expect(hudAmmoCount(i, 7)).toBe(9);
    expect(i.items.some((it) => it.id === 20)).toBe(true);
    expect(hudAmmoCount(i, 3)).toBe(1); // the bow itself, still counted off items
  });

  it('a count of 0 still shows on the HUD rather than vanishing the ammo line', () => {
    const i = withBow([{ id: 10, typeId: 7, quantity: 1 }]);
    applyAmmoCount(i, 7, 0);
    expect(resolveAmmoHud(i)).toEqual({ typeId: 7, name: 'arrow', count: 0 });
  });

  it('is a no-op for a null ammo type', () => {
    const i = withBow([{ id: 10, typeId: 7, quantity: 12 }]);
    applyAmmoCount(i, null, 999);
    expect(hudAmmoCount(i, 7)).toBe(12);
  });
});

// The invariant that makes splitting the count out of `items` safe: a pushed
// number is only ever a stand-in for stacks the client has not been re-sent.
// The moment a real snapshot describes that type again, the cached number has
// to go, or the HUD and the inventory panel would render different totals for
// the same arrows.
describe('pushed count vs. a fresh snapshot', () => {
  it('a join snapshot wins over a previously pushed count', () => {
    const i = inv({ items: [{ id: 20, typeId: 3, quantity: 1 }, { id: 10, typeId: 7, quantity: 5 }], equipment: { main_hand: 20 } });
    applyAmmoCount(i, 7, 4);
    expect(hudAmmoCount(i, 7)).toBe(4);

    // Rejoin: the server re-sends the whole inventory.
    applyJoined(i, {
      itemTypes: [ARROW, BOW, SWORD],
      items: [{ id: 20, typeId: 3, quantity: 1 }, { id: 30, typeId: 7, quantity: 9 }],
      equipment: { main_hand: 20 },
    });
    expect(hudAmmoCount(i, 7)).toBe(9);
    expect(ammoCount(i, 7)).toBe(9);
    expect(hudAmmoCount(i, 7)).toBe(ammoCount(i, 7));
  });

  it('a pickup of that ammo type discards the stale pushed count', () => {
    const i = inv({ items: [{ id: 20, typeId: 3, quantity: 1 }, { id: 10, typeId: 7, quantity: 5 }], equipment: { main_hand: 20 } });
    applyAmmoCount(i, 7, 4);
    addItem(i, { id: 31, typeId: 7, quantity: 6 });
    // 5 (the stack that was already there) + 6 (just picked up) — NOT 4, and
    // not 4 + 6 either. The item list is now the better source.
    expect(hudAmmoCount(i, 7)).toBe(11);
    expect(hudAmmoCount(i, 7)).toBe(ammoCount(i, 7));
  });

  it('a drop of that ammo type discards the stale pushed count', () => {
    const i = inv({
      items: [{ id: 20, typeId: 3, quantity: 1 }, { id: 10, typeId: 7, quantity: 5 }, { id: 11, typeId: 7, quantity: 2 }],
      equipment: { main_hand: 20 },
    });
    applyAmmoCount(i, 7, 6);
    removeItem(i, 10);
    expect(hudAmmoCount(i, 7)).toBe(2);
    expect(hudAmmoCount(i, 7)).toBe(ammoCount(i, 7));
  });

  it('a pickup of an UNRELATED type leaves the pushed ammo count alone', () => {
    const i = inv({ items: [{ id: 20, typeId: 3, quantity: 1 }, { id: 10, typeId: 7, quantity: 5 }], equipment: { main_hand: 20 } });
    applyAmmoCount(i, 7, 4);
    addItem(i, { id: 40, typeId: 1, quantity: 1 }); // a sword
    expect(hudAmmoCount(i, 7)).toBe(4);
  });
});

// D3: the server refusing a shot is authoritative information about how much
// ammo there is, not merely a cue to flash the HUD red. Game.js's onNoAmmo
// applies a count of 0 for the type named in the frame.
describe('noammo zeroes the displayed count', () => {
  it('a refusal drives the HUD to 0 for that type', () => {
    const i = inv({ items: [{ id: 20, typeId: 3, quantity: 1 }, { id: 10, typeId: 7, quantity: 1 }], equipment: { main_hand: 20 } });
    expect(resolveAmmoHud(i).count).toBe(1); // the stale "arrow: 1" the player used to be stuck on
    applyAmmoCount(i, 7, 0); // what onNoAmmo does with msg.item_type_id
    expect(resolveAmmoHud(i)).toEqual({ typeId: 7, name: 'arrow', count: 0 });
  });

  it('an older server that omits item_type_id changes nothing rather than zeroing the wrong type', () => {
    const i = inv({ items: [{ id: 20, typeId: 3, quantity: 1 }, { id: 10, typeId: 7, quantity: 3 }], equipment: { main_hand: 20 } });
    applyAmmoCount(i, undefined, 0);
    applyAmmoCount(i, null, 0);
    expect(resolveAmmoHud(i).count).toBe(3);
  });
});

describe('inventory quantity plumbing', () => {
  it('carries quantity through applyJoined (it used to be dropped)', () => {
    const i = inv({ items: [{ id: 10, typeId: 7, quantity: 25 }] });
    expect(i.items[0].quantity).toBe(25);
  });
});
