// B2. Gear the character no longer qualifies for (after a respec, an unallocated
// passive, a lost buff stone) stays EQUIPPED but DORMANT, Path of Exile style:
// it gives nothing -- no armour, no weapon, no affixes, no stone stats -- and the
// only thing left to do with it is take it off. It is NOT auto-unequipped.
const test = require('node:test');
const assert = require('node:assert');
const { dormantGear, illegalEquipped } = require('../src/authority/equipRequirements.js');
const { mitigation, activeWeaponType, activeEquippedId, unequip } = require('../src/authority/items.js');
const { equippedAffixGrants } = require('../src/services/gearAffixes.js');
const { socketedBuffStones } = require('../src/services/stoneBonuses.js');

const NO_REQ = {
  req_level: 1, req_strength: 0, req_dexterity: 0, req_constitution: 0,
  req_intelligence: 0, req_wisdom: 0, req_charisma: 0,
};
const TYPES = new Map([
  // 1: plate that DEMANDS 20 strength, 10 defence, fire resist
  [1, { id: 1, name: 'giants-plate', category: 'armor', slot: 'chest', defense: 10,
    resistances: { fire: 5 }, ...NO_REQ, req_strength: 20 }],
  // 2: plain helm, no requirement
  [2, { id: 2, name: 'plain-helm', category: 'armor', slot: 'head', defense: 3, ...NO_REQ }],
  // 3: a heavy sword gated on 20 strength, 50 damage
  [3, { id: 3, name: 'greatsword', category: 'weapon', slot: 'main_hand', two_handed: false,
    kind: 'melee', damage: 50, ...NO_REQ, req_strength: 20 }],
  // 4: the default fists
  [4, { id: 4, name: 'fists', category: 'weapon', slot: 'main_hand', two_handed: false,
    kind: 'melee', damage: 5, ...NO_REQ }],
  // 5: a +20 strength buff stone
  [5, { id: 5, name: 'stone-of-might', category: 'stone', stat_bonus_stat: 'strength', stat_bonus_amount: 20 }],
  // 6: a ring that is only wearable with the +20 STR the plate-less stone gives
  [6, { id: 6, name: 'strong-ring', category: 'armor', slot: 'ring1', defense: 0, ...NO_REQ, req_strength: 20 }],
]);

const WEAK = { strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 };
const STRONG = { ...WEAK, strength: 25 };

function inv(extra = {}) {
  return {
    items: [
      { id: 'plate', typeId: 1 },
      { id: 'helm', typeId: 2 },
      { id: 'sword', typeId: 3 },
    ],
    equipment: { chest: 'plate', head: 'helm', main_hand: 'sword' },
    ...extra,
  };
}

test('an equipped item the character does not qualify for is reported dormant, the rest are not', () => {
  const d = dormantGear(inv(), TYPES, WEAK, 10);
  assert.deepStrictEqual([...d].sort(), ['plate', 'sword']);
  assert.ok(!d.has('helm'), 'the requirement-free helm stays active');
});

test('the same gear is fully active once the stats are back', () => {
  assert.strictEqual(dormantGear(inv(), TYPES, STRONG, 10).size, 0);
});

test('dormant armour gives no defence and no resistance, but stays on the paper doll', () => {
  const i = inv();
  assert.strictEqual(mitigation(i, TYPES).defense, 13, 'all gear counted while nothing is dormant');
  i.dormant = dormantGear(i, TYPES, WEAK, 10);
  const m = mitigation(i, TYPES);
  assert.strictEqual(m.defense, 3, 'only the helm still counts');
  assert.ok(!m.resistances || !m.resistances.fire, 'the plate\'s fire resist is gone too');
  assert.strictEqual(i.equipment.chest, 'plate', 'NOT unequipped: still worn');
  assert.strictEqual(activeEquippedId(i, 'chest'), undefined);
  assert.strictEqual(activeEquippedId(i, 'head'), 'helm');
});

test('a dormant weapon is not used: the character fights with the default weapon', () => {
  const i = inv();
  assert.strictEqual(activeWeaponType(i, TYPES, 4).name, 'greatsword');
  i.dormant = dormantGear(i, TYPES, WEAK, 10);
  assert.strictEqual(activeWeaponType(i, TYPES, 4).name, 'fists', 'dormant sword falls back to fists');
  assert.strictEqual(i.equipment.main_hand, 'sword', 'but it is still equipped');
});

test('dormant gear contributes no affixes and no socketed stone stats', () => {
  const i = inv();
  i.items[0].affixes = [{ label: 'of Might', effect: { type: 'stat', stat: 'strength' }, value: 3 }];
  i.items[1].affixes = [{ label: 'of Sight', effect: { type: 'stat', stat: 'wisdom' }, value: 2 }];
  i.items[0].socketedStoneTypeId = 5;
  assert.strictEqual(equippedAffixGrants(i).length, 2);
  assert.strictEqual(socketedBuffStones(i, TYPES).length, 1);
  i.dormant = dormantGear(i, TYPES, WEAK, 10);
  assert.deepStrictEqual(equippedAffixGrants(i).map((a) => a.label), ['of Sight'], 'only the active helm\'s affix');
  assert.strictEqual(socketedBuffStones(i, TYPES).length, 0, 'the dormant plate\'s stone is off');
});

test('dormancy is a fixed point: an item that only qualified through another dormant item goes dormant too', () => {
  // The plate holds a +20 STR stone. Without it the ring (20 STR) could not be
  // worn; the plate itself needs 20 STR it can never reach (its own stone is
  // excluded from its own check). So the plate is dormant, its stone stops
  // counting, and the ring -- which only qualified through that stone -- follows.
  const i = {
    items: [
      { id: 'plate', typeId: 1, socketedStoneTypeId: 5 },
      { id: 'ring', typeId: 6 },
    ],
    equipment: { chest: 'plate', ring1: 'ring' },
  };
  // A single pass would call the ring legal (the stone grants +20).
  assert.deepStrictEqual(illegalEquipped(i, TYPES, WEAK, 10).map((b) => b.itemId), ['plate']);
  const d = dormantGear(i, TYPES, WEAK, 10);
  assert.deepStrictEqual([...d].sort(), ['plate', 'ring']);
});

test('level requirements also make gear dormant', () => {
  const i = { items: [{ id: 'h', typeId: 7 }], equipment: { head: 'h' } };
  const types = new Map([[7, { id: 7, name: 'crown', category: 'armor', slot: 'head', defense: 4, ...NO_REQ, req_level: 30 }]]);
  assert.strictEqual(dormantGear(i, types, WEAK, 10).has('h'), true);
  assert.strictEqual(dormantGear(i, types, WEAK, 30).has('h'), false);
});

test('taking a dormant item off still works (the one thing left to do with it)', async () => {
  const i = inv();
  i.dormant = dormantGear(i, TYPES, WEAK, 10);
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push(sql); return { rows: [], rowCount: 1 }; } };
  const r = await unequip(pool, 7, i, 'chest');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(i.equipment.chest, undefined);
});
