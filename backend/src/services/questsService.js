// backend/src/services/questsService.js
//
// PURE & DB services for quests, quest tracking, and Act IV permanent legacy choices.

const { Pool } = require('pg');

async function listAllQuests(pool) {
  const { rows } = await pool.query(
    'SELECT * FROM quests ORDER BY act ASC, id ASC',
  );
  return rows;
}

async function getCharacterQuests(pool, characterId) {
  const questsRes = await pool.query(
    `SELECT q.*, cq.status, cq.progress_count, cq.completed_at
     FROM quests q
     LEFT JOIN character_quests cq ON q.id = cq.quest_id AND cq.character_id = $1
     ORDER BY q.act ASC, q.id ASC`,
    [characterId],
  );

  const choiceRes = await pool.query(
    'SELECT legacy_choice FROM player_progression WHERE character_id = $1',
    [characterId],
  );

  const legacyChoice = choiceRes.rows[0] ? choiceRes.rows[0].legacy_choice : null;

  return {
    quests: questsRes.rows,
    legacyChoice,
  };
}

async function startQuest(pool, characterId, questKeyOrId) {
  const isId = Number.isInteger(Number(questKeyOrId)) && !isNaN(questKeyOrId);
  const qRes = isId
    ? await pool.query('SELECT * FROM quests WHERE id = $1', [Number(questKeyOrId)])
    : await pool.query('SELECT * FROM quests WHERE key = $1', [questKeyOrId]);
  if (qRes.rows.length === 0) throw new Error(`Quest "${questKeyOrId}" not found`);
  const quest = qRes.rows[0];

  const existing = await pool.query(
    'SELECT * FROM character_quests WHERE character_id = $1 AND quest_id = $2',
    [characterId, quest.id],
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const { rows } = await pool.query(
    `INSERT INTO character_quests (character_id, quest_id, status, progress_count)
     VALUES ($1, $2, 'active', 0)
     RETURNING *`,
    [characterId, quest.id],
  );
  return rows[0];
}

async function completeQuest(pool, characterId, questKeyOrId, legacyChoice = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const isId = Number.isInteger(Number(questKeyOrId)) && !isNaN(questKeyOrId);
    const qRes = isId
      ? await client.query('SELECT * FROM quests WHERE id = $1', [Number(questKeyOrId)])
      : await client.query('SELECT * FROM quests WHERE key = $1', [questKeyOrId]);
    if (qRes.rows.length === 0) throw new Error(`Quest "${questKeyOrId}" not found`);
    const quest = qRes.rows[0];

    // Check or insert character_quest
    let cqRes = await client.query(
      'SELECT * FROM character_quests WHERE character_id = $1 AND quest_id = $2',
      [characterId, quest.id],
    );
    if (cqRes.rows.length === 0) {
      cqRes = await client.query(
        `INSERT INTO character_quests (character_id, quest_id, status, progress_count)
         VALUES ($1, $2, 'active', 0) RETURNING *`,
        [characterId, quest.id],
      );
    }
    if (cqRes.rows[0].status === 'completed') {
      await client.query('COMMIT');
      return { quest, alreadyCompleted: true };
    }

    // Mark completed
    await client.query(
      `UPDATE character_quests
       SET status = 'completed', completed_at = NOW()
       WHERE character_id = $1 AND quest_id = $2`,
      [characterId, quest.id],
    );

    // Award rewards: gold to user, passive points & exp to player_progression
    if (quest.gold_reward > 0) {
      await client.query(
        `UPDATE users
         SET gold = gold + $2
         FROM characters c
         WHERE c.id = $1 AND users.id = c.user_id`,
        [characterId, quest.gold_reward],
      );
    }

    if (quest.passive_points_reward > 0 || quest.exp_reward > 0) {
      await client.query(
        `UPDATE player_progression
         SET passive_points = passive_points + $2,
             experience = experience + $3
         WHERE character_id = $1`,
        [characterId, quest.passive_points_reward || 0, quest.exp_reward || 0],
      );
    }

    // Permanent Act IV Legacy Choice (if Act 4 & not chosen yet)
    let appliedLegacyChoice = null;
    if (quest.act === 4 && legacyChoice) {
      const allowedChoices = ['city_restoration', 'elemental_surge'];
      if (allowedChoices.includes(legacyChoice)) {
        await client.query(
          `UPDATE player_progression
           SET legacy_choice = COALESCE(legacy_choice, $2)
           WHERE character_id = $1`,
          [characterId, legacyChoice],
        );
        appliedLegacyChoice = legacyChoice;
      }
    }

    await client.query('COMMIT');
    return { quest, completed: true, status: 'completed', legacyChoice: appliedLegacyChoice };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listAllQuests,
  getCharacterQuests,
  startQuest,
  completeQuest,
};
