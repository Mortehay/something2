// backend/scripts/seed-quests.js
//
// Upserts the authored QUESTS catalog into PostgreSQL `quests` table.

const { Pool } = require('pg');
const { QUESTS } = require('../seeds/data/questsData.js');

async function seedQuests() {
  // DATABASE_URL is set inside the backend container. No fallback: a guessed
  // URL either fails obscurely or writes to the wrong database.
  if (!process.env.DATABASE_URL) {
    console.error('seed-quests: DATABASE_URL is not set; refusing to guess a database.');
    process.exitCode = 1;
    return;
  }
  // The schema (objective, target_count, prerequisite_key) comes from
  // migration 1714440812000_quests_objective_columns. A seeder must not change
  // the schema; run the migrations first.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    let count = 0;
    for (const q of QUESTS) {
      await pool.query(
        `INSERT INTO quests (key, act, title, description, objective, target_count, prerequisite_key, village_key, npc_key, required_level, exp_reward, gold_reward, passive_points_reward, title_reward)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (key) DO UPDATE SET
           act = EXCLUDED.act,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           objective = EXCLUDED.objective,
           target_count = EXCLUDED.target_count,
           prerequisite_key = EXCLUDED.prerequisite_key,
           village_key = EXCLUDED.village_key,
           npc_key = EXCLUDED.npc_key,
           required_level = EXCLUDED.required_level,
           exp_reward = EXCLUDED.exp_reward,
           gold_reward = EXCLUDED.gold_reward,
           passive_points_reward = EXCLUDED.passive_points_reward,
           title_reward = EXCLUDED.title_reward`,
        [
          q.key, q.act, q.title, q.description,
          q.objective || q.description, q.target_count || 1, q.prerequisite_key || null,
          q.village_key, q.npc_key,
          q.required_level, q.exp_reward, q.gold_reward, q.passive_points_reward, q.title_reward,
        ],
      );
      count += 1;
    }
    console.log(`quests: ${count} upserted into database`);
  } catch (err) {
    console.error('Failed to seed quests:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  seedQuests();
}

module.exports = { seedQuests };
