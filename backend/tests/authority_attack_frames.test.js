const test = require('node:test');
const assert = require('node:assert');
const { __test } = require('../src/authority/server.js');

// pushAttacks / drainAttacks are exported for test through server.js's __test
// bag; the broadcast wiring itself is exercised in the browser step.
const { pushAttacks, drainAttacks, MAX_PENDING_ATTACKS } = __test;

const A = (i) => ({ a: `p:u${i}`, v: 'sweep_arc', x: i, y: i, nx: 1, ny: 0, reach: 80, arc: 0.6, hit: false });

test('attacks accumulate between ticks rather than replacing each other', () => {
  // Two players swinging inside one tick interval must BOTH be drawn. The
  // detonation stash replaces; copying that here loses every swing but one.
  const entry = {};
  pushAttacks(entry, [A(1)]);
  pushAttacks(entry, [A(2)]);
  assert.equal(entry.pendingAttacks.length, 2);
  assert.deepEqual(entry.pendingAttacks.map((a) => a.a), ['p:u1', 'p:u2']);
});

test('drain returns the batch and clears the stash in one step', () => {
  const entry = {};
  pushAttacks(entry, [A(1), A(2)]);
  assert.equal(drainAttacks(entry).length, 2);
  // Cleared BEFORE the send loop: if send() throws partway through, a stale
  // batch must not survive to be re-drawn on the next tick.
  assert.equal(drainAttacks(entry).length, 0);
});

test('an empty drain returns an empty array, never null', () => {
  assert.deepEqual(drainAttacks({}), []);
});

test('the stash is capped', () => {
  // Accumulation has no natural bound; a world whose broadcast is wedged must
  // not grow this array without limit.
  const entry = {};
  for (let i = 0; i < MAX_PENDING_ATTACKS + 20; i++) pushAttacks(entry, [A(i)]);
  assert.equal(entry.pendingAttacks.length, MAX_PENDING_ATTACKS);
});

test('pushing nothing does not allocate a stash', () => {
  const entry = {};
  pushAttacks(entry, []);
  pushAttacks(entry, null);
  pushAttacks(entry, undefined);
  assert.equal(entry.pendingAttacks, undefined, 'an idle world must pay nothing');
});
