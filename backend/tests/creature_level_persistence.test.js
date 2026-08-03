const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, CREATURE_DAMAGE } = require('../src/authority/creatures.js');

function simWith(rows) {
  const s = new CreatureSim({ chunkSize: 16 });
  s.addCreatures(rows);
  return s;
}

test('addCreatures carries level and damage from the database row', () => {
  const s = simWith([{ id: 'a', type: 'Wolf', x: 10, y: 10, hp: 21, level: 6, damage: 7.5, color: '#c00' }]);
  const c = s.all()[0];
  assert.equal(c.level, 6);
  assert.equal(c.damage, 7.5);
  assert.equal(c.maxHp, 21, 'maxHp must come from the persisted, already-scaled hp');
});

test('a creature row with no damage falls back to the flat constant', () => {
  // Rows written before this migration have damage defaulted at the column
  // level, but a unit-test row or an older cached entry may omit it entirely.
  const s = simWith([{ id: 'b', type: 'Wolf', x: 0, y: 0, hp: 10, color: '#c00' }]);
  assert.equal(s.all()[0].damage, CREATURE_DAMAGE);
  assert.equal(s.all()[0].level, 1, 'a row with no level reads as level 1');
});

test('the snapshot sent to clients includes level', () => {
  const s = simWith([{ id: 'c', type: 'Wolf', x: 10, y: 20, hp: 21, level: 6, damage: 7.5, color: '#c00' }]);
  const snap = s.snapshotForNeighborhood(['0,0']);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].level, 6, 'the client cannot draw a level it was never sent');
});

test('scaled defense reaches the mitigation the sim actually uses', () => {
  // This is a characterization test, not a regression guard for the SQL bug
  // it was originally written to describe: it builds the row directly and
  // never touches a SELECT, so it cannot detect a query that feeds
  // creatureMitigation the entity type's BASE et.defense instead of the
  // scaled wc.defense -- swapping in the pre-fix creatures.js.addCreatures
  // still passes this test unchanged, because the input row already carries
  // the correct scaled `defense: 4`. What it DOES pin: given a row whose
  // `defense` is already the scaled value, creatureMitigation must build
  // `mit.defense` from it rather than from anything else. The actual guard
  // against the SELECT regressing back to et.defense is the SQL-text assertion
  // in authority_creatures_integration.test.js ("the chunk creature load
  // SELECTs the columns CreatureSim maps into `mit`/level/damage").
  const s = simWith([{ id: 'd', type: 'Wolf', x: 0, y: 0, hp: 30, level: 9, damage: 9, defense: 4, color: '#c00' }]);
  assert.equal(s.all()[0].mit.defense, 4,
    'creatureMitigation must be built from the scaled per-creature defense, not the base type value');
});

test('a creature row with no defense still mitigates rather than crashing', () => {
  // wc.defense is NULL for every creature predating level scaling; the SELECT
  // COALESCEs it to the base, but a fixture or a missing entity type can still
  // deliver undefined, and mit must never come back undefined -- applyDamage
  // treats a missing mit as NO_MITIGATION, silently making resistances inert.
  const s = simWith([{ id: 'e', type: 'Wolf', x: 0, y: 0, hp: 10, color: '#c00' }]);
  assert.equal(s.all()[0].mit.defense, 0);
});
