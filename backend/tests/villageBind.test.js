const test = require('node:test');
const assert = require('node:assert');
const { planBind } = require('../src/authority/server');

const villages = [{ id: 'v1', minRow: 5, minCol: 5, width: 8, height: 6, gateEdge: 'S', spawnX: 650, spawnY: 550 }];

test('planBind returns the village when the player enters an unbound village', () => {
  const v = planBind({ villages, gRow: 7, gCol: 7, boundVillageId: null });
  assert.equal(v && v.id, 'v1');
});

test('planBind returns null when already bound to the village at that point', () => {
  assert.equal(planBind({ villages, gRow: 7, gCol: 7, boundVillageId: 'v1' }), null);
});

test('planBind returns null when the player is outside every village', () => {
  assert.equal(planBind({ villages, gRow: 50, gCol: 50, boundVillageId: null }), null);
});

test('planBind rebinds when entering a different village than the current bind', () => {
  const two = [...villages, { id: 'v2', minRow: 20, minCol: 20, width: 5, height: 5, gateEdge: 'N', spawnX: 2200, spawnY: 2200 }];
  const v = planBind({ villages: two, gRow: 21, gCol: 21, boundVillageId: 'v1' });
  assert.equal(v && v.id, 'v2');
});
