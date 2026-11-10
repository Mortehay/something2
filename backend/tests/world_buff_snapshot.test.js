// Snapshot buffs carry castAt (the buff's startedAt) and, only for aura buffs, auraRadius.
// Pure in-memory: a World with a stub map, no DB.
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');

const stubMap = () => ({ chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] });

function worldWithBuffs() {
  const w = new World(stubMap(), new Map(), 1);
  w.addPlayer('u1', { x: 400, y: 400 });
  const p = w.getPlayer('u1');
  const mk = (id, startedAt, fx) => ({
    id, nameUk: id, nameEn: id, icon: 'i', iconColor: '#fff',
    startedAt, durationMs: 20000, expiresAt: startedAt + 20000, fx,
  });
  p.buffs = new Map([
    ['mag_immolation_aura', mk('mag_immolation_aura', 1000, { aura: { dps: 8, radius: 150, element: 'fire' } })],
    ['war_shield_wall', mk('war_shield_wall', 2500, { taken: 0.7 })],
  ]);
  return { w, p };
}

test('snapshot buffs carry castAt, and auraRadius only for aura buffs', () => {
  const { w } = worldWithBuffs();
  const buffs = w.snapshot().players[0].buffs;
  assert.equal(buffs.length, 2);
  const [imm, wall] = buffs;
  assert.equal(imm.castAt, 1000);
  assert.equal(imm.auraRadius, 150);
  assert.equal(wall.castAt, 2500);
  assert.equal('auraRadius' in wall, false, 'no auraRadius key when the buff has no aura');
});

test('auraRadius follows the live buff data', () => {
  const { w, p } = worldWithBuffs();
  p.buffs.get('mag_immolation_aura').fx.aura.radius = 200;
  assert.equal(w.snapshot().players[0].buffs[0].auraRadius, 200);
});

test('a non-positive aura radius is omitted', () => {
  const { w, p } = worldWithBuffs();
  p.buffs.get('mag_immolation_aura').fx.aura.radius = 0;
  assert.equal('auraRadius' in w.snapshot().players[0].buffs[0], false);
});
