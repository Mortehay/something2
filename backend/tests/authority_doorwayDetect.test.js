const test = require('node:test');
const assert = require('node:assert');
const { planTransition } = require('../src/authority/server');

const links = new Map([['E', { toWorldId: 'B', toWidth: 16, toHeight: 16 }]]);
const worldRow = { width: 24, height: 24 };

test('returns null when not on a doorway tile', () => {
  assert.equal(planTransition({ tileName: 'grass', gRow: 12, gCol: 23, worldRow, links, now: 1000, cdUntil: 0 }), null);
});

test('returns null when the edge has no link', () => {
  assert.equal(planTransition({ tileName: 'map_doorway', gRow: 0, gCol: 12, worldRow, links, now: 1000, cdUntil: 0 }), null); // N unlinked
});

test('returns null while cooldown is active', () => {
  assert.equal(planTransition({ tileName: 'map_doorway', gRow: 12, gCol: 23, worldRow, links, now: 500, cdUntil: 1000 }), null);
});

test('plans a transition to the linked world at the mirrored arrival', () => {
  const t = planTransition({ tileName: 'map_doorway', gRow: 12, gCol: 23, worldRow, links, now: 2000, cdUntil: 1000 });
  // crossing E => arrive at B's W doorway, one tile in: col 1, row midRow=8 (16/2)
  assert.equal(t.toWorldId, 'B');
  assert.deepEqual({ x: t.arriveX, y: t.arriveY }, { x: 1 * 100 + 18, y: 8 * 100 + 18 });
});
