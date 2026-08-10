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

// --- Arrival latch (SOMET-271) --------------------------------------------
//
// planTransition's cooldown only DELAYS a doorway; a player who arrives on one
// and stands still is transitioned as soon as it lapses. That is not a corner
// case: a character's saved position in a world is very often the doorway it
// walked out through, so both map fast travel and plain login-resume put it
// right back on the tile that sends it away again. Confirmed live before the
// fix -- a travel to Old Trailhead landed on its east doorway and the character
// was back in Windwatch Pass seconds later.
const { suppressArrivalDoorway } = require('../src/authority/server');

test('a player that just arrived on a doorway tile is not sent back through it', () => {
  const p = { _arrivalTile: '12,23' };
  assert.equal(suppressArrivalDoorway(p, '12,23'), true);
  // Still latched: standing still must keep suppressing, however many ticks
  // pass. A cooldown-style fix would pass the first assertion and fail here.
  assert.equal(suppressArrivalDoorway(p, '12,23'), true);
});

test('stepping off the arrival tile releases the latch for good', () => {
  const p = { _arrivalTile: '12,23' };
  assert.equal(suppressArrivalDoorway(p, '12,22'), false, 'moved: the doorway is live again');
  assert.equal(p._arrivalTile, null, 'the latch must clear, not merely stop matching');
  // And walking BACK onto it is a real crossing the player chose to make.
  assert.equal(suppressArrivalDoorway(p, '12,23'), false,
    'returning to the tile on foot must transition -- the latch is for arrivals, not a permanent block');
});

test('a player with no latch is unaffected', () => {
  // Every player reaching the doorway check the ordinary way (walking) has no
  // latch set. If this returned true, doorways would stop working entirely.
  assert.equal(suppressArrivalDoorway({}, '1,1'), false);
  assert.equal(suppressArrivalDoorway({ _arrivalTile: null }, '1,1'), false);
});
