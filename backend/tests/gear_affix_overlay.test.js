// backend/tests/gear_affix_overlay.test.js
//
// SOMET-496, the PURE half. services/gearAffixes.js is the runtime overlay
// that finally hands composeStats the gear it always accepted and never got.
//
// Every expected number here is HAND-WRITTEN from the formulas in
// progressionConstants.js, never re-summed from the inputs the code sums.
// Nothing below asserts on `sources` alone: `sources` is exactly what already
// looked right while the game ignored it, so every claim about a stat being
// LIVE is made through derivePlayerStats.
const test = require('node:test');
const assert = require('node:assert');

const { composeStats, withComposedStats } = require('../src/services/statComposition.js');
const { equippedAffixGrants, withGearAffixes } = require('../src/services/gearAffixes.js');
const { derivePlayerStats } = require('../src/services/playerStats.js');
const { withStoneBonuses } = require('../src/services/stoneBonuses.js');

const BASE = {
  strength: 5, dexterity: 5, constitution: 5,
  intelligence: 5, wisdom: 5, charisma: 5,
};

// What passiveTreeStore#composeProgression produces, minus the database. It
// shares withComposedStats with the real one, so a row built here has the same
// shape the overlay will meet in production.
function composedRow(passives) {
  return withComposedStats(
    { ...BASE, level: 12, experience: 0, passive_points: 0 },
    composeStats({ base: BASE, passives, gear: [] }),
  );
}

const WARRIOR = { maxHp: 100, maxMana: 100 };

function affix(effect, value, label) {
  return { affixTypeId: 1, key: 'k', label, value, effect };
}

// ---------------------------------------------------------------------------
// equippedAffixGrants: what the overlay is handed
// ---------------------------------------------------------------------------

test('only EQUIPPED items contribute their affixes', () => {
  const worn = { id: 'worn', typeId: 1, affixes: [affix({ type: 'stat', stat: 'intelligence' }, 6, 'of Insight')] };
  const spare = { id: 'spare', typeId: 1, affixes: [affix({ type: 'stat', stat: 'intelligence' }, 99, 'of Cheating')] };

  const grants = equippedAffixGrants({ items: [worn, spare], equipment: { main_hand: 'worn' } });
  assert.deepStrictEqual(grants,
    [{ label: 'of Insight', effect: { type: 'stat', stat: 'intelligence' }, value: 6 }]);

  // The negative half. Without it, "reads inv.items" would pass the assertion
  // above and let a player stack every affix they own by carrying the items.
  assert.deepStrictEqual(equippedAffixGrants({ items: [worn, spare], equipment: {} }), []);
});

test('a non-stat affix is carried through, not filtered out', () => {
  // equipRequirements#gearStatGrants keeps only `stat` affixes because six
  // numbers are all the equip gate can use. Doing the same here would ship
  // SOMET-495's defect one layer down: a +40 hp affix with no consumer.
  const item = {
    id: 'i',
    affixes: [
      affix({ type: 'resource', pool: 'hp' }, 40, 'of the Bear'),
      affix({ type: 'damage', element: 'fire' }, 20, 'Flaming'),
      affix({ type: 'resist', element: 'ice' }, 15, 'of Warding'),
      affix({ type: 'status', status: 'burn' }, 1, 'Searing'),
    ],
  };
  const kinds = equippedAffixGrants({ items: [item], equipment: { chest: 'i' } })
    .map((g) => g.effect.type);
  assert.deepStrictEqual(kinds, ['resource', 'damage', 'resist', 'status']);
});

test('an affix with no label falls back to its catalog key', () => {
  const item = { id: 'i', affixes: [{ key: 'of_might', value: 3, effect: { type: 'stat', stat: 'strength' } }] };
  assert.strictEqual(
    equippedAffixGrants({ items: [item], equipment: { chest: 'i' } })[0].label, 'of_might',
  );
});

// ---------------------------------------------------------------------------
// The overlay itself
// ---------------------------------------------------------------------------

// THE TICKET. Hand-computed against progressionConstants: a Warrior bases at
// 100 mana, MANA_PER_INT is 10 and SPELL_PER_INT is 0.05, both measured from
// BASE_STAT = 5. INT 5 -> 100 mana, x1.00. INT 11 -> 100 + 10*6 = 160 mana,
// and 1 + 0.05*6 = x1.30.
test('a +6 INT affix raises INT, max mana AND the spell multiplier', () => {
  const row = composedRow([]);
  const bare = derivePlayerStats(row, WARRIOR);
  assert.strictEqual(bare.maxMana, 100);
  assert.strictEqual(bare.spellMult, 1);

  const geared = withGearAffixes(row, [
    { label: 'of Insight', effect: { type: 'stat', stat: 'intelligence' }, value: 6 },
  ]);
  const stats = derivePlayerStats(geared, WARRIOR);
  assert.strictEqual(geared.intelligence, 11);
  assert.strictEqual(stats.maxMana, 160);
  assert.strictEqual(stats.spellMult, 1.3);

  // Unequipping is the same call with an empty list -- the overlay is
  // recomputed per frame, never accumulated.
  const back = derivePlayerStats(withGearAffixes(row, []), WARRIOR);
  assert.strictEqual(back.maxMana, 100);
  assert.strictEqual(back.spellMult, 1);
});

// NO DOUBLE COUNTING. Base 5 + tree 4 + gear 6 = INT 15, ONCE.
// maxMana  = 100 + 10 * (15 - 5) = 200
// spellMult= 1 + 0.05 * (15 - 5) = 1.5
// A row that folded gear in twice would read INT 21, 260 mana and x1.8.
test('a passive and an affix on the same stat are counted once each', () => {
  const row = composedRow([{ type: 'stat', stat: 'intelligence', value: 4, label: 'Study' }]);
  // Tree alone: INT 9 -> 100 + 10 * (9 - 5) = 140.
  assert.strictEqual(derivePlayerStats(row, WARRIOR).maxMana, 140);

  const geared = withGearAffixes(row, [
    { label: 'of Insight', effect: { type: 'stat', stat: 'intelligence' }, value: 6 },
  ]);
  const stats = derivePlayerStats(geared, WARRIOR);
  assert.strictEqual(geared.intelligence, 15);
  assert.strictEqual(stats.maxMana, 200);
  assert.strictEqual(stats.spellMult, 1.5);
  assert.deepStrictEqual(geared.sources.intelligence, { base: 5, tree: 4, gear: 6 });
});

test('applying the overlay twice replaces the gear half rather than doubling it', () => {
  const row = composedRow([{ type: 'stat', stat: 'intelligence', value: 4, label: 'Study' }]);
  const gear = [{ label: 'of Insight', effect: { type: 'stat', stat: 'intelligence' }, value: 6 }];
  const once = withGearAffixes(row, gear);
  const twice = withGearAffixes(once, gear);
  assert.strictEqual(twice.intelligence, 15);
  assert.strictEqual(derivePlayerStats(twice, WARRIOR).maxMana, 200);
});

// The tree's OTHER grant kinds have to survive the recompose. The overlay
// rebuilds the row from `sources` + the tree modifiers, so a kind that does
// not round-trip through modifierToEntry silently disappears the moment the
// player equips anything at all -- a passive-tree regression triggered by gear.
test('the tree half survives the recompose intact, every grant kind', () => {
  const row = composedRow([
    { type: 'stat', stat: 'constitution', value: 3, label: 'Toughness' },
    { type: 'resource', pool: 'hp', value: 40, label: 'Thick Skin' },
    { type: 'resource', pool: 'stamina', value: 25, label: 'Wind' },
    { type: 'damage', element: 'fire', value: 35, label: 'Pyromancy' },
    { type: 'resist', element: 'ice', value: 12, label: 'Frostward' },
    { type: 'status', status: 'burn', value: 1, label: 'Searing Blows' },
    { type: 'rule', rule: 'lifeCostMultiplier', value: 0.75, label: 'Blood Pact' },
    { type: 'rule', rule: 'cooldownFloor', value: 0.36, label: 'Nimble' },
  ]);
  const before = derivePlayerStats(row, WARRIOR);
  // Hand-computed: CON 8 -> 100 + 10*3 = 130, +40 flat = 170. Stamina 100 + 25.
  assert.strictEqual(before.maxHp, 170);
  assert.strictEqual(before.maxStamina, 125);
  assert.strictEqual(before.damageMult.fire, 1.35);
  assert.strictEqual(before.resists.ice, 0.12);
  assert.deepStrictEqual(before.hitStatuses, ['burn']);
  assert.strictEqual(before.lifeCostMultiplier, 0.75);

  const after = derivePlayerStats(
    withGearAffixes(row, [{ label: 'of Insight', effect: { type: 'stat', stat: 'intelligence' }, value: 6 }]),
    WARRIOR,
  );
  assert.strictEqual(after.maxHp, 170, 'the tree half must not move when gear is folded in');
  assert.strictEqual(after.maxStamina, 125);
  assert.strictEqual(after.damageMult.fire, 1.35);
  assert.strictEqual(after.resists.ice, 0.12);
  assert.deepStrictEqual(after.hitStatuses, ['burn']);
  assert.strictEqual(after.lifeCostMultiplier, 0.75);
  assert.strictEqual(after.maxMana, 160, 'and the gear half must be live');
});

// The recompose has to be EXACTLY what a from-scratch composition would have
// produced. This is the fixed point that makes every other assertion above
// safe: no merge arithmetic, no second copy of composeStats' combination
// rules.
test('recomposing a composed row equals composing base+tree+gear in one pass', () => {
  const passives = [
    { type: 'stat', stat: 'constitution', value: 3, label: 'Toughness' },
    { type: 'resource', pool: 'hp', value: 40, label: 'Thick Skin' },
    { type: 'damage', element: 'fire', value: 35, label: 'Pyromancy' },
    { type: 'resist', element: 'ice', value: -15, label: 'Glass Cannon' },
    { type: 'status', status: 'chill', value: 1, label: 'Jarring Blows' },
    { type: 'rule', rule: 'lifeCostMultiplier', value: 0.75, label: 'Blood Pact' },
    { type: 'rule', rule: 'treeCharmBonus', value: 5, label: 'Beast Bond' },
    { type: 'rule', rule: 'cooldownFloor', value: 0.36, label: 'Nimble' },
    { type: 'rule', rule: 'regenLifeShare', value: 0.2, label: 'Sanguine' },
  ];
  const gear = [
    { label: 'of Insight', effect: { type: 'stat', stat: 'intelligence' }, value: 6 },
    { label: 'of the Bear', effect: { type: 'resource', pool: 'hp' }, value: 25 },
    { label: 'Flaming', effect: { type: 'damage', element: 'fire' }, value: 20 },
    { label: 'of Warding', effect: { type: 'resist', element: 'ice' }, value: 18 },
    { label: 'Searing', effect: { type: 'status', status: 'burn' }, value: 1 },
  ];

  const oneShot = composeStats({ base: BASE, passives, gear });
  const overlaid = withGearAffixes(composedRow(passives), gear);

  for (const k of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
    assert.strictEqual(overlaid[k], oneShot[k], k);
  }
  assert.deepStrictEqual(overlaid.sources, oneShot.sources);
  assert.deepStrictEqual(overlaid.modifiers, oneShot.modifiers);
  assert.deepStrictEqual(overlaid.rules, oneShot.rules);
  assert.deepStrictEqual(overlaid.pools, oneShot.pools);
  assert.deepStrictEqual(overlaid.damageMult, oneShot.damageMult);
  assert.deepStrictEqual(overlaid.resists, oneShot.resists);
  assert.deepStrictEqual(overlaid.hitStatuses, oneShot.hitStatuses);

  // And the recompose is not vacuously equal because both sides are empty.
  assert.ok(oneShot.modifiers.length === 14, 'the fixture must actually carry grants');
  assert.strictEqual(oneShot.damageMult.fire, 1.55);
  assert.strictEqual(oneShot.resists.ice, 0.03);
  assert.deepStrictEqual(oneShot.hitStatuses, ['burn', 'chill']);
});

// A row that never went through composeProgression (DEFAULT_PROGRESSION, a
// hand-built fixture) has no `sources`. Its six columns ARE the base, and the
// overlay must add to them rather than resetting them to BASE_STAT.
test('a raw row with no `sources` takes its six columns as the base', () => {
  const raw = { ...BASE, strength: 22, level: 30 };
  const out = withGearAffixes(raw, [
    { label: 'of Might', effect: { type: 'stat', stat: 'strength' }, value: 8 },
  ]);
  assert.strictEqual(out.strength, 30);
  // meleeMult = 1 + 0.05 * (30 - 5) = 2.25
  assert.strictEqual(derivePlayerStats(out, WARRIOR).meleeMult, 2.25);
});

test('an empty gear list returns the row untouched, by identity', () => {
  const row = composedRow([]);
  assert.strictEqual(withGearAffixes(row, []), row);
});

// ---------------------------------------------------------------------------
// The hazard the frame boundary has to respect
// ---------------------------------------------------------------------------

// withGearAffixes REBUILDS the six top-level keys, so it destroys whatever an
// earlier overlay wrote onto them. server.js folds gear first and the buff
// stones on top; progression_frame_shape.test.js pins that literal order in
// the source. This is the same fact stated in numbers, so the cost of getting
// it wrong is visible rather than a regex away.
//
// CON 5 base + 7 affix + 5 stone = 17 -> maxHp = 100 + HP_PER_CON 10 * 12 = 220.
// Reversed, the stone is discarded: CON 12 -> maxHp = 100 + 10 * 7 = 170.
test('gear folds in FIRST and the buff stones on top, or the stones vanish', () => {
  const row = composedRow([]);
  const gear = [{ label: 'of the Ox', effect: { type: 'stat', stat: 'constitution' }, value: 7 }];
  const stones = [{ stat_bonus_stat: 'constitution', stat_bonus_amount: 5 }];

  const correct = withStoneBonuses(withGearAffixes(row, gear), stones);
  assert.strictEqual(correct.constitution, 17);
  assert.strictEqual(derivePlayerStats(correct, WARRIOR).maxHp, 220);

  const reversed = withGearAffixes(withStoneBonuses(row, stones), gear);
  assert.strictEqual(reversed.constitution, 12, 'the reversed order silently drops the stone');
  assert.strictEqual(derivePlayerStats(reversed, WARRIOR).maxHp, 170);
});
