import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as client from '../lootFilter.js';

// The client evaluator decides what is DRAWN; the server's decides what auto-loot may TAKE. They
// must agree on every item, or the picture would lie about what gets picked up. Both run over the
// same grid of rules and items here.
const require = createRequire(import.meta.url);
const server = require(path.resolve(__dirname, '../../../../../../../../backend/src/authority/lootFilter.js'));

const TYPES = new Map([
  [1, { category: 'weapon' }], [2, { category: 'armor' }], [3, { category: 'currency' }], [4, { category: 'stone' }],
]);
const typeOf = (id) => TYPES.get(id) || null;

const conds = [
  {}, { rarities: ['white'] }, { rarities: ['blue', 'foxy'] }, { categories: ['weapon'] }, { categories: ['currency'] },
  { typeIds: [2] }, { minLevel: 10 }, { maxLevel: 10 }, { minLevel: 5, maxLevel: 40 },
  { affixIds: [1, 2], affixMode: 'any' }, { affixIds: [1, 2], affixMode: 'all' },
  { rarities: ['yellow'], categories: ['armor'], minLevel: 20, affixIds: [3] },
];
const rules = conds.map((c, i) => server.sanitizeConfig({
  presets: [{ id: 'p', rules: [{ id: 'r', action: ['hide', 'show', 'emphasize'][i % 3], conditions: c }] }],
}).presets[0].rules[0]);
rules.forEach((r, i) => { r.id = `r${i}`; }); // distinct ids, so the first-match test can tell rules apart

const items = [];
for (const typeId of [1, 2, 3, 4, 99]) {
  for (const rarity of ['white', 'blue', 'yellow', 'foxy', undefined]) {
    for (const itemLevel of [1, 10, 11, 20, 40, 150, undefined]) {
      for (const affixIds of [[], [1], [2, 3], [1, 2, 3]]) items.push({ typeId, rarity, itemLevel, affixIds });
    }
  }
}

describe('client loot filter evaluator matches the server', () => {
  it('agrees on every rule x item in the grid', () => {
    let checked = 0;
    for (const rule of rules) {
      for (const item of items) {
        expect(client.ruleMatches(rule, item, typeOf), JSON.stringify([rule.conditions, item])).toBe(server.ruleMatches(rule, item, typeOf));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('agrees on the first-match verdict over the whole rule list', () => {
    for (const item of items) {
      const a = client.evaluate(rules, item, typeOf);
      const b = server.evaluate(rules, item, typeOf);
      expect(a && a.rule.id).toBe(b && b.rule.id);
      expect(a && a.action).toBe(b && b.action);
    }
  });
});
