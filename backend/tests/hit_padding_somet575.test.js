// SOMET-575: the padded hit radius is WIRED into both live melee paths --
// a creature swing scan (CreatureSim.meleeArcScan) and a PvP swing
// (World.attack). Unit tests on inArc alone stay green if a caller goes back
// to passing width/2, so these drive the callers.
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { CreatureSim } = require('../src/authority/creatures.js');
const { hitRadius } = require('../src/authority/weapons.js');

const openMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 1024 });

test('meleeArcScan reaches a 48px creature by its padded body edge', () => {
  const sim = new CreatureSim(openMap());
  const r = hitRadius({ width: 48 });
  assert.ok(r > 24, 'sanity: the creature radius is padded');
  // Centre placed so the PADDED edge is 2px inside reach 190 and the bare
  // 24px edge is outside it.
  const d = 190 + r - 2;
  assert.ok(d - 24 > 190, 'sanity: the unpadded edge would be out of reach');
  sim.creatures.set('c1', { id: 'c1', type: 'slime', x: 1000 + d - 24, y: 1000 - 24, width: 48, height: 48, hp: 10 });
  const { hit } = sim.meleeArcScan(1000, 1000, 1, 0, 190, 0.6);
  assert.deepEqual(hit, ['c1']);
});

test('a PvP swing reaches a 64px player by its padded body edge', () => {
  const weapon = {
    id: 1, name: 'test blade', category: 'weapon', kind: 'melee',
    damage: 5, cooldown: 0.5, reach: 55, arc_width: 0.5,
    mana_cost: 0, stamina_cost: 0, element: null, resistances: {},
  };
  const w = new World(openMap(), new Map([[1, weapon]]), 1);
  w.addPlayer('u1', { x: 0, y: 0 });
  const a = w.getPlayer('u1');
  const r = hitRadius(a);
  assert.ok(r > a.width / 2, 'sanity: the player radius is padded');
  const d = 55 + r - 2;
  assert.ok(d - a.width / 2 > 55, 'sanity: the unpadded edge would be out of reach');
  w.addPlayer('u2', { x: a.x + d, y: a.y });
  const b = w.getPlayer('u2');
  const hp0 = b.hp;
  w.attack('u1', 1, 0);
  assert.ok(b.hp < hp0, `swing at centre distance ${d} missed a player whose padded edge is inside reach`);
});
