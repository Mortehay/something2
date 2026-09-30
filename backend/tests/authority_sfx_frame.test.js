// Game audio slice 3, Task 5: the authority's `sfx` event channel.
//
// Two layers, both through the REAL code:
//   1. The World: swings, shots, projectile landings, creature bites and
//      deaths each leave their event on the world's buffers, drained by
//      World#drainSfx -- the one call server.js makes per tick.
//   2. The wire: a real authority server over a real socket, where a dagger
//      swing that kills a wolf must reach the client's `state` frame as
//      use + hit + hurt + death, and a quiet frame must carry no `sfx` key.
// Plus the per-frame cap through server.js's own stash helpers.
//
// No database: the World layer needs none, and the wire layer runs on a fake
// pool (the same routing authority_combat_integration.test.js uses).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { World } = require('../src/authority/world.js');
const { CREATURE_SIZE } = require('../src/authority/creatures.js');
const { attachAuthority, __test } = require('../src/authority/server.js');
const { creatureHurt } = require('../src/authority/sfxEvents.js');

const TYPES = new Map([
  [1, { id: 1, name: 'dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null }],
  [3, { id: 3, name: 'bow', category: 'weapon', kind: 'projectile', damage: 12, cooldown: 0.6, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null }],
  [6, { id: 6, name: 'oak staff', category: 'weapon', kind: 'projectile', damage: 10, cooldown: 0.6, range: 600, projectile_speed: 700, projectile_radius: 10, pierce: 1, mana_cost: 0, element: null }],
]);
const openMap = () => ({ chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] });
const wielding = (typeId) => ({ items: [{ id: `i${typeId}`, typeId }], equipment: { main_hand: `i${typeId}` } });
const only = (events, e) => events.filter((ev) => ev.e === e);

test('world: a melee swing that hits a creature emits use + hit + hurt', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 }); // centre 132,132; default dagger, reach 80
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 108, hp: 500, facing: 'S' }]);
  const { attacks, impacts } = w.attack('u1', 1, 0);
  assert.equal(impacts.length, 1, 'precondition: the swing connected');
  assert.equal(attacks.length, 1, 'the VFX attack record is still emitted');

  const sfx = w.drainSfx();
  assert.deepEqual(only(sfx, 'use'), [{ e: 'use', k: 'melee', s: 'dagger', a: 'p:u1', x: 132, y: 132 }]);
  const cx = 150 + CREATURE_SIZE / 2, cy = 108 + CREATURE_SIZE / 2;
  assert.deepEqual(only(sfx, 'hit'), [{ e: 'hit', k: 'melee', s: 'dagger', x: cx, y: cy }]);
  assert.deepEqual(only(sfx, 'hurt'), [{ e: 'hurt', c: 'Wolf', x: cx, y: cy }]);
  assert.deepEqual(only(sfx, 'death'), [], 'a 500 hp wolf survives one dagger swing');
  assert.deepEqual(w.drainSfx(), [], 'drain clears the buffers');
});

test('world: a swing at empty ground is a use with no hit', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 });
  w.attack('u1', 1, 0);
  const sfx = w.drainSfx();
  assert.deepEqual(sfx.map((ev) => ev.e), ['use']);
});

test('world: a projectile weapon fire is a use of its attack family', () => {
  const bow = new World(openMap(), TYPES, 1);
  bow.addPlayer('u1', { x: 100, y: 100 }, wielding(3));
  bow.attack('u1', 1, 0);
  assert.deepEqual(bow.drainSfx(), [{ e: 'use', k: 'ranged', s: 'bow', a: 'p:u1', x: 132, y: 132 }]);

  const staff = new World(openMap(), TYPES, 1);
  staff.addPlayer('u1', { x: 100, y: 100 }, wielding(6));
  staff.attack('u1', 1, 0);
  assert.deepEqual(staff.drainSfx(), [{ e: 'use', k: 'magic', s: 'oak staff', a: 'p:u1', x: 132, y: 132 }]);
});

test('world: a landed arrow is a hit labelled with the weapon that fired it, plus the creature hurt', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 }, wielding(3));
  w.creatures.addCreatures([{ id: 'c1', type: 'Slime', x: 300, y: 108, hp: 500, facing: 'S' }]);
  w.attack('u1', 1, 0);
  w.drainSfx(); // the fire itself, asserted above
  for (let i = 0; i < 20 && w.projectiles.count() > 0; i++) w.tickProjectiles(0.05);
  const sfx = w.drainSfx();
  const hit = only(sfx, 'hit');
  assert.equal(hit.length, 1, JSON.stringify(sfx));
  assert.equal(hit[0].k, 'ranged');
  assert.equal(hit[0].s, 'bow');
  const hurt = only(sfx, 'hurt');
  assert.equal(hurt.length, 1);
  assert.equal(hurt[0].c, 'Slime');
  assert.equal(hurt[0].x, 300 + CREATURE_SIZE / 2);
});

test('world: a detonation is ONE magic hit however many it catches', () => {
  const types = new Map(TYPES);
  types.set(7, { id: 7, name: 'fire staff', category: 'weapon', kind: 'projectile', damage: 5, cooldown: 0.6, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, aoe_radius: 200, detonate_at: 'contact', mana_cost: 0, element: null });
  const w = new World(openMap(), types, 1);
  w.addPlayer('u1', { x: 100, y: 100 }, wielding(7));
  w.creatures.addCreatures([
    { id: 'c1', type: 'Slime', x: 300, y: 108, hp: 500, facing: 'S' },
    { id: 'c2', type: 'Slime', x: 330, y: 108, hp: 500, facing: 'S' },
  ]);
  w.attack('u1', 1, 0);
  w.drainSfx();
  for (let i = 0; i < 20 && w.projectiles.count() > 0; i++) w.tickProjectiles(0.05);
  const sfx = w.drainSfx();
  const hit = only(sfx, 'hit');
  assert.equal(hit.length, 1, JSON.stringify(sfx));
  assert.equal(hit[0].k, 'magic');
  assert.equal(hit[0].s, 'fire staff');
  assert.equal(only(sfx, 'hurt').length, 0, 'a blast is one sound, not one per victim');
});

test('world: an explosive-arrow detonation keeps the bow\'s ranged family', () => {
  const types = new Map(TYPES);
  types.set(8, { id: 8, name: 'blast bow', category: 'weapon', kind: 'projectile', damage: 5, cooldown: 0.6, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, aoe_radius: 200, detonate_at: 'contact', mana_cost: 0, element: null });
  const w = new World(openMap(), types, 1);
  w.addPlayer('u1', { x: 100, y: 100 }, wielding(8));
  w.creatures.addCreatures([{ id: 'c1', type: 'Slime', x: 300, y: 108, hp: 500, facing: 'S' }]);
  w.attack('u1', 1, 0);
  const fire = w.drainSfx();
  assert.equal(fire[0].k, 'ranged', 'precondition: attackKindOf reads the bow as ranged');
  for (let i = 0; i < 20 && w.projectiles.count() > 0; i++) w.tickProjectiles(0.05);
  const sfx = w.drainSfx();
  assert.deepEqual(only(sfx, 'hurt'), [], 'precondition: it detonated rather than hitting directly');
  assert.deepEqual(only(sfx, 'hit').map((ev) => [ev.k, ev.s]), [['ranged', 'blast bow']]);
});

test('world: a guard biting a creature is heard as the guard\'s use + hit AND the victim\'s hurt', () => {
  const w = new World(openMap(), new Map(), null);
  w.addPlayer('u1', { x: 500, y: 500 });
  w.creatures.addCreatures([
    { id: 'guard', type: 'Village Guard', x: 500, y: 560, hp: 300, level: 20, facing: 'S', faction: 'guard', home_x: 500, home_y: 560, damage: 1 },
    { id: 'foe', type: 'Wolf', x: 520, y: 560, hp: 500, level: 6, facing: 'S' },
  ]);
  const active = ['0,0', '0,1', '1,0', '1,1', '-1,0', '0,-1', '-1,-1', '1,-1', '-1,1'];
  let sfx = [];
  for (let i = 0; i < 20 && !sfx.some((ev) => ev.a === 'c:guard'); i++) {
    w.tickCreatures(0.2, active);
    sfx = sfx.concat(w.drainSfx());
  }
  const use = sfx.find((ev) => ev.a === 'c:guard');
  assert.ok(use, `the guard never attacked: ${JSON.stringify(sfx)}`);
  assert.equal(use.c, 'Village Guard');
  const hit = sfx.find((ev) => ev.e === 'hit' && ev.c === 'Village Guard');
  assert.ok(hit);
  const hurt = sfx.filter((ev) => ev.e === 'hurt');
  assert.ok(hurt.some((ev) => ev.c === 'Wolf' && ev.x === hit.x && ev.y === hit.y), JSON.stringify(sfx));
});

test('world: a creature biting a PLAYER emits no hurt (players have none)', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 });
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 140, y: 108, hp: 500, facing: 'S', damage: 1, faction: 'hostile' }]);
  let sfx = [];
  for (let i = 0; i < 40 && !sfx.some((ev) => ev.e === 'use'); i++) {
    w.tick(0.05);
    w.tickCreatures(0.05, ['0,0', '0,1', '1,0', '1,1']);
    sfx = sfx.concat(w.drainSfx());
  }
  assert.ok(sfx.some((ev) => ev.e === 'use'), 'precondition: the wolf bit');
  assert.deepEqual(only(sfx, 'hurt'), []);
});

test('world: a creature-owned shot lands as a hit named by its shooter type', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 300, y: 100 }); // centre 332,132
  w.projectiles.spawn({
    ownerId: 'c9', ownerKind: 'creature', ownerFaction: 'hostile', ownerType: 'Goblin Archer',
    x: 150, y: 132, nx: 1, ny: 0, damage: 1,
    weapon: { projectile_speed: 900, projectile_radius: 8, range: 700, pierce: 1, aoe_radius: 0, element: 'physical', damage: 1 },
  });
  for (let i = 0; i < 20 && w.projectiles.count() > 0; i++) w.tickProjectiles(0.05);
  const hit = only(w.drainSfx(), 'hit');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].c, 'Goblin Archer');
  assert.equal(hit[0].k, undefined);
  assert.equal(hit[0].s, undefined);
  assert.equal(hit[0].x, 332);
});

test('world: a killed creature emits one death with its type and last position', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 });
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 108, hp: 5, facing: 'S' }]);
  const { kills } = w.attack('u1', 1, 0);
  assert.deepEqual(kills.map((k) => k.id), ['c1'], 'precondition: the swing killed it');
  assert.equal(w.creatures.get('c1'), undefined, 'precondition: gone from the sim');
  const deaths = only(w.drainSfx(), 'death');
  assert.deepEqual(deaths, [{ e: 'death', c: 'Wolf', x: 150 + CREATURE_SIZE / 2, y: 108 + CREATURE_SIZE / 2 }]);
});

// SOMET-592 (M3): unloading a creature whose chunk left the active set is
// not a death. pruneInactive deletes it directly, never through
// _removeKilled; a refactor that routed it there would make every creature
// the player walks away from "die" audibly.
test('world: a creature leaving the AOI (pruneInactive) plays no death', () => {
  const w = new World(openMap(), TYPES, 1);
  w.creatures.addCreatures([
    { id: 'gone', type: 'Wolf', x: 5000, y: 5000, hp: 50, facing: 'S' },
    { id: 'here', type: 'Slime', x: 10, y: 10, hp: 50, facing: 'S' },
  ]);
  w.creatures.clearDirty(['gone', 'here']);
  w.drainSfx();
  const dropped = w.creatures.pruneInactive(['0,0']);
  assert.equal(dropped, 1, 'precondition: exactly the far creature was unloaded');
  assert.equal(w.creatures.get('gone'), undefined, 'precondition: gone from the sim');
  assert.ok(w.creatures.get('here'), 'precondition: the in-chunk creature stays');
  assert.deepEqual(only(w.drainSfx(), 'death'), []);
});

test('world: a creature bite is a creature use plus a creature hit at the target', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 });
  // Touching the player: a default hostile bites on its first tick in range.
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 140, y: 108, hp: 500, facing: 'S', damage: 1, faction: 'hostile' }]);
  let sfx = [];
  for (let i = 0; i < 40 && !sfx.some((ev) => ev.e === 'use'); i++) {
    w.tick(0.05);
    w.tickCreatures(0.05, ['0,0', '0,1', '1,0', '1,1']);
    sfx = sfx.concat(w.drainSfx());
  }
  const use = only(sfx, 'use');
  assert.ok(use.length >= 1, `the wolf never attacked: ${JSON.stringify(sfx)}`);
  assert.equal(use[0].c, 'Wolf');
  assert.equal(use[0].a, 'c:c1');
  assert.equal(use[0].k, undefined, 'creature events carry no attack family');
  const hit = only(sfx, 'hit');
  assert.ok(hit.length >= 1);
  assert.equal(hit[0].c, 'Wolf');
  assert.equal(hit[0].x, 132, 'the hit is at the TARGET (the player centre)');
});

test('world: a successful skill cast is a use of skill:<id>', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 });
  // Twin Slash gates on level/stats; a copy (never the shared BASE_STATS
  // object) that meets them, so the cast reaches its success path.
  const p = w.getPlayer('u1');
  p.stats = { ...p.stats, level: 50, strength: 99, dexterity: 99, constitution: 99 };
  const res = w.castSkill('u1', 'war_twin_slash', 0, 0, 1, 0);
  assert.equal(res.ok, true, `precondition: the cast succeeded (${res.reason})`);
  assert.deepEqual(only(w.drainSfx(), 'use'), [{ e: 'use', k: 'melee', s: 'skill:war_twin_slash', a: 'p:u1', x: 132, y: 132 }]);

  const refused = new World(openMap(), TYPES, 1);
  refused.addPlayer('u1', { x: 100, y: 100 });
  assert.equal(refused.castSkill('u1', 'no_such_skill', 0, 0, 1, 0).ok, false);
  assert.deepEqual(refused.drainSfx(), [], 'a refused cast is silent');
});

// SOMET-592 (I3): skills used to push only their `use`, so every
// skill/<id>/hit slot was dead and skill damage was silent unless a creature
// died. A caster that meets any gem's requirements, with resources to spare.
function skillWorld() {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 }); // centre 132,132; default dagger (melee)
  const p = w.getPlayer('u1');
  p.stats = {
    ...p.stats, level: 50, strength: 99, dexterity: 99, constitution: 99, intelligence: 99, wisdom: 99, charisma: 99,
  };
  p.mana = 999; p.stamina = 999; p.hp = 999; p.maxHp = 999;
  return w;
}

test('world: a magic AoE skill hitting two creatures is ONE hit at its centre plus a hurt per victim', () => {
  const w = skillWorld();
  // war_shockwave: type magic, a targeted radial AoE (no cone/nova id).
  w.creatures.addCreatures([
    { id: 'c1', type: 'Slime', x: 380, y: 380, hp: 5000, facing: 'S' },
    { id: 'c2', type: 'Wolf', x: 420, y: 380, hp: 5000, facing: 'S' },
    { id: 'far', type: 'Wolf', x: 2000, y: 2000, hp: 5000, facing: 'S' },
  ]);
  const res = w.castSkill('u1', 'war_shockwave', 400, 400, 1, 0);
  assert.equal(res.ok, true, `precondition: the cast succeeded (${res.reason} ${res.error || ''})`);
  assert.ok(w.creatures.get('c1').hp < 5000 && w.creatures.get('c2').hp < 5000, 'precondition: both were damaged');
  assert.equal(w.creatures.get('far').hp, 5000, 'precondition: the far wolf was outside the blast');
  const sfx = w.drainSfx();
  assert.deepEqual(only(sfx, 'hit'), [{ e: 'hit', k: 'magic', s: 'skill:war_shockwave', x: 400, y: 400 }]);
  const hurt = only(sfx, 'hurt');
  assert.deepEqual(hurt.map((ev) => ev.c).sort(), ['Slime', 'Wolf']);
  assert.deepEqual(hurt.find((ev) => ev.c === 'Slime'), { e: 'hurt', c: 'Slime', x: 380 + CREATURE_SIZE / 2, y: 380 + CREATURE_SIZE / 2 });
  assert.deepEqual(only(sfx, 'death'), []);
  assert.equal(sfx[0].e, 'use', 'the cast is heard before its landing');
});

test('world: a melee skill hit is a hit + hurt per struck creature, once however many strikes', () => {
  const w = skillWorld();
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 108, hp: 5000, facing: 'S' }]);
  // war_twin_slash strikes twice; the sound is per landed target, not per strike.
  const res = w.castSkill('u1', 'war_twin_slash', 0, 0, 1, 0);
  assert.equal(res.ok, true, `precondition: the cast succeeded (${res.reason})`);
  assert.ok(w.creatures.get('c1').hp < 5000, 'precondition: the arc connected');
  const sfx = w.drainSfx();
  const cx = 150 + CREATURE_SIZE / 2, cy = 108 + CREATURE_SIZE / 2;
  assert.deepEqual(only(sfx, 'hit'), [{ e: 'hit', k: 'melee', s: 'skill:war_twin_slash', x: cx, y: cy }]);
  assert.deepEqual(only(sfx, 'hurt'), [{ e: 'hurt', c: 'Wolf', x: cx, y: cy }]);
});

test('world: a killing skill hit is a hit + death, and no hurt', () => {
  const w = skillWorld();
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 108, hp: 1, facing: 'S' }]);
  const res = w.castSkill('u1', 'war_crushing_blow', 0, 0, 1, 0);
  assert.equal(res.ok, true, `precondition: the cast succeeded (${res.reason})`);
  assert.deepEqual(res.kills.map((k) => k.id), ['c1'], 'precondition: the blow killed it');
  const sfx = w.drainSfx();
  const cx = 150 + CREATURE_SIZE / 2, cy = 108 + CREATURE_SIZE / 2;
  assert.deepEqual(only(sfx, 'hit'), [{ e: 'hit', k: 'melee', s: 'skill:war_crushing_blow', x: cx, y: cy }]);
  assert.deepEqual(only(sfx, 'death'), [{ e: 'death', c: 'Wolf', x: cx, y: cy }]);
  assert.deepEqual(only(sfx, 'hurt'), [], 'a kill already has its death');
});

test('world: a magic AoE that kills one of two victims hurts only the survivor', () => {
  const w = skillWorld();
  w.creatures.addCreatures([
    { id: 'weak', type: 'Slime', x: 380, y: 380, hp: 1, facing: 'S' },
    { id: 'tough', type: 'Wolf', x: 420, y: 380, hp: 5000, facing: 'S' },
  ]);
  const res = w.castSkill('u1', 'war_shockwave', 400, 400, 1, 0);
  assert.equal(res.ok, true, `precondition: the cast succeeded (${res.reason})`);
  assert.deepEqual(res.kills.map((k) => k.id), ['weak']);
  const sfx = w.drainSfx();
  assert.equal(only(sfx, 'hit').length, 1);
  assert.deepEqual(only(sfx, 'hurt').map((ev) => ev.c), ['Wolf']);
  assert.deepEqual(only(sfx, 'death').map((ev) => ev.c), ['Slime']);
});

test('world: a cone skill is a hit + hurt per creature in the cone', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 }, wielding(3)); // a bow: arc_piercing_shot requires one
  const p = w.getPlayer('u1');
  p.stats = {
    ...p.stats, level: 50, strength: 99, dexterity: 99, constitution: 99, intelligence: 99, wisdom: 99, charisma: 99,
  };
  p.mana = 999; p.stamina = 999;
  w.creatures.addCreatures([
    { id: 'c1', type: 'Wolf', x: 250, y: 108, hp: 5000, facing: 'S' },
    { id: 'c2', type: 'Slime', x: 330, y: 108, hp: 5000, facing: 'S' },
  ]);
  const res = w.castSkill('u1', 'arc_piercing_shot', 0, 0, 1, 0);
  assert.equal(res.ok, true, `precondition: the cast succeeded (${res.reason} ${res.error || ''})`);
  const sfx = w.drainSfx();
  const hit = only(sfx, 'hit');
  assert.deepEqual(hit.map((ev) => [ev.k, ev.s, ev.x]).sort(),
    [['magic', 'skill:arc_piercing_shot', 250 + CREATURE_SIZE / 2], ['magic', 'skill:arc_piercing_shot', 330 + CREATURE_SIZE / 2]].sort());
  assert.deepEqual(only(sfx, 'hurt').map((ev) => ev.c).sort(), ['Slime', 'Wolf']);
});

test('world: a skill that damages nothing is its use alone', () => {
  const w = skillWorld();
  const res = w.castSkill('u1', 'war_shockwave', 400, 400, 1, 0);
  assert.equal(res.ok, true);
  assert.deepEqual(w.drainSfx().map((ev) => ev.e), ['use']);
});

test('server stash: 100 events in one tick leave a frame of 64', () => {
  const { pushSfx, drainSfx } = __test;
  const entry = {};
  const events = Array.from({ length: 100 }, (_, i) => creatureHurt('Wolf', i, i));
  pushSfx(entry, events.slice(0, 50));
  pushSfx(entry, events.slice(50));
  const frame = drainSfx(entry);
  assert.equal(frame.length, 64);
  assert.equal(frame[0].x, 0, 'overflow drops the newest');
  assert.deepEqual(drainSfx(entry), []);
  pushSfx(entry, []);
  assert.equal(entry.pendingSfx, undefined, 'an idle world allocates no stash');
});

test('world: the buffers are capped even if nobody drains them', () => {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 });
  for (let i = 0; i < 100; i++) {
    w.getPlayer('u1')._attackCd = 0;
    w.attack('u1', 1, 0);
  }
  assert.equal(w.drainSfx().length, 64);
});

// -- The wire. Fake pool routing copied from authority_combat_integration.

const SECRET = 'test-secret';
function fakePool() {
  const pool = {
    query: async (sql, params) => {
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [{
        name: 'Wolf', color: '#c00', hp: 5, attack_element: 'physical',
        behavior_name: 'Line', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
        projectile_speed: 0, projectile_radius: 0, aggro_radius: 444, leash_radius: 777,
        chase_style: 'skirmish', preferred_range: 111, move_speed_mult: 1.3, damage_override: 9,
      }] };
      // Omnidirectional dagger, so the swing lands whatever the facing.
      if (/FROM item_types/i.test(sql)) {
        return { rows: [
          { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
            damage: 10, cooldown: 0.3, reach: 90, arc_width: Math.PI * 2,
            range: null, projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: 0, element: null,
            defense: null, resistances: null },
        ] };
      }
      if (/FROM player_items/i.test(sql)) return { rows: [] };
      if (/FROM player_equipment/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
      if (/DELETE FROM world_creatures/i.test(sql)) return { rows: [] };
      if (/FROM world_creatures/i.test(sql)) {
        if (params[1] === 0) return { rows: [{ id: 'wolf1', type: 'Wolf', x: 410, y: 400, hp: 5, facing: 'S', color: '#c00' }] };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}
function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }
function bootWith(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000 });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('wire: a dagger swing that kills a wolf reaches the state frame as use + hit + hurt + death', async () => {
  const { url, handle, server } = await bootWith(fakePool());
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(1))}`);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');
    let loaded = false;
    for (let i = 0; i < 20 && !loaded; i++) {
      const m = await nextMsg(ws, 'creatures');
      if (m.creatures.some((c) => c.id === 'wolf1')) loaded = true;
    }
    assert.ok(loaded, 'precondition: wolf loaded before the swing');

    // Frames before the swing: the wolf may already be biting (creature
    // `use`/`hit`), so what is asserted is only that no key is ever present
    // with an EMPTY list.
    ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
    const seen = [];
    for (let i = 0; i < 40 && !seen.some((ev) => ev.e === 'death'); i++) {
      const s = await nextMsg(ws, 'state');
      if ('sfx' in s) {
        assert.ok(Array.isArray(s.sfx) && s.sfx.length > 0, 'sfx is omitted when empty, never []');
        assert.ok(s.sfx.length <= 64);
        seen.push(...s.sfx);
      }
    }
    const mine = seen.filter((ev) => ev.a === 'p:1');
    assert.equal(mine.length, 1, JSON.stringify(seen));
    assert.equal(mine[0].e, 'use');
    assert.equal(mine[0].k, 'melee');
    assert.equal(mine[0].s, 'dagger');
    assert.ok(seen.some((ev) => ev.e === 'hit' && ev.k === 'melee' && ev.s === 'dagger'), JSON.stringify(seen));
    assert.ok(seen.some((ev) => ev.e === 'hurt' && ev.c === 'Wolf'));
    const death = seen.find((ev) => ev.e === 'death');
    assert.ok(death, 'the kill reached the frame as a death');
    assert.equal(death.c, 'Wolf');
    assert.ok(Number.isFinite(death.x) && Number.isFinite(death.y));
  } finally {
    ws.close(); handle.close(); server.close();
  }
});
