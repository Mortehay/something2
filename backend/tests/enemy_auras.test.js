// SOMET-606 (S4). The enemies-side aura pass over PLAYERS. Spec §3.2: same
// aura -> the STRONGEST debuff, which is the SMALLEST multiplier (the allies
// pass uses Math.max -- copying it here is the defect this file exists for);
// different auras multiply; totals floored at 0.5.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEnemyAuras } = require('../src/authority/creatures.js');

const A = (over = {}) => ({ name: 'blight', targetSide: 'enemies', radius: 300,
  damageMult: 1, defenseMult: 1, speedMult: 1, dotDps: 0, dotElement: 'physical', tickMs: 1000, ...over });
const src = (id, x, auras, over = {}) => ({ id, x, y: 0, width: 48, height: 48, hp: 50, faction: 'hostile', auras, ...over });
const pl = (userId, x, over = {}) => ({ userId, x, y: 0, width: 64, height: 64, hp: 100, ...over });

test('a player inside an enemies aura gets its multipliers; outside gets nothing', () => {
  const out = applyEnemyAuras([src('S', 0, [A({ speedMult: 0.6, damageMult: 0.8, defenseMult: 0.7 })])],
    [pl('in', 100), pl('out', 900)]);
  assert.deepEqual([...out.keys()], ['in']);
  const d = out.get('in');
  assert.equal(d.speedMult, 0.6);
  assert.equal(d.damageMult, 0.8);
  assert.equal(d.defenseMult, 0.7);
  assert.deepEqual(d.auras.map((a) => [a.name, a.sourceId]), [['blight', 'S']]);
});

test('same aura from two sources: the SMALLEST multiplier wins, never compounding (not Math.max)', () => {
  const out = applyEnemyAuras([
    src('weak', 0, [A({ speedMult: 0.9 })]),
    src('strong', 10, [A({ speedMult: 0.6 })]),
  ], [pl('u', 50)]);
  assert.equal(out.get('u').speedMult, 0.6);
  assert.equal(out.get('u').auras.length, 1);
});

test('two DIFFERENT auras multiply, and the total is floored at 0.5 on every stat', () => {
  const out = applyEnemyAuras([
    src('a', 0, [A({ name: 'mire', speedMult: 0.6, damageMult: 0.6, defenseMult: 0.6 })]),
    src('b', 0, [A({ name: 'dread', speedMult: 0.6, damageMult: 0.9, defenseMult: 0.6 })]),
  ], [pl('u', 50)]);
  const d = out.get('u');
  assert.equal(d.speedMult, 0.5, '0.6 * 0.6 = 0.36 must floor to 0.5');
  assert.equal(d.defenseMult, 0.5);
  assert.ok(Math.abs(d.damageMult - 0.54) < 1e-12, `0.6*0.9 = 0.54 stays above the floor, got ${d.damageMult}`);
  assert.deepEqual(d.auras.map((a) => a.name), ['mire', 'dread']);
  assert.equal(d.auras[0].speedMult, 0.6, 'per-name entries are pre-floor');
});

test('an enemies aura can only hinder: a multiplier above 1 is treated as 1', () => {
  const out = applyEnemyAuras([src('S', 0, [A({ damageMult: 1.5, speedMult: 0.8 })])], [pl('u', 50)]);
  assert.equal(out.get('u').damageMult, 1);
  assert.equal(out.get('u').speedMult, 0.8);
});

test('DoT: per name the LARGEST dps wins and names its source', () => {
  const out = applyEnemyAuras([
    src('low', 0, [A({ dotDps: 2, dotElement: 'fire' })]),
    src('high', 0, [A({ dotDps: 7, dotElement: 'fire' })]),
  ], [pl('u', 50)]);
  const a = out.get('u').auras[0];
  assert.equal(a.dotDps, 7);
  assert.equal(a.sourceId, 'high');
  assert.equal(a.dotElement, 'fire');
});

for (const [label, over] of [
  ['a charmed pet', { charmOwnerUserId: 'u' }],
  ['a guard', { faction: 'guard' }],
  ['a wild creature', { faction: 'wild' }],
  ['a dead source', { hp: 0 }],
]) {
  test(`${label} never debuffs a player`, () => {
    const out = applyEnemyAuras([src('S', 0, [A({ speedMult: 0.5 })], over)], [pl('u', 50)]);
    assert.equal(out.size, 0);
  });
}

test('allies-side auras, radius 0 and dead/NaN-position players are ignored', () => {
  assert.equal(applyEnemyAuras([src('S', 0, [A({ targetSide: 'allies', speedMult: 0.5 })])], [pl('u', 50)]).size, 0);
  assert.equal(applyEnemyAuras([src('S', 0, [A({ radius: 0, speedMult: 0.5 })])], [pl('u', 50)]).size, 0);
  assert.equal(applyEnemyAuras([src('S', 0, [A({ speedMult: 0.5 })])], [pl('u', 50, { hp: 0 })]).size, 0);
  assert.equal(applyEnemyAuras([src('S', 0, [A({ speedMult: 0.5 })])], [pl('u', NaN)]).size, 0);
});

test('no players or no sources returns an empty Map', () => {
  assert.equal(applyEnemyAuras([src('S', 0, [A()])], []).size, 0);
  assert.equal(applyEnemyAuras([], [pl('u', 0)]).size, 0);
});

// -- Oracle. Written independently of the implementation (Maps, no scratch),
// so a typed-array slip (wrong stride, stale scratch from a previous call)
// shows up as a mismatch on some seed.
function oracle(creatures, players) {
  const out = new Map();
  for (const p of players) {
    if (!(p.hp > 0)) continue;
    const pcx = p.x + p.width / 2, pcy = p.y + p.height / 2;
    const byName = new Map();
    for (const c of creatures) {
      if (!(c.hp > 0) || c.faction !== 'hostile' || c.charmOwnerUserId != null || !Array.isArray(c.auras)) continue;
      for (const a of c.auras) {
        if (a.targetSide !== 'enemies' || !(a.radius > 0)) continue;
        const dx = c.x + c.width / 2 - pcx, dy = c.y + c.height / 2 - pcy;
        if (!(dx * dx + dy * dy <= a.radius * a.radius)) continue;
        const h = (v) => (v < 1 ? v : 1);
        const cur = byName.get(a.name);
        if (!cur) byName.set(a.name, { d: h(a.damageMult), f: h(a.defenseMult), s: h(a.speedMult), dps: a.dotDps > 0 ? a.dotDps : 0, src: c.id });
        else {
          cur.d = Math.min(cur.d, h(a.damageMult)); cur.f = Math.min(cur.f, h(a.defenseMult)); cur.s = Math.min(cur.s, h(a.speedMult));
          if (a.dotDps > cur.dps) { cur.dps = a.dotDps; cur.src = c.id; }
        }
      }
    }
    if (byName.size === 0) continue;
    let d = 1, f = 1, s = 1;
    for (const v of byName.values()) { d *= v.d; f *= v.f; s *= v.s; }
    out.set(p.userId, { d: Math.max(0.5, d), f: Math.max(0.5, f), s: Math.max(0.5, s),
      names: [...byName.keys()], dps: [...byName.values()].map((v) => v.dps), srcs: [...byName.values()].map((v) => v.src) });
  }
  return out;
}
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('matches the oracle over 1000 seeded layouts, called twice each (scratch reuse)', () => {
  const rnd = rngFrom(0x606);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  let debuffed = 0, multiName = 0, floored = 0;
  for (let i = 0; i < 1000; i++) {
    const creatures = []; const players = [];
    const span = 200 + rnd() * 600;
    for (let k = 0, n = Math.floor(rnd() * 30); k < n; k++) {
      const auras = [];
      for (let j = 0, m = Math.floor(rnd() * 3); j < m; j++) {
        auras.push(A({ name: pick(['mire', 'dread', 'blight']), targetSide: rnd() < 0.8 ? 'enemies' : 'allies',
          radius: rnd() < 0.1 ? 0 : rnd() * 400, damageMult: 0.3 + rnd(), defenseMult: 0.3 + rnd(),
          speedMult: 0.3 + rnd(), dotDps: rnd() < 0.5 ? 0 : rnd() * 10 }));
      }
      creatures.push({ id: `c${k}`, x: rnd() * span, y: rnd() * span, width: 48, height: 48,
        hp: rnd() < 0.1 ? 0 : 10, faction: pick(['hostile', 'hostile', 'guard']),
        charmOwnerUserId: rnd() < 0.05 ? 'u0' : null, auras });
    }
    for (let k = 0, n = 1 + Math.floor(rnd() * 8); k < n; k++) {
      players.push({ userId: `u${k}`, x: rnd() * span, y: rnd() * span, width: 64, height: 64, hp: rnd() < 0.1 ? 0 : 100 });
    }
    const exp = oracle(creatures, players);
    for (const pass of [1, 2]) {
      const got = applyEnemyAuras(creatures, players);
      assert.deepEqual([...got.keys()].sort(), [...exp.keys()].sort(), `layout ${i} pass ${pass}: ids`);
      for (const [id, e] of exp) {
        const g = got.get(id);
        for (const [k, ek] of [['damageMult', 'd'], ['defenseMult', 'f'], ['speedMult', 's']]) {
          assert.ok(Math.abs(g[k] - e[ek]) < 1e-12, `layout ${i} ${id}.${k} ${g[k]} vs ${e[ek]}`);
        }
        assert.deepEqual(g.auras.map((a) => a.name), e.names, `layout ${i} ${id} order`);
        assert.deepEqual(g.auras.map((a) => a.dotDps), e.dps);
        assert.deepEqual(g.auras.map((a) => a.sourceId), e.srcs);
      }
    }
    debuffed += exp.size;
    for (const e of exp.values()) { if (e.names.length >= 2) multiName++; if (e.s === 0.5) floored++; }
  }
  // Anti-vacuity: the generator must actually reach overlap and the floor.
  assert.ok(debuffed > 1500, `only ${debuffed} debuffed players`);
  assert.ok(multiName > 300, `only ${multiName} multi-name targets`);
  assert.ok(floored > 50, `only ${floored} floored targets`);
});
