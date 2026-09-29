// backend/tests/sfx_events.test.js
//
// attackKindOf, over the REAL seeded weapon catalog on the scratch DB (a
// read-only SELECT -- no clip/binding rows, so this needs no advisory lock).
// Expectations are hand-written by NAME FAMILY, not derived by calling the
// helper -- a bug in attackKindOf must not also be baked into its own test.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  attackKindOf, skillAttackKind, SFX_CAP,
  weaponUse, weaponHit, creatureUse, creatureHit, creatureHurt, creatureDeath, skillUse,
  pushSfxEvent,
} = require('../src/authority/sfxEvents');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to read from a real database' : false;

// Ordered, first-match-wins. Checked against every weapon row currently in
// the seeded catalog (144, both the legacy hand-authored rows and the
// gear-ladder's 12 families x 10 tiers) before this table was written --
// zero rows matched none of these four patterns. A future catalog row that
// matches none of them fails the test loudly (see the loop below) rather
// than silently passing unclassified.
//
// Order matters: 'quarterstaff' contains the substring 'staff', so the melee
// pattern is checked FIRST -- matching attackKindOf's own kind-before-name
// ordering (its `kind === 'melee'` branch runs before getWeaponCategory).
const FAMILY_RULES = [
  { rx: /blade|sword|axe|mace|spear|dagger|quarterstaff|halberd/, expect: 'melee' },
  // legacy names with no shared family word: knife (dagger-like), stick/club
  // (mace-like), morning star, scythe, pike, unarmed.
  { rx: /knife|stick|club|morning star|scythe|pike|unarmed/, expect: 'melee' },
  { rx: /bow|crossbow|arbalest|sling|dart/, expect: 'ranged' },
  { rx: /wand|staff|scepter|magic-bolt/, expect: 'magic' },
];

function expectedFamily(name) {
  const n = name.toLowerCase();
  const rule = FAMILY_RULES.find((r) => r.rx.test(n));
  return rule ? rule.expect : null;
}

test('attackKindOf: every seeded weapon row, by name family', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(async () => { await pool.end(); });

  const rows = (await pool.query(
    "SELECT name, kind, ammo_type_id, stone_mode FROM item_types WHERE category = 'weapon' ORDER BY name",
  )).rows;
  assert.ok(rows.length > 0, 'precondition: the weapon catalog is seeded');

  const unmatched = [];
  const mismatches = [];
  for (const row of rows) {
    const expected = expectedFamily(row.name);
    if (!expected) { unmatched.push(row.name); continue; }
    // stone_mode is passed through deliberately (see below): a real weapon
    // row's own stone_mode is always 'replace' (item_types_stone_mode_
    // category_check), and attackKindOf must ignore it -- it is not read by
    // the current implementation at all, unlike the version this replaces.
    const actual = attackKindOf({ name: row.name, kind: row.kind, ammo_type_id: row.ammo_type_id, stone_mode: row.stone_mode });
    if (actual !== expected) mismatches.push(`${row.name}: expected ${expected}, got ${actual} (kind=${row.kind}, ammo_type_id=${row.ammo_type_id}, stone_mode=${row.stone_mode})`);
  }

  assert.deepEqual(unmatched, [], `weapon row(s) matching no known name family -- classify them explicitly: ${unmatched.join(', ')}`);
  assert.deepEqual(mismatches, [], `attackKindOf disagreed with the name-family table:\n${mismatches.join('\n')}`);
});

test('attackKindOf: edge cases', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(async () => { await pool.end(); });

  await t.test('a melee row with the catalog default stone_mode (\'replace\') is still melee', async () => {
    const row = (await pool.query(
      "SELECT name, kind, ammo_type_id, stone_mode FROM item_types WHERE category = 'weapon' AND kind = 'melee' LIMIT 1",
    )).rows[0];
    assert.equal(row.stone_mode, 'replace', 'precondition: every non-stone row defaults to replace');
    assert.equal(
      attackKindOf({ name: row.name, kind: row.kind, ammo_type_id: row.ammo_type_id, stone_mode: row.stone_mode }),
      'melee',
    );
  });

  await t.test('a bow with a socketed spell stone (stoneItemId set) is magic, not ranged', async () => {
    const row = (await pool.query(
      "SELECT name, kind, ammo_type_id FROM item_types WHERE category = 'weapon' AND name = 'bow'",
    )).rows[0];
    assert.equal(attackKindOf({ ...row, stoneItemId: 999 }), 'magic');
  });

  await t.test('no weapon at all (unarmed slot) falls back to melee', () => {
    assert.equal(attackKindOf(null), 'melee');
  });
});

// -- The pure event builders (Task 5). No database: these run everywhere.

test('skillAttackKind: melee skills are melee, every other skill type is magic', () => {
  assert.equal(skillAttackKind({ id: 'war_twin_slash', type: 'melee' }), 'melee');
  for (const type of ['magic', 'buff', 'debuff']) {
    assert.equal(skillAttackKind({ id: 'x', type }), 'magic', type);
  }
  assert.equal(skillAttackKind(null), 'magic');
});

// Exactly these keys, in any order, and no undefined/null value anywhere --
// an absent fact is an absent key, never `"s": null` on the wire.
function assertShape(ev, keys) {
  assert.deepEqual(Object.keys(ev).sort(), [...keys].sort());
  for (const [key, value] of Object.entries(ev)) {
    assert.ok(value !== undefined && value !== null, `${key} is ${value}`);
  }
}

test('every builder returns exactly the documented keys', () => {
  const sword = { name: 'crude blade', kind: 'melee' };
  assertShape(weaponUse(sword, 7, 10, 20), ['e', 'k', 's', 'a', 'x', 'y']);
  assert.deepEqual(weaponUse(sword, 7, 10, 20), { e: 'use', k: 'melee', s: 'crude blade', a: 'p:7', x: 10, y: 20 });

  assertShape(weaponHit('ranged', 'bow', 1, 2), ['e', 'k', 's', 'x', 'y']);
  assert.deepEqual(weaponHit('ranged', 'bow', 1, 2), { e: 'hit', k: 'ranged', s: 'bow', x: 1, y: 2 });

  assert.deepEqual(creatureUse({ id: 'c9', type: 'Wolf' }, 3, 4), { e: 'use', c: 'Wolf', a: 'c:c9', x: 3, y: 4 });
  assert.deepEqual(creatureHit('Wolf', 5, 6), { e: 'hit', c: 'Wolf', x: 5, y: 6 });
  assert.deepEqual(creatureHurt('Slime', 5, 6), { e: 'hurt', c: 'Slime', x: 5, y: 6 });
  assert.deepEqual(creatureDeath('Slime', 5, 6), { e: 'death', c: 'Slime', x: 5, y: 6 });

  assert.deepEqual(
    skillUse({ id: 'mag_fireball', type: 'magic' }, 'u1', 7, 8),
    { e: 'use', k: 'magic', s: 'skill:mag_fireball', a: 'p:u1', x: 7, y: 8 },
  );
});

test('absent facts are omitted keys, never undefined or null values', () => {
  // A weapon row with no name (a creature's weapon-shaped flight object, a
  // test double) -- `s` is dropped rather than sent empty.
  assertShape(weaponUse({ kind: 'melee' }, 1, 0, 0), ['e', 'k', 'a', 'x', 'y']);
  assertShape(weaponHit('magic', null, 0, 0), ['e', 'k', 'x', 'y']);
  assertShape(weaponHit('magic', undefined, 0, 0), ['e', 'k', 'x', 'y']);
  // A creature double with no type still yields a well-formed event.
  assertShape(creatureUse({ id: 'c1' }, 0, 0), ['e', 'a', 'x', 'y']);
  assertShape(creatureDeath(undefined, 0, 0), ['e', 'x', 'y']);
});

test('coordinates are whole world pixels', () => {
  const ev = creatureHurt('Wolf', 10.4, 19.6);
  assert.equal(ev.x, 10);
  assert.equal(ev.y, 20);
});

test('pushSfxEvent caps the buffer and drops events with no position', () => {
  const list = [];
  for (let i = 0; i < SFX_CAP + 36; i++) pushSfxEvent(list, creatureHurt('Wolf', i, i));
  assert.equal(SFX_CAP, 64);
  assert.equal(list.length, 64);
  assert.equal(list[63].x, 63, 'overflow drops the NEWEST, the oldest are kept');

  const small = [];
  assert.equal(pushSfxEvent(small, creatureHurt('Wolf', NaN, 0)), false);
  assert.equal(pushSfxEvent(small, null), false);
  assert.equal(small.length, 0);
});
