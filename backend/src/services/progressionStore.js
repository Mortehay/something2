// Every read and write of player_progression. Nothing outside this file and
// playerStats.js touches the raw stat columns.

const {
  levelForXp, applyDeathPenalty, refundedPoints, DEFAULT_PROGRESSION,
} = require('./playerStats.js');
const C = require('./progressionConstants.js');

const XP_SOURCES = ['kill', 'chest', 'dungeon_clear'];
const COLUMNS = `user_id, experience, level, stat_points,
                 strength, dexterity, constitution, intelligence, wisdom, charisma`;

// experience is bigint, which node-postgres returns as a STRING to avoid
// silent precision loss past 2^53. Normalise once, here, so no caller has to
// remember -- a forgotten Number() turns `xp + 10` into "0" + 10 === "010".
function mapRow(r) {
  return {
    user_id: r.user_id,
    experience: Number(r.experience) || 0,
    level: Number(r.level) || 1,
    stat_points: Number(r.stat_points) || 0,
    strength: Number(r.strength),
    dexterity: Number(r.dexterity),
    constitution: Number(r.constitution),
    intelligence: Number(r.intelligence),
    wisdom: Number(r.wisdom),
    charisma: Number(r.charisma),
  };
}

// Lazily creates the row. Registration does NOT create it: users arrive by
// several routes (the register endpoint, the admin seeder, the migration
// backfill) and one lazy insert here covers all of them, where a hook on one
// route would cover only that route.
//
// `forUpdate` takes a row lock (SELECT ... FOR UPDATE) instead of a plain
// read. It only serialises anything when `db` is a client mid-transaction --
// a bare pool.query commits (and releases the lock) before this function
// even returns -- so it exists solely for awardXp, which is documented to
// always run inside the caller's transaction. Every other caller stays on
// the plain unlocked read.
async function loadProgression(db, userId, { forUpdate = false } = {}) {
  await db.query(
    'INSERT INTO player_progression (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
  const r = await db.query(
    `SELECT ${COLUMNS} FROM player_progression WHERE user_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId],
  );
  return r.rows.length ? mapRow(r.rows[0]) : { ...DEFAULT_PROGRESSION, user_id: userId };
}

// Takes `db`, not `pool`: the kill path calls this INSIDE its own transaction
// so the XP award and the creature-death commit stand or fall together.
//
// The read below is a locked SELECT ... FOR UPDATE, not a plain read. A
// single melee arc or AoE detonation can kill several creatures in one tick,
// and onCreatureDeath is deliberately fire-and-forget (the tick loop must
// not await it -- see server.js's own comment to that effect), so several
// overlapping transactions can call awardXp for the SAME user before any of
// them commits. Without a lock, every one of those reads the same starting
// experience and the last UPDATE to commit wins, silently discarding every
// other award -- and since level and stat_points are derived from that same
// stale read, a level-up can be lost (or double-granted) right along with
// the XP. The row lock forces the second-and-later transactions to block
// until the first commits, so each one re-reads the just-committed value
// rather than a stale one.
async function awardXp(db, userId, amount, source) {
  const before = await loadProgression(db, userId, { forUpdate: true });
  const amt = Math.floor(Number(amount) || 0);
  // An unrecognised source is refused rather than defaulted. `chest` and
  // `dungeon_clear` are accepted today and unused -- they are the seam B and
  // C plug into, and accepting them now means neither has to touch this file.
  if (amt <= 0 || !XP_SOURCES.includes(source)) {
    return {
      progression: before, leveledUp: false, newLevel: before.level, pointsGained: 0, awarded: 0,
    };
  }
  const experience = before.experience + amt;
  const newLevel = levelForXp(experience);
  const pointsGained = Math.max(0, newLevel - before.level) * C.STAT_POINTS_PER_LEVEL;
  const r = await db.query(
    `UPDATE player_progression
        SET experience = $2, level = $3, stat_points = stat_points + $4, updated_at = now()
      WHERE user_id = $1
      RETURNING ${COLUMNS}`,
    [userId, experience, newLevel, pointsGained],
  );
  return {
    progression: mapRow(r.rows[0]),
    leveledUp: newLevel > before.level,
    newLevel,
    pointsGained,
    awarded: amt,
  };
}

async function allocateStat(pool, userId, statKey, count) {
  // Whitelist, not interpolation. statKey reaches this from an HTTP body.
  if (!C.STAT_KEYS.includes(statKey)) return { ok: false, reason: 'unknown stat' };
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) return { ok: false, reason: 'invalid count' };

  await loadProgression(pool, userId);
  // The guard is in the WHERE clause, not in a read-then-write pair: two
  // concurrent requests both pass a read-first check and both spend the same
  // points. Postgres serialises the UPDATE, so exactly one matches.
  const r = await pool.query(
    `UPDATE player_progression
        SET ${statKey} = ${statKey} + $2, stat_points = stat_points - $2, updated_at = now()
      WHERE user_id = $1 AND stat_points >= $2
      RETURNING ${COLUMNS}`,
    [userId, n],
  );
  if (r.rowCount !== 1) return { ok: false, reason: 'not enough points' };
  return { ok: true, progression: mapRow(r.rows[0]) };
}

async function respec(pool, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await loadProgression(client, userId);
    const cost = C.RESPEC_BASE * before.level;
    // Gold moves first, guarded in its own WHERE. If it does not move, the
    // whole transaction rolls back -- a failed payment must never yield a
    // free respec.
    const g = await client.query(
      'UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold',
      [userId, cost],
    );
    if (g.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not enough gold', cost };
    }
    const refund = refundedPoints(before);
    const r = await client.query(
      `UPDATE player_progression
          SET strength = $2, dexterity = $2, constitution = $2,
              intelligence = $2, wisdom = $2, charisma = $2,
              stat_points = stat_points + $3, updated_at = now()
        WHERE user_id = $1
        RETURNING ${COLUMNS}`,
      [userId, C.BASE_STAT, refund],
    );
    await client.query('COMMIT');
    return {
      ok: true, progression: mapRow(r.rows[0]), gold: Number(g.rows[0].gold) || 0, cost,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function applyDeath(pool, userId) {
  const before = await loadProgression(pool, userId);
  const { experience, lost } = applyDeathPenalty(before.experience, before.level);
  if (lost <= 0) return { progression: before, lost: 0 };
  const r = await pool.query(
    `UPDATE player_progression SET experience = $2, updated_at = now()
      WHERE user_id = $1 RETURNING ${COLUMNS}`,
    [userId, experience],
  );
  return { progression: mapRow(r.rows[0]), lost };
}

module.exports = {
  loadProgression, awardXp, allocateStat, respec, applyDeath, XP_SOURCES,
};
