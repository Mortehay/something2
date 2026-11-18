'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startQuest } = require('../src/services/questsService.js');

// recordReach only hears about worlds entered AFTER a quest is taken, so a character who had already
// explored the Catacombs had to walk out and back in. Accepting a `reach` quest now counts the worlds
// the character has visited (like the floor quests count the deepest Spire floor).

function stubPool({ visited }) {
  const log = [];
  const quest = { id: 41, key: 'explore_catacombs', title: 'The Catacombs', objective_type: 'reach', target_key: 'The Catacombs',
    target_count: 1, required_level: 8, prerequisite_key: null, required_class: null, required_reputation: 0, pool_group: null };
  return {
    log,
    query: async (sql, params) => {
      log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM quests WHERE key/i.test(sql)) return { rows: [quest] };
      if (/FROM character_quests WHERE character_id = \$1 AND quest_id = \$2/i.test(sql)) {
        return { rows: /INSERT/i.test(log.map((l) => l.sql).join(' ')) ? [{ character_id: 9, quest_id: 41, status: 'active', progress_count: 0 }] : [] };
      }
      if (/FROM player_progression/i.test(sql)) return { rows: [{ level: 10 }] };
      if (/FROM character_visited_worlds/i.test(sql)) return { rows: visited ? [{ '?column?': 1 }] : [] };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('accepting a reach quest credits a world the character has already been in', async () => {
  const pool = stubPool({ visited: true });
  await startQuest(pool, 9, 'explore_catacombs');
  const seed = pool.log.find((l) => /UPDATE character_quests SET progress_count/i.test(l.sql));
  assert.ok(seed, 'progress was seeded');
  assert.deepEqual(seed.params, [9, 41, 1]);
  const visitedQuery = pool.log.find((l) => /character_visited_worlds/i.test(l.sql));
  assert.equal(visitedQuery.params[1], 'The Catacombs');
});

test('and credits nothing for a place never visited', async () => {
  const pool = stubPool({ visited: false });
  await startQuest(pool, 9, 'explore_catacombs');
  assert.equal(pool.log.some((l) => /UPDATE character_quests SET progress_count/i.test(l.sql)), false);
});
