// backend/scripts/seed-quests.js
//
// Upserts the authored QUESTS catalog into PostgreSQL `quests` table.

const { Pool } = require('pg');
const { QUESTS } = require('../seeds/data/questsData.js');

async function seedQuests() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/game_db',
  });

  try {
    let count = 0;
    for (const q of QUESTS) {
      await pool.query(
        `INSERT INTO quests (key, act, title, description, village_key, npc_key, required_level, exp_reward, gold_reward, passive_points_reward, title_reward)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (key) DO UPDATE SET
           act = EXCLUDED.act,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           village_key = EXCLUDED.village_key,
           npc_key = EXCLUDED.npc_key,
           required_level = EXCLUDED.required_level,
           exp_reward = EXCLUDED.exp_reward,
           gold_reward = EXCLUDED.gold_reward,
           passive_points_reward = EXCLUDED.passive_points_reward,
           title_reward = EXCLUDED.title_reward`,
        [
          q.key, q.act, q.title, q.description, q.village_key, q.npc_key,
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
