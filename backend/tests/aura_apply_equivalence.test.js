const test = require('node:test');
const assert = require('node:assert');
const { applyAuras } = require('../src/authority/creatures.js');

// SOMET-617: applyAuras was rewritten for speed (typed-array centres, faction
// buckets, reused scratch accumulators). The golden trace pins ONE scenario;
// this file pins the rest of the input space. `referenceApplyAuras` below is
// the pre-617 algorithm, kept verbatim and ONLY here, as the semantic oracle.
// If you change the stacking rules, change the reference in the same commit --
// never "fix" a mismatch by editing only one side.

function center(o) { return { x: o.x + o.width / 2, y: o.y + o.height / 2 }; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function referenceApplyAuras(creatures) {
  const buffs = new Map();
  const sources = [];
  for (const c of creatures) {
    if (!(c.hp > 0) || !Array.isArray(c.auras)) continue;
    for (const a of c.auras) if (a.targetSide === 'allies' && a.radius > 0) sources.push({ c, a });
  }
  if (sources.length === 0) return buffs;
  const perTarget = new Map();
  for (const { c: src, a } of sources) {
    const sc = center(src);
    const r2 = a.radius * a.radius;
    for (const other of creatures) {
      if (other === src || other.hp <= 0) continue;
      if (other.faction !== src.faction) continue;
      const oc = center(other);
      if (dist2(sc.x, sc.y, oc.x, oc.y) > r2) continue;
      let byName = perTarget.get(other.id);
      if (!byName) { byName = new Map(); perTarget.set(other.id, byName); }
      const cur = byName.get(a.name);
      if (!cur) {
        byName.set(a.name, { damageMult: a.damageMult, defenseMult: a.defenseMult, speedMult: a.speedMult });
      } else {
        cur.damageMult = Math.max(cur.damageMult, a.damageMult);
        cur.defenseMult = Math.max(cur.defenseMult, a.defenseMult);
        cur.speedMult = Math.max(cur.speedMult, a.speedMult);
      }
    }
  }
  for (const [id, byName] of perTarget) {
    let d = 1; let f = 1; let s = 1;
    for (const v of byName.values()) { d *= v.damageMult; f *= v.defenseMult; s *= v.speedMult; }
    buffs.set(id, { damageMult: d, defenseMult: f, speedMult: s });
  }
  return buffs;
}

// mulberry32: deterministic, so a failure reproduces from its seed.
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['pack_leader', 'war_drum', 'frenzy', 'bulwark'];
const FACTIONS = ['hostile', 'hostile', 'hostile', 'guard', 'wild'];

// Dense, overlapping layouts so most creatures sit inside several radii of
// several names: that is where max-within-name, multiply-across-names and the
// multiply ORDER (floats are not associative past two factors) all matter.
function layout(rnd) {
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const n = 1 + Math.floor(rnd() * 40);
  const span = 200 + rnd() * 800;
  const list = [];
  for (let i = 0; i < n; i++) {
    const hpRoll = rnd();
    const c = {
      // ~10% share an id with an earlier creature: the old pass keyed by id.
      id: i > 0 && rnd() < 0.1 ? list[Math.floor(rnd() * i)].id : `c${i}`,
      x: rnd() * span, y: rnd() * span,
      width: 16 + Math.floor(rnd() * 64), height: 16 + Math.floor(rnd() * 64),
      hp: hpRoll < 0.1 ? 0 : hpRoll < 0.15 ? -5 : 1 + Math.floor(rnd() * 100),
      faction: pick(FACTIONS),
    };
    if (rnd() < 0.5) {
      const k = Math.floor(rnd() * 4); // 0..3, so [] is exercised too
      c.auras = [];
      for (let j = 0; j < k; j++) {
        c.auras.push({
          name: pick(NAMES),
          targetSide: rnd() < 0.85 ? 'allies' : 'enemies',
          radius: rnd() < 0.1 ? 0 : rnd() * 400,
          damageMult: 0.5 + rnd() * 1.5,
          defenseMult: 0.5 + rnd() * 1.5,
          speedMult: 0.5 + rnd() * 1.5,
        });
      }
    }
    list.push(c);
  }
  // ~10% of layouts list one creature object twice (self-exclusion is by identity).
  if (rnd() < 0.1) list.push(list[Math.floor(rnd() * list.length)]);
  return list;
}

// Exact identity: same keys, same ITERATION ORDER, bit-identical values.
function assertSameBuffs(actual, expected, label) {
  assert.deepStrictEqual([...actual.keys()], [...expected.keys()], `${label}: buffed ids / order differ`);
  for (const [id, e] of expected) {
    const a = actual.get(id);
    for (const k of ['damageMult', 'defenseMult', 'speedMult']) {
      assert.ok(Object.is(a[k], e[k]), `${label}: ${id}.${k} = ${a[k]}, reference ${e[k]}`);
    }
  }
}

test('applyAuras matches the reference algorithm over 2000 seeded random layouts', () => {
  const rnd = rngFrom(0x617);
  let buffedTotal = 0; let multiNameTargets = 0; let sameNameOverlaps = 0;
  for (let i = 0; i < 2000; i++) {
    const list = layout(rnd);
    const expected = referenceApplyAuras(list);
    assertSameBuffs(applyAuras(list), expected, `layout #${i}`);
    // Called twice: the scratch buffers are reused across calls (ticks).
    assertSameBuffs(applyAuras(list), expected, `layout #${i} (second call)`);
    buffedTotal += expected.size;
  }
  // Anti-vacuity: the generator must actually produce the interesting cases,
  // or an always-empty pair of Maps would pass the loop above.
  const probe = rngFrom(0x617);
  for (let i = 0; i < 2000; i++) {
    const list = layout(probe);
    const hits = new Map(); // id -> Map(name -> count)
    for (const src of list) {
      if (!(src.hp > 0) || !Array.isArray(src.auras)) continue;
      for (const a of src.auras) {
        if (a.targetSide !== 'allies' || !(a.radius > 0)) continue;
        const sc = center(src);
        for (const o of list) {
          if (o === src || o.hp <= 0 || o.faction !== src.faction) continue;
          const oc = center(o);
          if (dist2(sc.x, sc.y, oc.x, oc.y) > a.radius * a.radius) continue;
          if (!hits.has(o.id)) hits.set(o.id, new Map());
          const m = hits.get(o.id);
          m.set(a.name, (m.get(a.name) || 0) + 1);
        }
      }
    }
    for (const m of hits.values()) {
      if (m.size >= 3) multiNameTargets++;
      for (const c of m.values()) if (c >= 2) sameNameOverlaps++;
    }
  }
  assert.ok(buffedTotal > 5000, `only ${buffedTotal} buffed targets generated`);
  assert.ok(multiNameTargets > 500, `only ${multiNameTargets} targets under >=3 different auras`);
  assert.ok(sameNameOverlaps > 500, `only ${sameNameOverlaps} same-name overlaps`);
});

test('applyAuras matches the reference on hand-picked edge inputs', () => {
  const A = (over) => ({ name: 'pack_leader', targetSide: 'allies', radius: 300,
    damageMult: 1.25, defenseMult: 1.2, speedMult: 1.1, ...over });
  const cases = {
    'NaN faction neither buffs nor is buffed': [
      { id: 'L', x: 0, y: 0, width: 10, height: 10, hp: 5, faction: NaN, auras: [A()] },
      { id: 'F', x: 5, y: 0, width: 10, height: 10, hp: 5, faction: NaN },
    ],
    'NaN hp target is still buffed (old check was hp <= 0)': [
      { id: 'L', x: 0, y: 0, width: 10, height: 10, hp: 5, faction: 'hostile', auras: [A()] },
      { id: 'F', x: 5, y: 0, width: 10, height: 10, hp: NaN, faction: 'hostile' },
    ],
    'NaN position target is still buffed (NaN > r2 is false)': [
      { id: 'L', x: 0, y: 0, width: 10, height: 10, hp: 5, faction: 'hostile', auras: [A()] },
      { id: 'F', x: undefined, y: 0, width: 10, height: 10, hp: 5, faction: 'hostile' },
    ],
    'string radius and multipliers coerce the same way': [
      { id: 'L', x: 0, y: 0, width: 10, height: 10, hp: 5, faction: 'hostile', auras: [A({ radius: '300', damageMult: '1.5' })] },
      { id: 'F', x: 5, y: 0, width: 10, height: 10, hp: 5, faction: 'hostile' },
    ],
    'no sources at all': [
      { id: 'F', x: 5, y: 0, width: 10, height: 10, hp: 5, faction: 'hostile', auras: [] },
    ],
  };
  for (const [label, list] of Object.entries(cases)) {
    assertSameBuffs(applyAuras(list), referenceApplyAuras(list), label);
  }
  // Non-array iterables were accepted by the old for-of.
  const set = new Set(cases['NaN hp target is still buffed (old check was hp <= 0)']);
  assertSameBuffs(applyAuras(set), referenceApplyAuras(set), 'Set input');
});
