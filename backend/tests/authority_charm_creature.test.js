const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { selectGuardTarget, GUARD_AGGRO_RADIUS, GUARD_LEASH_RADIUS } = require('../src/authority/creatures.js');
const { applyCharm } = require('../src/authority/effects.js');

function stubMap() {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8, getChunk: () => [] };
}

function armed() {
  const w = new World(stubMap(), new Map(), null);
  w.addPlayer('druid', { x: 500, y: 500 });
  return w;
}

const ACTIVE = ['0,0', '0,1', '1,0', '1,1', '-1,0', '0,-1', '-1,-1', '1,-1', '-1,1'];

test('charming a creature flips its faction and records its owner', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 560, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  assert.equal(w.creatures.get('pet').faction, 'hostile');

  const ok = w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  assert.equal(ok, true);

  const pet = w.creatures.get('pet');
  assert.equal(pet.faction, 'charmed');
  assert.equal(pet.baseFaction, 'hostile', 'the original faction is remembered so release can restore it');
  assert.equal(pet.charmOwnerUserId, 'druid');
  assert.equal(pet.charmedByCharacterId, 3);
  assert.equal(pet.charmExpiresAt, 60000);
});

test('a charmed creature stops targeting players and follows its druid', () => {
  const w = armed();
  // 400px east of the druid: further than the 120px follow range, so it closes.
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 900, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });

  const before = w.creatures.get('pet').x;
  w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], w.now);
  const pet = w.creatures.get('pet');

  assert.ok(pet.x < before, 'a pet walks toward its druid, not away from them');
  assert.equal(pet._target, null, 'and never acquires a player as a target');
  assert.equal(pet.mode, 'follow');
});

test('an UNcharmed creature at the same spot chases the player instead', () => {
  // The control: without this, "follows its druid" could be passing because
  // the creature happens to chase the player who is standing there anyway.
  const w = armed();
  w.creatures.addCreatures([
    { id: 'wild', type: 'Wolf', x: 900, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], w.now);
  const wild = w.creatures.get('wild');
  assert.equal(wild._targetKind, 'player');
  assert.equal(wild._target, 'druid');
});

test('a charmed creature attacks the druid\'s target', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00', damage: 7 },
    { id: 'foe', type: 'Wolf', x: 560, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  // What the druid last landed a hit on. World.attack stamps this; set it here
  // directly so this test exercises the sim, not the attack resolver.
  w.getPlayer('druid')._charmTargetId = 'foe';

  const hpBefore = w.creatures.get('foe').hp;
  w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], w.now);

  assert.equal(w.creatures.get('pet')._target, 'foe');
  assert.equal(w.creatures.get('pet')._targetKind, 'creature');
  assert.ok(w.creatures.get('foe').hp < hpBefore, 'a pet actually fights the target it was pointed at');
});

test('a pet\'s kill is credited to its druid, not to the pet', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00', damage: 50 },
    { id: 'foe', type: 'Wolf', x: 560, y: 500, hp: 3, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  w.getPlayer('druid')._charmTargetId = 'foe';

  // Through World.tickCreatures, which is the shape server.js consumes: a raw
  // creature id where a userId belongs is exactly the bogus-killerUserId trap
  // killerUserIdFor exists to avoid.
  const r = w.tickCreatures(0.2, ACTIVE);
  assert.deepEqual(r.kills, [{ id: 'foe', killerUserId: 'druid' }]);
  assert.equal(w.creatures.has('foe'), false);
});

test('a guard\'s own kill is still credited to nobody', () => {
  // The credit map must not leak a killer onto the paths that had none.
  const w = armed();
  w.creatures.addCreatures([
    {
      id: 'guard', type: 'Guard', x: 500, y: 560, hp: 300, level: 20, facing: 'S',
      color: '#00c', faction: 'guard', home_x: 500, home_y: 560, damage: 999,
    },
    { id: 'foe', type: 'Wolf', x: 520, y: 560, hp: 3, level: 6, facing: 'S', color: '#c00' },
  ]);
  const r = w.tickCreatures(0.2, ACTIVE);
  assert.deepEqual(r.kills, [{ id: 'foe', killerUserId: null }]);
});

test('a charmed creature never attacks its own druid, even if pointed at them', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00', damage: 7 },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });

  const druid = w.getPlayer('druid');
  const hpBefore = druid.hp;
  for (let i = 0; i < 10; i++) w.creatures.tick(0.2, ACTIVE, [druid], w.now + i * 200);
  assert.equal(druid.hp, hpBefore);
});

test('a pet never attacks another of the same druid\'s pets', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'petA', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00', damage: 7 },
    { id: 'petB', type: 'Wolf', x: 560, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00', damage: 7 },
  ]);
  w.creatures.charm('petA', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  w.creatures.charm('petB', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  // The druid's last hit was on petB, before it was charmed.
  w.getPlayer('druid')._charmTargetId = 'petB';

  const hpBefore = w.creatures.get('petB').hp;
  for (let i = 0; i < 5; i++) w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], w.now + i * 200);
  assert.equal(w.creatures.get('petB').hp, hpBefore);
  assert.equal(w.creatures.get('petA')._target, null);
});

test('an expired charm releases the creature back to hostile', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 1000 });

  w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], 1001);
  const pet = w.creatures.get('pet');
  assert.equal(pet.faction, 'hostile');
  assert.equal(pet.charmOwnerUserId, null);
  assert.equal(pet.charmedByCharacterId, null);
  assert.equal(pet.charmExpiresAt, 0);
});

test('a released creature targets players again on the NEXT tick, not the release tick', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00', damage: 7 },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 1000 });
  const druid = w.getPlayer('druid');
  const hpBefore = druid.hp;
  // The release tick itself must not also bite: a pet lapsing in contact would
  // otherwise get a free hit on its own former owner.
  w.creatures.tick(0.2, ACTIVE, [druid], 1001);
  assert.equal(druid.hp, hpBefore);
  assert.equal(w.creatures.get('pet')._target, null);
  // And on the tick after, it is an ordinary hostile again.
  w.creatures.tick(0.2, ACTIVE, [druid], 1201);
  assert.equal(w.creatures.get('pet')._target, 'druid');
});

test('a charm whose druid has left the world is released', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  // No players at all -- the druid disconnected, or walked into another world.
  w.creatures.tick(0.2, ACTIVE, [], w.now);
  assert.equal(w.creatures.get('pet').faction, 'hostile');
});

test('a pet dragged past the leash is released rather than walking forever', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 500, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  // Inside the leash: still a pet.
  w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], w.now);
  assert.equal(w.creatures.get('pet').faction, 'charmed');
  // Teleported far away (a portal, a knockback chain, a respawn elsewhere) but
  // still inside the active set, so the leash -- not the chunk freeze -- is
  // what ends the charm.
  const pet = w.creatures.get('pet');
  pet.x = 500 + 2000; pet.y = 500;
  const wide = [...ACTIVE];
  for (let cx = -2; cx <= 12; cx++) for (let cy = -2; cy <= 4; cy++) wide.push(`${cx},${cy}`);
  w.creatures.tick(0.2, wide, [w.getPlayer('druid')], w.now);
  assert.equal(w.creatures.get('pet').faction, 'hostile');
});

test('a charmed guard comes back as a guard, never as a wild hostile', () => {
  const w = armed();
  w.creatures.addCreatures([
    {
      id: 'g', type: 'Guard', x: 540, y: 500, hp: 300, level: 20, facing: 'S',
      color: '#00c', faction: 'guard', home_x: 540, home_y: 500,
    },
  ]);
  w.creatures.charm('g', { userId: 'druid', characterId: 3, expiresAt: 1000 });
  assert.equal(w.creatures.get('g').faction, 'charmed');
  w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], 1001);
  assert.equal(w.creatures.get('g').faction, 'guard');
});

test('charm refuses a creature id the sim does not hold', () => {
  const w = armed();
  assert.equal(w.creatures.charm('ghost', { userId: 'druid', characterId: 3, expiresAt: 60000 }), false);
});

// The consequence the plan flagged: the flip is what takes a pet OUT of the
// guard's damage graph. This is the mechanism, asserted directly rather than
// left as prose.
test('a village guard stops treating a charmed creature as a target', () => {
  const w = armed();
  w.creatures.addCreatures([
    {
      id: 'guard', type: 'Guard', x: 500, y: 500, hp: 300, level: 20, facing: 'S',
      color: '#00c', faction: 'guard', home_x: 500, home_y: 500,
    },
    { id: 'pet', type: 'Wolf', x: 560, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  const guard = w.creatures.get('guard');
  const args = {
    guard, creatures: w.creatures.all(),
    aggroRadius: GUARD_AGGRO_RADIUS, leashRadius: GUARD_LEASH_RADIUS,
    playersById: new Map(), now: 0,
  };
  assert.equal(selectGuardTarget(args).id, 'pet', 'a wild wolf at the gate is engaged');
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  assert.equal(selectGuardTarget({ ...args, creatures: w.creatures.all() }), null,
    'and the same wolf, charmed, is ignored -- a level-150 guard does not execute a pet');
});

test('a charmed creature is off its charmer\'s own melee target list', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 560, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  // The arc reaches it either way; only the pacify argument differs.
  const open = w.creatures.meleeArcScan(532, 532, 1, 0, 200, 1.8, null);
  assert.deepEqual(open.hit, ['pet']);
  assert.deepEqual(open.blocked, []);
  const pacified = w.creatures.meleeArcScan(532, 532, 1, 0, 200, 1.8, 'druid');
  assert.deepEqual(pacified.hit, []);
  assert.deepEqual(pacified.blocked, ['pet'], 'refused, and the player is shown why');
  // Another player's swing is unaffected -- the pacify is per-charmer.
  const other = w.creatures.meleeArcScan(532, 532, 1, 0, 200, 1.8, 'someone-else');
  assert.deepEqual(other.hit, ['pet']);
});


// --- The two seams World.attack owns. The sim tests above set `_charmTargetId`
// by hand and call meleeArcScan directly; these prove the ATTACK RESOLVER
// actually writes the one and passes the other. Without them, deleting either
// line in world.js leaves every test in this file green.

const HALBERD = {
  id: 2, name: 'halberd', category: 'weapon', kind: 'melee', damage: 18,
  cooldown: 0.9, reach: 190, arc_width: 1.8, mana_cost: 0, stamina_cost: 0,
  element: null, knockback: 0, vfx: { attack: 'sweep_arc' },
};
const TYPES = new Map([[2, HALBERD]]);
const INV = { items: [{ id: 'i2', typeId: 2 }], equipment: { main_hand: 'i2' } };

function armedWithWeapon() {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 500, y: 500 });
  return w;
}

test('attacking a creature stamps the target this player\'s summons will fight', () => {
  const w = armedWithWeapon();
  w.addPlayer('hunter', { x: 300, y: 500 }, INV);
  w.creatures.addCreatures([
    { id: 'foe', type: 'Wolf', x: 420, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  assert.equal(w.getPlayer('hunter')._charmTargetId, null);
  w.attack('hunter', 1, 0);
  assert.equal(w.getPlayer('hunter')._charmTargetId, 'foe',
    'without this stamp a druid\'s pets have nothing to be pointed at and only ever heel');
});

test('a swing that reaches nothing leaves the summon target alone', () => {
  const w = armedWithWeapon();
  w.addPlayer('hunter', { x: 300, y: 500 }, INV);
  w.creatures.addCreatures([
    { id: 'foe', type: 'Wolf', x: 420, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.attack('hunter', 1, 0);
  w.getPlayer('hunter')._attackCd = 0;
  w.attack('hunter', -1, 0);   // swinging west, at empty ground
  assert.equal(w.getPlayer('hunter')._charmTargetId, 'foe',
    'a whiff must not un-point the pack mid-fight');
});

test('a charmed player cannot damage their charmer\'s pet through World.attack', () => {
  const w = armedWithWeapon();
  w.addPlayer('victim', { x: 300, y: 500 }, INV);
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 420, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  applyCharm(w.getPlayer('victim'), 'druid', w.now);

  const hpBefore = w.creatures.get('pet').hp;
  const r = w.attack('victim', 1, 0);
  assert.equal(w.creatures.get('pet').hp, hpBefore,
    'the whole arc -- damage, riders, knockback -- is refused, not just the damage');
  assert.equal(w.getPlayer('victim')._charmTargetId, null,
    'and a refused swing must not point the druid\'s own pack at anything');
  // The refusal is SHOWN, as a block cue on the pet, rather than reading as a
  // miss at empty ground.
  assert.ok(r.impacts.some((i) => i.t === 'c:pet'),
    'a pacified swing that physically reached the pet must produce a block cue');
});

test('the same swing lands normally when the attacker is not charmed', () => {
  // The control for the test above: proves the arc geometry reaches the pet,
  // so the refusal is the pacify and not a swing that was always going to miss.
  const w = armedWithWeapon();
  w.addPlayer('victim', { x: 300, y: 500 }, INV);
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 420, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  const hpBefore = w.creatures.get('pet').hp;
  w.attack('victim', 1, 0);   // never charmed
  assert.ok(w.creatures.get('pet').hp < hpBefore);
});
