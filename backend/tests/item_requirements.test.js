const test = require('node:test');
const assert = require('node:assert');
const {
  gearStatGrants, effectiveStatsFor, meetsRequirements, illegalEquipped, unequipBlockers,
} = require('../src/authority/equipRequirements.js');

// A catalog with exactly the pieces the circularity rule needs:
//  - 20: a chest piece that DEMANDS 20 strength
//  - 21: the buff stone that GRANTS +20 strength
//  - 22: a plain helm with no requirements
//  - 23: a weapon gated on level 40
const TYPES = new Map([
  [20, { id: 20, name: 'giants-plate', category: 'armor', slot: 'chest', defense: 5,
    req_level: 1, req_strength: 20, req_dexterity: 0, req_constitution: 0,
    req_intelligence: 0, req_wisdom: 0, req_charisma: 0 }],
  [21, { id: 21, name: 'stone-of-might', category: 'stone', slot: null,
    stat_bonus_stat: 'strength', stat_bonus_amount: 20 }],
  [22, { id: 22, name: 'plain-helm', category: 'armor', slot: 'head', defense: 1,
    req_level: 1, req_strength: 0, req_dexterity: 0, req_constitution: 0,
    req_intelligence: 0, req_wisdom: 0, req_charisma: 0 }],
  [23, { id: 23, name: 'veteran-blade', category: 'weapon', slot: 'main_hand', two_handed: false,
    kind: 'melee', req_level: 40, req_strength: 0, req_dexterity: 0, req_constitution: 0,
    req_intelligence: 0, req_wisdom: 0, req_charisma: 0 }],
]);

const BASE = {
  strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
};

// The plate carries the +20 STR stone in its own socket.
function selfGrantingInv() {
  return {
    items: [
      { id: 'plate', typeId: 20, socketedStoneTypeId: 21, socketedStoneItemId: 'stone' },
      { id: 'stone', typeId: 21 },
      { id: 'helm', typeId: 22 },
    ],
    equipment: {},
  };
}

test('an item granting +20 STR does NOT satisfy its own 20-STR requirement', () => {
  const inv = selfGrantingInv();
  // Pretend it is already in the chest slot: the check must still exclude it.
  inv.equipment = { chest: 'plate' };
  const stats = effectiveStatsFor(inv, TYPES, BASE, { excludeItemId: 'plate' });
  assert.strictEqual(stats.strength, 5, 'the candidate item contributes nothing to its own gate');
  const r = meetsRequirements(TYPES.get(20), 1, stats);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /strength/i);
});

test('the same stone socketed into a DIFFERENT equipped item does satisfy it', () => {
  const inv = {
    items: [
      { id: 'plate', typeId: 20 },
      { id: 'helm', typeId: 22, socketedStoneTypeId: 21, socketedStoneItemId: 'stone' },
      { id: 'stone', typeId: 21 },
    ],
    equipment: { head: 'helm' },
  };
  const stats = effectiveStatsFor(inv, TYPES, BASE, { excludeItemId: 'plate' });
  assert.strictEqual(stats.strength, 25);            // 5 base + 20 from the helm
  assert.deepStrictEqual(meetsRequirements(TYPES.get(20), 1, stats), { ok: true });
});

test('a stone in an UNEQUIPPED item grants nothing', () => {
  const inv = selfGrantingInv();                     // nothing equipped at all
  assert.deepStrictEqual(gearStatGrants(inv, TYPES), {
    strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0,
  });
});

test('req_level is checked against the character level', () => {
  const r = meetsRequirements(TYPES.get(23), 39, BASE);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /level 40/);
  assert.deepStrictEqual(meetsRequirements(TYPES.get(23), 40, BASE), { ok: true });
});

test('illegalEquipped names every equipped item that no longer qualifies', () => {
  const inv = {
    items: [{ id: 'plate', typeId: 20 }, { id: 'blade', typeId: 23 }, { id: 'helm', typeId: 22 }],
    equipment: { chest: 'plate', main_hand: 'blade', head: 'helm' },
  };
  const bad = illegalEquipped(inv, TYPES, BASE, 1);
  assert.deepStrictEqual(bad.map((b) => b.slot).sort(), ['chest', 'main_hand']);
  assert.deepStrictEqual(bad.map((b) => b.name).sort(), ['giants-plate', 'veteran-blade']);
});

test('unequipBlockers names the item that DEPENDS on the one being removed', () => {
  const inv = {
    items: [
      { id: 'plate', typeId: 20 },
      { id: 'helm', typeId: 22, socketedStoneTypeId: 21, socketedStoneItemId: 'stone' },
      { id: 'stone', typeId: 21 },
    ],
    equipment: { chest: 'plate', head: 'helm' },
  };
  const blockers = unequipBlockers(inv, TYPES, BASE, 1, 'head');
  assert.deepStrictEqual(blockers, [{ slot: 'chest', name: 'giants-plate' }]);
  // Removing the plate itself blocks nothing.
  assert.deepStrictEqual(unequipBlockers(inv, TYPES, BASE, 1, 'chest'), []);
});

// DEVIATION FROM THE PLAN, pinned here. The plan's unequipBlockers reported
// every item illegal AFTER the removal, without asking whether it was already
// illegal BEFORE. A respec deliberately leaves illegal gear equipped (that is
// what the auto-unequip refusal path hands back), so under that version the
// player could not unequip ANYTHING -- every slot would be refused, naming the
// item they were trying to get rid of. Only a NEWLY illegal item is a blocker.
test('an item that is ALREADY illegal does not block unrelated unequips', () => {
  const inv = {
    items: [
      { id: 'plate', typeId: 20 },                   // needs 20 STR, has 5 -- already illegal
      { id: 'helm', typeId: 22 },                    // plain, no requirements
    ],
    equipment: { chest: 'plate', head: 'helm' },
  };
  // The plate is illegal before and after; removing the helm changes nothing
  // about it, so the helm must come off freely.
  assert.deepStrictEqual(unequipBlockers(inv, TYPES, BASE, 1, 'head'), []);
});
