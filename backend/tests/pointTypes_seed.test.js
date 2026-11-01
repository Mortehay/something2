const test = require('node:test');
const assert = require('node:assert');
const {
  POINT_KINDS, POINT_TYPES, VILLAGE_POST_KINDS, villageArtColumn,
  QUEST_GIVER_NAMES, questGiverKey,
} = require('../seeds/data/pointTypes.js');
const { QUESTS, EXPANSION_QUESTS } = require('../seeds/data/questsData.js');

test('every point kind has exactly one seeded placeholder type, except quest givers', () => {
  assert.deepStrictEqual([...POINT_KINDS].sort(), [
    'bank', 'blacksmith', 'chest_field', 'chest_vault', 'gem_merchant', 'merchant',
    'portal', 'quest_giver', 'skill_merchant', 'waypoint',
  ]);
  const byKind = new Map();
  for (const t of POINT_TYPES) {
    assert.ok(POINT_KINDS.includes(t.point_kind), `${t.name} names unknown kind ${t.point_kind}`);
    if (t.point_kind === 'quest_giver') continue;
    assert.ok(!byKind.has(t.point_kind), `two seeded types for ${t.point_kind}`);
    byKind.set(t.point_kind, t);
  }
  assert.strictEqual(byKind.size, POINT_KINDS.length - 1);
});

// SOMET-678. One entity per quest giver; the FIRST is the kind default
// (seed-catalogs fills an empty default from the first row of each kind).
test('quest givers: eight named entities, Elder Eldrin first, keys match quests.npc_key', () => {
  const givers = POINT_TYPES.filter((t) => t.point_kind === 'quest_giver').map((t) => t.name);
  assert.deepStrictEqual(givers, [
    'Elder Eldrin', 'Shadow Hunter', 'Lord Thorn', 'Elder Sunspire',
    'Archon Aether', 'Astronomer Zahir', 'Arch-Druid Elyona', 'Captain Valdor',
  ]);
  assert.deepStrictEqual(QUEST_GIVER_NAMES, givers);
  const keys = givers.map(questGiverKey);
  assert.deepStrictEqual(keys, [
    'elder_eldrin', 'shadow_hunter', 'lord_thorn', 'elder_sunspire',
    'archon_aether', 'astronomer_zahir', 'arch_druid_elyona', 'captain_valdor',
  ]);
  const npcKeys = new Set([...QUESTS, ...EXPANSION_QUESTS].map((q) => q.npc_key).filter(Boolean));
  assert.ok(npcKeys.size >= 7);
  for (const k of npcKeys) assert.ok(keys.includes(k), `quest npc_key ${k} has no giver entity`);
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
  assert.deepStrictEqual(VILLAGE_POST_KINDS, ['merchant', 'bank', 'gem_merchant', 'skill_merchant', 'quest_giver', 'blacksmith']);
  assert.strictEqual(villageArtColumn('blacksmith'), 'blacksmith_entity_type_id');
  assert.strictEqual(villageArtColumn('quest_giver'), 'quest_giver_entity_type_id');
  assert.strictEqual(villageArtColumn('merchant'), 'merchant_entity_type_id');
  assert.strictEqual(villageArtColumn('skill_merchant'), 'skill_merchant_entity_type_id');
  assert.throws(() => villageArtColumn('portal'), /not a village post kind/);
});
