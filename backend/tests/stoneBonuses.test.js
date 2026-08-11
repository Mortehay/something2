const test = require('node:test');
const assert = require('node:assert');
const { withStoneBonuses, socketedBuffStones } = require('../src/services/stoneBonuses.js');

test('withStoneBonuses adds each buff stone\'s amount to the matching stat, without mutating the input', () => {
  const progression = { strength: 10, dexterity: 5, level: 3 };
  const buffs = [{ stat_bonus_stat: 'strength', stat_bonus_amount: 4 }];
  const result = withStoneBonuses(progression, buffs);
  assert.equal(result.strength, 14);
  assert.equal(result.dexterity, 5);
  assert.equal(progression.strength, 10, 'must not mutate the original progression object');
});

test('withStoneBonuses sums multiple buffs on the same stat', () => {
  const progression = { intelligence: 5 };
  const buffs = [
    { stat_bonus_stat: 'intelligence', stat_bonus_amount: 2 },
    { stat_bonus_stat: 'intelligence', stat_bonus_amount: 3 },
  ];
  assert.equal(withStoneBonuses(progression, buffs).intelligence, 10);
});

test('withStoneBonuses with no buffs returns the same values as the input', () => {
  const progression = { strength: 10, level: 3 };
  assert.deepEqual(withStoneBonuses(progression, []), progression);
});

test('withStoneBonuses defaults buffStones to [] when omitted', () => {
  const progression = { strength: 10 };
  assert.deepEqual(withStoneBonuses(progression), progression);
});

// --- socketedBuffStones ---------------------------------------------------

const BUFF_STONE_TYPE = { id: 100, category: 'stone', element: null, stat_bonus_stat: 'constitution', stat_bonus_amount: 5 };
const SPELL_STONE_TYPE = { id: 101, category: 'stone', element: 'fire', stat_bonus_stat: null, stat_bonus_amount: null };
const WEAPON_TYPE = { id: 1, category: 'weapon' };
const ARMOR_TYPE = { id: 2, category: 'armor', slot: 'chest' };

function typesMap(...types) { return new Map(types.map((t) => [t.id, t])); }

test('socketedBuffStones returns the bonus for a socketed buff stone in an EQUIPPED item', () => {
  const inv = {
    items: [{ id: 'w1', typeId: WEAPON_TYPE.id, socketedStoneTypeId: BUFF_STONE_TYPE.id }],
    equipment: { main_hand: 'w1' },
  };
  const out = socketedBuffStones(inv, typesMap(BUFF_STONE_TYPE, WEAPON_TYPE));
  assert.deepEqual(out, [{ stat_bonus_stat: 'constitution', stat_bonus_amount: 5 }]);
});

test('socketedBuffStones ignores a socketed spell stone (element set, stat_bonus_stat null)', () => {
  const inv = {
    items: [{ id: 'w1', typeId: WEAPON_TYPE.id, socketedStoneTypeId: SPELL_STONE_TYPE.id }],
    equipment: { main_hand: 'w1' },
  };
  const out = socketedBuffStones(inv, typesMap(SPELL_STONE_TYPE, WEAPON_TYPE));
  assert.deepEqual(out, []);
});

test('socketedBuffStones ignores items with no socketed stone', () => {
  const inv = { items: [{ id: 'w1', typeId: WEAPON_TYPE.id }], equipment: { main_hand: 'w1' } };
  const out = socketedBuffStones(inv, typesMap(WEAPON_TYPE));
  assert.deepEqual(out, []);
});

test('socketedBuffStones collects bonuses across multiple EQUIPPED hosts', () => {
  const otherBuff = { id: 102, category: 'stone', element: null, stat_bonus_stat: 'dexterity', stat_bonus_amount: 3 };
  const inv = {
    items: [
      { id: 'w1', typeId: WEAPON_TYPE.id, socketedStoneTypeId: BUFF_STONE_TYPE.id },
      { id: 'a1', typeId: ARMOR_TYPE.id, socketedStoneTypeId: otherBuff.id },
    ],
    equipment: { main_hand: 'w1', chest: 'a1' },
  };
  const out = socketedBuffStones(inv, typesMap(BUFF_STONE_TYPE, otherBuff, WEAPON_TYPE, ARMOR_TYPE));
  assert.deepEqual(out, [
    { stat_bonus_stat: 'constitution', stat_bonus_amount: 5 },
    { stat_bonus_stat: 'dexterity', stat_bonus_amount: 3 },
  ]);
});

// Important #4 fix (SOMET-245 final review): before this fix, socketedBuffStones
// walked ALL of inv.items with no check against inv.equipment -- a buff
// stone socketed into an item sitting loose in the backpack (never
// equipped) contributed its bonus anyway. With one socket per item and no
// cap on carried items, that let a player stack every buff stone they owned
// by socketing each into a spare item and never equipping any of them.
test('socketedBuffStones contributes nothing for a buff stone socketed into an item that is NOT currently equipped', () => {
  const inv = {
    items: [{ id: 'w1', typeId: WEAPON_TYPE.id, socketedStoneTypeId: BUFF_STONE_TYPE.id }],
    equipment: {}, // w1 sits in the backpack, unequipped
  };
  const out = socketedBuffStones(inv, typesMap(BUFF_STONE_TYPE, WEAPON_TYPE));
  assert.deepEqual(out, [], 'a buff stone in an unequipped item must not contribute its bonus');
});

// The exact exploit this closes: TWO buff-stone hosts owned at once, only
// ONE equipped -- only the equipped one's bonus may count.
test('socketedBuffStones does not stack a buff stone from a spare, unequipped item alongside an equipped one', () => {
  const otherBuff = { id: 102, category: 'stone', element: null, stat_bonus_stat: 'dexterity', stat_bonus_amount: 3 };
  const inv = {
    items: [
      { id: 'w1', typeId: WEAPON_TYPE.id, socketedStoneTypeId: BUFF_STONE_TYPE.id }, // equipped
      { id: 'w2', typeId: WEAPON_TYPE.id, socketedStoneTypeId: otherBuff.id }, // spare, in the backpack
    ],
    equipment: { main_hand: 'w1' },
  };
  const out = socketedBuffStones(inv, typesMap(BUFF_STONE_TYPE, otherBuff, WEAPON_TYPE));
  assert.deepEqual(out, [{ stat_bonus_stat: 'constitution', stat_bonus_amount: 5 }],
    'only the equipped host\'s buff stone may contribute -- the spare weapon\'s stone must be silently excluded, not stacked');
});
