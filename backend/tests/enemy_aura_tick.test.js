// backend/tests/enemy_aura_tick.test.js
// SOMET-606 (S4). The live tick: debuffs land on players, clear when they
// leave, and the DoT goes THROUGH applyDamageWithEffects -- resistances,
// defense, death via resolveDeaths -- never a raw hp subtraction.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim, NO_BUFF } = require('../src/authority/creatures.js');
const { World } = require('../src/authority/world.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const FROZEN = new Set(); // no active chunk: creatures neither move nor bite, auras still apply
const blight = (over = {}) => ({ name: 'blight', targetSide: 'enemies', radius: 300, damageMult: 1,
  defenseMult: 1, speedMult: 0.6, dotDps: 10, dotElement: 'fire', tickMs: 500, ...over });
function sim(auras, over = {}) {
  const s = new CreatureSim(stubMap(), () => 0.5);
  s.addCreatures([{ id: 'S', type: 'T', x: 0, y: 0, hp: 100, faction: 'hostile', auras, ...over }]);
  return s;
}
const player = (x = 50, over = {}) => ({ userId: 'u1', x, y: 0, width: 64, height: 64, hp: 100, maxHp: 100, mit: null, ...over });

test('inside: _buff carries the debuff; outside: the shared neutral buff', () => {
  const s = sim([blight()]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p._buff.speedMult, 0.6);
  p.x = 5000;
  s.tick(0.05, FROZEN, [p], 50);
  assert.equal(p._buff.speedMult, 1);
  assert.equal(p._buff.auras, undefined, 'NO_BUFF, not a stale debuff');
});

test('the debuff clears the tick after the source dies, and in an empty sim', () => {
  const s = sim([blight()]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);
  s.get('S').hp = 0;
  s.tick(0.05, FROZEN, [p], 50);
  assert.equal(p._buff.speedMult, 1);
  const empty = new CreatureSim(stubMap(), () => 0.5);
  p._buff = { speedMult: 0.5 }; // stale from another world
  empty.tick(0.05, FROZEN, [p], 0);
  assert.equal(p._buff.speedMult, 1);
});

test('DoT cadence: first charge on entry, then one per tick_ms -- 10 dps @ 500ms over 2s = 5 charges of 5', () => {
  const s = sim([blight()]);
  const p = player();
  for (let now = 0; now <= 2000; now += 50) s.tick(0.05, FROZEN, [p], now);
  // charges at 0, 500, 1000, 1500, 2000
  assert.equal(p.hp, 100 - 5 * 5);
});

test('two sources, two names: each charge takes ITS OWN source element and cadence, and they add', () => {
  // A: fire, 10 dps every 500ms (raw 5). B: ice, 4 dps every 1000ms (raw 4).
  // 50% FIRE resist only, so a swapped element changes both numbers; a
  // swapped cadence changes the charge count and the raw size.
  const s = new CreatureSim(stubMap(), () => 0.5);
  s.addCreatures([
    { id: 'A', type: 'T', x: 0, y: 0, hp: 100, faction: 'hostile',
      auras: [blight({ speedMult: 1, dotDps: 10, dotElement: 'fire', tickMs: 500 })] },
    { id: 'B', type: 'T', x: 40, y: 0, hp: 100, faction: 'hostile',
      auras: [blight({ name: 'frost', speedMult: 1, dotDps: 4, dotElement: 'ice', tickMs: 1000 })] },
  ]);
  const p = player(50, { mit: { defense: 0, resistances: { fire: 0.5 } } });
  const at = new Map();
  for (let now = 0; now <= 2000; now += 50) { s.tick(0.05, FROZEN, [p], now); at.set(now, p.hp); }
  // t=0: both on entry -> 2.5 (fire, halved) + 4 (ice, full)
  assert.equal(at.get(0), 100 - 2.5 - 4);
  assert.equal(at.get(450), 100 - 6.5, 'nothing between charges');
  // t=500: only A (500ms cadence) -> 2.5; attributed to A
  assert.equal(at.get(500), 100 - 6.5 - 2.5);
  // t=1000: both again
  assert.equal(at.get(1000), 100 - 9 - 6.5);
  // fire charges at 0/500/1000/1500/2000 (5 x 2.5), ice at 0/1000/2000 (3 x 4)
  assert.equal(p.hp, 100 - 5 * 2.5 - 3 * 4);
  assert.deepEqual([...p._auraDotAt.entries()].sort(), [['blight', 2500], ['frost', 3000]]);
});

test('two sources: a charge from only one name is attributed to that source', () => {
  const s = new CreatureSim(stubMap(), () => 0.5);
  s.addCreatures([
    { id: 'A', type: 'T', x: 0, y: 0, hp: 100, faction: 'hostile',
      auras: [blight({ dotDps: 10, dotElement: 'fire', tickMs: 500 })] },
    { id: 'B', type: 'T', x: 40, y: 0, hp: 100, faction: 'hostile',
      auras: [blight({ name: 'frost', dotDps: 4, dotElement: 'ice', tickMs: 1000 })] },
  ]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);
  s.tick(0.05, FROZEN, [p], 500); // only A is due
  assert.equal(p._provokedBy.by, 'c:A');
  s.tick(0.05, FROZEN, [p], 1000); // A then B -> B stamped last
  assert.equal(p._provokedBy.by, 'c:B');
});

test('DoT respects resistance: 50% fire resist halves every charge', () => {
  const s = sim([blight({ tickMs: 1000 })]);
  const p = player(50, { mit: { defense: 0, resistances: { fire: 0.5 } } });
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p.hp, 100 - 10 * 0.5);
});

test('DoT respects defense AND the aura\'s own defense debuff', () => {
  const s = sim([blight({ tickMs: 1000, defenseMult: 0.5 })]);
  const p = player(50, { mit: { defense: 4, resistances: {} } });
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p.hp, 100 - (10 - 4 * 0.5));
});

test('DoT is attributed to the source creature (provocation stamp), not left anonymous', () => {
  const s = sim([blight({ tickMs: 1000 })]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p._provokedBy.by, 'c:S');
});

test('no banking: time spent outside does not burst on re-entry; in-out-in inside tick_ms does not re-charge', () => {
  const s = sim([blight({ tickMs: 1000 })]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);            // charge 1
  p.x = 5000;
  for (let now = 50; now < 400; now += 50) s.tick(0.05, FROZEN, [p], now);
  p.x = 50;
  s.tick(0.05, FROZEN, [p], 400);          // back in before 1000: no charge
  assert.equal(p.hp, 90);
  p.x = 5000;
  for (let now = 450; now < 5000; now += 50) s.tick(0.05, FROZEN, [p], now);
  p.x = 50;
  s.tick(0.05, FROZEN, [p], 5000);          // one charge, not five
  assert.equal(p.hp, 80);
});

test('a player already at hp <= 0 is not charged', () => {
  const s = sim([blight({ tickMs: 1000 })]);
  const p = player(50, { hp: 0 });
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p.hp, 0);
});

test('NaN dps / NaN tick_ms never make the player immortal or charge NaN', () => {
  const s = sim([blight({ dotDps: NaN }), blight({ name: 'other', tickMs: NaN, dotDps: 10 })]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);
  assert.ok(Number.isFinite(p.hp), `hp ${p.hp}`);
  assert.equal(p.hp, 90, 'NaN tick_ms falls back to 1000: 10 dps -> 10');
});

test('a DoT kill reaches resolveDeaths exactly once (the one player-death path)', () => {
  const map = { ...stubMap(), getChunk: () => [] };
  const w = new World(map, new Map(), null);
  w.addPlayer('u1', { x: 50, y: 0 });
  w.creatures.addCreatures([{ id: 'S', type: 'T', x: 0, y: 0, hp: 100, faction: 'hostile',
    auras: [blight({ dotDps: 100000, tickMs: 1000 })] }]);
  w.tickCreatures(0.05, FROZEN);
  assert.deepEqual(w.resolveDeaths(), ['u1']);
  assert.deepEqual(w.resolveDeaths(), [], 'respawned at full, not re-reported');
});

test('Q5: resolveDeaths clears the aura debuff and the DoT clocks -- a respawned player carries nothing stale', () => {
  const map = { ...stubMap(), getChunk: () => [] };
  const w = new World(map, new Map(), null);
  w.addPlayer('u1', { x: 50, y: 0 });
  w.creatures.addCreatures([{ id: 'S', type: 'T', x: 0, y: 0, hp: 100, faction: 'hostile',
    auras: [blight({ dotDps: 100000, tickMs: 1000 })] }]);
  w.tickCreatures(0.05, FROZEN);
  const p = w.players.get('u1');
  assert.equal(p._buff.speedMult, 0.6, 'precondition: debuffed when killed');
  assert.ok(p._auraDotAt instanceof Map && p._auraDotAt.size === 1, 'precondition: a DoT clock existed');
  assert.deepEqual(w.resolveDeaths(), ['u1']);
  assert.equal(p._buff, NO_BUFF, 'respawned with the neutral buff, not the killer\'s debuff');
  assert.equal(p._auraDotAt, undefined, 'no DoT clock survives the death');
});
