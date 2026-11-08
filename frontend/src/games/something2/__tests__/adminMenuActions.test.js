import { describe, it, expect } from 'vitest';
import {
  parseWhole, goldAction, levelAction, xpAction, pointsAction, restoreAction, itemAction,
  isGearCategory, filterItems, logLine, GOLD_PRESETS, LEVEL_PRESETS, XP_PRESETS, RARITY_OPTIONS,
  MAX_GOLD_GRANT, MAX_ITEM_LEVEL, MAX_ITEM_QTY,
} from '../adminMenuActions.js';

describe('parseWhole', () => {
  it('reads plain, spaced, comma-grouped and exponent numbers', () => {
    expect(parseWhole('1000')).toBe(1000);
    expect(parseWhole(' 1,000,000 ')).toBe(1000000);
    expect(parseWhole('1_000')).toBe(1000);
    expect(parseWhole('1e6')).toBe(1000000);
    expect(parseWhole(42.9)).toBe(42);
    expect(parseWhole('7.8')).toBe(7);
  });
  it('is NaN for everything else', () => {
    for (const bad of ['', 'abc', '-5', '1x', null, undefined, NaN, Infinity, '0x10', '1e', {}]) {
      expect(Number.isNaN(parseWhole(bad)), String(bad)).toBe(true);
    }
  });
});

describe('grant builders', () => {
  it('build the wire action and its option', () => {
    expect(goldAction('1,000')).toEqual({ action: 'gold', opts: { amount: 1000 } });
    expect(levelAction('50')).toEqual({ action: 'level', opts: { level: 50 } });
    expect(xpAction(100000)).toEqual({ action: 'xp', opts: { amount: 100000 } });
    expect(pointsAction('10')).toEqual({ action: 'points', opts: { amount: 10 } });
    expect(restoreAction()).toEqual({ action: 'restore', opts: {} });
  });
  it('refuse zero, negatives and junk with a message that names the field', () => {
    expect(goldAction('0').error).toMatch(/Gold/);
    expect(levelAction('-1').error).toMatch(/Level/);
    expect(xpAction('lots').error).toMatch(/XP/);
    expect(pointsAction('').error).toMatch(/Passive points/);
  });
  it('refuse over the server limit instead of silently sending it', () => {
    expect(goldAction(MAX_GOLD_GRANT + 1).error).toMatch(/at most/);
    expect(goldAction(MAX_GOLD_GRANT).action).toBe('gold');
    expect(levelAction(10001).error).toMatch(/at most/);
  });
  it('every preset is itself a valid grant', () => {
    for (const n of GOLD_PRESETS) expect(goldAction(n).error).toBeUndefined();
    for (const n of LEVEL_PRESETS) expect(levelAction(n).error).toBeUndefined();
    for (const n of XP_PRESETS) expect(xpAction(n).error).toBeUndefined();
  });
});

describe('itemAction', () => {
  const ok = { itemTypeId: '12', rarity: 'foxy', level: '100', quantity: '1' };
  it('builds a drop', () => {
    expect(itemAction(ok)).toEqual({ action: 'item', opts: { itemTypeId: 12, rarity: 'foxy', level: 100, quantity: 1 } });
  });
  it('needs an item, a known rarity, and sane level and quantity', () => {
    expect(itemAction({ ...ok, itemTypeId: '' }).error).toMatch(/item/);
    expect(itemAction({}).error).toMatch(/item/);
    expect(itemAction({ ...ok, rarity: 'purple' }).error).toMatch(/rarity/);
    expect(itemAction({ ...ok, level: MAX_ITEM_LEVEL + 1 }).error).toMatch(/Item level/);
    expect(itemAction({ ...ok, quantity: MAX_ITEM_QTY + 1 }).error).toMatch(/Quantity/);
    expect(itemAction({ ...ok, quantity: 0 }).error).toMatch(/Quantity/);
  });
  it('offers exactly the four server rarities', () => {
    expect(RARITY_OPTIONS.map((o) => o.value)).toEqual(['white', 'blue', 'yellow', 'foxy']);
  });
});

describe('item picker helpers', () => {
  const items = [
    { id: 1, name: 'Iron Sword', category: 'weapon' },
    { id: 2, name: 'Health Potion', category: 'consumable' },
    { id: 3, name: 'Leather Cap', category: 'armor' },
  ];
  it('filters by name or category, case-insensitively', () => {
    expect(filterItems(items, 'sword').map((i) => i.id)).toEqual([1]);
    expect(filterItems(items, 'ARMOR').map((i) => i.id)).toEqual([3]);
    expect(filterItems(items, '  ').length).toBe(3);
    expect(filterItems(items, 'zzz')).toEqual([]);
  });
  it('caps the list and tolerates a missing catalog', () => {
    expect(filterItems(items, '', 2).length).toBe(2);
    expect(filterItems(undefined, 'x')).toEqual([]);
  });
  it('knows which categories roll as gear', () => {
    expect(isGearCategory('weapon')).toBe(true);
    expect(isGearCategory('armor')).toBe(true);
    expect(isGearCategory('consumable')).toBe(false);
  });
  it('logLine marks the outcome and survives a missing answer', () => {
    expect(logLine({ ok: true, text: '+5 gold' })).toEqual({ ok: true, text: '+5 gold' });
    expect(logLine({ ok: false, text: 'nope' }).ok).toBe(false);
    expect(logLine(null)).toEqual({ ok: false, text: 'no answer' });
  });
});
