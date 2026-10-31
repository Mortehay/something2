const { test } = require('node:test');
const assert = require('node:assert');
const { shortestRoute, questTarget, edgeExit, arrivalAfter } = require('../src/services/questRoute.js');

const W = (id, name, w = 96, h = 96) => [id, { id, name, width: w, height: h }];
const worlds = new Map([W('a', 'Alpha'), W('b', 'Beta'), W('c', 'Gamma'), W('z', 'Island')]);
// a --E--> b --E--> c   (and the mirror rows, as setLink writes them)
const links = [
  { from_world_id: 'a', to_world_id: 'b', edge: 'E' },
  { from_world_id: 'b', to_world_id: 'a', edge: 'W' },
  { from_world_id: 'b', to_world_id: 'c', edge: 'E' },
  { from_world_id: 'c', to_world_id: 'b', edge: 'W' },
];

test('doorway geometry: exit is mid-edge, arrival is one tile inside the opposite edge', () => {
  assert.deepStrictEqual(edgeExit(worlds.get('a'), 'E'), { x: 9550, y: 4850 });
  assert.deepStrictEqual(edgeExit(worlds.get('a'), 'N'), { x: 4850, y: 50 });
  assert.deepStrictEqual(arrivalAfter(worlds.get('b'), 'E'), { x: 150, y: 4850 });
  assert.strictEqual(edgeExit({ width: null, height: null }, 'E'), null, 'unbounded worlds have no doorways');
});

test('same world: straight line, first leg is the target itself', () => {
  const r = shortestRoute({ worlds, links, from: { worldId: 'a', x: 1000, y: 1000 }, targets: [{ worldId: 'a', x: 1000, y: 1500, label: 'T' }] });
  assert.strictEqual(r.sameWorld, true);
  assert.strictEqual(r.totalPx, 500);
  assert.deepStrictEqual(r.first, { x: 1000, y: 1500 });
  assert.strictEqual(r.restPx, 0);
});

test('one hop: walk to the doorway, then from the arrival to the target', () => {
  const r = shortestRoute({ worlds, links, from: { worldId: 'a', x: 4850, y: 4850 }, targets: [{ worldId: 'b', x: 550, y: 4850 }] });
  assert.strictEqual(r.sameWorld, false);
  assert.deepStrictEqual(r.first, { x: 9550, y: 4850 });
  assert.strictEqual(r.totalPx, 4700 + 400);
  assert.strictEqual(r.restPx, 400);
  assert.deepStrictEqual(r.hops, ['Alpha', 'Beta']);
});

test('the distance is the SUM across every map on the way, not the last map only', () => {
  const r = shortestRoute({ worlds, links, from: { worldId: 'a', x: 9550, y: 4850 }, targets: [{ worldId: 'c', x: 150, y: 4850 }] });
  // a: 0 to the E doorway; b: 150 -> 9550 across; c: arrive at 150, already there.
  assert.strictEqual(r.totalPx, 0 + 9400 + 0);
  assert.deepStrictEqual(r.hops, ['Alpha', 'Beta', 'Gamma']);
});

test('a portal link uses its own coordinates at both ends', () => {
  const portal = [{ from_world_id: 'a', to_world_id: 'z', edge: 'PORTAL', from_x: 1000, from_y: 1000, to_x: 200, to_y: 300 }];
  const r = shortestRoute({ worlds, links: portal, from: { worldId: 'a', x: 1000, y: 1400 }, targets: [{ worldId: 'z', x: 200, y: 700 }] });
  assert.strictEqual(r.totalPx, 400 + 400);
  assert.deepStrictEqual(r.first, { x: 1000, y: 1000 });
});

test('picks the cheaper of several targets; unreachable gives null', () => {
  const near = { worldId: 'b', x: 150, y: 4850 };
  const far = { worldId: 'c', x: 150, y: 4850 };
  const r = shortestRoute({ worlds, links, from: { worldId: 'a', x: 9550, y: 4850 }, targets: [far, near] });
  assert.strictEqual(r.target, near);
  assert.strictEqual(shortestRoute({ worlds, links, from: { worldId: 'a', x: 0, y: 0 }, targets: [{ worldId: 'z', x: 0, y: 0 }] }), null);
});

test('questTarget: accept, gather, turn_in, hunt, climb, done', () => {
  const q = { village_key: 'sunspire', target_count: 5, objective_type: 'kill', target_key: 'Slime' };
  assert.deepStrictEqual(questTarget(q, null), { mode: 'accept', specKeys: ['sunspire'] });
  assert.deepStrictEqual(questTarget(q, { status: 'active', progress_count: 2 }), { mode: 'hunt', kind: 'kill', key: 'Slime' });
  assert.deepStrictEqual(questTarget({ ...q, objective_type: 'floor', target_count: 25, target_key: 'spire' }, { status: 'active', progress_count: 4 }), { mode: 'climb', nextFloor: 5 });
  assert.strictEqual(questTarget({ ...q, objective_type: 'floor', target_count: 25 }, { status: 'active', progress_count: 25 }).mode, 'turn_in');
  assert.strictEqual(questTarget(q, { status: 'active', progress_count: 5 }).mode, 'turn_in');
  assert.strictEqual(questTarget(q, { status: 'completed', progress_count: 5 }).mode, 'done');
  const g = questTarget({ ...q, objective_type: 'interact', target_key: 'obelisk' }, { status: 'active', progress_count: 1 });
  assert.strictEqual(g.mode, 'gather');
  assert.deepStrictEqual(g.specKeys, ['ashen_oasis']);
  assert.strictEqual(g.nodeGroup, 'obelisk');
  assert.strictEqual(questTarget({ ...q, objective_type: 'choice', target_count: 1 }, { status: 'active', progress_count: 0 }).mode, 'turn_in');
});
