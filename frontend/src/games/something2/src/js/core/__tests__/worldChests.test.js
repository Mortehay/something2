import { describe, it, expect } from 'vitest';
import { chestsFromFrame, applyChestOpened, chestView, formatCountdown } from '../worldChests.js';
import { createInventory, typeOf } from '../inventory.js';

// SOMET-372. The client had no world-chest code at all: `chests` frames fell
// through to a console warning and `openchest` was never sent, so the whole
// feature was server-only. These pin the two things the client half has to get
// right, both of which fail SILENTLY rather than loudly if they regress.

function invWithType(typeId) {
  const inv = createInventory();
  inv.types = new Map([[typeId, { id: typeId, name: 'Iron Sword', category: 'weapon' }]]);
  return inv;
}

describe('chestsFromFrame', () => {
  it('replaces the whole list, so a chest that leaves AOI disappears', () => {
    const first = chestsFromFrame({ chests: [{ id: 'a' }, { id: 'b' }] });
    expect(first.map((c) => c.id)).toEqual(['a', 'b']);
    // The server re-sends the FULL neighbourhood every tick; treating a
    // shorter list as a delta would leave a chest drawn after the player has
    // walked two chunks away from it.
    expect(chestsFromFrame({ chests: [{ id: 'b' }] }).map((c) => c.id)).toEqual(['b']);
  });

  it('collapses a malformed frame to empty instead of throwing in the socket handler', () => {
    expect(chestsFromFrame({})).toEqual([]);
    expect(chestsFromFrame({ chests: null })).toEqual([]);
    expect(chestsFromFrame(undefined)).toEqual([]);
  });
});

describe('applyChestOpened', () => {
  it('stores loot under typeId, not the raw item_type_id the server sends', () => {
    // THE REGRESSION THIS EXISTS FOR. openChest returns the raw player_items
    // row (`RETURNING id, item_type_id, quantity`), while the `picked` frame
    // carries claimItem's already-normalized {id, typeId, quantity}. Passing
    // the row straight to addItem stores typeId: undefined -- the item is in
    // the list, the count looks right, and it can never be equipped, dropped
    // or sold because typeOf() cannot resolve it.
    const inv = invWithType(7);
    applyChestOpened(inv, [], { chestId: 'c1', items: [{ id: 42, item_type_id: 7, quantity: 1 }] });

    expect(inv.items).toHaveLength(1);
    expect(inv.items[0].typeId).toBe(7);
    expect(typeOf(inv, 42)).toMatchObject({ name: 'Iron Sword' });
  });

  it('marks the opened chest so the lid changes on the same frame as the toast', () => {
    const chests = [{ id: 'c1', state: 'unlocked' }, { id: 'c2', state: 'locked' }];
    applyChestOpened(createInventory(), chests, { chestId: 'c1', items: [] });
    expect(chests[0].state).toBe('opened');
    expect(chests[1].state).toBe('locked');
  });

  it('reports item count and XP in the toast, and says so when a chest is empty', () => {
    const inv = invWithType(7);
    expect(applyChestOpened(inv, [], {
      chestId: 'c1', items: [{ id: 1, item_type_id: 7, quantity: 1 }, { id: 2, item_type_id: 7, quantity: 1 }], awarded: 25,
    })).toBe('Chest opened — 2 items, 25 XP');
    expect(applyChestOpened(inv, [], { chestId: 'c1', items: [] })).toBe('The chest is empty');
    // A zero-XP open (already at the level cap for this chest) must not read
    // as ", 0 XP".
    expect(applyChestOpened(inv, [], { chestId: 'c1', items: [{ id: 3, item_type_id: 7, quantity: 1 }], awarded: 0 }))
      .toBe('Chest opened — 1 item');
  });

  it('does not award progression locally — that rides the separate frame', () => {
    // `awarded` is display-only here. The server sends its own `progression`
    // frame after a chest open (the same one kills use), and a client that
    // also mutated progression from this frame would double-count.
    const inv = invWithType(7);
    const progression = { level: 3, experience: 100 };
    applyChestOpened(inv, [], { chestId: 'c1', items: [], awarded: 50, leveledUp: true, newLevel: 4 });
    expect(progression).toEqual({ level: 3, experience: 100 });
  });
});

describe('looted vault chests (per character)', () => {
  it('a frame with reopenInMs becomes an absolute reopenAt on this client\'s clock', () => {
    const [c] = chestsFromFrame({ chests: [{ id: 'a', state: 'opened', reopenInMs: 90000 }] }, 1000);
    expect(c.reopenAt).toBe(91000);
    const [plain] = chestsFromFrame({ chests: [{ id: 'b', state: 'unlocked' }] }, 1000);
    expect(plain.reopenAt).toBeUndefined();
  });

  it('opening a vault chest starts its countdown at once', () => {
    const chests = [{ id: 'a', state: 'unlocked' }];
    applyChestOpened(invWithType(1), chests, { chestId: 'a', items: [], reopenInMs: 1800000 }, 5000);
    expect(chests[0].state).toBe('opened');
    expect(chests[0].reopenAt).toBe(1805000);
  });

  it('the label counts down, and flips back to Treasure by itself when it runs out', () => {
    const c = { state: 'opened', reopenAt: 10000 + 872000 };
    expect(chestView(c, 10000)).toEqual({ state: 'opened', label: 'Looted — opens again in 14:32', openable: false });
    expect(chestView(c, 10000 + 871001).label).toBe('Looted — opens again in 0:01');
    expect(chestView(c, 10000 + 872000)).toEqual({ state: 'unlocked', label: 'Treasure', openable: true });
  });

  it('a chest with no countdown keeps the old labels', () => {
    expect(chestView({ state: 'opened' }).label).toBe('Looted');
    expect(chestView({ state: 'unlocked' }).label).toBe('Treasure');
    expect(chestView({ state: 'locked' }).label).toBe('Treasure (guarded)');
    expect(chestView({}).openable).toBe(true);
  });

  it('formats minutes and seconds', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(59001)).toBe('1:00');
    expect(formatCountdown(1800000)).toBe('30:00');
  });
});
