const test = require('node:test');
const assert = require('node:assert/strict');
// Taken before the module loads: its arrival counter is seeded from the clock.
const loadedAfter = Date.now();
const amber = require('../src/authority/amber.js');
const { setAmberConfig, getAmberConfig, seal, markReady, breakOut, isSealed, expire, amberView } = amber;

const cfg = (variants = []) => setAmberConfig({ maxMs: 30000, afterReadyMs: 10000, variants });

test('seal starts a 30 s hard cap', () => {
  cfg();
  const p = {};
  seal(p, 1000);
  assert.equal(isSealed(p, 30999), true);
  assert.equal(isSealed(p, 31000), false);
});

test('ready shortens to 10 s after ready', () => {
  cfg();
  const p = {};
  seal(p, 0);
  assert.equal(markReady(p, p.amber.arrival, 5000), true);
  assert.equal(p.amber.endAt, 15000);
  assert.equal(amberView(p, 6000).ms, 9000);
});

test('ready never extends past the hard cap', () => {
  cfg();
  const p = {};
  seal(p, 0);
  markReady(p, p.amber.arrival, 25000);
  assert.equal(p.amber.endAt, 30000);
});

test('second ready ignored', () => {
  cfg();
  const p = {};
  seal(p, 0);
  const a = p.amber.arrival;
  assert.equal(markReady(p, a, 1000), true);
  assert.equal(markReady(p, a, 2000), false);
  assert.equal(p.amber.endAt, 11000);
});

test('stale arrival id ignored', () => {
  cfg();
  const p = {};
  seal(p, 0);
  const a1 = p.amber.arrival;
  seal(p, 100);
  const a2 = p.amber.arrival;
  assert.notEqual(a1, a2);
  assert.equal(markReady(p, a1, 200), false);
  assert.equal(p.amber.readyAt, null);
});

test('break before ready ends the seal too', () => {
  cfg();
  const p = {};
  seal(p, 0);
  assert.equal(breakOut(p, p.amber.arrival, 100), true);
  assert.equal(isSealed(p, 100), false);
});

test('break after ready ends at once', () => {
  cfg();
  const p = {};
  seal(p, 0);
  const a = p.amber.arrival;
  markReady(p, a, 100);
  assert.equal(breakOut(p, a, 200), true);
  assert.equal(p.amber, null);
  assert.equal(isSealed(p, 200), false);
});

test('break with a stale arrival is refused', () => {
  cfg();
  const p = {};
  seal(p, 0);
  const a1 = p.amber.arrival;
  seal(p, 10);
  markReady(p, p.amber.arrival, 20);
  assert.equal(breakOut(p, a1, 30), false);
  assert.equal(isSealed(p, 30), true);
});

test('variant drawn from approved list', () => {
  setAmberConfig({ maxMs: 30000, afterReadyMs: 10000, variants: [2, 5, 9] });
  let p = {};
  seal(p, 0, () => 0.5);
  assert.equal(p.amber.variant, 5);
  p = {};
  seal(p, 0, () => 0.999);
  assert.equal(p.amber.variant, 9);
  cfg([]);
  p = {};
  seal(p, 0);
  assert.equal(p.amber.variant, null);
});

test('config is replaced whole and readable', () => {
  setAmberConfig({ maxMs: 1, afterReadyMs: 2, variants: [7] });
  assert.deepEqual(getAmberConfig(), { maxMs: 1, afterReadyMs: 2, variants: [7] });
  cfg();
});

test('expire clears once due', () => {
  cfg();
  const p = {};
  seal(p, 0);
  const end = p.amber.endAt;
  assert.equal(expire(p, end - 1), false);
  assert.ok(p.amber);
  assert.equal(expire(p, end), true);
  assert.equal(p.amber, null);
});

test('unsealed player', () => {
  assert.equal(isSealed({}, 0), false);
  assert.equal(amberView({}, 0), null);
  assert.equal(expire({}, 0), false);
});

test('arrival ids do not restart at 1 with the process (seeded from the clock)', () => {
  cfg();
  const p = {};
  seal(p, 0);
  const a1 = p.amber.arrival;
  seal(p, 0);
  assert.ok(Number.isSafeInteger(a1));
  assert.ok(a1 >= loadedAfter, `${a1} should be >= ${loadedAfter}`);
  assert.equal(p.amber.arrival, a1 + 1);
});
