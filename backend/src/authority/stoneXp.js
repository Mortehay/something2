// Stone XP, independent of services/progressionStore.js's player-scoped
// awardXp -- a stone's XP/level live entirely in stone_instances, never
// touching player_progression. See stone_instances' migration
// (1714440166000_stone_instances.js) for the xp/level columns this writes.
//
// Level formula: services/progressionConstants.js's XP_BASE curve is
// player-level-scoped (xpToNext(level) = XP_BASE * level, cumulative
// XP_BASE*(level-1)*level/2) and tuned against player XP sources (kills,
// chests, dungeons) that have nothing to do with a stone landing hits --
// reusing it here would borrow tuning that was never validated for this
// axis. No other stone-XP curve exists yet to reuse, so this is a flat
// per-level threshold, same "first numbers, not balanced ones" caveat
// progressionConstants.js's own header attaches to the player curve.
const LEVEL_XP_THRESHOLD = 100; // XP per stone level, flat -- see comment above before changing.

// Flat per-landed-hit award. progressionConstants.js has no existing
// per-hit (as opposed to per-kill) XP convention to borrow -- XP_KILL_BASE
// is scaled by a creature/player level difference that has no equivalent
// concept for "a spell stone's hit connected," so a flat constant is the
// documented fallback the brief allows rather than inventing a bespoke
// scaled curve for a single data point.
const STONE_XP_PER_HIT = 10;

// Adds `amount` XP to the stone instance identified by its OWN
// player_items.id (stonePlayerItemId) -- NOT the host weapon's id, and NOT
// the stone's catalog item_type_id. Race-safe: increments in SQL
// (`xp = xp + $1`), never read-then-write in JS, so two hits landed in the
// same tick (or across overlapping requests) cannot clobber each other.
// `beforeLevel` is read first (unlocked -- see below) purely to compute
// `leveledUp`; the actual write and its RETURNING are what's authoritative.
//
// Returns null if the stone id does not exist (e.g. it was destroyed by an
// unsocket roll between the hit landing and this write reaching the DB --
// fire-and-forget callers, per server.js's onStoneHit, already treat a
// rejected/no-op award as best-effort and just log, never crash the tick).
async function awardStoneXp(pool, stonePlayerItemId, amount) {
  const before = await pool.query('SELECT level FROM stone_instances WHERE player_item_id = $1', [stonePlayerItemId]);
  const beforeLevel = before.rows[0] ? Number(before.rows[0].level) : 1;

  const r = await pool.query(
    `UPDATE stone_instances SET xp = xp + $1,
            level = GREATEST(level, 1 + floor((xp + $1) / $2)::int)
      WHERE player_item_id = $3
      RETURNING xp, level`,
    [amount, LEVEL_XP_THRESHOLD, stonePlayerItemId],
  );
  if (r.rowCount === 0) return null;
  const { xp, level } = r.rows[0];
  return { xp: Number(xp), level: Number(level), leveledUp: Number(level) > beforeLevel };
}

module.exports = { awardStoneXp, LEVEL_XP_THRESHOLD, STONE_XP_PER_HIT };
