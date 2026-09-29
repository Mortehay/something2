// backend/tests/sfx_events.test.js
//
// Pure, no DB (attackKindOf takes a plain weapon-shaped object). Table asserted
// by hand, not by calling the helper to derive its own expectation.
const test = require('node:test');
const assert = require('node:assert');
const { attackKindOf } = require('../src/authority/sfxEvents');

// One representative weapon per gear-ladder family (backend/seeds/data/
// gearLadder.js GEAR_FAMILIES), shaped exactly as the columns attackKindOf
// reads (kind, ammo_type_id, stoneItemId, augment, stone_mode).
//
// KNOWN GAP, found while writing this table: the gear-ladder generator
// (backend/seeds/generateGearLadder.js) never sets ammo_type_id on its
// bow/crossbow rows, so on the REAL seeded catalog every crude-bow/
// crude-crossbow/.../dragon-bow/dragon-crossbow row (20 rows) reads
// ammo_type_id NULL and attackKindOf classifies it 'magic', not 'ranged' --
// only the three hand-authored legacy rows (bow=25, arbalest=26, sling=27)
// carry a real ammo reference. That is a gearLadder catalog-data gap, not a
// bug in attackKindOf or in this registry: fixing it means adding ammo
// consumption to weapons that never had it, which is a live combat-balance
// change outside this task's file list. This table therefore asserts the
// INTENDED family mapping (bow/crossbow -> ranged) against a WELL-FORMED
// input (ammo_type_id set, matching what a correctly-wired bow row looks
// like) rather than against the live catalog's current, gappy rows -- see
// the task-2 report for the flagged follow-up.
const CASES = [
  // melee families -- kind === 'melee' decides it outright.
  { name: 'blade family',        w: { kind: 'melee', ammo_type_id: null }, expect: 'melee' },
  { name: 'sword family',        w: { kind: 'melee', ammo_type_id: null }, expect: 'melee' },
  { name: 'axe family',          w: { kind: 'melee', ammo_type_id: null }, expect: 'melee' },
  { name: 'mace family',         w: { kind: 'melee', ammo_type_id: null }, expect: 'melee' },
  { name: 'spear family',        w: { kind: 'melee', ammo_type_id: null }, expect: 'melee' },
  { name: 'dagger family',       w: { kind: 'melee', ammo_type_id: null }, expect: 'melee' },
  { name: 'quarterstaff family', w: { kind: 'melee', ammo_type_id: null }, expect: 'melee' },

  // ranged families -- projectile kind WITH an ammo item wired (well-formed
  // shape; see the gap note above for what the live catalog rows carry today).
  { name: 'bow family (ammo wired)',      w: { kind: 'projectile', ammo_type_id: 25 }, expect: 'ranged' },
  { name: 'crossbow family (ammo wired)', w: { kind: 'projectile', ammo_type_id: 26 }, expect: 'ranged' },

  // magic families -- projectile kind, no ammo reference.
  { name: 'wand family',    w: { kind: 'projectile', ammo_type_id: null }, expect: 'magic' },
  { name: 'staff family',   w: { kind: 'projectile', ammo_type_id: null }, expect: 'magic' },
  { name: 'scepter family', w: { kind: 'projectile', ammo_type_id: null }, expect: 'magic' },

  // a socketed spell/augment stone overrides to magic regardless of the
  // host weapon's own kind, even a melee weapon.
  {
    name: 'melee weapon with a socketed spell stone',
    w: { kind: 'melee', ammo_type_id: null, stoneItemId: 42 },
    expect: 'magic',
  },
  {
    name: 'melee weapon with an augment stone',
    w: { kind: 'melee', ammo_type_id: null, augment: { element: 'fire', bonusDamage: 3 } },
    expect: 'magic',
  },
  {
    name: 'a catalog-level stone_mode value (never meaningful on a bare weapon TYPE) still forces magic',
    w: { kind: 'melee', ammo_type_id: null, stone_mode: 'replace' },
    expect: 'magic',
  },

  // edge cases.
  { name: 'no weapon at all (unarmed) falls back to melee', w: null, expect: 'melee' },
];

test('attackKindOf: gear-ladder families and edge cases', () => {
  for (const { name, w, expect: exp } of CASES) {
    assert.equal(attackKindOf(w), exp, name);
  }
});
