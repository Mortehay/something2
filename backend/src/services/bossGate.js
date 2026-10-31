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

// Resolves true when this is the character's FIRST clear of that boss.
async function recordBossClear(pool, characterId, worldId) {
  const r = await pool.query(
    `INSERT INTO character_boss_clears (character_id, world_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [characterId, worldId],
  );
  return r.rowCount > 0;
}

// First-clear reward: gold, a thousand per floor (Floor 5 pays 5,000; Floor 60
// pays 60,000). Paid once per character per boss, with the clear itself.
const GOLD_PER_FLOOR = 1000;
function firstClearGold(floor) {
  return Number.isInteger(floor) && floor > 0 ? floor * GOLD_PER_FLOOR : 0;
}

// Gold is an account balance (users.gold), the same one quest rewards pay into.
// Resolves the new balance, or null when the character does not exist.
async function awardGold(pool, characterId, amount) {
  if (!(amount > 0)) return null;
  const r = await pool.query(
    `UPDATE users SET gold = gold + $2
       FROM characters c
      WHERE c.id = $1 AND users.id = c.user_id
      RETURNING users.gold`,
    [characterId, amount],
  );
  return r.rows[0] ? Number(r.rows[0].gold) : null;
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

// What to tell a player at a sealed door / after the clear. The Floor 60 gate is
// the endgame one: a world boss guards the way into Floor 61.
function isWorldBossGate(row) {
  return !!(row && row.dungeon_boss && /^Spire of Trials: Floor 60$/.test(String(row.name || '')));
}
function sealedMessage(row) {
  return isWorldBossGate(row)
    ? 'A World Boss guards the passage to Floor 61 — defeat it to enter.'
    : 'The door is sealed — defeat the floor boss to go on.';
}
function openedMessage(row) {
  return isWorldBossGate(row)
    ? 'The World Boss falls — the passage to Floor 61 is open!'
    : 'Floor boss defeated — the way forward is open!';
}

module.exports = {
  firstClearGold, awardGold, GOLD_PER_FLOOR,
  isWorldBossGate, sealedMessage, openedMessage, isGatedWorld, mayPass, loadClearedBosses, recordBossClear, clearBeneficiaries, SHARE_RADIUS_PX };
