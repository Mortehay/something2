// backend/src/services/chests.js
// Vault chest authoring support: stamps a map-spec-declared chest and its
// guard into a world, mirroring insertVillageGuards'/insertPortalGuards' role
// for villages/portals. `db` is any queryable (bare pool or a checked-out
// transaction client), same contract those two follow.
//
// Unlike a village/portal guard (a fixed-stat "Village Guard"/pack creature
// template, hp always 300, never leveled), a vault chest names a REAL
// creature type by `guardCreatureType` and scales it to `level` with the
// same scaleCreature the world-population paths already use for scattered
// and packed creatures -- a vault guard is meant to be a real, level-
// appropriate fight, not a flavor-only obstacle.
//
// world_creatures has no `resistances` column -- resistances live on
// entity_types and are joined in at creature-load time (authority/server.js's
// live-creature SELECT: `et.resistances`, keyed by wc.type = et.name). So the
// guard's resistances need no per-instance write here; naming the right
// `type` is enough for the authority to resolve them.
const { scaleCreature } = require('./creatureLevel.js');

async function insertVaultChest(db, worldId, chestSpec) {
  const { x, y, guardCreatureType, level } = chestSpec;
  const et = await db.query(
    'SELECT id, hp, defense FROM entity_types WHERE name = $1', [guardCreatureType],
  );
  if (et.rowCount === 0) {
    throw new Error(`insertVaultChest: unknown guard creature type "${guardCreatureType}"`);
  }
  const t = et.rows[0];
  const scaled = scaleCreature({ hp: t.hp || 10, defense: Number(t.defense ?? 0) || 0 }, level);

  // home_x/home_y is the chest tile itself: the authority leashes the guard
  // to it, exactly like a village/portal guard leashes to its post.
  const guard = await db.query(
    `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, defense)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [worldId, guardCreatureType, x, y, scaled.hp, 'S', x, y, level, scaled.defense],
  );
  const guardCreatureId = guard.rows[0].id;

  const chest = await db.query(
    `INSERT INTO world_chests (world_id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids, state)
     VALUES ($1,$2,$3,'vault',$4,$5,$6,'locked') RETURNING id`,
    [worldId, x, y, t.id, level, JSON.stringify([guardCreatureId])],
  );
  return { id: chest.rows[0].id, guardCreatureId };
}

// Parallel to fetchVillages (villages.js): the live-world loader reads this
// once per world and holds it in-memory the same way it already holds
// villages, so a chest's guard-death/open/respawn transitions can be checked
// against `entry.chests` without a query per tick.
async function fetchChests(pool, worldId) {
  const r = await pool.query(
    `SELECT id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids, state, opened_at, respawn_at
       FROM world_chests WHERE world_id = $1 ORDER BY created_at ASC`,
    [worldId],
  );
  return r.rows.map((c) => ({
    id: c.id,
    x: c.x, y: c.y,
    kind: c.kind,
    guardEntityTypeId: c.guard_entity_type_id,
    guardLevel: c.guard_level,
    guardCreatureIds: c.guard_creature_ids || [],
    state: c.state,
    openedAt: c.opened_at,
    respawnAt: c.respawn_at,
  }));
}

module.exports = { insertVaultChest, fetchChests };
