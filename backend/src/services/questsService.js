// backend/src/services/questsService.js
//
// PURE & DB services for quests, quest tracking, sequential unlocks, and Act IV permanent legacy choices.

const { levelForXp } = require('./playerStats.js');
const { getSetting } = require('./gameSettings.js');

// Act IV permanent legacy choices (player_progression.legacy_choice).
const LEGACY_CHOICES = ['city_restoration', 'elemental_surge'];

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
      progress_count: (q.objective_type === 'manual' || q.objective_type === 'choice') && status === 'active'
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
    const isTurnIn = quest.objective_type === 'manual' || quest.objective_type === 'choice';
    const currentProg = isTurnIn
      ? targetCount
      : Number(cqRes.rows[0].progress_count) || 0;

    // `choice`: the turn-in IS the decision. Take the legacy asked for now, or
    // the one already stored (a character that chose through an older build);
    // with neither there is nothing to turn in.
    if (quest.objective_type === 'choice' && !LEGACY_CHOICES.includes(legacyChoice)) {
      const had = await client.query(
        'SELECT legacy_choice FROM player_progression WHERE character_id = $1',
        [characterId],
      );
      if (!(had.rows[0] && LEGACY_CHOICES.includes(had.rows[0].legacy_choice))) {
        throw new QuestError('Choose a legacy to complete this quest.');
      }
    }
    if (currentProg < targetCount) {
      throw new QuestError(`Quest objective not completed yet (${currentProg}/${targetCount})`);
    }

    // Mark completed
    await client.query(
      `UPDATE character_quests
       SET status = 'completed', completed_at = NOW(), reward_item_pending = $3
       WHERE character_id = $1 AND quest_id = $2`,
      [characterId, quest.id, !!quest.item_reward],
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

      if (LEGACY_CHOICES.includes(legacyChoice)) {
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
        item: quest.item_reward || null,
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

// SERVER-INTERNAL. The character used a quest node (see services/questNodes.js).
// Credits every ACTIVE `interact` quest on that group, once per node per quest,
// in one statement: the node row is the proof, so pressing E ten times on one
// herb advances nothing after the first. Empty array = no active quest needed
// this node, or it was already used for them.
async function recordNode(pool, characterId, group, nodeKey) {
  const { rows } = await pool.query(
    `WITH eligible AS (
       SELECT cq.character_id, cq.quest_id, q.key, q.title, q.target_count
         FROM character_quests cq
         JOIN quests q ON q.id = cq.quest_id
        WHERE cq.character_id = $1 AND cq.status = 'active'
          AND q.objective_type = 'interact' AND q.target_key = $2
          AND cq.progress_count < q.target_count
     ), fresh AS (
       INSERT INTO character_quest_nodes (character_id, quest_id, node_key)
       SELECT character_id, quest_id, $3::text FROM eligible
       ON CONFLICT DO NOTHING
       RETURNING quest_id
     )
     UPDATE character_quests cq
        SET progress_count = LEAST(e.target_count, cq.progress_count + 1)
       FROM eligible e JOIN fresh f ON f.quest_id = e.quest_id
      WHERE cq.character_id = e.character_id AND cq.quest_id = e.quest_id
  RETURNING e.key, e.title, e.target_count, cq.progress_count`,
    [characterId, group, nodeKey],
  );
  return rows;
}

// Node keys this character has spent on a quest that is still active, so the
// client can dim them.
async function doneNodeKeys(pool, characterId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT n.node_key
       FROM character_quest_nodes n
       JOIN character_quests cq
         ON cq.character_id = n.character_id AND cq.quest_id = n.quest_id
      WHERE n.character_id = $1 AND cq.status = 'active'`,
    [characterId],
  );
  return rows.map((r) => r.node_key);
}

// "Spire of Trials: Floor 7" -> 7, anything else -> null.
function floorFromWorldName(name) {
  const m = /^Spire of Trials: Floor (\d+)$/.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

// SERVER-INTERNAL. The character is standing on floor N of the Spire. Progress
// is the DEEPEST floor reached (GREATEST), never a count of entries, so going
// in and out of a floor farms nothing.
async function recordFloor(pool, characterId, floor) {
  const f = Math.floor(Number(floor));
  if (!Number.isFinite(f) || f < 1) return [];
  const { rows } = await pool.query(
    `UPDATE character_quests cq
        SET progress_count = LEAST(q.target_count, $2::int)
       FROM quests q
      WHERE q.id = cq.quest_id
        AND cq.character_id = $1 AND cq.status = 'active'
        AND q.objective_type = 'floor'
        AND cq.progress_count < LEAST(q.target_count, $2::int)
  RETURNING q.key, q.title, q.target_count, cq.progress_count`,
    [characterId, f],
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
  findQuest,
  recordNode,
  doneNodeKeys,
  recordFloor,
  floorFromWorldName,
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

// Item rewards still owed to this character: [{ questId, key, item }].
async function pendingRewardItems(pool, characterId) {
  const { rows } = await pool.query(
    `SELECT q.id AS quest_id, q.key, q.item_reward AS item
       FROM character_quests cq JOIN quests q ON q.id = cq.quest_id
      WHERE cq.character_id = $1 AND cq.reward_item_pending AND q.item_reward IS NOT NULL`,
    [characterId],
  );
  return rows.map((r) => ({ questId: r.quest_id, key: r.key, item: r.item }));
}

// The item has been dropped for the player; stop owing it. Guarded on the flag
// so two deliveries racing cannot both clear (or both believe they delivered).
async function clearRewardPending(pool, characterId, questId) {
  const r = await pool.query(
    `UPDATE character_quests SET reward_item_pending = false
      WHERE character_id = $1 AND quest_id = $2 AND reward_item_pending`,
    [characterId, questId],
  );
  return r.rowCount === 1;
}

module.exports.pendingRewardItems = pendingRewardItems;
module.exports.clearRewardPending = clearRewardPending;
