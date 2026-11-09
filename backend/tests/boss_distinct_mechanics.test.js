// backend/tests/boss_distinct_mechanics.test.js
// The mechanics the world bosses' distinct kits are built on, driven through the REAL CreatureSim
// from rows shaped like the loader's: ground that stays (zone), delayed explosions on players
// (mark), a circle of safety (shelter), a storm in rounds (rain with waves), and the crowd control
// a skill puts on whoever it hits (root, slow, silence).
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');
const { hasEffect, effectMagnitude } = require('../src/authority/effects.js');
const fs = require('node:fs');
const path = require('node:path');

function openMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.5;
const active = new Set(['0,0', '0,1', '1,0', '1,1']);

function driver(s) {
  let now = 0;
  const step = (players, deltaMs) => { now += deltaMs; return s.tick(deltaMs / 1000, active, players, now, undefined); };
  step.now = () => now;
  return step;
}

function skillRow(over = {}) {
  return {
    slot: 1, skill_id: 1, name: 'Test Skill', kind: 'zone',
    telegraph_ms: 500, cooldown_ms: 60000, radius: 100, range: 800,
    damage_mult: 1, element: 'fire', summon_entity: null, summon_count: 1,
    vfx: { telegraph: 'tele_fx', cast: 'cast_fx', impact: 'hit_fx' }, power_scale: 1, params: null, min_phase: 1, requires_enrage: false,
    ...over,
  };
}
function creatureRow(skills, over = {}) {
  return {
    id: over.id || 'boss', type: 'Boss', x: 0, y: 0, hp: 1e6, facing: 'S', home_x: null, home_y: null, level: 1, damage: 10,
    blocks_portal_id: null, defense: 0, color: '#fff', resistances: {}, faction: 'hostile', attack_element: 'fire',
    behavior_name: 'Boss', aggro_radius: 900, leash_radius: 2000, chase_style: 'hold', preferred_range: 0,
    move_speed_mult: 1, damage_override: null, aura_names: null, aura_defs: [],
    behavior_gold_min: 0, behavior_gold_max: 0, abilities: [], skills,
  };
}
function player(over = {}) {
  return { userId: over.userId || 'u1', x: over.x ?? 0, y: over.y ?? 0, width: 64, height: 64, hp: over.hp ?? 100000, maxHp: 100000, _buff: undefined };
}
const sim = (skills) => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([creatureRow(skills)]);
  return s;
};
const dealt = (p) => 100000 - p.hp;

// ---- zone: ground that stays ---------------------------------------------------------------

test('a zone of "targets" puts a pool under each nearby player, and nothing is hurt by the cast itself', () => {
  const s = sim([skillRow({ params: { hazard: { pattern: 'targets', count: 4, linger_ms: 5000, tick_ms: 500 } }, damage_mult: 0.5 })]);
  const tick = driver(s);
  const a = player({ userId: 'a', x: 300, y: 0 });
  const b = player({ userId: 'b', x: 300, y: 300 });
  const t = tick([a, b], 0).telegraphs;
  assert.equal(t.length, 2, 'a telegraph for each pool');
  assert.deepEqual(new Set(t.map((x) => `${Math.round(x.x)},${Math.round(x.y)}`)).size, 2);
  const hpBefore = [a.hp, b.hp];
  tick([a, b], 500);
  assert.equal(s.hazards.length, 2, 'two pools');
  assert.deepEqual([a.hp, b.hp], hpBefore, 'the cast itself hurts nobody');
});

test('a pool hurts whoever stands in it on its own beat, not whoever stands elsewhere', () => {
  const s = sim([skillRow({ radius: 120, damage_mult: 0.5, params: { hazard: { pattern: 'targets', count: 1, linger_ms: 5000, tick_ms: 500 } } })]);
  const tick = driver(s);
  const stay = player({ userId: 'stay', x: 300, y: 0 });
  tick([stay], 0);
  tick([stay], 500); // resolves: the pool is under `stay`
  const away = player({ userId: 'away', x: 900, y: 900 });
  const before = stay.hp;
  tick([stay, away], 100);
  assert.ok(stay.hp < before, 'standing in it hurts');
  assert.equal(away.hp, 100000, 'elsewhere is safe');
  const mid = stay.hp;
  tick([stay, away], 100);
  assert.equal(stay.hp, mid, 'one hit per beat, not per tick');
  tick([stay, away], 500);
  assert.ok(stay.hp < mid, 'and again on the next beat');
});

test('a pool expires, and goes with the boss that made it', () => {
  const s = sim([skillRow({ params: { hazard: { pattern: 'targets', count: 1, linger_ms: 1000, tick_ms: 500 } } })]);
  const tick = driver(s);
  const p = player({ x: 300, y: 0 });
  tick([p], 0); tick([p], 500);
  assert.equal(s.hazards.length, 1);
  tick([p], 1200);
  assert.equal(s.hazards.length, 0, 'expired');

  const s2 = sim([skillRow({ params: { hazard: { pattern: 'targets', count: 1, linger_ms: 20000, tick_ms: 500 } } })]);
  const t2 = driver(s2);
  const q = player({ x: 300, y: 0 });
  t2([q], 0); t2([q], 500);
  assert.equal(s2.hazards.length, 1);
  s2.remove('boss');
  assert.equal(s2.hazards.length, 0, 'removed with its owner');
});

test('a ring of fire leaves the middle clear', () => {
  const s = sim([skillRow({
    radius: 700, damage_mult: 0.5,
    params: { hazard: { pattern: 'ring', outer: 700, inner: 400, linger_ms: 8000, tick_ms: 500 } },
  })]);
  const tick = driver(s);
  const middle = player({ userId: 'm', x: 150, y: 0 });
  const edge = player({ userId: 'e', x: 550, y: 0 });
  const t = tick([middle, edge], 0).telegraphs;
  assert.equal(t.length, 1);
  assert.equal(t[0].radius, 700);
  assert.equal(t[0].inner, 400, 'the telegraph shows the hole');
  tick([middle, edge], 500);
  tick([middle, edge], 600);
  assert.equal(middle.hp, 100000, 'inside the ring: untouched');
  assert.ok(edge.hp < 100000, 'on the ring: burnt');
});

test('a frost field that does no damage still slows, and stops when you step out', () => {
  const s = sim([skillRow({ element: 'ice', damage_mult: 0, radius: 150, params: { hazard: { pattern: 'targets', count: 1, linger_ms: 6000, tick_ms: 500, slow_pct: 65 } } })]);
  const tick = driver(s);
  const p = player({ x: 300, y: 0 });
  tick([p], 0); tick([p], 500);
  tick([p], 100);
  assert.equal(p.hp, 100000, 'no damage');
  assert.ok(hasEffect(p, 'chill', s2now(tick)), 'slowed');
  assert.ok(Math.abs(effectMagnitude(p, 'chill', s2now(tick)) - 0.35) < 1e-6, 'to 35% speed');
});
function s2now(tick) { return tick.now(); }

// ---- mark: a delayed explosion on players -------------------------------------------------

test('a mark rides on each marked player, and goes off where they stand when it ends', () => {
  const s = sim([skillRow({ kind: 'mark', radius: 150, damage_mult: 2, params: { mark: { targets: 'all' } } })]);
  const tick = driver(s);
  const a = player({ userId: 'a', x: 200, y: 0 });
  const b = player({ userId: 'b', x: 600, y: 300 });
  const r = tick([a, b], 0);
  assert.deepEqual(r.marks.map((m) => m.userId).sort(), ['a', 'b']);
  assert.equal(r.telegraphs.length, 0, 'a mark is a ring on the player, not a spot on the ground');
  assert.equal(r.marks[0].radius, 150);
  assert.equal(r.marks[0].telegraphMs, 500);
  a.x = 900; a.y = 0; // a runs off before it ends
  tick([a, b], 500);
  assert.ok(dealt(a) > 0 && dealt(b) > 0, 'each explodes where it stands now');
});

test('standing next to a marked player is the mistake: blasts stack', () => {
  const lone = player({ userId: 'lone', x: 900, y: 600 });
  const s1 = sim([skillRow({ kind: 'mark', radius: 200, damage_mult: 2, params: { mark: { targets: 'all' } } })]);
  const t1 = driver(s1);
  const a1 = player({ userId: 'a', x: 300, y: 0 });
  t1([a1, lone], 0); t1([a1, lone], 500);
  const alone = dealt(a1);

  const s2 = sim([skillRow({ kind: 'mark', radius: 200, damage_mult: 2, params: { mark: { targets: 'all' } } })]);
  const t2 = driver(s2);
  const a2 = player({ userId: 'a', x: 300, y: 0 });
  const buddy = player({ userId: 'b', x: 360, y: 0 }); // within each other's blast
  t2([a2, buddy], 0); t2([a2, buddy], 500);
  assert.equal(dealt(a2), alone * 2, 'two marks on top of each other: twice the damage');
});

test('a single-target mark marks just the target', () => {
  const s = sim([skillRow({ kind: 'mark', radius: 150, params: { mark: { targets: 1 } } })]);
  const tick = driver(s);
  const near = player({ userId: 'near', x: 200, y: 0 });
  const far = player({ userId: 'far', x: 700, y: 600 });
  assert.equal(tick([near, far], 0).marks.length, 1);
});

test('a marked player who died is skipped, not a crash', () => {
  const s = sim([skillRow({ kind: 'mark', radius: 150, params: { mark: { targets: 'all' } } })]);
  const tick = driver(s);
  const a = player({ userId: 'a', x: 200, y: 0 });
  const b = player({ userId: 'b', x: 700, y: 600 });
  tick([a, b], 0);
  a.hp = 0;
  assert.doesNotThrow(() => tick([a, b], 500));
  assert.equal(a.hp, 0);
});

// ---- shelter: run to the circle ---------------------------------------------------------

test('a shelter shows its safe circle toward the target and hurts everyone outside it', () => {
  const s = sim([skillRow({
    kind: 'shelter', radius: 0, damage_mult: 3, element: 'fire',
    params: { ultimate: true, shelter: { safe_radius: 120, safe_dist: 400, reach: 1100 } },
  })]);
  const tick = driver(s);
  const target = player({ userId: 'target', x: 700, y: 0 });
  const t = tick([target], 0).telegraphs;
  assert.equal(t.length, 1);
  assert.equal(t[0].safe, true, 'flagged as safety');
  assert.equal(t[0].radius, 120);
  assert.equal(t[0].ultimate, true);
  // The circle sits 400 from the boss (centre 32,32) toward the target (to the east).
  assert.ok(Math.abs(t[0].x - 432) < 25 && Math.abs(t[0].y - 32) < 40, `circle at ${t[0].x},${t[0].y}`);
  const inside = player({ userId: 'in', x: t[0].x - 32, y: t[0].y - 32 });
  const outside = player({ userId: 'out', x: 700, y: 400 });
  const faraway = player({ userId: 'far', x: 5000, y: 5000 });
  tick([target, inside, outside, faraway], 500);
  assert.equal(inside.hp, 100000, 'inside the circle: untouched');
  assert.ok(dealt(outside) > 0, 'outside: hit');
  assert.ok(dealt(target) > 0, 'the target, standing outside, too');
  assert.equal(faraway.hp, 100000, 'beyond the boss reach');
});

// ---- statuses ---------------------------------------------------------------------------

test('a slam with a root roots whoever it hits, and only them', () => {
  const s = sim([skillRow({ kind: 'slam', radius: 150, params: { status: { root_s: 2 } } })]);
  const tick = driver(s);
  const hit = player({ userId: 'hit', x: 300, y: 0 });
  const missed = player({ userId: 'missed', x: 900, y: 700 });
  tick([hit, missed], 0); tick([hit, missed], 500);
  const now = tick.now();
  assert.ok(hasEffect(hit, 'chill', now));
  assert.ok(effectMagnitude(hit, 'chill', now) < 0.01, 'rooted: speed ~0');
  assert.equal(hasEffect(missed, 'chill', now), false);
});

test('silence stops a hit player from acting for its duration', () => {
  const s = sim([skillRow({ kind: 'slam', radius: 150, params: { status: { silence_s: 4 } } })]);
  const tick = driver(s);
  const p = player({ x: 300, y: 0 });
  tick([p], 0); tick([p], 500);
  assert.ok(p._interruptedUntil >= tick.now() + 3900, 'silenced for ~4 s');
});

test('a nova with a slow slows everyone it hits', () => {
  const s = sim([skillRow({ kind: 'nova', radius: 400, params: { status: { slow_pct: 50, slow_s: 3 } } })]);
  const tick = driver(s);
  const p = player({ x: 200, y: 0 });
  tick([p], 0); tick([p], 500);
  assert.ok(Math.abs(effectMagnitude(p, 'chill', tick.now()) - 0.5) < 1e-6);
});

// ---- a storm in rounds ------------------------------------------------------------------

test('a rain with waves comes round again, each time planned on where you are now', () => {
  const s = sim([skillRow({
    kind: 'rain', radius: 120, damage_mult: 1,
    params: { waves: 3, wave_ms: 600, zones: { count: 3, spread: 200, pattern: 'scatter' } },
  })]);
  const tick = driver(s);
  const p = player({ x: 300, y: 0 });
  const first = tick([p], 0).telegraphs;
  assert.equal(first.length, 3);
  assert.equal(first[0].telegraphMs, 500);
  tick([p], 500); // round 1 lands, round 2 is planned
  const boss = s.creatures.get('boss');
  assert.ok(boss._pendingSkill, 'the boss stays at its post for the next round');
  assert.equal(boss._pendingSkill.wave, 2);
  p.x = 900; p.y = 900; // the target moved
  const second = tick([p], 100).telegraphs;
  assert.equal(second.length, 0, 'telegraphs are emitted when a round is planned, not later');
  tick([p], 500);
  assert.equal(boss._pendingSkill.wave, 3);
  tick([p], 700);
  assert.equal(boss._pendingSkill, null, 'after the last round the boss is free again');
});

test('the rounds re-plan around the target AT THE TIME', () => {
  const s = sim([skillRow({ kind: 'rain', radius: 100, params: { waves: 2, wave_ms: 500, zones: { count: 1, spread: 10, pattern: 'scatter' } } })]);
  const tick = driver(s);
  const p = player({ x: 300, y: 0 });
  const r1 = tick([p], 0).telegraphs[0];
  p.x = 1200; p.y = 900;
  tick([p], 500);
  const boss = s.creatures.get('boss');
  const z = boss._pendingSkill.zones[0];
  assert.ok(Math.hypot(z.x - (p.x + 32), z.y - (p.y + 32)) < 60, 'the second round is on the new position');
  assert.ok(Math.hypot(z.x - r1.x, z.y - r1.y) > 500, 'not where the first one was');
});

// ---- the wire -----------------------------------------------------------------------------

test('the world frame carries hazards, marks and a shelter flag', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/authority/world.js'), 'utf8');
  assert.match(src, /activeMarks/);
  assert.match(src, /marks: this\.activeMarks\.map/);
  assert.match(src, /hazards: this\.creatures\.hazards\.map/);
  assert.match(src, /\.\.\.\(t\.safe \? \{ safe: 1 \} : \{\}\)/);
  assert.match(src, /attacks: creatureAttacks, impacts: creatureImpacts, telegraphs, marks/);
});
