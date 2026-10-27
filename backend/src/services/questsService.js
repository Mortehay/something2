// backend/src/services/questsService.js
//
// PURE & DB services for quests, quest tracking, sequential unlocks, and Act IV permanent legacy choices.

const { levelForXp } = require('./playerStats.js');

async function listAllQuests(pool) {
  const { rows } = await pool.query(
    'SELECT * FROM quests ORDER BY act ASC, id ASC',
  );
  return rows;
}

async function getCharacterQuests(pool, characterId) {
  const questsRes = await pool.query(
    `SELECT q.*, cq.status AS raw_status, cq.progress_count, cq.completed_at
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

  const rawQuests = questsRes.rows;
  const completedKeys = new Set(
    rawQuests.filter((q) => q.raw_status === 'completed').map((q) => q.key),
  );

  // Compute sequential status:
  // - completed: finished
  // - active: in progress
  // - available: 1st quest OR prerequisite (or previous quest) is completed
  // - locked: prerequisite quest not completed yet
  const quests = rawQuests.map((q, idx) => {
    let status = q.raw_status;
    if (!status) {
      const prereqKey = q.prerequisite_key || (idx > 0 ? rawQuests[idx - 1].key : null);
      if (!prereqKey || completedKeys.has(prereqKey)) {
        status = 'available';
      } else {
        status = 'locked';
      }
    }
    const { raw_status, ...rest } = q;
    return {
      ...rest,
      status,
      target_count: q.target_count || 1,
      objective: q.objective || q.description,
    };
  });

  return {
    quests,
    legacyChoice,
  };
}

async function checkPrerequisiteCompleted(pool, characterId, quest) {
  let prereqKey = quest.prerequisite_key;
  if (!prereqKey) {
    const prevRes = await pool.query(
      'SELECT key FROM quests WHERE (act < $1 OR (act = $1 AND id < $2)) ORDER BY act DESC, id DESC LIMIT 1',
      [quest.act, quest.id],
    );
    if (prevRes.rows.length > 0) {
      prereqKey = prevRes.rows[0].key;
    }
  }

  if (prereqKey) {
    const pRes = await pool.query(
      `SELECT cq.status FROM character_quests cq
       JOIN quests q ON q.id = cq.quest_id
       WHERE cq.character_id = $1 AND q.key = $2`,
      [characterId, prereqKey],
    );
    if (pRes.rows.length === 0 || pRes.rows[0].status !== 'completed') {
      throw new Error(`Quest "${quest.title}" is locked. Complete the prerequisite quest first.`);
    }
  }
}

async function startQuest(pool, characterId, questKeyOrId) {
  const isId = Number.isInteger(Number(questKeyOrId)) && !isNaN(questKeyOrId);
  const qRes = isId
    ? await pool.query('SELECT * FROM quests WHERE id = $1', [Number(questKeyOrId)])
    : await pool.query('SELECT * FROM quests WHERE key = $1', [questKeyOrId]);
  if (qRes.rows.length === 0) throw new Error(`Quest "${questKeyOrId}" not found`);
  const quest = qRes.rows[0];

  // Enforce sequential unlocking
  await checkPrerequisiteCompleted(pool, characterId, quest);

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
      await checkPrerequisiteCompleted(client, characterId, quest);
      cqRes = await client.query(
        `INSERT INTO character_quests (character_id, quest_id, status, progress_count)
         VALUES ($1, $2, 'active', 0) RETURNING *`,
        [characterId, quest.id],
      );
    }
    if (cqRes.rows[0].status === 'completed') {
      await client.query('COMMIT');
      return { quest, alreadyCompleted: true, status: 'completed' };
    }

    const currentProg = Number(cqRes.rows[0].progress_count) || 0;
    const targetCount = Number(quest.target_count) || 1;
    if (currentProg < targetCount) {
      throw new Error(`Quest objective not completed yet (${currentProg}/${targetCount})`);
    }

    // Mark completed
    await client.query(
      `UPDATE character_quests
       SET status = 'completed', completed_at = NOW()
       WHERE character_id = $1 AND quest_id = $2`,
      [characterId, quest.id],
    );

    // Award Gold
    if (quest.gold_reward > 0) {
      await client.query(
        `UPDATE users
         SET gold = gold + $2
         FROM characters c
         WHERE c.id = $1 AND users.id = c.user_id`,
        [characterId, quest.gold_reward],
      );
    }

    // Award XP, Level & Passive Points (recalculating level)
    let newLevel = 1;
    let leveledUp = false;
    let pointsGained = 0;

    const progRes = await client.query(
      'SELECT experience, level, passive_points FROM player_progression WHERE character_id = $1 FOR UPDATE',
      [characterId],
    );

    if (progRes.rows.length > 0) {
      const curXp = Number(progRes.rows[0].experience) || 0;
      const curLevel = Number(progRes.rows[0].level) || 1;
      const curPass = Number(progRes.rows[0].passive_points) || 0;

      const addXp = quest.exp_reward || 0;
      const addPass = quest.passive_points_reward || 0;

      const newXp = curXp + addXp;
      newLevel = levelForXp(newXp);
      const levelsGained = Math.max(0, newLevel - curLevel);
      leveledUp = levelsGained > 0;
      pointsGained = levelsGained * 1;

      const totalPassive = curPass + addPass + pointsGained;

      await client.query(
        `UPDATE player_progression
         SET experience = $2, level = $3, passive_points = $4, updated_at = NOW()
         WHERE character_id = $1`,
        [characterId, newXp, newLevel, totalPassive],
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
    return {
      quest,
      completed: true,
      status: 'completed',
      legacyChoice: appliedLegacyChoice,
      rewards: {
        gold: quest.gold_reward,
        exp: quest.exp_reward,
        passive_points: quest.passive_points_reward,
        title: quest.title_reward,
        newLevel,
        leveledUp,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function incrementQuestProgress(pool, characterId, questKeyOrId, amount = 1) {
  const isId = Number.isInteger(Number(questKeyOrId)) && !isNaN(questKeyOrId);
  const qRes = isId
    ? await pool.query('SELECT * FROM quests WHERE id = $1', [Number(questKeyOrId)])
    : await pool.query('SELECT * FROM quests WHERE key = $1', [questKeyOrId]);
  if (qRes.rows.length === 0) throw new Error(`Quest "${questKeyOrId}" not found`);
  const quest = qRes.rows[0];

  const cqRes = await pool.query(
    'SELECT * FROM character_quests WHERE character_id = $1 AND quest_id = $2',
    [characterId, quest.id],
  );

  if (cqRes.rows.length === 0 || cqRes.rows[0].status !== 'active') {
    return null;
  }

  const curProg = Number(cqRes.rows[0].progress_count) || 0;
  const target = Number(quest.target_count) || 1;
  const newProg = Math.min(target, curProg + amount);

  const updateRes = await pool.query(
    `UPDATE character_quests
     SET progress_count = $3
     WHERE character_id = $1 AND quest_id = $2
     RETURNING *`,
    [characterId, quest.id, newProg],
  );
  return updateRes.rows[0];
}

module.exports = {
  listAllQuests,
  getCharacterQuests,
  startQuest,
  completeQuest,
  incrementQuestProgress,
};
