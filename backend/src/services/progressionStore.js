// Every read and write of player_progression. Nothing outside this file and
// playerStats.js touches the raw stat columns.

const { levelForXp, applyDeathPenalty, DEFAULT_PROGRESSION } = require('./playerStats.js');
const { getSetting } = require('./gameSettings.js');

// Required lazily, inside the functions that use it: passiveTreeStore.js
// requires this module back (for loadProgression's row lock), and a top-level
// require here would be a cycle that resolves to an empty object at load time.
function composer() { return require('./passiveTreeStore.js').composeProgression; }

const XP_SOURCES = ['kill', 'chest', 'dungeon_clear'];
const COLUMNS = `character_id, experience, level, passive_points,
                 strength, dexterity, constitution, intelligence, wisdom, charisma`;

// experience is bigint, which node-postgres returns as a STRING to avoid
// silent precision loss past 2^53. Normalise once, here, so no caller has to
// remember -- a forgotten Number() turns `xp + 10` into "0" + 10 === "010".
function mapRow(r) {
  return {
    character_id: r.character_id,
    experience: Number(r.experience) || 0,
    level: Number(r.level) || 1,
    passive_points: Number(r.passive_points) || 0,
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
async function loadProgression(db, characterId, { forUpdate = false } = {}) {
  await db.query(
    'INSERT INTO player_progression (character_id) VALUES ($1) ON CONFLICT (character_id) DO NOTHING',
    [characterId],
  );
  const r = await db.query(
    `SELECT ${COLUMNS} FROM player_progression WHERE character_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [characterId],
  );
  const row = r.rows.length ? mapRow(r.rows[0]) : { ...DEFAULT_PROGRESSION, character_id: characterId };
  // The ONE place the tree is folded in. Every caller of loadProgression --
  // the join frame, the character-sheet route, awardXp's own pre-read -- gets
  // the composed row for free, which is what stops a second, drifting composer
  // appearing at any of the seven `progression` push sites.
  return composer()(db, characterId, row);
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
// other award -- and since level and passive_points are derived from that same
// stale read, a level-up can be lost (or double-granted) right along with
// the XP. The row lock forces the second-and-later transactions to block
// until the first commits, so each one re-reads the just-committed value
// rather than a stale one.
async function awardXp(db, characterId, amount, source) {
  const before = await loadProgression(db, characterId, { forUpdate: true });
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
  const levelsGained = Math.max(0, newLevel - before.level);
  // The settings read happens ONLY on an actual level-up, so the common case
  // (a kill that does not level anyone) still issues exactly the two queries
  // it always did. `db` may be a client mid-transaction; getSetting is a plain
  // SELECT and is safe on either.
  const perLevel = levelsGained > 0
    ? Number(await getSetting(db, 'passive_points_per_level')) || 0
    : 0;
  const pointsGained = levelsGained * perLevel;
  const r = await db.query(
    `UPDATE player_progression
        SET experience = $2, level = $3, passive_points = passive_points + $4, updated_at = now()
      WHERE character_id = $1
      RETURNING ${COLUMNS}`,
    [characterId, experience, newLevel, pointsGained],
  );
  return {
    // Composed, like loadProgression's return: a kill push that carried the
    // raw row would overwrite the client's allocatedNodeIds with undefined and
    // silently revert every effective stat to the class-base snapshot.
    progression: await composer()(db, characterId, mapRow(r.rows[0])),
    leveledUp: newLevel > before.level,
    newLevel,
    pointsGained,
    awarded: amt,
  };
}

// Takes `pool`, not `db`, and opens its OWN transaction -- unlike awardXp,
// nothing upstream already has one open: server.js's onPlayerDeath calls
// this directly, fire-and-forget, off the tick loop (mirrors respec's shape
// for the same reason). Locks the row with the SAME SELECT ... FOR UPDATE
// contract 2ef7de5 gave awardXp, and for the identical hazard: a single tick
// can fire a kill (onCreatureDeath -> awardXp, its own transaction) and a
// death (onPlayerDeath -> applyDeath) for the SAME player at once. Read
// unlocked, this function's SELECT can capture the PRE-kill experience while
// awardXp's transaction is still open; its UPDATE -- writing a JS-computed
// ABSOLUTE value -- then blocks on awardXp's row lock and, once released,
// overwrites the row with that stale value, silently discarding the award
// that just committed. Worse: the de-level floor here is computed from that
// same stale `level` column, so if the kill's award levelled the player up
// inside this window, the write can land the persisted experience BELOW the
// NEW level's floor -- the exact invariant applyDeathPenalty exists to
// protect, violated by losing the race rather than by any arithmetic bug.
// `rng` is injectable so a test can pin the roll, matching the convention
// commitCreatureDeath already uses. The draw is taken here and handed to the
// pure penalty maths rather than generated inside it.
async function applyDeath(pool, characterId, { rng = Math.random } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await loadProgression(client, characterId, { forUpdate: true });
    const { experience, lost } = applyDeathPenalty(before.experience, before.level, rng());
    if (lost <= 0) {
      await client.query('COMMIT');
      return { progression: before, lost: 0 };
    }
    const r = await client.query(
      `UPDATE player_progression SET experience = $2, updated_at = now()
        WHERE character_id = $1 RETURNING ${COLUMNS}`,
      [characterId, experience],
    );
    const composed = await composer()(client, characterId, mapRow(r.rows[0]));
    await client.query('COMMIT');
    return { progression: composed, lost };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// `respec` is GONE, not renamed: T7 moved it to passiveTreeStore.respecPassives,
// which resets the passive allocations rather than six columns nothing can
// raise. Leaving a shim here would leave a second, gold-charging reset alive.
module.exports = { loadProgression, awardXp, applyDeath, XP_SOURCES };
