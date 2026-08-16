const test = require('node:test');
const assert = require('node:assert');
const {
  resolveAttackOrigin, bodyLift, attackLift, originFractions,
  configureAttackOrigins, resetAttackOrigins,
} = require('../src/authority/attackOrigin.js');

// SOMET-329 made the fractions admin data. Every test below asserts against
// the SEEDED defaults, so any test that configures a catalog must put them
// back -- otherwise it leaks into whatever runs next in the same process.
test.afterEach(() => resetAttackOrigins());

test('an authored origin wins over the kind default', () => {
  assert.equal(resolveAttackOrigin({ kind: 'projectile', attack_origin: 'head' }), 'head');
  assert.equal(resolveAttackOrigin({ kind: 'melee', attack_origin: 'feet' }), 'feet');
});

test('an unauthored weapon falls to its kind default', () => {
  assert.equal(resolveAttackOrigin({ kind: 'melee', attack_origin: null }), 'middle');
  assert.equal(resolveAttackOrigin({ kind: 'projectile' }), 'middle');
});

test('junk degrades to middle rather than throwing or reading as feet', () => {
  // `feet` is the dangerous wrong answer: it is a real origin whose lift is 0,
  // so a bad value that resolved to it would put every attack on the ground
  // and look like a deliberate authoring choice rather than a bug.
  for (const junk of [{}, null, undefined, { attack_origin: 'HEAD' }, { attack_origin: 42 },
    { attack_origin: '' }, { kind: 'siege', attack_origin: 'shoulder' }]) {
    assert.equal(resolveAttackOrigin(junk), 'middle', `junk: ${JSON.stringify(junk)}`);
  }
});

test('the lift is a fraction of the BODY, not of the tile', () => {
  // The whole defect in one assertion. The old code lifted every attack by
  // ISO_TILE_H/2 = 32px regardless of who swung it. That is 50% of a 64px
  // player but 67% of a 48px creature -- which is why a creature's attacks
  // read as coming from its head while a player's read as mid-body.
  assert.equal(bodyLift(64, 'middle'), 32, 'a 64px player: unchanged from the old constant');
  assert.equal(bodyLift(48, 'middle'), 24, 'a 48px creature: 24, NOT the old 32');
  assert.notEqual(bodyLift(48, 'middle'), 32, 'the tile constant must no longer leak in');
});

test('each origin lands where its name claims', () => {
  assert.equal(bodyLift(64, 'feet'), 0);
  assert.equal(bodyLift(64, 'middle'), 32);
  assert.equal(bodyLift(64, 'head'), 54);       // 0.85 * 64, rounded
  // Ordered, and strictly so -- an authored `head` that did not actually sit
  // above `middle` would satisfy every individual assertion above.
  assert.ok(bodyLift(64, 'feet') < bodyLift(64, 'middle'));
  assert.ok(bodyLift(64, 'middle') < bodyLift(64, 'head'));
});

test('head stays inside the sprite', () => {
  // 0.85, not 1.0: a lift equal to the body height sits ON the top edge of the
  // sprite rect, which reads as floating above the head rather than at it.
  for (const h of [32, 48, 64, 96, 128]) {
    assert.ok(bodyLift(h, 'head') < h, `head lift must stay below the sprite top for h=${h}`);
  }
});

test('an unusable body height falls back to the 64px player box', () => {
  // Never 0: a 0 lift is `feet`, so a missing height would silently relocate
  // every attack to the ground instead of degrading to today's appearance.
  for (const bad of [0, -10, NaN, null, undefined, 'tall']) {
    assert.equal(bodyLift(bad, 'middle'), 32, `bad height: ${String(bad)}`);
  }
});

test('attackLift composes resolution and measurement', () => {
  assert.equal(attackLift({ kind: 'projectile', attack_origin: 'head' }, 64), 54);
  assert.equal(attackLift({ kind: 'melee' }, 48), 24);
  // An unauthored weapon swung by a default-size player is exactly the old
  // hardcoded constant -- this is AC 3 (no existing content changes look).
  assert.equal(attackLift({ kind: 'melee' }, 64), 32);
});

test('every fraction in the table is a usable 0..1', () => {
  for (const [name, f] of Object.entries(originFractions())) {
    assert.ok(Number.isFinite(f) && f >= 0 && f <= 1, `${name} = ${f}`);
  }
});

// ---------------------------------------------------------------------------
// SOMET-329: the fractions are catalog data now.
// ---------------------------------------------------------------------------

test('a configured catalog actually moves where attacks launch from', () => {
  // The point of making this data: an admin editing height_fraction must
  // change the game, not just the row.
  configureAttackOrigins(new Map([['feet', 0], ['middle', 0.25], ['head', 0.9]]));
  assert.equal(bodyLift(64, 'middle'), 16, 'not the seeded 32 -- the catalog wins');
  assert.equal(bodyLift(64, 'head'), 58);
});

test('a catalog can introduce an origin the code never knew about', () => {
  configureAttackOrigins({ feet: 0, middle: 0.5, head: 0.85, shoulder: 0.7 });
  assert.equal(resolveAttackOrigin({ attack_origin: 'shoulder' }), 'shoulder');
  assert.equal(bodyLift(64, 'shoulder'), 45);
});

test('an empty or junk catalog is ignored, never applied', () => {
  // Applying an empty table would leave bodyLift with no fractions at all,
  // and its `middle` fallback would resolve to undefined -> NaN on the wire.
  for (const junk of [null, undefined, new Map(), {}, { middle: 'half' }, { '': 0.5 }, { middle: 4 }, { middle: -1 }]) {
    configureAttackOrigins(junk);
    assert.equal(bodyLift(64, 'middle'), 32, `junk catalog: ${JSON.stringify(junk)}`);
  }
});

test('a catalog missing middle still cannot produce NaN', () => {
  // An admin may delete rows. `middle` is the fallback every unauthored
  // weapon resolves to, so losing it is the one deletion that could take the
  // whole game's attack rendering down.
  configureAttackOrigins({ feet: 0, head: 0.85 });
  const lift = bodyLift(64, 'middle');
  assert.ok(Number.isFinite(lift), `expected a finite lift, got ${lift}`);
  assert.equal(lift, 32, 'falls back to the SEEDED middle');
  assert.ok(Number.isFinite(attackLift({ kind: 'melee' }, 48)));
});
