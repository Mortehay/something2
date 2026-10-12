// SOMET-606 / SOMET-617 rule: the enemies pass reuses its scratch buffers --
// steady-state ticks of the same size allocate no new typed arrays. A version
// that builds `new Float64Array` per call fails the second assertion.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEnemyAuras, __enemyAuraScratchGrowths } = require('../src/authority/creatures.js');

test('steady-state calls never regrow the scratch buffers', () => {
  const creatures = [];
  for (let i = 0; i < 50; i++) {
    creatures.push({ id: `c${i}`, x: i * 20, y: 0, width: 48, height: 48, hp: 10, faction: 'hostile',
      auras: [{ name: i % 2 ? 'mire' : 'dread', targetSide: 'enemies', radius: 400, damageMult: 0.9,
        defenseMult: 0.9, speedMult: 0.9, dotDps: 1, dotElement: 'fire', tickMs: 1000 }] });
  }
  const players = Array.from({ length: 20 }, (_, k) => ({ userId: `u${k}`, x: k * 30, y: 0, width: 64, height: 64, hp: 100 }));
  applyEnemyAuras(creatures, players);           // sizes the scratch
  const before = __enemyAuraScratchGrowths();
  for (let t = 0; t < 500; t++) applyEnemyAuras(creatures, players);
  assert.equal(__enemyAuraScratchGrowths(), before);
  assert.ok(applyEnemyAuras(creatures, players).size === 20, 'anti-vacuity: every player debuffed');
});
