const test = require('node:test');
const assert = require('node:assert');
const { World, PLAYER_SPEED } = require('../src/authority/world.js');
const {
  applyEffect, hasEffect, BURN, CHILL,
  BURN_MAGNITUDE, BURN_TICK_MS, BURN_DURATION_MS,
} = require('../src/authority/effects.js');

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
