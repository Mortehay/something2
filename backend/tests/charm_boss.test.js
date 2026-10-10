// SOMET-609 (S9). A boss is never a pet. Without this a Druid could charm a
// low-level dungeon Elite: the in-memory charm lands, then the persistence
// UPDATE throws on the non-uuid `boss:` id -- a boss pet nothing can undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canBeCharmed } = require('../src/services/charm.js');

test('canBeCharmed refuses every boss tier and accepts an ordinary creature', () => {
  for (const bossTier of ['world', 'dungeon_end', 'dungeon_elite']) {
    assert.equal(canBeCharmed({ type: 'X', bossTier }), false, bossTier);
  }
  assert.equal(canBeCharmed({ type: 'Wolf', bossTier: null }), true);
  assert.equal(canBeCharmed(null), false);
});

test('the charm handler consults canBeCharmed before the budget read', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const handler = src.indexOf('charm(ws, msg) {');
  const pet = src.indexOf("already someone's pet", handler);
  const guard = src.indexOf('canBeCharmed(c)', handler);
  const budget = src.indexOf('charmBudget(', pet);
  assert.ok(handler !== -1 && pet !== -1 && guard !== -1 && budget !== -1, 'markers present');
  assert.ok(guard < budget, 'boss check must precede the budget/DB work');
  // The refusal must come before any in-memory charm state is written.
  const write = src.indexOf('charmOwnerUserId =', handler);
  assert.ok(write === -1 || guard < write, 'boss check must precede any charm state write');
});
