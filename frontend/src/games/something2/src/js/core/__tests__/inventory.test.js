import { describe, it, expect } from 'vitest';
import { createInventory, applyJoined, applyEquipment, canEquipClient, typeOf, SLOTS } from '../inventory.js';

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
