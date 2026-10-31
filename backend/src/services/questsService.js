// backend/src/services/questsService.js
//
// PURE & DB services for quests, quest tracking, sequential unlocks, and Act IV permanent legacy choices.

const { levelForXp } = require('./playerStats.js');
const { getSetting } = require('./gameSettings.js');

// A refusal the caller can act on (locked quest, level too low, unknown quest),
// as opposed to a database failure. The route maps `status` to HTTP and hides
// the message of anything that is NOT a QuestError, so a pg error text never
// reaches the client.
class QuestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'QuestError';
    this.status = status;
  }
}

async function findQuest(db, questKeyOrId) {
  const isId = questKeyOrId !== null && questKeyOrId !== undefined && questKeyOrId !== ''
    && Number.isInteger(Number(questKeyOrId));
  const qRes = isId
    ? await db.query('SELECT * FROM quests WHERE id = $1', [Number(questKeyOrId)])
    : await db.query('SELECT * FROM quests WHERE key = $1', [String(questKeyOrId)]);
  if (qRes.rows.length === 0) throw new QuestError(`Quest "${questKeyOrId}" not found`, 404);
  return qRes.rows[0];
}

// required_level used to be stored and shown in the log but never enforced: a
// level-1 character could take a level-55 quest.
async function assertLevelReached(db, characterId, quest) {
  const need = Number(quest.required_level) || 1;
  if (need <= 1) return;
  const r = await db.query(
    'SELECT level FROM player_progression WHERE character_id = $1',
    [characterId],
  );
  const level = r.rows.length ? Number(r.rows[0].level) || 1 : 1;
  if (level < need) {
    throw new QuestError(`Quest "${quest.title}" requires level ${need} (you are level ${level}).`);
  }
}

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
    // A daily finished before today is offered again from zero.
    if (status === 'completed' && dailyDue(q, q.completed_at)) {
      status = 'available';
      q = { ...q, progress_count: 0 };
    }
    if (!status) {
      // A side quest has no implicit "previous quest" prerequisite.
      const prereqKey = q.prerequisite_key
        || (!q.is_side && idx > 0 ? rawQuests[idx - 1].key : null);
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
      // A manual objective is met by turning it in, so an accepted one shows
      // as done and the log offers Complete (completeQuest applies the same rule).
      progress_count: q.objective_type === 'manual' && status === 'active'
        ? (q.target_count || 1)
        : Number(q.progress_count) || 0,
      target_count: q.target_count || 1,
      objective: q.objective || q.description,
    };
  });

  return {
    quests,
    legacyChoice,
  };
}

// A repeat_kind 'daily' quest that was completed on an earlier UTC day.
function dailyDue(quest, completedAt, now = new Date()) {
  if (quest.repeat_kind !== 'daily' || !completedAt) return false;
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(completedAt).getTime() < startOfToday;
}

async function checkPrerequisiteCompleted(pool, characterId, quest) {
  let prereqKey = quest.prerequisite_key;
  if (!prereqKey && !quest.is_side) {
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
      throw new QuestError(`Quest "${quest.title}" is locked. Complete the prerequisite quest first.`);
    }
  }
}

async function startQuest(pool, characterId, questKeyOrId) {
  const quest = await findQuest(pool, questKeyOrId);

  const existing = await pool.query(
    'SELECT * FROM character_quests WHERE character_id = $1 AND quest_id = $2',
    [characterId, quest.id],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.status === 'completed' && dailyDue(quest, row.completed_at)) {
      // Guarded on status so a double click resets once, not twice.
      const reset = await pool.query(
        `UPDATE character_quests
            SET status = 'active', progress_count = 0, completed_at = NULL
          WHERE character_id = $1 AND quest_id = $2 AND status = 'completed'
          RETURNING *`,
        [characterId, quest.id],
      );
      if (reset.rows[0]) return reset.rows[0];
    }
    return row;
  }

  // Enforce sequential unlocking and the level gate.
  await checkPrerequisiteCompleted(pool, characterId, quest);
  await assertLevelReached(pool, characterId, quest);

  // ON CONFLICT: a double click sends two starts, and the loser used to hit the
  // primary key and surface as a "duplicate key" error toast.
  await pool.query(
    `INSERT INTO character_quests (character_id, quest_id, status, progress_count)
     VALUES ($1, $2, 'active', 0)
     ON CONFLICT (character_id, quest_id) DO NOTHING`,
    [characterId, quest.id],
  );
  const { rows } = await pool.query(
    'SELECT * FROM character_quests WHERE character_id = $1 AND quest_id = $2',
    [characterId, quest.id],
  );
  return rows[0];
}

async function completeQuest(pool, characterId, questKeyOrId, legacyChoice = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const quest = await findQuest(client, questKeyOrId);

    // Make sure the row exists, then take a row lock on it. Without the lock,
    // two concurrent completes (a double click, or two tabs) both read
    // 'active', both passed the progress check and both paid out gold, XP and
    // passive points.
    let cqRes = await client.query(
      'SELECT * FROM character_quests WHERE character_id = $1 AND quest_id = $2 FOR UPDATE',
      [characterId, quest.id],
    );
    if (cqRes.rows.length === 0) {
      await checkPrerequisiteCompleted(client, characterId, quest);
      await assertLevelReached(client, characterId, quest);
      await client.query(
        `INSERT INTO character_quests (character_id, quest_id, status, progress_count)
         VALUES ($1, $2, 'active', 0)
         ON CONFLICT (character_id, quest_id) DO NOTHING`,
        [characterId, quest.id],
      );
      cqRes = await client.query(
        'SELECT * FROM character_quests WHERE character_id = $1 AND quest_id = $2 FOR UPDATE',
        [characterId, quest.id],
      );
    }
    if (cqRes.rows[0].status === 'completed') {
      await client.query('COMMIT');
      return { quest, alreadyCompleted: true, status: 'completed' };
    }

    const targetCount = Number(quest.target_count) || 1;
    // `manual` objectives have no in-game tracker yet, so the turn-in itself
    // is the proof (see migration 1714440827000).
    const currentProg = quest.objective_type === 'manual'
      ? targetCount
      : Number(cqRes.rows[0].progress_count) || 0;
    if (currentProg < targetCount) {
      throw new QuestError(`Quest objective not completed yet (${currentProg}/${targetCount})`);
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

    // Award XP, Level & Passive Points (recalculating level). The row is
    // created lazily, like progressionStore.loadProgression does: a character
    // that never killed anything has none, and its quest rewards used to be
    // dropped silently while the quest was still marked completed.
    await client.query(
      'INSERT INTO player_progression (character_id) VALUES ($1) ON CONFLICT (character_id) DO NOTHING',
      [characterId],
    );
    const progRes = await client.query(
      'SELECT experience, level, passive_points FROM player_progression WHERE character_id = $1 FOR UPDATE',
      [characterId],
    );

    const curXp = Number(progRes.rows[0].experience) || 0;
    const curLevel = Number(progRes.rows[0].level) || 1;
    const curPass = Number(progRes.rows[0].passive_points) || 0;

    const addXp = quest.exp_reward || 0;
    const addPass = quest.passive_points_reward || 0;

    const newXp = curXp + addXp;
    const newLevel = levelForXp(newXp);
    const levelsGained = Math.max(0, newLevel - curLevel);
    const leveledUp = levelsGained > 0;
    // Same per-level grant the kill path uses (progressionStore.awardXp). This
    // was a hard-coded 1, so changing the game setting moved kills but not quests.
    const perLevel = leveledUp
      ? Number(await getSetting(client, 'passive_points_per_level')) || 0
      : 0;
    const pointsGained = levelsGained * perLevel;
    const totalPassive = curPass + addPass + pointsGained;

    await client.query(
      `UPDATE player_progression
       SET experience = $2, level = $3, passive_points = $4, updated_at = NOW()
       WHERE character_id = $1`,
      [characterId, newXp, Math.max(curLevel, newLevel), totalPassive],
    );

    // Permanent Act IV Legacy Choice (if Act 4 & not chosen yet). COALESCE keeps
    // the first choice, so report what is STORED, not what was asked for: a
    // second request used to be echoed back as if it had been applied.
    let appliedLegacyChoice = null;
    if (quest.act === 4 && legacyChoice) {
      const allowedChoices = ['city_restoration', 'elemental_surge'];
      if (allowedChoices.includes(legacyChoice)) {
        const lc = await client.query(
          `UPDATE player_progression
           SET legacy_choice = COALESCE(legacy_choice, $2)
           WHERE character_id = $1
           RETURNING legacy_choice`,
          [characterId, legacyChoice],
        );
        appliedLegacyChoice = lc.rows[0] ? lc.rows[0].legacy_choice : null;
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
        newLevel: Math.max(curLevel, newLevel),
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

// SERVER-INTERNAL. Not exposed over HTTP any more: it was POST /api/quests/progress,
// which let any caller set their own progress to the target and then claim the
// reward. A kill/pickup/visit hook in the authority is the intended caller.
async function incrementQuestProgress(pool, characterId, questKeyOrId, amount = 1) {
  const inc = Math.floor(Number(amount));
  if (!Number.isFinite(inc) || inc <= 0) return null;
  const quest = await findQuest(pool, questKeyOrId);
  const target = Number(quest.target_count) || 1;

  // One atomic statement: the read-modify-write version lost increments when
  // two kills landed in the same tick.
  const updateRes = await pool.query(
    `UPDATE character_quests
     SET progress_count = LEAST($3, progress_count + $4)
     WHERE character_id = $1 AND quest_id = $2 AND status = 'active'
     RETURNING *`,
    [characterId, quest.id, target, inc],
  );
  return updateRes.rows[0] || null;
}

// SERVER-INTERNAL. One creature died to this character: advance every ACTIVE
// quest it counts for, in a single statement (so two kills in one tick cannot
// lose an increment). Returns the changed rows so the caller can tell the
// player; an empty array when no quest cared, which is the common case.
async function recordKill(pool, characterId, { typeName = null, isBoss = false } = {}) {
  const { rows } = await pool.query(
    `UPDATE character_quests cq
        SET progress_count = LEAST(q.target_count, cq.progress_count + 1)
       FROM quests q
      WHERE q.id = cq.quest_id
        AND cq.character_id = $1
        AND cq.status = 'active'
        AND cq.progress_count < q.target_count
        AND (
          q.objective_type = 'kill_any'
          OR (q.objective_type = 'boss' AND $3::boolean)
          OR (q.objective_type = 'kill' AND $2::text IS NOT NULL
              AND lower(q.target_key) = lower($2::text))
        )
    RETURNING q.key, q.title, q.target_count, cq.progress_count`,
    [characterId, typeName, !!isBoss],
  );
  return rows;
}

// Give up an ACTIVE quest: the row (and its progress) is dropped so the quest
// is offered again from zero. A completed quest is never touched.
async function abandonQuest(pool, characterId, questKeyOrId) {
  const quest = await findQuest(pool, questKeyOrId);
  const r = await pool.query(
    `DELETE FROM character_quests
      WHERE character_id = $1 AND quest_id = $2 AND status = 'active'`,
    [characterId, quest.id],
  );
  if (r.rowCount === 0) throw new QuestError(`Quest "${quest.title}" is not active.`, 409);
  return { quest };
}

module.exports = {
  dailyDue,
  recordKill,
  abandonQuest,
  QuestError,
  listAllQuests,
  getCharacterQuests,
  startQuest,
  completeQuest,
  incrementQuestProgress,
};
