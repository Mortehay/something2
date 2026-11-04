const test = require('node:test');
const assert = require('node:assert');
const { summarizePreview } = require('../scripts/seed-sync.js');
const { BOARD_SEED_GROUPS } = require('../src/services/seedSync/boardSeedGroups.js');
const { GROUPS } = require('../src/services/seedSync/registry.js');

let n = 0;
const row = (over) => ({ syncUuid: `u${n += 1}`, table: 't', key: 'k', kind: 'changed', defaultDecision: 'git', blockedReason: null, ...over });

test('summarizePreview counts by decision', () => {
  const rows = [
    row({ kind: 'new', defaultDecision: 'git' }),
    row({ kind: 'deleted_in_git', defaultDecision: 'delete' }),
    row({ kind: 'changed', defaultDecision: 'git' }),
    row({ kind: 'edited_here', defaultDecision: null }),
  ];
  assert.deepStrictEqual(summarizePreview(rows, 'git'), { add: 1, change: 1, remove: 1, overwrite: 1 });
});

test('summarizePreview counts a row once, and a kept-local row as nothing', () => {
  const rows = [
    row({ kind: 'not_exported', defaultDecision: 'local' }),
    row({ kind: 'only_here', defaultDecision: 'local' }),
    row({ kind: 'edited_here', defaultDecision: null }),
  ];
  assert.deepStrictEqual(summarizePreview(rows, 'local'), { add: 0, change: 0, remove: 0, overwrite: 0 });
});

test('summarizePreview never counts a blocked row as removed', () => {
  const rows = [
    row({ kind: 'deleted_in_git', defaultDecision: 'delete', blockedReason: 'in_use' }),
    row({ kind: 'new', defaultDecision: 'git', blockedReason: 'owner_missing' }),
    row({ kind: 'edited_here', defaultDecision: null, blockedReason: 'key_clash' }),
  ];
  assert.deepStrictEqual(summarizePreview(rows, 'git'), { add: 0, change: 0, remove: 0, overwrite: 0 });
});

test('summarizePreview without --resolve leaves undecided rows uncounted', () => {
  assert.deepStrictEqual(summarizePreview([row({ kind: 'edited_here', defaultDecision: null })], null),
    { add: 0, change: 0, remove: 0, overwrite: 0 });
});

test('BOARD_SEED_GROUPS is the ordered board list and all ids are registered', () => {
  assert.deepStrictEqual(BOARD_SEED_GROUPS, ['ai_providers', 'tile_types', 'items', 'attack_effects', 'aura_effects',
    'creature_behaviors', 'entities', 'biomes', 'skill_tree', 'progression', 'quests']);
  const ids = new Set(GROUPS.map((g) => g.id));
  for (const g of BOARD_SEED_GROUPS) assert.ok(ids.has(g), g);
});
