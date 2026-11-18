'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { xpForKill, xpToNext, levelForXp, xpFloor } = require('../src/services/playerStats.js');

// The strongest ordinary creature is level 140. Without a ceiling on the player's level in the
// difference, everyone at 145+ was 5+ levels past everything and earned 0: the last levels could
// not be reached by killing.
test('top-level creatures stay worth full XP to a player above them', () => {
  const atCap = xpForKill(140, 140);
  assert.ok(atCap > 0);
  for (const pl of [141, 145, 149, 150]) assert.equal(xpForKill(140, pl), atCap, `player level ${pl}`);
});

test('every level up to 150 can be reached with kills of the top creatures', () => {
  const kills = (level) => Math.ceil(xpToNext(level) / xpForKill(140, level));
  for (let l = 140; l < 150; l += 1) assert.ok(kills(l) > 0 && kills(l) < 200, `level ${l} takes ${kills(l)} kills`);
  assert.equal(levelForXp(xpFloor(150)), 150);
});

test('low creatures still pay nothing to a much stronger player (no new farming)', () => {
  assert.equal(xpForKill(1, 100), 0);
  assert.equal(xpForKill(50, 100), 0);
});
