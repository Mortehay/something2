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

const { canEquip } = require('../src/authority/items.js');

test('canEquip with no requirement context behaves exactly as before', () => {
  const inv = { items: [{ id: 'blade', typeId: 23 }], equipment: {} };
  assert.deepStrictEqual(canEquip(inv, TYPES, 'blade', 'main_hand'), { ok: true });
});

test('canEquip refuses an item whose level requirement is unmet', () => {
  const inv = { items: [{ id: 'blade', typeId: 23 }], equipment: {} };
  const r = canEquip(inv, TYPES, 'blade', 'main_hand', { level: 39, base: BASE });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'requires level 40');
});

test('canEquip refuses the self-granting plate and accepts it once the stone moves', () => {
  const self = selfGrantingInv();
  assert.strictEqual(canEquip(self, TYPES, 'plate', 'chest', { level: 1, base: BASE }).ok, false);

  const helped = {
    items: [
      { id: 'plate', typeId: 20 },
      { id: 'helm', typeId: 22, socketedStoneTypeId: 21, socketedStoneItemId: 'stone' },
      { id: 'stone', typeId: 21 },
    ],
    equipment: { head: 'helm' },
  };
  assert.deepStrictEqual(canEquip(helped, TYPES, 'plate', 'chest', { level: 1, base: BASE }), { ok: true });
});

// The slot/category rules must still be the ones that answer, and must answer
// FIRST: a player told "requires 20 strength" about a helm they tried to put
// in the chest slot would go hunting for strength instead of fixing the slot.
test('a slot/category refusal outranks a requirement refusal', () => {
  const inv = { items: [{ id: 'plate', typeId: 20 }], equipment: {} };
  const r = canEquip(inv, TYPES, 'plate', 'head', { level: 1, base: BASE });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'that item goes in chest');
});

// Acceptance criterion 5, asserted against the REAL catalog rather than a
// fixture: with the migration's identity defaults, every item type currently
// in the database must stay equippable by a level-1 base-stat character, so
// this change is a no-op for every item that exists today.
test('every catalog row behaves identically with and without the gate', async (t) => {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) { t.skip('no TEST_DATABASE_URL / DATABASE_URL'); return; }
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    t.skip(`NO DATABASE at ${url} (${err.message})`);
    return;
  }
  t.after(async () => { await pool.end().catch(() => {}); });

  // eslint-disable-next-line global-require
  const { loadItemTypes } = require('../src/authority/items.js');
  const types = await loadItemTypes(pool);
  assert.ok(types.size > 0, 'the catalog must not be empty, or this test proves nothing');

  const req = { level: 1, base: BASE };
  let checked = 0;
  for (const type of types.values()) {
    // Only equippable categories have a paper-doll slot to be gated on.
    const slot = type.category === 'weapon' ? 'main_hand' : type.slot;
    if (!slot) continue;
    const inv = { items: [{ id: 'probe', typeId: type.id }], equipment: {} };
    const withReq = canEquip(inv, types, 'probe', slot, req);
    const without = canEquip(inv, types, 'probe', slot, null);
    assert.deepStrictEqual(withReq, without,
      `${type.name} (id ${type.id}) must behave identically with and without a requirement context`);
    checked += 1;
  }
  assert.ok(checked > 0, 'no equippable catalog rows were checked -- the assertion would be vacuous');
});
