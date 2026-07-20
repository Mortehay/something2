const test = require('node:test');
const assert = require('node:assert');
const { World, PLAYER_SPEED } = require('../src/authority/world.js');
const {
  applyEffect, hasEffect, BURN, CHILL, SHOCK,
  BURN_MAGNITUDE, BURN_TICK_MS, BURN_DURATION_MS,
  CHILL_MAGNITUDE, SHOCK_MAGNITUDE, SHOCK_MANA_DRAIN,
  applyElementEffect, applyShockInterrupt, canAct,
  SHOCK_INTERRUPT_MS, SHOCK_IMMUNITY_MS,
} = require('../src/authority/effects.js');
const { fastestCooldownMsForElement } = require('./fixtures/weapon_catalog.js');
const { PLAYER_MANA_REGEN } = require('../src/authority/world.js');
const { CREATURE_DAMAGE } = require('../src/authority/creatures.js');
const { CHUNK_KEY } = require('../src/authority/coords.js');

// Stub map: walkable unless x >= wall; speed 1.
function stubMap(wall = Infinity) {
  return { isWalkable: (wx) => wx < wall, speedAt: () => 1 };
}

test('setInput clamps dx,dy into [-1,1]', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setInput('u1', 1, 5, -9);
  w.tick(1); // speed*1*1 = PLAYER_SPEED on x, -PLAYER_SPEED on y (after normalize)
  const p = w.getPlayer('u1');
  // Clamped to (1,-1) then normalized by hypot(1,1): step = PLAYER_SPEED/sqrt2
  assert.ok(Math.abs(p.x - PLAYER_SPEED / Math.SQRT2) < 1e-3);
  assert.ok(Math.abs(p.y + PLAYER_SPEED / Math.SQRT2) < 1e-3);
});

test('tick advances a player on open ground', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setInput('u1', 1, 1, 0);
  w.tick(0.05);
  assert.ok(w.getPlayer('u1').x > 0);
});

test('tick blocks movement into an unwalkable tile', () => {
  const w = new World(stubMap(50)); // wall at x=50
  w.addPlayer('u1', { x: 0, y: 0 }); // center at (32,32); +x step would cross wall quickly
  w.setInput('u1', 1, 1, 0);
  w.tick(1); // large dt: step is huge, center+step >= 50 → blocked
  assert.equal(w.getPlayer('u1').x, 0);
});

test('ackSeq tracks the latest input seq; snapshot has the right shape', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 3, y: 4 });
  w.setInput('u1', 7, 0, 0);
  w.tick(0.05);
  assert.equal(w.getPlayer('u1').ackSeq, 7);
  const snap = w.snapshot();
  assert.equal(snap.players.length, 1);
  // Widened in Task 5 (weapon dispatch/mana/projectiles): snapshot now also
  // carries mana/maxMana/equipment per player (mirrors the hp/maxHp precedent).
  // Task 6: weaponId retired in favor of equipment (inventory-driven weapon).
  // F1 fast-follow: autoLoot added so the client mirror can be corrected from
  // every state frame, not just `joined`.
  // Task 4 (stamina): widened again for stamina/maxStamina, mirroring mana.
  assert.deepEqual(
    Object.keys(snap.players[0]).sort(),
    ['autoLoot', 'equipment', 'facing', 'hp', 'id', 'mana', 'maxHp', 'maxMana', 'maxStamina', 'stamina', 'x', 'y'],
  );
  assert.equal(snap.players[0].id, 'u1');
});

test('removePlayer + isEmpty', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  assert.equal(w.isEmpty(), false);
  w.removePlayer('u1');
  assert.equal(w.isEmpty(), true);
});

test('world exposes a ground item sim sized to the chunk', () => {
  const w = new World(stubMap(), new Map(), null, 32);
  assert.strictEqual(w.groundItems.chunkSize, 32);
  assert.strictEqual(w.groundItems.count(), 0);
});

test('autoLoot defaults off and toggles strictly', () => {
  const w = new World(stubMap(), new Map(), null, 64);
  w.addPlayer('u1', { x: 0, y: 0 });
  assert.strictEqual(w.getPlayer('u1').autoLoot, false);
  w.setAutoLoot('u1', true);
  assert.strictEqual(w.getPlayer('u1').autoLoot, true);
  w.setAutoLoot('u1', 'yes'); // non-boolean -> false, never truthy-coerced
  assert.strictEqual(w.getPlayer('u1').autoLoot, false);
  w.setAutoLoot('nobody', true); // unknown player must not throw
});

// --- Status effects tick inside the world (Task 4) --------------------------

function mkWorld(wall = Infinity) { return new World(stubMap(wall)); }

function addCreature(w, over = {}) {
  w.creatures.addCreatures([{
    id: 'c1', type: 'slime', x: 0, y: 0, hp: 10, color: '#fff',
    defense: 0, resistances: {}, ...over,
  }]);
  return w.creatures.creatures.get(over.id || 'c1');
}

test('effects are applied before movement so a chill affects the same tick', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  applyEffect(p, CHILL, { durationMs: 5000, magnitude: 0.6, now: 0 });
  w.setInput('u1', 1, 1, 0);
  w.tick(1);
  assert.ok(p.x < PLAYER_SPEED, 'the chill did not apply until the following tick');
});

test('chill expiry restores the EXACT original speed', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  for (let i = 0; i < 50; i++) {           // repeated apply/expire cycles
    applyEffect(p, CHILL, { durationMs: 10, magnitude: 0.6, now: i * 100 });
    w.tick(0.2);
  }
  assert.equal(p.speed, PLAYER_SPEED,
    'speed drifted — chill must recompute from a stored base, not multiply/divide in place');
});

// NOTE on the test above: for every plausible chill magnitude, IEEE754 makes
// `base * m / m === base` exactly, so a naive multiply-on-apply /
// divide-on-expire implementation does NOT actually drift and that test alone
// would not catch it. The two below are what hold the recompute-from-base
// design in place: they cover the failure modes multiply-in-place really has —
// compounding while the effect is sustained, and ignoring a refreshed
// magnitude because the applied factor was already banked into `speed`.

test('a sustained chill does not compound tick over tick', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  applyEffect(p, CHILL, { durationMs: 5000, magnitude: 0.6, now: 0 });
  for (let i = 0; i < 20; i++) w.tick(0.05); // 1000ms, still chilled throughout
  assert.equal(p.speed, PLAYER_SPEED * 0.6,
    'chill compounded per tick instead of being recomputed from the base');
  w.tick(5);
  assert.equal(p.speed, PLAYER_SPEED);
});

test('a chill refreshed with a different magnitude retargets speed from the base', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  applyEffect(p, CHILL, { durationMs: 5000, magnitude: 0.5, now: 0 });
  w.tick(0.05);
  assert.equal(p.speed, PLAYER_SPEED * 0.5);
  applyEffect(p, CHILL, { durationMs: 5000, magnitude: 0.25, now: w.now });
  w.tick(0.05);
  assert.equal(p.speed, PLAYER_SPEED * 0.25,
    'a refresh must retarget from the base, not stack on / ignore the banked factor');
  w.tick(6);
  assert.equal(p.speed, PLAYER_SPEED, 'expiry did not restore the exact base');
});

test('an expired effect is evicted from the target', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  applyEffect(p, CHILL, { durationMs: 100, magnitude: 0.5, now: 0 });
  w.tick(0.05); // now = 50ms: still live
  assert.equal(hasEffect(p, CHILL, 50), true);
  w.tick(0.2);  // now = 250ms: past expiry
  assert.equal(p.effects.has(CHILL), false, 'expired effect was never evicted');
  assert.equal(p.speed, PLAYER_SPEED);
});

test('the SAME tick path drives creature effects, not a second implementation', () => {
  const w = mkWorld();
  const c = addCreature(w);
  applyEffect(c, CHILL, { durationMs: 5000, magnitude: 0.5, now: 0 });
  const base = c.speed;
  w.tick(0.1);
  assert.equal(c.speed, base * 0.5, 'creatures do not get chilled by World.tick');
  // ...and the same recompute-from-base rule restores them exactly.
  w.tick(6);
  assert.equal(c.speed, base);
});

test('burn damages a player through applyDamage (mitigation still applies)', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  p.mit = { defense: 0, resistances: { fire: 0.5 } };
  const hp0 = p.hp;
  applyEffect(p, BURN, { durationMs: 4000, magnitude: BURN_MAGNITUDE, now: 0 });
  w.tick(BURN_TICK_MS / 1000);
  assert.equal(hp0 - p.hp, BURN_MAGNITUDE * 0.5,
    'burn must route through applyDamage, not subtract hp raw');
});

test('a player killed by a burn tick is left for resolveDeaths, not respawned by the burn', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  p.hp = 1;
  applyEffect(p, BURN, { durationMs: 4000, magnitude: BURN_MAGNITUDE, now: 0 });
  w.tick(BURN_TICK_MS / 1000);
  assert.ok(p.hp <= 0, 'burn did not kill the player');
  w.resolveDeaths();
  assert.equal(p.hp, p.maxHp, 'the single death path did not run');
});

test('a creature killed by a burn tick is REPORTED so it routes through the death commit', () => {
  const w = mkWorld();
  addCreature(w, { hp: 2 });
  applyEffect(w.creatures.creatures.get('c1'), BURN, {
    durationMs: 4000, magnitude: BURN_MAGNITUDE, now: 0,
  });
  const r = w.tick(BURN_TICK_MS / 1000);
  assert.deepEqual(r.killedCreatureIds, ['c1'],
    'burn kills must be reported to the caller the way attack/tickProjectiles report theirs');
  assert.equal(w.creatures.has('c1'), false, 'the burn-killed creature was not removed');
});

test('a burn tick that does not kill reports nothing', () => {
  const w = mkWorld();
  const c = addCreature(w, { hp: 50 });
  applyEffect(c, BURN, { durationMs: 4000, magnitude: BURN_MAGNITUDE, now: 0 });
  const r = w.tick(BURN_TICK_MS / 1000);
  assert.deepEqual(r.killedCreatureIds, []);
  assert.equal(c.hp, 50 - BURN_MAGNITUDE);
});

// Burn deals FIRE damage, and fire carries the burn rider. If the burn tick's
// own damage re-applied that rider, burn would refresh itself forever and
// nothing hit by a fire weapon would ever stop burning. This is the reason
// damageCreatureById does not apply riders — see the note there.
test('a burn tick does not refresh its own burn', () => {
  const w = mkWorld();
  const c = addCreature(w, { hp: 100000 });
  applyEffect(c, BURN, { durationMs: BURN_DURATION_MS, magnitude: BURN_MAGNITUDE, now: 0 });
  for (let i = 0; i < 40; i++) w.tick(0.5); // 20s, far past the 4s duration
  assert.equal(c.effects.has(BURN), false,
    'burn refreshed itself from its own damage tick and never expires');
  assert.ok(c.hp > 99000, 'burn kept ticking long past its duration');
});

test('a player burn tick does not refresh its own burn either', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  p.maxHp = 100000; p.hp = 100000;
  applyEffect(p, BURN, { durationMs: BURN_DURATION_MS, magnitude: BURN_MAGNITUDE, now: 0 });
  for (let i = 0; i < 40; i++) w.tick(0.5);
  assert.equal(p.effects.has(BURN), false);
});

// --- Task 6: shock's mana drain and vulnerability, through the real tick ---

test('a shocked player loses mana through World.tick, on shock\'s own interval', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  p.mana = 100; p.maxMana = 100;
  applyEffect(p, SHOCK, { durationMs: 60000, magnitude: SHOCK_MAGNITUDE, now: 0 });
  // 1000ms in 50ms slices -> exactly one drain tick, against 1s of regen.
  for (let i = 0; i < 20; i++) w.tick(0.05);
  // Regen adds PLAYER_MANA_REGEN over the same second, but the pool starts full
  // and is capped, so the drain is what actually moves the number.
  assert.ok(p.mana < 100, `mana did not drain under shock (still ${p.mana})`);
  // The drain fires on the tick that crosses SHOCK_TICK_MS; regen then runs for
  // that same 50ms slice, since the pool is no longer full. Exact, not
  // approximate, so a changed drain or a second spurious tick both fail loudly.
  assert.equal(p.mana, 100 - SHOCK_MANA_DRAIN + PLAYER_MANA_REGEN * 0.05);
});

// The drain must be strong enough to matter against regen, or it is decoration:
// a caster under sustained lightning must recover mana STRICTLY slower than one
// who is not. This is the reachability half — the clamp test proves it is safe,
// this proves it is felt.
test('shock\'s drain measurably slows mana recovery rather than being cosmetic', () => {
  const w = mkWorld();
  w.addPlayer('shocked', { x: 0, y: 0 });
  w.addPlayer('clear', { x: 0, y: 0 });
  const a = w.getPlayer('shocked'), b = w.getPlayer('clear');
  a.mana = 0; b.mana = 0;
  applyEffect(a, SHOCK, { durationMs: 60000, magnitude: SHOCK_MAGNITUDE, now: 0 });
  for (let i = 0; i < 60; i++) {              // 3s
    applyEffect(a, SHOCK, { durationMs: 60000, magnitude: SHOCK_MAGNITUDE, now: w.now });
    w.tick(0.05);
  }
  assert.ok(a.mana < b.mana * 0.75,
    `sustained shock left ${a.mana} mana vs ${b.mana} unshocked — the drain is not `
    + 'meaningful against PLAYER_MANA_REGEN');
});

test('a creature under shock takes the vulnerability but is never given a mana pool', () => {
  const w = mkWorld();
  const c = addCreature(w, { hp: 100 });
  applyEffect(c, SHOCK, { durationMs: 60000, magnitude: SHOCK_MAGNITUDE, now: 0 });
  for (let i = 0; i < 40; i++) w.tick(0.05); // 2s: two drain ticks would have fired
  assert.equal('mana' in c, false, 'the drain invented a mana pool on a creature');
  assert.equal(c.hp, 100, 'the drain must not fall back to damaging a target with no mana');
});

test('shock amplifies damage taken from a creature\'s contact bite, not only from weapons', () => {
  const w = mkWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  applyEffect(p, SHOCK, { durationMs: 60000, magnitude: SHOCK_MAGNITUDE, now: 0 });
  const c = addCreature(w, { hp: 100 });
  c.x = p.x; c.y = p.y;                       // inside CONTACT_RANGE
  // This file's stub map carries no chunkSize, so the sim's chunk maths would
  // key on NaN and the creature would be frozen out of the active set.
  w.creatures.chunkSize = 64;
  const hp0 = p.hp;
  w.tick(0.05);
  w.tickCreatures(0.05, [CHUNK_KEY(0, 0)]);
  assert.equal(hp0 - p.hp, CREATURE_DAMAGE * (1 + SHOCK_MAGNITUDE),
    'creature contact damage bypassed the shock vulnerability — it is not reading the world clock');
});

// Chill reachability. PLAYER_SPEED is 200 and CREATURE_SPEED is 40, so a
// chilled player at x0.6 still moves at 120 — three times creature speed.
// Creatures cannot catch ANY player at any multiplier this slice would use, so
// a test written against creature pursuit could never fail. Chill is a PvP /
// projectile-dodging mechanic, and this asserts the differential is large
// enough to decide a player-versus-player chase.
test('chill is reachable as a PvP mechanic: the speed gap closes real distance', () => {
  const w = mkWorld();
  w.addPlayer('runner', { x: 0, y: 0 });
  w.addPlayer('chaser', { x: 0, y: 0 });
  const runner = w.getPlayer('runner'), chaser = w.getPlayer('chaser');
  applyEffect(runner, CHILL, { durationMs: 60000, magnitude: CHILL_MAGNITUDE, now: 0 });
  w.setInput('runner', 1, 1, 0);
  w.setInput('chaser', 1, 1, 0);
  for (let i = 0; i < 20; i++) w.tick(0.05);  // 1s of a straight-line chase
  const closed = chaser.x - runner.x;
  assert.ok(closed > PLAYER_SPEED * 0.3,
    `an unchilled chaser closed only ${closed}px in one second — the chill differential is `
    + 'too small to decide a PvP chase');
  assert.equal(runner.speed, PLAYER_SPEED * CHILL_MAGNITUDE);
});

// --- Task 7: the interrupt, consumed by the attack path ---

// mkWorld() carries NO weapon catalog, so canAttack() there returns false for
// every player regardless of the interrupt — an interrupt test written against
// it would pass without the feature existing at all. These tests arm the world
// with a real weapon so the refusal they observe is the interrupt's.
function mkArmedWorld() {
  const weapon = {
    id: 1, name: 'test staff', category: 'weapon', kind: 'melee',
    damage: 5, cooldown: 0.5, reach: 80, arc_width: 1.0,
    mana_cost: 10, stamina_cost: 4, element: null, resistances: {},
  };
  return new World(stubMap(), new Map([[1, weapon]]), 1);
}

test('the armed-world fixture really can attack, so the refusals below mean something', () => {
  const w = mkArmedWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  assert.equal(w.canAttack('u1').ok, true,
    'the fixture cannot attack even uninterrupted — every interrupt test using it is vacuous');
});

test('an interrupted player cannot attack, and the refusal costs neither mana nor cooldown', () => {
  const w = mkArmedWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  const mana0 = p.mana, stamina0 = p.stamina;
  applyShockInterrupt(p, w.now);
  assert.equal(w.canAttack('u1').ok, false, 'canAttack ignored the interrupt');
  w.attack('u1', 1, 0);
  assert.equal(p.mana, mana0, 'a refused attack must not spend mana');
  assert.equal(p.stamina, stamina0, 'a refused attack must not spend stamina');
  assert.equal(p._attackCd, 0,
    'an interrupted attack started the cooldown — that punishes the player twice for one hit');
});

test('the player can attack again once the interrupt lapses, without waiting out the immunity window', () => {
  const w = mkArmedWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  applyShockInterrupt(p, w.now);
  for (let i = 0; i < 10; i++) w.tick(0.05);   // 500ms > SHOCK_INTERRUPT_MS
  assert.ok(SHOCK_INTERRUPT_MS < 500 && SHOCK_IMMUNITY_MS > 500,
    'this test assumes it runs past the interrupt but INSIDE the immunity window');
  assert.equal(canAct(p, w.now), true);
  assert.equal(w.canAttack('u1').ok, true,
    'control returned only after the immunity window, not after the interrupt');
});

// End-to-end: sustained storm-staff fire against a real World must not remove
// the target's ability to act for most of the fight.
test('a player under sustained lightning fire keeps the ability to attack for most of 10s', () => {
  const w = mkArmedWorld();
  w.addPlayer('victim', { x: 0, y: 0 });
  const victim = w.getPlayer('victim');
  const cd = fastestCooldownMsForElement('lightning');
  let nextShot = 0, able = 0, samples = 0;
  while (w.now < 10000) {
    if (w.now >= nextShot) {
      applyElementEffect(victim, 'lightning', w.now, 'attacker');
      nextShot = w.now + cd;
    }
    samples += 1;
    if (w.canAttack('victim').ok) able += 1;
    w.tick(0.1);
  }
  assert.ok(able > samples * 0.5,
    `the victim could act on only ${able}/${samples} ticks under sustained storm-staff fire`);
});

test('respawn restores control and clears lingering effects, but not the shock immunity window', () => {
  const w = mkArmedWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  applyEffect(p, BURN, { durationMs: 60000, magnitude: BURN_MAGNITUDE, now: w.now });
  applyShockInterrupt(p, w.now);
  p.hp = -1;
  w.resolveDeaths();
  assert.equal(canAct(p, w.now), true, 'a respawned player must not get up still staggered');
  assert.equal(p.effects.size, 0, 'a status effect leaked across a respawn');
  assert.equal(applyShockInterrupt(p, w.now), false,
    'respawning shed the immunity window, making death a route to being chain-locked at spawn');
});
