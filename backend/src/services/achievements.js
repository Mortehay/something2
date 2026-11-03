'use strict';

// Achievements: a catalog of milestones over named COUNTERS. The game feeds the
// counters (kills, chests opened, quests done, deepest Spire floor, synergies
// landed ...); crossing a milestone's target unlocks it once and may award a
// TITLE the player can wear. Titles also come from quests (quests.title_reward).
//
// Counters are written through an in-memory BUFFER flushed on a timer: a kill or
// a skill cast must not cost a database write each, and the unlock toast is
// fine arriving a couple of seconds late. `mode` is 'add' (a running total) or
// 'max' (a high-water mark: level, deepest floor, best standing).

const CATEGORIES = ['combat', 'exploration', 'quests', 'progression', 'skills'];

const ach = (key, category, counter, target, name, description, icon, title = null) => (
  { key, category, counter, target, name, description, icon, title }
);

const CATALOG = [
  // --- combat ---
  ach('first_blood', 'combat', 'kills', 1, 'First Blood', 'Defeat your first creature.', '🗡️'),
  ach('slayer_100', 'combat', 'kills', 100, 'Hundred Down', 'Defeat 100 creatures.', '⚔️'),
  ach('slayer_1000', 'combat', 'kills', 1000, 'Thousand Strong', 'Defeat 1,000 creatures.', '🛡️', 'the Slayer'),
  ach('slayer_10000', 'combat', 'kills', 10000, 'Endless War', 'Defeat 10,000 creatures.', '💀', 'the Relentless'),
  ach('boss_1', 'combat', 'boss_kills', 1, 'Giant Killer', 'Defeat a boss.', '👑'),
  ach('boss_10', 'combat', 'boss_kills', 10, 'Bossbane', 'Defeat 10 bosses.', '🐉', 'Bossbane'),
  ach('boss_50', 'combat', 'boss_kills', 50, 'Titan Breaker', 'Defeat 50 bosses.', '🔥', 'Titan Breaker'),
  // --- exploration ---
  ach('chests_1', 'exploration', 'chests', 1, 'Finders Keepers', 'Open a chest.', '📦'),
  ach('chests_25', 'exploration', 'chests', 25, 'Treasure Hunter', 'Open 25 chests.', '💰', 'Treasure Hunter'),
  ach('chests_100', 'exploration', 'chests', 100, 'Dragon Hoard', 'Open 100 chests.', '🏺'),
  ach('spire_10', 'exploration', 'spire_floor', 10, 'Up the Spire', 'Reach floor 10 of the Spire of Trials.', '🗼'),
  ach('spire_30', 'exploration', 'spire_floor', 30, 'Spire Climber', 'Reach floor 30 of the Spire of Trials.', '🧗', 'Spire Climber'),
  ach('spire_60', 'exploration', 'spire_floor', 60, 'Spire Master', 'Reach floor 60 of the Spire of Trials.', '🌠', 'Spire Master'),
  // --- quests ---
  ach('quests_1', 'quests', 'quests_done', 1, 'Odd Jobs', 'Complete a quest.', '📜'),
  ach('quests_10', 'quests', 'quests_done', 10, 'Reliable Hand', 'Complete 10 quests.', '📘'),
  ach('quests_30', 'quests', 'quests_done', 30, 'Questkeeper', 'Complete 30 quests.', '📚', 'Questkeeper'),
  ach('daily_10', 'quests', 'daily_done', 10, 'Daily Grind', 'Complete 10 daily quests.', '🌅'),
  ach('rep_friend', 'quests', 'reputation_max', 30, 'A Friendly Face', 'Become a Friend of a village (30 standing).', '🤝'),
  ach('rep_honored', 'quests', 'reputation_max', 100, 'Honored Guest', 'Become Honored in a village (100 standing).', '🏅', 'the Honored'),
  ach('rep_revered', 'quests', 'reputation_max', 250, 'Living Legend', 'Become Revered in a village (250 standing).', '🎖️', 'the Revered'),
  // --- progression ---
  ach('level_10', 'progression', 'level', 10, 'Getting Started', 'Reach level 10.', '⭐'),
  ach('level_25', 'progression', 'level', 25, 'Seasoned', 'Reach level 25.', '🌟'),
  ach('level_50', 'progression', 'level', 50, 'Veteran', 'Reach level 50.', '✨', 'the Veteran'),
  ach('level_100', 'progression', 'level', 100, 'Legend', 'Reach level 100.', '🏆', 'the Legend'),
  // --- skills ---
  ach('skills_100', 'skills', 'skills_cast', 100, 'Warming Up', 'Cast skills 100 times.', '🔥'),
  ach('skills_1000', 'skills', 'skills_cast', 1000, 'Practiced Hand', 'Cast skills 1,000 times.', '🌀'),
  ach('synergy_1', 'skills', 'synergies', 1, 'Spark of Genius', 'Land a skill synergy.', '💥'),
  ach('synergy_50', 'skills', 'synergies', 50, 'Combo Artist', 'Land 50 skill synergies.', '🎯'),
  ach('synergy_500', 'skills', 'synergies', 500, 'Combo Master', 'Land 500 skill synergies.', '☄️', 'Combo Master'),
  ach('form_10', 'skills', 'form_casts', 10, 'Shapeshifter', 'Change shape 10 times.', '🐺', 'the Shapeshifter'),
];

const BY_KEY = new Map(CATALOG.map((a) => [a.key, a]));
const COUNTERS = [...new Set(CATALOG.map((a) => a.counter))];

// ---- the write buffer -------------------------------------------------------
// characterId -> counter -> { mode, value }. 'add' accumulates; 'max' keeps the highest.
const buffer = new Map();

function bufferTrack(characterId, counter, amount = 1, mode = 'add') {
  if (characterId == null || !COUNTERS.includes(counter)) return;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return;
  let per = buffer.get(characterId);
  if (!per) { per = new Map(); buffer.set(characterId, per); }
  const cur = per.get(counter);
  if (!cur) per.set(counter, { mode, value: n });
  else if (mode === 'max') cur.value = Math.max(cur.value, n);
  else cur.value += n;
}

// Newly unlocked achievements for one counter whose stored value is `value`.
async function unlockFor(db, characterId, counter, value) {
  const due = CATALOG.filter((a) => a.counter === counter && value >= a.target);
  const out = [];
  for (const a of due) {
    const r = await db.query(
      `INSERT INTO character_achievements (character_id, achievement_key) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING achievement_key`,
      [characterId, a.key],
    );
    if (r.rows.length) out.push({ key: a.key, name: a.name, description: a.description, title: a.title });
  }
  return out;
}

// Writes one counter now and returns what it unlocked.
async function writeCounter(db, characterId, counter, mode, amount) {
  const sql = mode === 'max'
    ? `INSERT INTO character_counters (character_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (character_id, key) DO UPDATE SET value = GREATEST(character_counters.value, EXCLUDED.value)
       RETURNING value`
    : `INSERT INTO character_counters (character_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (character_id, key) DO UPDATE SET value = character_counters.value + EXCLUDED.value
       RETURNING value`;
  const r = await db.query(sql, [characterId, counter, Math.floor(amount)]);
  return unlockFor(db, characterId, counter, Number(r.rows[0].value) || 0);
}

// Flushes the buffer. Returns [{ characterId, unlocked: [...] }] for the characters
// that unlocked something. A failed write is put back so nothing is lost.
async function flush(db) {
  const snapshot = [...buffer.entries()];
  buffer.clear();
  const results = [];
  for (const [characterId, per] of snapshot) {
    const unlocked = [];
    for (const [counter, { mode, value }] of per) {
      try {
        unlocked.push(...await writeCounter(db, characterId, counter, mode, value));
      } catch (err) {
        console.error('achievements: flush failed, will retry:', err.message);
        bufferTrack(characterId, counter, value, mode);
      }
    }
    if (unlocked.length) results.push({ characterId, unlocked });
  }
  return results;
}

// ---- reading ---------------------------------------------------------------
async function loadCounters(db, characterId) {
  const r = await db.query('SELECT key, value FROM character_counters WHERE character_id = $1', [characterId]);
  const out = {};
  for (const row of r.rows) out[row.key] = Number(row.value) || 0;
  return out;
}

async function getJournal(db, characterId) {
  const counters = await loadCounters(db, characterId);
  // What is still in the buffer counts too, so the journal is never behind.
  const per = buffer.get(characterId);
  if (per) {
    for (const [counter, { mode, value }] of per) {
      counters[counter] = mode === 'max' ? Math.max(counters[counter] || 0, value) : (counters[counter] || 0) + value;
    }
  }
  const un = await db.query(
    'SELECT achievement_key, unlocked_at FROM character_achievements WHERE character_id = $1', [characterId]);
  const unlockedAt = new Map(un.rows.map((r) => [r.achievement_key, r.unlocked_at]));

  const achievements = CATALOG.map((a) => {
    const counter = counters[a.counter] || 0;
    return {
      key: a.key, category: a.category, name: a.name, description: a.description, icon: a.icon,
      target: a.target, counter: Math.min(counter, a.target),
      unlocked: unlockedAt.has(a.key),
      unlockedAt: unlockedAt.has(a.key) ? new Date(unlockedAt.get(a.key)).toISOString() : null,
      title: a.title,
    };
  });

  const titles = [];
  for (const a of achievements) {
    if (a.unlocked && a.title) titles.push({ title: a.title, source: 'achievement', sourceName: a.name });
  }
  const qt = await db.query(
    `SELECT q.title_reward, q.title AS quest_title
       FROM character_quests cq JOIN quests q ON q.id = cq.quest_id
      WHERE cq.character_id = $1 AND cq.status = 'completed' AND q.title_reward IS NOT NULL
      ORDER BY q.act, q.id`, [characterId]);
  for (const row of qt.rows) {
    if (!titles.some((t) => t.title === row.title_reward)) {
      titles.push({ title: row.title_reward, source: 'quest', sourceName: row.quest_title });
    }
  }
  const ch = await db.query('SELECT active_title FROM characters WHERE id = $1', [characterId]);
  return {
    achievements, titles, counters,
    activeTitle: ch.rows.length ? ch.rows[0].active_title : null,
  };
}

// Wear a title (or clear it with null). Only a title the character owns.
async function setActiveTitle(db, characterId, title) {
  if (title === null || title === undefined || title === '') {
    await db.query('UPDATE characters SET active_title = NULL WHERE id = $1', [characterId]);
    return { ok: true, activeTitle: null };
  }
  const journal = await getJournal(db, characterId);
  if (!journal.titles.some((t) => t.title === title)) {
    return { ok: false, error: 'You have not earned that title.' };
  }
  await db.query('UPDATE characters SET active_title = $2 WHERE id = $1', [characterId, String(title)]);
  return { ok: true, activeTitle: String(title) };
}

module.exports = {
  CATEGORIES, CATALOG, BY_KEY, COUNTERS,
  bufferTrack, flush, writeCounter, unlockFor, loadCounters, getJournal, setActiveTitle,
  _bufferSize: () => buffer.size,
};
