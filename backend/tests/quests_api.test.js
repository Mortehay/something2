require('./helpers/auth.js');
const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { QUESTS } = require('../seeds/data/questsData.js');
const { levelForXp } = require('../src/services/playerStats.js');

// This file inserts users/characters, so it must never fall back to the
// default DATABASE_URL: no TEST_DATABASE_URL, no run (a CI run must fail).
const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL is required in CI for quests_api.test.js');
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

// The app under test must read and write the same DB the assertions use.
const pool = url ? new Pool({ connectionString: url }) : null;
if (pool) __setPool(pool);
after(async () => { if (pool) await pool.end(); });

test('GET /api/quests returns all seeded quests (Act I to IV)', { skip }, async () => {
  const res = await request(app).get('/api/quests');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body && res.body.ok);
  assert.ok(Array.isArray(res.body.quests));
  assert.ok(res.body.quests.length > 0, 'quests table is empty: seed quests first (node scripts/seed-quests.js)');
  assert.ok(res.body.quests.length >= 8, 'Expected at least 8 seeded quests: seed quests first (node scripts/seed-quests.js)');

  const act1 = res.body.quests.find(q => q.key === 'act1_core_whisper');
  assert.ok(act1, 'Expected Act I quest act1_core_whisper: seed quests first (node scripts/seed-quests.js)');
  assert.strictEqual(act1.act, 1);
  assert.strictEqual(act1.village_key, 'sunspire');

  const act4 = res.body.quests.find(q => q.key === 'act4_new_dawn');
  assert.ok(act4, 'Expected Act IV quest act4_new_dawn: seed quests first (node scripts/seed-quests.js)');
  assert.strictEqual(act4.act, 4);
});

test('POST /api/quests start/progress/complete follows the prerequisite chain and sets legacy choice', { skip }, async () => {
  const prefix = `test_quest_${process.pid}_${Date.now()}`;
  let userId = null;
  let charId = null;
  try {
    const userRes = await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, 'hash', 'player') RETURNING id`,
      [prefix]
    );
    userId = userRes.rows[0].id;
    const charRes = await pool.query(
      `INSERT INTO characters (user_id, name, slot, entity_type_id)
       VALUES ($1, $2, 1, (SELECT id FROM entity_types WHERE is_playable = true LIMIT 1)) RETURNING id`,
      [userId, prefix]
    );
    charId = charRes.rows[0].id;

    const startPassive = 5;
    const startXp = 50000;
    const startLevel = 40;
    await pool.query(
      `INSERT INTO player_progression (character_id, level, experience, passive_points, legacy_choice)
       VALUES ($1, $2, $3, $4, NULL)`,
      [charId, startLevel, startXp, startPassive]
    );

    // Expected values come from the seed data, not from the DB row under test.
    const byKey = new Map(QUESTS.map(q => [q.key, q]));
    const seedAct4 = byKey.get('act4_new_dawn');
    assert.ok(seedAct4, 'act4_new_dawn missing from questsData.js');

    const questsRes = await pool.query(`SELECT id, key FROM quests WHERE key = ANY($1)`, [QUESTS.map(q => q.key)]);
    const idByKey = new Map(questsRes.rows.map(r => [r.key, r.id]));
    const act4Id = idByKey.get('act4_new_dawn');
    assert.ok(act4Id, 'act4_new_dawn not in quests table: seed quests first (node scripts/seed-quests.js)');

    // Fresh character: the server must refuse Act IV while its prerequisite is open.
    const locked = await request(app).post('/api/quests/start').send({ characterId: charId, questId: act4Id });
    assert.strictEqual(locked.status, 400);
    assert.match(locked.body.error, /locked/);

    // The service stores completion as character_quests.status = 'completed'.
    // Walk prerequisite_key back from Act IV and mark that chain completed.
    const chain = [];
    for (let k = seedAct4.prerequisite_key; k; k = byKey.get(k).prerequisite_key) {
      assert.ok(idByKey.has(k), `prerequisite ${k} not in quests table: seed quests first (node scripts/seed-quests.js)`);
      chain.push(idByKey.get(k));
    }
    assert.ok(chain.length > 0, 'expected a non-empty prerequisite chain');
    await pool.query(
      `INSERT INTO character_quests (character_id, quest_id, status, progress_count, completed_at)
       SELECT $1, unnest($2::int[]), 'completed', 1, NOW()`,
      [charId, chain]
    );

    const startRes = await request(app).post('/api/quests/start').send({ characterId: charId, questId: act4Id });
    assert.strictEqual(startRes.status, 200, JSON.stringify(startRes.body));
    assert.strictEqual(startRes.body.questState.status, 'active');

    const progRes0 = await request(app).post('/api/quests/progress')
      .send({ characterId: charId, questId: act4Id, amount: seedAct4.target_count });
    assert.strictEqual(progRes0.status, 200, JSON.stringify(progRes0.body));
    assert.strictEqual(Number(progRes0.body.progressState.progress_count), seedAct4.target_count);

    const completeRes = await request(app).post('/api/quests/complete')
      .send({ characterId: charId, questId: act4Id, legacyChoice: 'city_restoration' });
    assert.strictEqual(completeRes.status, 200, JSON.stringify(completeRes.body));
    assert.strictEqual(completeRes.body.status, 'completed');
    assert.strictEqual(completeRes.body.legacyChoice, 'city_restoration');

    // Only Act IV is completed through the service, so the arithmetic is its
    // own reward plus one point per level gained.
    const newLevel = levelForXp(startXp + seedAct4.exp_reward);
    const expectedPassive = startPassive + seedAct4.passive_points_reward + Math.max(0, newLevel - startLevel);
    const progRes = await pool.query(
      `SELECT legacy_choice, passive_points FROM player_progression WHERE character_id = $1`,
      [charId]
    );
    assert.strictEqual(progRes.rows[0].legacy_choice, 'city_restoration');
    assert.strictEqual(progRes.rows[0].passive_points, expectedPassive);
  } finally {
    if (charId !== null) {
      await pool.query(`DELETE FROM character_quests WHERE character_id = $1`, [charId]);
      await pool.query(`DELETE FROM player_progression WHERE character_id = $1`, [charId]);
      await pool.query(`DELETE FROM characters WHERE id = $1`, [charId]);
    }
    if (userId !== null) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE username = $1`, [prefix]);
  }
});
