const test = require('node:test');
const assert = require('node:assert');
const tc = require('../src/authority/teleportCast.js');

const player = (over = {}) => ({ x: 100, y: 100, hp: 85, mana: 115, usesLifeCost: false, stats: {}, ...over });

test('the cast takes exactly 2.5s: not ready a tick before, ready at the mark', () => {
  const p = player();
  tc.beginCast(p, 1000);
  assert.strictEqual(tc.checkCast(p, 3499), null);
  assert.ok(tc.isCasting(p));
  assert.strictEqual(tc.checkCast(p, 3500), 'ready');
  assert.ok(!tc.isCasting(p));
});

test('completion spends mana and issues a time-limited travel ticket', () => {
  const p = player();
  tc.beginCast(p, 0);
  assert.strictEqual(tc.checkCast(p, tc.CAST_MS), 'ready');
  assert.strictEqual(p.mana, 115 - tc.MANA_COST);
  assert.ok(tc.ticketValid(p, tc.CAST_MS + 1000));
  assert.ok(!tc.ticketValid(p, tc.CAST_MS + tc.TICKET_MS + 1));
  tc.consumeTicket(p);
  assert.ok(!tc.ticketValid(p, tc.CAST_MS + 1000));
});

test('no ticket exists until a cast completes', () => {
  assert.ok(!tc.ticketValid(player(), 5000));
});

test('moving interrupts the cast and costs nothing', () => {
  const p = player();
  tc.beginCast(p, 0);
  p.x += 50;
  assert.strictEqual(tc.checkCast(p, 1000), 'moved');
  assert.strictEqual(p.mana, 115);
  assert.ok(!tc.isCasting(p));
});

test('taking damage interrupts the cast; regeneration alone does not', () => {
  const p = player();
  tc.beginCast(p, 0);
  p.hp += 3; // regen
  assert.strictEqual(tc.checkCast(p, 500), null);
  p.hp -= 10; // hit
  assert.strictEqual(tc.checkCast(p, 1000), 'hurt');
  assert.ok(!tc.ticketValid(p, 1000));
});

test('cancelCast reports whether a cast was running', () => {
  const p = player();
  assert.strictEqual(tc.cancelCast(p), false);
  tc.beginCast(p, 0);
  assert.strictEqual(tc.cancelCast(p), true);
  assert.ok(!tc.isCasting(p));
});

test('not enough mana: refused up front, and re-checked at completion', () => {
  assert.strictEqual(tc.resourceRefusal(player({ mana: 5 })), 'mana');
  const p = player();
  tc.beginCast(p, 0);
  p.mana = 0; // drained while channelling
  assert.strictEqual(tc.checkCast(p, tc.CAST_MS), 'poor');
  assert.ok(!tc.ticketValid(p, tc.CAST_MS));
});

test('a Cultist pays in life, by the class rule, never in mana', () => {
  const p = player({ usesLifeCost: true, hp: 85, mana: 0, stats: { lifeCostMultiplier: 1 } });
  assert.strictEqual(tc.resourceRefusal(p), null);
  tc.beginCast(p, 0);
  assert.strictEqual(tc.checkCast(p, tc.CAST_MS), 'ready');
  assert.ok(p.hp < 85);
  assert.strictEqual(p.mana, 0);
});

test('the no-saved-point message is the one the design specifies', () => {
  assert.strictEqual(tc.NO_SAVED_POINT, 'Немає збереженої точки телепортації!');
});
