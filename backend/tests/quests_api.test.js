const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('../src/index.js');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@db:5432/game_db'
});

after(async () => {
  await pool.end();
});

test('GET /api/quests returns all seeded quests (Act I to IV)', async () => {
  const res = await request(app).get('/api/quests');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body && res.body.ok);
  assert.ok(Array.isArray(res.body.quests));
  assert.ok(res.body.quests.length >= 8, 'Expected at least 8 seeded quests');

  const act1 = res.body.quests.find(q => q.key === 'act1_core_whisper');
  assert.ok(act1, 'Expected Act I quest act1_core_whisper');
  assert.strictEqual(act1.act, 1);
  assert.strictEqual(act1.village_key, 'sunspire');

  const act4 = res.body.quests.find(q => q.key === 'act4_new_dawn');
  assert.ok(act4, 'Expected Act IV quest act4_new_dawn');
  assert.strictEqual(act4.act, 4);
});

test('POST /api/quests/start and /complete updates character progression and sets legacy choice', async () => {
  // 1. Create a temporary user and character
  const userRes = await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'hash', 'player') RETURNING id`,
    [`test_quest_hero_${Date.now()}`]
  );
  const userId = userRes.rows[0].id;

  const charRes = await pool.query(
    `INSERT INTO characters (user_id, name, slot, entity_type_id)
     VALUES ($1, $2, 1, (SELECT id FROM entity_types WHERE is_playable = true LIMIT 1)) RETURNING id`,
    [userId, `Hero_${Date.now()}`]
  );
  const charId = charRes.rows[0].id;

  // Initialize player progression
  await pool.query(
    `INSERT INTO player_progression (character_id, level, experience, passive_points, legacy_choice)
     VALUES ($1, 40, 50000, 5, NULL)
     ON CONFLICT (character_id) DO UPDATE SET level = 40`,
    [charId]
  );

  // 2. Fetch quests to get quest ids
  const questsRes = await pool.query(`SELECT id, key FROM quests WHERE key = 'act4_new_dawn'`);
  assert.ok(questsRes.rows.length > 0);
  const act4Id = questsRes.rows[0].id;

  // 3. Start Act IV quest
  const startRes = await request(app)
    .post('/api/quests/start')
    .send({ characterId: charId, questId: act4Id });
  assert.strictEqual(startRes.status, 200);
  assert.strictEqual(startRes.body.questState.status, 'active');

  // 4. Complete Act IV with permanent legacy choice 'city_restoration'
  const completeRes = await request(app)
    .post('/api/quests/complete')
    .send({
      characterId: charId,
      questId: act4Id,
      legacyChoice: 'city_restoration',
    });

  assert.strictEqual(completeRes.status, 200);
  assert.strictEqual(completeRes.body.status, 'completed');
  assert.strictEqual(completeRes.body.legacyChoice, 'city_restoration');

  // Verify DB state
  const progRes = await pool.query(
    `SELECT legacy_choice, passive_points FROM player_progression WHERE character_id = $1`,
    [charId]
  );
  assert.strictEqual(progRes.rows[0].legacy_choice, 'city_restoration');
  assert.ok(progRes.rows[0].passive_points >= 7, 'Expected rewarded passive points');

  // Clean up
  await pool.query(`DELETE FROM character_quests WHERE character_id = $1`, [charId]);
  await pool.query(`DELETE FROM player_progression WHERE character_id = $1`, [charId]);
  await pool.query(`DELETE FROM characters WHERE id = $1`, [charId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
});
