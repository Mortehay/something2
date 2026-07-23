// backend/tests/guardFactionLoad.test.js
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, loadCreatureTypes } = require('../src/authority/creatures');

const MAP = { chunkSize: 64, isWalkable: () => true, speedAt: () => 1 };

test('loadCreatureTypes selects faction and carries it onto each type', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [
    { id: 1, name: 'Slime', color: '#0f0', hp: 10, defense: 0, resistances: {}, faction: 'hostile' },
    { id: 2, name: 'Village Guard', color: '#3f6fb5', hp: 300, defense: 10, resistances: {}, faction: 'guard' },
  ] }; } };
  const { creatureTypes } = await loadCreatureTypes(pool);
  assert.match(sql, /faction/, 'SELECT must include faction — omitting it loads undefined and silently disables guards');
  assert.equal(creatureTypes.find((t) => t.name === 'Village Guard').faction, 'guard');
  assert.equal(creatureTypes.find((t) => t.name === 'Slime').faction, 'hostile');
});

test('addCreatures carries faction and home anchor, defaulting faction to hostile', () => {
  const sim = new CreatureSim(MAP, () => 0.5);
  sim.addCreatures([
    { id: 'a', type: 'Slime', x: 0, y: 0, hp: 10 },
    { id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 },
  ]);
  const a = sim.creatures.get('a'), g = sim.creatures.get('g');
  assert.equal(a.faction, 'hostile');
  assert.equal(a.home, null);
  assert.equal(g.faction, 'guard');
  assert.deepEqual(g.home, { x: 100, y: 100 });
  assert.equal(g._targetKind, null);
});
