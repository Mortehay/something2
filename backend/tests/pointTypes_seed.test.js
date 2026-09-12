const test = require('node:test');
const assert = require('node:assert');
const {
  POINT_KINDS, POINT_TYPES, VILLAGE_POST_KINDS, villageArtColumn,
} = require('../seeds/data/pointTypes.js');

test('every point kind has exactly one seeded placeholder type', () => {
  assert.deepStrictEqual([...POINT_KINDS].sort(), [
    'bank', 'chest_field', 'chest_vault', 'gem_merchant', 'merchant',
    'portal', 'skill_merchant', 'waypoint',
  ]);
  const byKind = new Map();
  for (const t of POINT_TYPES) {
    assert.ok(POINT_KINDS.includes(t.point_kind), `${t.name} names unknown kind ${t.point_kind}`);
    assert.ok(!byKind.has(t.point_kind), `two seeded types for ${t.point_kind}`);
    byKind.set(t.point_kind, t);
  }
  assert.strictEqual(byKind.size, POINT_KINDS.length);
});

test('seeded point types are never decorations or creatures', () => {
  for (const t of POINT_TYPES) {
    assert.strictEqual(t.is_creature, false, t.name);
    assert.deepStrictEqual(t.spawn_tiles, [], `${t.name} must not be scattered by generateChunkDecorations`);
    assert.strictEqual(t.render_mode, 'rect', `${t.name} ships without art`);
    assert.ok(typeof t.prompt === 'string' && t.prompt.length > 20, `${t.name} needs a prompt the editor can generate from`);
    assert.ok(Number.isInteger(t.display_width) && t.display_width > 0, t.name);
    assert.ok(Number.isInteger(t.display_height) && t.display_height > 0, t.name);
  }
});

test('village post kinds map to their villages column', () => {
  assert.deepStrictEqual(VILLAGE_POST_KINDS, ['merchant', 'bank', 'gem_merchant', 'skill_merchant']);
  assert.strictEqual(villageArtColumn('merchant'), 'merchant_entity_type_id');
  assert.strictEqual(villageArtColumn('skill_merchant'), 'skill_merchant_entity_type_id');
  assert.throws(() => villageArtColumn('portal'), /not a village post kind/);
});
