import { describe, it, expect } from 'vitest';
import { createInventory, applyJoined, applyEquipment, canEquipClient, typeOf, SLOTS, addItem, removeItem } from '../inventory.js';

const JOINED = {
  itemTypes: [
    { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false },
    { id: 2, name: 'halberd', category: 'weapon', slot: 'main_hand', two_handed: true },
    { id: 5, name: 'leather-vest', category: 'armor', slot: 'chest' },
  ],
  items: [{ id: 'i1', typeId: 1 }, { id: 'i2', typeId: 2 }, { id: 'i5', typeId: 5 }],
  equipment: { main_hand: 'i1' },
};

it('applyJoined populates the catalog, items and equipment', () => {
  const inv = createInventory();
  applyJoined(inv, JOINED);
  expect(inv.items).toHaveLength(3);
  expect(inv.equipment.main_hand).toBe('i1');
  expect(typeOf(inv, 'i5').name).toBe('leather-vest');
});

// SOMET-316. The mirror has to carry soulbound or no panel can mark a carried
// item bound — the gap that let the account chest label a stored item and not
// the identical carried one.
describe('soulbound on the client mirror', () => {
  it('carries the flag per instance through applyJoined', () => {
    const inv = createInventory();
    applyJoined(inv, {
      ...JOINED,
      // Same typeId, different provenance — a mapper that hardcoded either
      // value would pass a single-row fixture and still be wrong in game.
      items: [{ id: 'granted', typeId: 5, soulbound: true }, { id: 'looted', typeId: 5, soulbound: false }],
    });
    expect(inv.items.map((i) => [i.id, i.soulbound])).toEqual([['granted', true], ['looted', false]]);
  });

  it('carries the flag through addItem, the path a withdrawn item arrives on', () => {
    const inv = createInventory();
    applyJoined(inv, { ...JOINED, items: [] });
    addItem(inv, { id: 'w1', typeId: 5, quantity: 1, soulbound: true });
    expect(inv.items[0].soulbound).toBe(true);
  });

  // A frame from a server that predates this change must read as "not bound",
  // never undefined: a later `!== false` test would silently invert on it.
  it('normalizes a missing flag to false rather than undefined', () => {
    const inv = createInventory();
    applyJoined(inv, JOINED);
    expect(inv.items.every((i) => i.soulbound === false)).toBe(true);
    addItem(inv, { id: 'noflag', typeId: 5, quantity: 1 });
    expect(inv.items.find((i) => i.id === 'noflag').soulbound).toBe(false);
  });
});

it('applyEquipment replaces the equipment map', () => {
  const inv = createInventory();
  applyJoined(inv, JOINED);
  applyEquipment(inv, { chest: 'i5' });
  expect(inv.equipment).toEqual({ chest: 'i5' });
});

it('canEquipClient mirrors the server slot rules', () => {
  const inv = createInventory();
  applyJoined(inv, JOINED);
  expect(canEquipClient(inv, 'i1', 'main_hand')).toBe(true);
  expect(canEquipClient(inv, 'i1', 'off_hand')).toBe(true);
  expect(canEquipClient(inv, 'i5', 'main_hand')).toBe(false); // armor in a hand
  expect(canEquipClient(inv, 'i1', 'chest')).toBe(false);     // weapon in armor slot
  expect(canEquipClient(inv, 'i2', 'off_hand')).toBe(false);  // two-handed in off hand
});

it('canEquipClient blocks the off hand while a two-handed weapon is held', () => {
  const inv = createInventory();
  applyJoined(inv, JOINED);
  applyEquipment(inv, { main_hand: 'i2' }); // halberd
  expect(canEquipClient(inv, 'i1', 'off_hand')).toBe(false);
});

it('SLOTS matches the server paper-doll', () => {
  expect(SLOTS).toEqual(['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2']);
});

it('addItem appends and removeItem deletes by id', () => {
  const inv = createInventory();
  addItem(inv, { id: 'i1', typeId: 3 });
  expect(inv.items).toHaveLength(1);
  addItem(inv, { id: 'i1', typeId: 3 }); // dedup: server may echo
  expect(inv.items).toHaveLength(1);
  removeItem(inv, 'i1');
  expect(inv.items).toHaveLength(0);
  removeItem(inv, 'nope'); // must not throw
});

describe('capacity mirror', () => {
  it('mirrors the server capacity from the join frame', () => {
    const inv = createInventory();
    applyJoined(inv, { itemTypes: [], items: [], equipment: {}, inventorySlots: 96 });
    expect(inv.capacity).toBe(96);
  });

  it('leaves capacity null when the server sends none, rather than inventing one', () => {
    const inv = createInventory();
    applyJoined(inv, { itemTypes: [], items: [], equipment: {} });
    expect(inv.capacity).toBeNull();
  });
});

// SOMET-490. authority/items.js has sent `rarity` on every inventory item
// since SOMET-480 -- this mirror was silently discarding it, which is why the
// panel had no grade to colour with and why the ground glow's palette had no
// second consumer to agree with.
describe('rarity mirror', () => {
  it('carries the grade off the join frame', () => {
    const inv = createInventory();
    applyJoined(inv, { itemTypes: [], equipment: {}, items: [{ id: 'i1', typeId: 3, rarity: 'foxy' }] });
    expect(inv.items[0].rarity).toBe('foxy');
  });

  it('carries the grade off a granted instance', () => {
    const inv = createInventory();
    addItem(inv, { id: 'i1', typeId: 3, rarity: 'yellow' });
    expect(inv.items[0].rarity).toBe('yellow');
  });

  it('defaults a frame with no grade to white rather than undefined', () => {
    // An older server frame must read as "ordinary", not as a value a
    // `rarity !== "white"` test would treat as graded.
    const inv = createInventory();
    applyJoined(inv, { itemTypes: [], equipment: {}, items: [{ id: 'i1', typeId: 3 }] });
    addItem(inv, { id: 'i2', typeId: 3 });
    expect(inv.items.map((i) => i.rarity)).toEqual(['white', 'white']);
  });
});
