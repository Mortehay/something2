/* eslint-disable camelcase */
// backend/migrations/1714440847000_quest_expansion.js
//
// Quest system expansion. New columns on quests:
//   required_class     entity_types name of a playable class (Mage, Warrior...)
//                      that may take the quest; NULL = anyone.
//   reputation_reward  standing gained with the quest's village on completion.
//   required_reputation  standing with the quest's own village needed to take it.
//   time_limit_sec     challenge: the objective must be met this many seconds
//                      after accepting, otherwise the quest is dropped.
//   pool_group         quests sharing a group form a rotating pool: only a few
//                      are offered each UTC day (deterministic per day).
//   choices            jsonb [{key,label,gold_reward,exp_reward,item_reward}]
//                      for a 'pick' quest - the turn-in is the decision.
// New objective types (varchar(16), no CHECK): collect, chest, skill, reach, pick.
// repeat_kind additionally accepts 'weekly'.
//
// character_quests.started_at drives the time limit; reward_item_name is the
// item a 'pick' choice granted (pendingRewardItems prefers it to the quest's).
// character_reputation is the per-village standing ledger.
//
// The expansion quests themselves are inserted from seeds/data/questsData.js
// (ON CONFLICT DO NOTHING: re-runs and the seeder stay idempotent).
exports.shorthands = undefined;

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE quests
      ADD COLUMN IF NOT EXISTS required_class varchar(32),
      ADD COLUMN IF NOT EXISTS reputation_reward integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS required_reputation integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS time_limit_sec integer,
      ADD COLUMN IF NOT EXISTS pool_group varchar(32),
      ADD COLUMN IF NOT EXISTS choices jsonb;
    ALTER TABLE character_quests
      ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS reward_item_name varchar(64);
    CREATE TABLE IF NOT EXISTS character_reputation (
      character_id integer NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      village_key  varchar(64) NOT NULL,
      points       integer NOT NULL DEFAULT 0,
      PRIMARY KEY (character_id, village_key)
    );
  `);

  const { EXPANSION_QUESTS } = require('../seeds/data/questsData.js');
  for (const q of EXPANSION_QUESTS) {
    pgm.sql(`
      INSERT INTO quests (key, act, title, description, objective, target_count, prerequisite_key,
                          village_key, npc_key, required_level, exp_reward, gold_reward,
                          passive_points_reward, title_reward, objective_type, target_key,
                          is_side, repeat_kind, item_reward, required_class, reputation_reward, required_reputation,
                          time_limit_sec, pool_group, choices)
      VALUES (${lit(q.key)}, ${num(q.act)}, ${lit(q.title)}, ${lit(q.description)},
              ${lit(q.objective || q.description)}, ${num(q.target_count) || 1}, ${lit(q.prerequisite_key)},
              ${lit(q.village_key)}, ${lit(q.npc_key)}, ${num(q.required_level) || 1},
              ${num(q.exp_reward)}, ${num(q.gold_reward)}, ${num(q.passive_points_reward)},
              ${lit(q.title_reward)}, ${lit(q.objective_type)}, ${lit(q.target_key)},
              ${q.is_side ? 'true' : 'false'}, ${lit(q.repeat_kind || 'none')}, ${lit(q.item_reward)},
              ${lit(q.required_class)}, ${num(q.reputation_reward)}, ${num(q.required_reputation)}, ${q.time_limit_sec ? num(q.time_limit_sec) : 'NULL'},
              ${lit(q.pool_group)}, ${q.choices ? `${lit(JSON.stringify(q.choices))}::jsonb` : 'NULL'})
      ON CONFLICT (key) DO NOTHING
    `);
  }
};

exports.down = (pgm) => {
  const { EXPANSION_QUESTS } = require('../seeds/data/questsData.js');
  if (EXPANSION_QUESTS.length) {
    pgm.sql(`DELETE FROM quests WHERE key IN (${EXPANSION_QUESTS.map((q) => lit(q.key)).join(',')})`);
  }
  pgm.sql(`
    DROP TABLE IF EXISTS character_reputation;
    ALTER TABLE character_quests DROP COLUMN IF EXISTS started_at, DROP COLUMN IF EXISTS reward_item_name;
    ALTER TABLE quests
      DROP COLUMN IF EXISTS required_class, DROP COLUMN IF EXISTS reputation_reward, DROP COLUMN IF EXISTS required_reputation,
      DROP COLUMN IF EXISTS time_limit_sec, DROP COLUMN IF EXISTS pool_group, DROP COLUMN IF EXISTS choices;
  `);
};
