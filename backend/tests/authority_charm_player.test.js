const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const {
  CHARMED, applyCharm, charmerOf, activeEffectKeys,
} = require('../src/authority/effects.js');

function stubMap() {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8, getChunk: () => [] };
}

const HALBERD = {
  id: 2, name: 'halberd', category: 'weapon', kind: 'melee', damage: 18,
  cooldown: 0.9, reach: 190, arc_width: 1.8, mana_cost: 0, stamina_cost: 0,
  element: null, knockback: 0, vfx: { attack: 'sweep_arc' },
};
const BOW = {
  id: 3, name: 'shortbow', category: 'weapon', kind: 'projectile', damage: 12,
  cooldown: 0.6, range: 400, projectile_speed: 600, projectile_radius: 6,
  pierce: 1, aoe_radius: 0, mana_cost: 0, stamina_cost: 0, element: null,
  knockback: 0, vfx: {},
};
const TYPES = new Map([[2, HALBERD], [3, BOW]]);
const INV = { items: [{ id: 'i2', typeId: 2 }], equipment: { main_hand: 'i2' } };
const BOW_INV = { items: [{ id: 'i3', typeId: 3 }], equipment: { main_hand: 'i3' } };

test('a charmed player cannot be chain-locked by repeated charms', () => {
  const victim = {};
  // The first charm lands.
  assert.equal(applyCharm(victim, 'druid', 0), true);
  assert.equal(charmerOf(victim, 0), 'druid');
  // Nine more charms across the whole 4s duration all bounce off the window,
  // and NONE of them extends anything.
  for (let t = 100; t <= 3900; t += 400) {
    assert.equal(applyCharm(victim, 'druid', t), false, `a charm at ${t}ms must not land`);
  }
  // At 4000ms the charm is over even though it was hammered throughout.
  assert.equal(charmerOf(victim, 4000), null);
  // And it stays over until the immunity window itself lapses at 8000ms.
  assert.equal(applyCharm(victim, 'druid', 7999), false);
  assert.equal(charmerOf(victim, 7999), null);
  // Only then may a second charm land.
  assert.equal(applyCharm(victim, 'druid', 8001), true);
  assert.equal(charmerOf(victim, 8001), 'druid');
});

test('a second druid cannot land a charm inside the first druid\'s window either', () => {
  const victim = {};
  assert.equal(applyCharm(victim, 'druidA', 0), true);
  assert.equal(applyCharm(victim, 'druidB', 10), false,
    'the window is per-TARGET, not per-caster: per-caster windows are two druids taking turns forever');
  assert.equal(charmerOf(victim, 10), 'druidA');
});

// The specific number, not just "it eventually lapses": a chain-locking build
// would still lapse, just never while anyone was shooting. 4s of the 8s window
// is time the target is provably free.
test('every charm buys the target four uninterruptible seconds of freedom', () => {
  const victim = {};
  applyCharm(victim, 'druid', 1000);
  // Charmed for [1000, 5000). Free from 5000. Cannot be re-charmed until 9000.
  assert.equal(charmerOf(victim, 4999), 'druid');
  assert.equal(charmerOf(victim, 5000), null);
  for (let t = 5000; t < 9000; t += 250) {
    assert.equal(applyCharm(victim, 'druid', t), false);
    assert.equal(charmerOf(victim, t), null, `free at ${t}ms`);
  }
  assert.equal(applyCharm(victim, 'druid', 9001), true);
});

test('the charm is broadcast as an ordinary effect key', () => {
  const victim = {};
  applyCharm(victim, 'druid', 0);
  assert.deepEqual(activeEffectKeys(victim, 1000), [CHARMED]);
  assert.equal(activeEffectKeys(victim, 5000), null);
});

test('a charmed player cannot damage the druid who charmed them', () => {
  const w = new World(stubMap(), TYPES, 2);
  // The victim at (100,100) swings due east into the druid at (260,100): well
  // inside a halberd's 190px reach.
  w.addPlayer('druid', { x: 260, y: 100 });
  w.addPlayer('victim', { x: 100, y: 100 }, INV);
  const druid = w.getPlayer('druid');
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);

  const hpBefore = druid.hp;
  const r = w.attack('victim', 1, 0);
  assert.equal(druid.hp, hpBefore, 'the charmer takes nothing from a pacified swing');
  assert.deepEqual(r.impacts, [], 'and gets no hit feedback for a blow that never landed');
});

test('a charmed player still damages everyone who is NOT their charmer', () => {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 260, y: 100 });
  w.addPlayer('bystander', { x: 260, y: 130 });
  w.addPlayer('victim', { x: 100, y: 100 }, INV);
  const victim = w.getPlayer('victim');
  const bystander = w.getPlayer('bystander');
  applyCharm(victim, 'druid', w.now);

  const hpBefore = bystander.hp;
  w.attack('victim', 1, 0);
  assert.ok(bystander.hp < hpBefore,
    'a pacify protects the charmer, not the whole world: this is not a stun');
});

test('an UNcharmed player damages the druid exactly as before', () => {
  // The control for the two tests above: if the arc geometry were wrong, the
  // pacify assertions would pass for the wrong reason.
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 260, y: 100 });
  w.addPlayer('victim', { x: 100, y: 100 }, INV);
  const druid = w.getPlayer('druid');
  const hpBefore = druid.hp;
  w.attack('victim', 1, 0);
  assert.ok(druid.hp < hpBefore);
});

test('a shot loosed while pacified never becomes lethal to the charmer mid-flight', () => {
  const w = new World(stubMap(), TYPES, 3);
  w.addPlayer('druid', { x: 400, y: 100 });
  w.addPlayer('victim', { x: 100, y: 100 }, BOW_INV);
  const druid = w.getPlayer('druid');
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);
  w.attack('victim', 1, 0);
  const hpBefore = druid.hp;
  // Well past the charm's own 4s lifetime: the snapshot on the projectile, not
  // a live re-read, is what still protects the druid here.
  for (let i = 0; i < 200; i++) { w.tick(0.05); w.tickProjectiles(0.05); }
  assert.equal(charmerOf(victim, w.now), null, 'the charm itself has long lapsed');
  assert.equal(druid.hp, hpBefore, 'and the arrow it launched still passes through');
});

test('a charmed player keeps their own movement input', () => {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 100, y: 100 });
  w.addPlayer('victim', { x: 1000, y: 1000 }, INV);
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);

  w.setInput('victim', 1, 1, 0);   // walking east, away from the druid
  const xBefore = victim.x;
  w.tick(0.05);
  assert.ok(victim.x > xBefore,
    'no control transfer: the charm never suppresses the target\'s own input');
  // And the input is honoured at FULL speed -- a charm that quietly halved it
  // would still pass the assertion above. The charmed player's own step is the
  // uncharmed one UNCHANGED; the only difference is the repel added on top of
  // it, which is bounded by CHARM_REPEL_SPEED (50) * dt.
  const uncharmed = new World(stubMap(), TYPES, 2);
  uncharmed.addPlayer('other', { x: 1000, y: 1000 }, INV);
  uncharmed.setInput('other', 1, 1, 0);
  uncharmed.tick(0.05);
  const own = uncharmed.getPlayer('other').x - 1000;
  const moved = victim.x - xBefore;
  assert.ok(moved >= own,
    'a charmed player\'s own eastward step is never reduced by the charm');
  assert.ok(moved - own <= 50 * 0.05 + 1e-9,
    'and the only extra displacement is the bounded soft repel, not a server-driven path');
  // Nothing server-driven writes the position back either: ackSeq still tracks
  // the client's own sequence number, which is what client-side authority means.
  assert.equal(victim.ackSeq, 1);
});

test('a charmed player is softly repelled from the druid', () => {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 500, y: 500 });
  w.addPlayer('victim', { x: 560, y: 500 }, INV);
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);

  w.setInput('victim', 1, 0, 0);   // standing still
  const xBefore = victim.x;
  w.tick(0.05);
  assert.ok(victim.x > xBefore, 'the repel pushes AWAY from the charmer, not toward');
  // SOFT: a full tick of repel moves the player far less than a tick of their
  // own walking would. A repel as strong as movement is a control transfer.
  assert.ok(victim.x - xBefore < 200 * 0.05,
    'the repel is a nudge, not a shove that outruns the player\'s own legs');
});

test('the repel stops the moment the charm lapses', () => {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 500, y: 500 });
  w.addPlayer('victim', { x: 560, y: 500 }, INV);
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);
  w.setInput('victim', 1, 0, 0);
  for (let i = 0; i < 80; i++) w.tick(0.05);   // 4s: the charm is over
  const settled = victim.x;
  for (let i = 0; i < 20; i++) w.tick(0.05);
  assert.equal(victim.x, settled, 'nothing keeps pushing an uncharmed player');
});

test('a charmed player never becomes a summon', () => {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 500, y: 500 });
  w.addPlayer('victim', { x: 560, y: 500 }, INV);
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);
  w.tick(0.05);

  // The summon roster is a CREATURE concept and nothing about a charmed player
  // may leak into it. These are the exact fields CreatureSim reads to decide
  // that something is a pet.
  assert.equal(victim.charmOwnerUserId, undefined);
  assert.equal(victim.charmedByCharacterId, undefined);
  assert.equal(w.creatures.count(), 0,
    'a pacified PLAYER must never appear in the creature sim');
});
