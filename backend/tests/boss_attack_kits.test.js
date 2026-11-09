// backend/tests/boss_attack_kits.test.js
// The new world-boss attacks: the boss skill kinds reachable from the catalog (charge, blink,
// rain, chain), the params that shape them (ring with a safe middle, pull, projectile fan,
// rain patterns), the phase / enrage gates on a binding, the "cast this now" queue the boss
// manager uses. (The bosses' kits themselves are pinned in boss_distinct_kits.test.js.)
//
// Live-tick tests drive the REAL CreatureSim from rows shaped like the loader's, the same
// discipline creature_skills_wiring.test.js keeps.
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, queueSkill, ENRAGE_COOLDOWN_SCALE } = require('../src/authority/creatures.js');
const { resolveSkill, creatureSkillError, buildZones, KINDS } = require('../src/services/creatureSkills.js');

function openMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.5;
const active = new Set(['0,0', '0,1', '1,0', '1,1']);

function driver(s) {
  let now = 0;
  return (players, deltaMs) => {
    now += deltaMs;
    return s.tick(deltaMs / 1000, active, players, now, undefined);
  };
}

function skillRow(over = {}) {
  return {
    slot: 1, skill_id: 1, name: 'Test Skill', kind: 'nova',
    telegraph_ms: 500, cooldown_ms: 4000, radius: 150, range: 300,
    damage_mult: 1, element: null, summon_entity: null, summon_count: 1,
    vfx: null, power_scale: 1, params: null, min_phase: 1, requires_enrage: false,
    ...over,
  };
}

function creatureRow(skills, over = {}) {
  return {
    id: over.id || 'c1', type: 'Boss', x: 0, y: 0, hp: 100000, facing: 'S',
    home_x: null, home_y: null, level: 1, damage: 10, blocks_portal_id: null,
    defense: 0, color: '#fff', resistances: {},
    faction: 'hostile', attack_element: 'physical',
    behavior_name: 'Boss', aggro_radius: 600, leash_radius: 1200, chase_style: 'hold', preferred_range: 0,
    move_speed_mult: 1, damage_override: null, aura_names: null, aura_defs: [],
    behavior_gold_min: 0, behavior_gold_max: 0, abilities: [], skills,
  };
}

function player(over = {}) {
  return {
    userId: over.userId || 'u1', x: over.x ?? 0, y: over.y ?? 0,
    width: 64, height: 64, hp: over.hp ?? 1000, maxHp: 1000, _buff: undefined,
  };
}

// ---- normalisation / validation ----------------------------------------------------------

test('the boss kinds are valid catalog kinds', () => {
  for (const k of ['charge', 'blink', 'rain', 'chain']) assert.ok(KINDS.includes(k), k);
  assert.equal(creatureSkillError({ name: 'x', kind: 'rain', cooldown_ms: 1000 }), null);
});

test('resolveSkill reads params and the binding gates', () => {
  const s = resolveSkill(skillRow({
    kind: 'projectile', min_phase: 3, requires_enrage: true,
    params: { proj_count: 5, proj_spread: 0.9, proj_speed: 260, pull: 40, inner_radius: 30, hits: 2, ultimate: true },
  }));
  assert.equal(s.projectileCount, 5);
  assert.equal(s.projectileSpread, 0.9);
  assert.equal(s.projectileSpeed, 260);
  assert.equal(s.pull, 40);
  assert.equal(s.innerRadius, 30);
  assert.equal(s.hits, 2);
  assert.equal(s.ultimate, true);
  assert.equal(s.minPhase, 3);
  assert.equal(s.requiresEnrage, true);
});

test('a skill with no params and no gates is exactly the old skill', () => {
  const s = resolveSkill(skillRow({ kind: 'slam' }));
  assert.equal(s.projectileCount, 1);
  assert.equal(s.projectileSpeed, null);
  assert.equal(s.pull, 0);
  assert.equal(s.innerRadius, 0);
  assert.equal(s.minPhase, 1);
  assert.equal(s.requiresEnrage, false);
  assert.equal(s.zones, null);
});

test('params are validated with a readable message', () => {
  const base = { name: 'x', kind: 'nova', cooldown_ms: 1000 };
  assert.match(creatureSkillError({ ...base, params: { hits: 99 } }), /params\.hits/);
  assert.match(creatureSkillError({ ...base, params: { proj_count: 0 } }), /params\.proj_count/);
  assert.match(creatureSkillError({ ...base, params: { zones: { pattern: 'spiral' } } }), /pattern/);
  assert.match(creatureSkillError({ ...base, params: [] }), /object/);
  assert.equal(creatureSkillError({ ...base, params: { pull: 120, zones: { count: 6, spread: 200, pattern: 'ring' } } }), null);
});

test('rain zone patterns: scatter starts on the target, ring surrounds it, cross has four arms', () => {
  const scatter = buildZones({ count: 6, spread: 400, pattern: 'scatter' }, 5);
  assert.equal(scatter.length, 6);
  assert.deepEqual(scatter[0], { dx: 0, dy: 0 });
  const ring = buildZones({ count: 6, spread: 200, pattern: 'ring' }, 5);
  assert.equal(ring.length, 6);
  for (const z of ring) assert.ok(Math.abs(Math.hypot(z.dx, z.dy) - 200) < 1e-6, 'every ring zone is `spread` away');
  assert.ok(!ring.some((z) => Math.hypot(z.dx, z.dy) < 1), 'no zone on the target in a ring: stepping in is the answer');
  const cross = buildZones({ count: 5, spread: 300, pattern: 'cross' }, 5);
  assert.equal(cross.length, 5);
  assert.deepEqual(cross[0], { dx: 0, dy: 0 });
});

// ---- the live tick -----------------------------------------------------------------------

test('Lava Ring: the middle of the ring is safe, the ring itself is not', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([creatureRow([skillRow({ kind: 'nova', radius: 200, range: 400, params: { inner_radius: 80 } })])]);
  const tick = driver(s);
  // The boss is at (0,0), 64x64: its centre is (32,32). A sits ~on top of it, B is in the ring.
  const inside = player({ userId: 'in', x: 10, y: 10 });
  const ring = player({ userId: 'ring', x: 150, y: 0 });
  const telegraph = tick([inside, ring], 0).telegraphs;
  assert.ok(telegraph.length > 0);
  assert.equal(telegraph[0].inner, 80, 'the telegraph says where the safe middle is');
  tick([inside, ring], 500);
  assert.equal(inside.hp, 1000, 'inside the hole: untouched');
  assert.ok(ring.hp < 1000, 'in the ring: hit');
});

test('Gravity Well: a nova with pull drags a survivor toward the centre', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([creatureRow([skillRow({ kind: 'nova', radius: 320, range: 450, params: { pull: 100 } })])]);
  const tick = driver(s);
  const p = player({ x: 250, y: 0 });
  const before = Math.hypot(p.x + 32 - 32, p.y + 32 - 32);
  tick([p], 0);
  tick([p], 500);
  const after = Math.hypot(p.x + 32 - 32, p.y + 32 - 32);
  assert.ok(p.hp < 1000);
  assert.ok(after < before - 50, `pulled in (${before} -> ${after})`);
});

test('a projectile skill with proj_count fires a fan, one shot is unchanged', () => {
  const fan = new CreatureSim(openMap(), noRedirect);
  fan.addCreatures([creatureRow([skillRow({
    kind: 'projectile', radius: 20, range: 600, params: { proj_count: 5, proj_spread: 0.9, proj_speed: 260 },
  })])]);
  let tick = driver(fan);
  const p = player({ x: 300, y: 0 });
  tick([p], 0);
  const shots = tick([p], 500).shots;
  assert.equal(shots.length, 5);
  assert.ok(shots.every((sh) => sh.speed === 260));
  const angles = shots.map((sh) => Math.atan2(sh.ny, sh.nx)).sort((a, b) => a - b);
  assert.ok(Math.abs((angles[4] - angles[0]) - 0.9) < 1e-6, 'spread across the configured arc');

  const single = new CreatureSim(openMap(), noRedirect);
  single.addCreatures([creatureRow([skillRow({ kind: 'projectile', radius: 20, range: 600 })])]);
  tick = driver(single);
  tick([p], 0);
  assert.equal(tick([p], 500).shots.length, 1);
});

test('Chain Lightning: strikes the target, jumps to a neighbour in range, spares one out of range', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([creatureRow([skillRow({
    kind: 'chain', radius: 260, range: 650, telegraph_ms: 300, params: { hits: 3 },
  })])]);
  const tick = driver(s);
  const a = player({ userId: 'a', x: 300, y: 0 });
  const b = player({ userId: 'b', x: 450, y: 0 });     // 150 from A: within the jump range
  const far = player({ userId: 'far', x: 300, y: 900 }); // nowhere near
  const t = tick([a, b, far], 0).telegraphs[0];
  assert.equal(t.radius, 70, 'the telegraph is the strike point, not the jump range');
  const r = tick([a, b, far], 300);
  assert.ok(a.hp < 1000, 'struck');
  assert.ok(b.hp < 1000, 'jumped to');
  assert.equal(far.hp, 1000, 'out of reach');
  assert.ok(1000 - b.hp < 1000 - a.hp, 'each jump is weaker');
  assert.ok(r.attacks.length >= 2, 'an arc is drawn for each leg');
  for (const at of r.attacks) assert.ok(Math.abs(Math.hypot(at.nx, at.ny) - 1) < 1e-6, 'unit direction');
});

test('Meteor Shower: a rain telegraphs every zone and hits what stands in one', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([creatureRow([skillRow({
    kind: 'rain', radius: 120, range: 700, telegraph_ms: 400, params: { zones: { count: 6, spread: 300, pattern: 'scatter' } },
  })])]);
  const tick = driver(s);
  const p = player({ x: 300, y: 0 });
  const t = tick([p], 0).telegraphs;
  assert.equal(t.length, 6);
  tick([p], 400);
  assert.ok(p.hp < 1000, 'the first zone is on the target');
});

test('Blazing Charge: a charge skill from the catalog commits a line and runs it', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([creatureRow([skillRow({ kind: 'charge', radius: 80, range: 650, telegraph_ms: 400, params: { dash_distance: 500 } })])]);
  const tick = driver(s);
  const p = player({ x: 300, y: 0 });
  const t = tick([p], 0).telegraphs[0];
  assert.equal(t.kind, 'line');
  const boss = s.creatures.get('c1');
  const x0 = boss.x;
  tick([p], 400);
  assert.ok(boss.x > x0 + 100, 'the boss ran toward the target');
});

test('a binding gated to phase 3 only opens at phase 3; enrage-only only when enraged', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([creatureRow([
    skillRow({ slot: 1, name: 'Phase3', kind: 'nova', min_phase: 3, telegraph_ms: 100 }),
    skillRow({ slot: 2, name: 'EnrageOnly', kind: 'nova', requires_enrage: true, telegraph_ms: 100 }),
  ])]);
  const tick = driver(s);
  const p = player({ x: 100, y: 0 });
  assert.equal(tick([p], 0).telegraphs.length, 0, 'phase 1, calm: nothing is open');
  const boss = s.creatures.get('c1');
  boss.phase = 3;
  assert.equal(tick([p], 50).telegraphs[0].skill, 'Phase3');
  boss.phase = 1;
  boss.enraged = true;
  tick([p], 200); // resolve the pending one
  assert.equal(tick([p], 10).telegraphs[0].skill, 'EnrageOnly');
});

test('a queued skill is cast ahead of the rotation, ignoring cooldown, range and gates; once', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([creatureRow([
    skillRow({ slot: 1, name: 'Rotation', kind: 'nova', telegraph_ms: 100, cooldown_ms: 60000 }),
    skillRow({ slot: 2, name: 'Signature', kind: 'nova', telegraph_ms: 100, cooldown_ms: 60000, min_phase: 4, range: 10 }),
  ])]);
  const tick = driver(s);
  const boss = s.creatures.get('c1');
  const p = player({ x: 100, y: 0 });
  tick([p], 0);        // Rotation starts, goes on its long cooldown
  tick([p], 200);      // resolves
  assert.equal(queueSkill(boss, 'Signature'), true);
  const t = tick([p], 10).telegraphs;
  assert.equal(t[0].skill, 'Signature', 'ahead of the rotation, though gated and out of range');
  assert.equal(boss._skillQueue.length, 0, 'consumed');
});

test('queueSkill drops unknown names at cast time and caps the queue', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([creatureRow([skillRow({ slot: 1, name: 'Known', kind: 'nova', telegraph_ms: 100, cooldown_ms: 60000, range: 1 })])]);
  const tick = driver(s);
  const boss = s.creatures.get('c1');
  const p = player({ x: 100, y: 0 });
  queueSkill(boss, 'Renamed Away');
  assert.equal(tick([p], 0).telegraphs.length, 0, 'an unknown name casts nothing');
  assert.equal(queueSkill(boss, null), false);
  for (let i = 0; i < 10; i++) queueSkill(boss, 'Known');
  assert.ok(boss._skillQueue.length <= 4);
});

test('enrage shortens every cooldown', () => {
  assert.ok(ENRAGE_COOLDOWN_SCALE > 0 && ENRAGE_COOLDOWN_SCALE < 1);
  const calm = new CreatureSim(openMap(), noRedirect);
  calm.addCreatures([creatureRow([skillRow({ kind: 'nova', telegraph_ms: 100, cooldown_ms: 4000 })])]);
  const mad = new CreatureSim(openMap(), noRedirect);
  mad.addCreatures([creatureRow([skillRow({ kind: 'nova', telegraph_ms: 100, cooldown_ms: 4000 })])]);
  mad.creatures.get('c1').enraged = true;
  const p1 = player({ x: 100, y: 0 });
  const p2 = player({ x: 100, y: 0 });
  const t1 = driver(calm); const t2 = driver(mad);
  t1([p1], 0); t2([p2], 0);
  // 3.2 s later (> 4000 * 0.75 = 3000, < 4000): only the enraged boss casts again.
  t1([p1], 3200); t2([p2], 3200);
  assert.equal(t1([p1], 10).telegraphs.length, 0);
  assert.equal(t2([p2], 10).telegraphs.length, 1);
});

