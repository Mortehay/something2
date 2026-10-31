// Boss gates: on a Spire of Trials floor that has a boss, the way forward (the
// east door to the next floor) stays shut until the character has beaten that
// floor's boss. The way back is never gated.
//
// Pure rules plus two tiny queries. The authority holds each live player's
// cleared set on the player object (loaded at join, updated on a kill) so the
// per-tick doorway check costs a Set lookup, not a query.

const SPIRE_FLOOR = /^Spire of Trials: Floor \d+$/;
// Players within this many pixels of the boss when it dies share the clear (a
// group fight must not force a second kill for whoever did not land the hit).
const SHARE_RADIUS_PX = 1500;

// A world is gated when it is a Spire floor that carries a boss.
function isGatedWorld(row) {
  return !!(row && row.dungeon_boss && SPIRE_FLOOR.test(String(row.name || '')));
}

// May this player take the doorway that leads to `toWorldId`?
//   gated      -- isGatedWorld(entry.row)
//   forwardTo  -- the world id the east door leads to
//   cleared    -- the player's Set of cleared world ids; undefined (not loaded
//                 yet) counts as nothing cleared, so the door fails CLOSED
function mayPass({ gated, worldId, toWorldId, forwardTo, cleared, isAdmin = false }) {
  if (!gated || isAdmin) return true;
  if (!forwardTo || toWorldId !== forwardTo) return true; // only the way forward is gated
  return !!(cleared && cleared.has(worldId));
}

async function loadClearedBosses(pool, characterId) {
  const r = await pool.query('SELECT world_id FROM character_boss_clears WHERE character_id = $1', [characterId]);
  return new Set(r.rows.map((x) => x.world_id));
}

async function recordBossClear(pool, characterId, worldId) {
  await pool.query(
    `INSERT INTO character_boss_clears (character_id, world_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [characterId, worldId],
  );
}

// Who gets credit for a boss death at (x, y): the killer plus everyone close.
// `players` is any iterable of live player objects.
function clearBeneficiaries(players, killerUserId, x, y) {
  const out = [];
  for (const p of players) {
    if (p.characterId == null) continue;
    const cx = p.x + (p.width || 0) / 2, cy = p.y + (p.height || 0) / 2;
    if (p.userId === killerUserId || Math.hypot(cx - x, cy - y) <= SHARE_RADIUS_PX) out.push(p);
  }
  return out;
}

module.exports = { isGatedWorld, mayPass, loadClearedBosses, recordBossClear, clearBeneficiaries, SHARE_RADIUS_PX };
