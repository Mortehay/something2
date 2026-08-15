// SOMET-329 slice B. Guards on the four option catalogs.
//
// These read the MIGRATION's seed SQL rather than a live database, for the
// same reason clear_maps.test.js reads its script: they must fail in CI and on
// a fresh checkout, not only where someone has already migrated.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../migrations/1714440350000_weapon_option_catalogs.js'), 'utf8',
);
const { ELEMENT_EFFECTS_FOR_TEST } = (() => {
  // effects.js does not export its element->rider table, so the guard below
  // reads the source. Deliberately a source read, not a require: exporting the
  // table purely to test it would widen a module's public surface for the
  // test's convenience, and the constant is a literal that regex matching
  // reads exactly as reliably.
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/effects.js'), 'utf8');
  const block = src.match(/const ELEMENT_EFFECTS = \{([\s\S]*?)\n\};/);
  const names = block ? [...block[1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]) : [];
  return { ELEMENT_EFFECTS_FOR_TEST: names };
})();

// Rows seeded into `elements`, parsed out of the migration's VALUES list.
function seededElements() {
  const block = MIGRATION.match(/INSERT INTO elements[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/);
  assert.ok(block, 'could not find the elements seed');
  return [...block[1].matchAll(/\('([\w]+)',\s*'(#[0-9a-fA-F]{6})',\s*(NULL|'#[0-9a-fA-F]{6}'),\s*'(\w+)',\s*(NULL|'(\w+)')/g)]
    .map((m) => ({
      name: m[1], color: m[2], tint: m[3], damageType: m[4], onHitEffect: m[6] || null,
    }));
}

test('every element the game already uses is seeded', () => {
  // The FK conversion in this migration nulls out any item_types.element it
  // cannot match. A missing seed would therefore silently STRIP the element
  // off live weapons rather than failing the migration.
  const names = seededElements().map((e) => e.name);
  for (const live of ['physical', 'arcane', 'fire', 'ice', 'lightning']) {
    assert.ok(names.includes(live), `element '${live}' is in use but not seeded`);
  }
});

test('element on_hit_effect matches the riders effects.js actually implements', () => {
  // The catalog stores the rider name as data; the RUNTIME still reads its own
  // ELEMENT_EFFECTS table this slice. This guard is what stops the two
  // drifting until the runtime is wired to the column -- a catalog claiming
  // 'ice -> chill' while effects.js has no chill would be a lie nothing else
  // catches.
  assert.ok(ELEMENT_EFFECTS_FOR_TEST.length > 0, 'could not parse ELEMENT_EFFECTS');
  for (const e of seededElements()) {
    if (!e.onHitEffect) continue;
    assert.ok(
      ELEMENT_EFFECTS_FOR_TEST.includes(e.name),
      `elements.${e.name} claims rider '${e.onHitEffect}' but effects.js has no rider for that element`,
    );
  }
  // And the reverse: an element effects.js rides must not be seeded riderless,
  // which would read as "fire does not burn" to anyone reading the catalog.
  const byName = new Map(seededElements().map((e) => [e.name, e]));
  for (const el of ELEMENT_EFFECTS_FOR_TEST) {
    const row = byName.get(el);
    assert.ok(row, `effects.js rides '${el}' but the catalog does not seed it`);
    assert.ok(row.onHitEffect, `effects.js rides '${el}' but the catalog seeds it with no on_hit_effect`);
  }
});

test('physical is seeded with no tint, so an impact keeps its own colour', () => {
  // RenderSystem's retired ELEMENT_TINT mapped physical to null explicitly.
  // Seeding a colour here would tint every physical hit in the game.
  const physical = seededElements().find((e) => e.name === 'physical');
  assert.equal(physical.tint, 'NULL');
  assert.equal(physical.damageType, 'physical');
});

test('no impact behaviour claims max_range until the engine can honour it', () => {
  // THE point of this guard. authority/projectiles.js detonates an AoE shot on
  // its FIRST contact of ANY kind -- terrain, creature, player, or running out
  // of range -- so 'contact' and 'max_range' are today indistinguishable.
  // Seeding a 'max_range' row would put a value in the catalog that the engine
  // silently ignores, which is the exact class of defect this epic exists to
  // remove. Slice C makes the distinction real; this fails the moment someone
  // seeds it early.
  const block = MIGRATION.match(/INSERT INTO impact_behaviors[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/);
  assert.ok(block, 'could not find the impact_behaviors seed');
  assert.ok(
    !/'max_range'/.test(block[1]),
    "an impact_behaviors row seeds detonate_at='max_range', but projectiles.js cannot distinguish it from 'contact' yet",
  );
  // The column must still ACCEPT it -- the constraint is what slice C builds on.
  assert.match(MIGRATION, /detonate_at IN \('contact','max_range'\)/);
});

test('the pre-existing element CHECK is dropped, or the catalog is decorative', () => {
  // element was NOT free text before this slice: 1714440017000 constrained it
  // to a hardcoded five-name list. Adding the FK without dropping that CHECK
  // leaves an admin able to add an `elements` row and still unable to USE it --
  // the write is rejected by a constraint the catalog knows nothing about.
  // This was a real defect in the first cut of this migration, found by
  // attempting the write against the live schema.
  assert.match(MIGRATION, /dropConstraint\('item_types', 'item_types_element_check'\)/);
  // ...and restored on the way down, so a rollback is not a silent widening.
  const down = MIGRATION.slice(MIGRATION.indexOf('exports.down'));
  assert.match(down, /item_types_element_check/);
});

test('the attack_origin CHECK is replaced by an FK, not merely dropped', () => {
  // Dropping the CHECK without adding the FK would leave the column
  // completely unconstrained -- strictly worse than slice A shipped.
  assert.match(MIGRATION, /dropConstraint\('item_types', 'item_types_attack_origin_check'\)/);
  assert.match(MIGRATION, /item_types_attack_origin_fkey/);
  assert.match(MIGRATION, /references: 'attack_origins\(name\)'/);
});

test('both name FKs RESTRICT on delete and CASCADE on rename', () => {
  // RESTRICT matches the existing ammo_type_id convention: deleting a
  // referenced row must fail loudly rather than silently blanking weapons.
  // CASCADE on update is what makes a rename possible at all.
  const fks = [...MIGRATION.matchAll(/references: '(attack_origins|elements)\(name\)',\s*\n\s*onDelete: '(\w+)',\s*\n\s*onUpdate: '(\w+)'/g)];
  assert.equal(fks.length, 2, 'expected exactly two name-keyed FKs');
  for (const [, table, onDelete, onUpdate] of fks) {
    assert.equal(onDelete, 'RESTRICT', `${table} must RESTRICT on delete`);
    assert.equal(onUpdate, 'CASCADE', `${table} must CASCADE on rename`);
  }
});

test('the down migration restores slice A CHECK constraint', () => {
  // Otherwise rolling back lands on a schema with neither the FK nor the
  // CHECK, i.e. an unconstrained column that slice A's tests would still pass
  // against.
  const down = MIGRATION.slice(MIGRATION.indexOf('exports.down'));
  assert.match(down, /item_types_attack_origin_check/);
  assert.match(down, /'feet','middle','head'/);
});
