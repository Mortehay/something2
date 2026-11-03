import { describe, it, expect } from 'vitest';
import { createInventory, applyJoined, addItem } from '../inventory.js';

// The client's item normalizer SPREADS the server's object: a field the server starts
// sending reaches the panel by default. The old explicit field list dropped everything
// it did not name (affixes, item level, enchant level), and nothing ever failed.
describe('item normalisation keeps every server field', () => {
  const server = {
    id: 'i1', typeId: 3, quantity: 2, soulbound: true, rarity: 'blue',
    itemLevel: 40, enchantLevel: 6,
    affixes: [{ affixTypeId: 1, key: 'of_might', value: 7.5, effect: { type: 'stat', stat: 'strength' } }],
    someFutureField: 'x',
  };

  it('applyJoined', () => {
    const inv = createInventory();
    applyJoined(inv, { itemTypes: [], items: [server], equipment: {} });
    expect(inv.items[0]).toEqual(server);
  });

  it('addItem', () => {
    const inv = createInventory();
    addItem(inv, server);
    expect(inv.items[0]).toEqual(server);
  });

  it('still defaults what an old frame omits', () => {
    const inv = createInventory();
    applyJoined(inv, { itemTypes: [], items: [{ id: 'a', typeId: 1 }], equipment: {} });
    expect(inv.items[0]).toMatchObject({ quantity: 1, soulbound: false, rarity: 'white', enchantLevel: 0 });
    addItem(inv, { id: 'b', typeId: 1, enchantLevel: -4 });
    expect(inv.items[1].enchantLevel).toBe(0);
    addItem(inv, { id: 'c', typeId: 1, enchantLevel: 'lots' });
    expect(inv.items[2].enchantLevel).toBe(0);
  });
});
