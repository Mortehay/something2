const test = require('node:test');
const assert = require('node:assert');
const {
  rarityAffixCount, eligibleAffixes, rollItemInstance, FOXY_VALUE_MULT,
} = require('../src/authority/affixes.js');

// A pool whose numbers are chosen so every expectation below is exact in
// binary floating point.
const POOL = [
  { id: 1, key: 'of_might',  kind: 'buff',   effect: { type: 'stat', stat: 'strength' },
    min_value: 2, max_value: 10, min_item_level: 1, max_item_level: null, allowed_slots: [], min_rarity: 'blue', weight: 100 },
  { id: 2, key: 'of_grace',  kind: 'buff',   effect: { type: 'stat', stat: 'dexterity' },
    min_value: 2, max_value: 10, min_item_level: 1, max_item_level: null, allowed_slots: [], min_rarity: 'blue', weight: 100 },
  { id: 3, key: 'flaming',   kind: 'buff',   effect: { type: 'damage', element: 'fire' },
    min_value: 1, max_value: 25, min_item_level: 20, max_item_level: null, allowed_slots: ['main_hand'], min_rarity: 'yellow', weight: 60 },
  { id: 4, key: 'cursed',    kind: 'debuff', effect: { type: 'status', status: 'chill' },
    min_value: 1, max_value: 4, min_item_level: 40, max_item_level: null, allowed_slots: ['main_hand'], min_rarity: 'foxy', weight: 40 },
  { id: 5, key: 'antique',   kind: 'buff',   effect: { type: 'stat', stat: 'wisdom' },
    min_value: 1, max_value: 3, min_item_level: 1, max_item_level: 20, allowed_slots: [], min_rarity: 'blue', weight: 100 },
];

// A scripted rng: hands back the listed values in order, then repeats the last.
function scripted(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

test('rarityAffixCount matches the grade table', () => {
  assert.strictEqual(rarityAffixCount('white', scripted([0.99])), 0);
  assert.strictEqual(rarityAffixCount('blue', scripted([0.99])), 1);
  // yellow is 3..6 -- four possibilities
  assert.strictEqual(rarityAffixCount('yellow', scripted([0])), 3);
  assert.strictEqual(rarityAffixCount('yellow', scripted([0.999])), 6);
  // foxy is 3..9 -- seven possibilities
  assert.strictEqual(rarityAffixCount('foxy', scripted([0])), 3);
  assert.strictEqual(rarityAffixCount('foxy', scripted([0.999])), 9);
  // an unknown grade grants nothing rather than throwing
  assert.strictEqual(rarityAffixCount('purple', scripted([0.5])), 0);
});

test('eligibleAffixes filters on item level, slot, min rarity and the debuff rule', () => {
  const atLow = eligibleAffixes(POOL, { itemLevel: 5, rarity: 'yellow', slot: 'chest' });
  assert.deepStrictEqual(atLow.map((a) => a.key), ['of_might', 'of_grace', 'antique']);

  // itemLevel 25 puts `antique` past its max_item_level of 20.
  const atMid = eligibleAffixes(POOL, { itemLevel: 25, rarity: 'yellow', slot: 'chest' });
  assert.deepStrictEqual(atMid.map((a) => a.key), ['of_might', 'of_grace']);

  // main_hand at level 25 unlocks `flaming` (slot-restricted, yellow+).
  const hand = eligibleAffixes(POOL, { itemLevel: 25, rarity: 'yellow', slot: 'main_hand' });
  assert.deepStrictEqual(hand.map((a) => a.key), ['of_might', 'of_grace', 'flaming']);

  // A blue item cannot reach a yellow-minimum affix.
  const blue = eligibleAffixes(POOL, { itemLevel: 25, rarity: 'blue', slot: 'main_hand' });
  assert.deepStrictEqual(blue.map((a) => a.key), ['of_might', 'of_grace']);

  // Debuffs are foxy-only, even where every other filter passes.
  const yellow50 = eligibleAffixes(POOL, { itemLevel: 50, rarity: 'yellow', slot: 'main_hand' });
  assert.strictEqual(yellow50.some((a) => a.key === 'cursed'), false);
  const foxy50 = eligibleAffixes(POOL, { itemLevel: 50, rarity: 'foxy', slot: 'main_hand' });
  assert.strictEqual(foxy50.some((a) => a.key === 'cursed'), true);
});

// An admin who mis-authors a debuff's min_rarity must not be able to leak it
// onto a lower grade: the foxy rule is about the GRADE, not about the row.
test('a debuff with min_rarity blue is STILL refused below foxy', () => {
  const leaky = [{ ...POOL[3], min_rarity: 'blue', min_item_level: 1 }];
  for (const rarity of ['blue', 'yellow']) {
    assert.deepStrictEqual(
      eligibleAffixes(leaky, { itemLevel: 50, rarity, slot: 'main_hand' }), [],
      `a debuff leaked onto ${rarity}`,
    );
  }
  assert.strictEqual(
    eligibleAffixes(leaky, { itemLevel: 50, rarity: 'foxy', slot: 'main_hand' }).length, 1,
  );
});

test('a white item rolls no affixes and keeps its item level', () => {
  const out = rollItemInstance(
    { itemType: { id: 9, slot: 'chest' }, itemLevel: 51, rarity: 'white', affixPool: POOL },
    scripted([0.5]),
  );
  assert.deepStrictEqual(out, { rarity: 'white', itemLevel: 51, affixes: [] });
});

test('affix values are hand-checkable: level scaling, then the foxy multiplier', () => {
  // of_might: min 2, max 10, min_item_level 1.
  // roll  = 2 + 0.5 * (10 - 2)          = 6
  // scale = 1 + (51 - 1) / 100          = 1.5
  // blue  = 6 * 1.5                     = 9
  const blue = rollItemInstance(
    { itemType: { id: 9, slot: 'chest' }, itemLevel: 51, rarity: 'blue', affixPool: [POOL[0]] },
    scripted([0, 0.5]),   // [0] picks the only affix, [0.5] is the value roll
  );
  assert.deepStrictEqual(blue.affixes, [{ affixTypeId: 1, key: 'of_might', value: 9 }]);

  // foxy = 6 * 1.5 * 1.25 = 11.25
  const foxy = rollItemInstance(
    { itemType: { id: 9, slot: 'chest' }, itemLevel: 51, rarity: 'foxy', affixPool: [POOL[0]] },
    scripted([0.999, 0, 0.5]),   // [0.999] -> 9 affixes wanted, pool holds 1
  );
  assert.strictEqual(foxy.affixes.length, 1, 'a pool of one cannot yield nine affixes');
  assert.deepStrictEqual(foxy.affixes, [{ affixTypeId: 1, key: 'of_might', value: 11.25 }]);
  assert.strictEqual(FOXY_VALUE_MULT, 1.25);
});

// The scale is measured from the affix's OWN min_item_level, not from 1.
// `cursed` starts at 40, so at item level 40 it carries no inflation at all.
test('the level scale starts at the affix\'s own min_item_level', () => {
  // cursed: min 1, max 4, min_item_level 40.
  // roll  = 1 + 0.5 * (4 - 1)  = 2.5
  // scale = 1 + (40 - 40)/100  = 1
  // foxy  = 2.5 * 1 * 1.25     = 3.125 -> rounded to 3.13
  const at40 = rollItemInstance(
    { itemType: { id: 9, slot: 'main_hand' }, itemLevel: 40, rarity: 'foxy', affixPool: [POOL[3]] },
    scripted([0, 0, 0.5]),   // [0] -> 3 wanted, [0] picks, [0.5] values
  );
  assert.deepStrictEqual(at40.affixes, [{ affixTypeId: 4, key: 'cursed', value: 3.13 }]);

  // At item level 140 the scale is 1 + (140-40)/100 = 2.
  // 2.5 * 2 * 1.25 = 6.25
  const at140 = rollItemInstance(
    { itemType: { id: 9, slot: 'main_hand' }, itemLevel: 140, rarity: 'foxy', affixPool: [POOL[3]] },
    scripted([0, 0, 0.5]),
  );
  assert.deepStrictEqual(at140.affixes, [{ affixTypeId: 4, key: 'cursed', value: 6.25 }]);
});

test('sampling is WITHOUT replacement -- one affix key cannot appear twice', () => {
  const out = rollItemInstance(
    { itemType: { id: 9, slot: 'chest' }, itemLevel: 5, rarity: 'yellow', affixPool: POOL },
    // count roll -> 6 wanted; then every pick/value roll is 0, which without
    // replacement must still walk down the pool rather than re-picking #1.
    scripted([0.999, 0]),
  );
  const keys = out.affixes.map((a) => a.key);
  assert.deepStrictEqual(keys, ['of_might', 'of_grace', 'antique']);
  assert.strictEqual(new Set(keys).size, keys.length);
});

// The no-replacement guarantee must hold for an rng that lands at the TOP of
// the cumulative range too, not only at 0 -- that is the branch where the
// fallthrough index (`remaining.length - 1`) is taken.
test('sampling without replacement also holds at the top of the weight range', () => {
  const out = rollItemInstance(
    { itemType: { id: 9, slot: 'chest' }, itemLevel: 5, rarity: 'yellow', affixPool: POOL },
    // eligible pool is [of_might, of_grace, antique]; rng ~1 walks it backwards.
    scripted([0.999, 0.999999]),
  );
  const keys = out.affixes.map((a) => a.key);
  assert.deepStrictEqual(keys, ['antique', 'of_grace', 'of_might']);
  assert.strictEqual(new Set(keys).size, 3);
});

test('an empty eligible pool yields an item with no affixes rather than throwing', () => {
  const out = rollItemInstance(
    { itemType: { id: 9, slot: 'ring1' }, itemLevel: 1, rarity: 'yellow', affixPool: [POOL[2]] },
    scripted([0.5]),
  );
  assert.deepStrictEqual(out.affixes, []);
});

// SOMET-480 acceptance #4. A debuff affix rides authority/effects.js, whose
// own header explains why: a control-removing effect under refresh semantics
// is a PERMANENT effect. These assertions read the real effects.js, so a
// future affix whose status does not obey those rules fails here rather than
// shipping as a permanent-lock exploit.
test('the debuff affix rides a status effects.js governs with refresh-not-stack', () => {
  const effects = require('../src/authority/effects.js');
  const eff = POOL[3].effect;
  assert.strictEqual(eff.type, 'status');
  // The status must be one effects.js actually knows; an unknown key would
  // make the affix inert (the D1/D2/C2 failure mode) rather than dangerous.
  assert.ok([effects.BURN, effects.CHILL, effects.SHOCK].includes(eff.status),
    `unknown status '${eff.status}'`);

  // Refresh, never stack: re-applying the same key leaves exactly one entry.
  const target = {};
  effects.applyEffect(target, eff.status, { durationMs: 3000, magnitude: 0.6, sourceId: 'w', now: 0 });
  effects.applyEffect(target, eff.status, { durationMs: 3000, magnitude: 0.6, sourceId: 'w', now: 500 });
  assert.strictEqual(target.effects.size, 1, 'a debuff must refresh, not stack');
  assert.strictEqual(target.effects.get(eff.status).until, 3500);

  // And it must not be a control-removing status. `chill` slows; `shock` takes
  // actions away and is only safe because applyShockInterrupt's non-refreshing
  // immunity window gates it. An affix that can be fired on demand must not
  // reach for the control-removing one.
  assert.notStrictEqual(eff.status, effects.SHOCK,
    'a weapon-borne debuff must not be the control-removing status');
});

// If a future affix DOES reach for shock, the anti-chain-lock window is what
// keeps it honest. Pinned here so this file fails if that guarantee is removed.
test('effects.js still refuses to chain-lock an interrupt under sustained fire', () => {
  const effects = require('../src/authority/effects.js');
  const target = {};
  assert.strictEqual(effects.applyShockInterrupt(target, 0), true);
  // A second hit 100ms later -- well inside a fast weapon's cooldown -- must
  // NOT land, and must not push the immunity window forward either.
  assert.strictEqual(effects.applyShockInterrupt(target, 100), false);
  assert.strictEqual(target._shockImmuneUntil, effects.SHOCK_IMMUNITY_MS);
  // The target regains control long before it may be interrupted again.
  assert.ok(effects.SHOCK_INTERRUPT_MS < effects.SHOCK_IMMUNITY_MS);
  assert.strictEqual(effects.canAct(target, effects.SHOCK_INTERRUPT_MS + 1), true);
});
