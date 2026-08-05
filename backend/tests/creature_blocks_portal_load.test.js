const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

function stubMap() { return { chunkSize: 8 }; }

test('addCreatures carries blocks_portal_id through as blocksPortalId', () => {
  const sim = new CreatureSim(stubMap());
  sim.addCreatures([
    { id: 'c1', type: 'Orc', x: 100, y: 100, hp: 50, faction: 'guard', blocks_portal_id: 'link-1' },
    { id: 'c2', type: 'Slime', x: 200, y: 200, hp: 20, faction: 'hostile' }, // no column at all
  ]);
  assert.equal(sim.creatures.get('c1').blocksPortalId, 'link-1');
  assert.strictEqual(sim.creatures.get('c2').blocksPortalId, null,
    'a creature with no blocks_portal_id must not silently inherit a stale value or crash');
});
