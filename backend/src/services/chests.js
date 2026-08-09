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
const { placeMapCreatures } = require('./mapService.js');

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

// Shared row -> in-memory shape mapper. Both fetchChests (world-load) and
// spawnFieldChest (a chest inserted mid-session) feed entry.chests, so both
// MUST produce the exact same camelCase shape -- a chest pushed onto
// entry.chests straight from a raw `RETURNING *` row (snake_case) would sit
// next to every other entry silently differently-shaped, a landmine for
// whatever later reads entry.chests (guard-death/open/respawn transitions).
function mapChestRow(c) {
  return {
    id: c.id,
    x: c.x, y: c.y,
    kind: c.kind,
    guardEntityTypeId: c.guard_entity_type_id,
    guardLevel: c.guard_level,
    guardCreatureIds: c.guard_creature_ids || [],
    state: c.state,
    openedAt: c.opened_at,
    respawnAt: c.respawn_at,
  };
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
  return r.rows.map(mapChestRow);
}

// Field chest: spawned only by a loot-map use, never map-spec-authored.
// Reuses placeMapCreatures for tile legality and level rolling instead of
// reimplementing creatureTileCandidates -- a field chest's guard is placed
// exactly like any other scattered creature, just with a world_chests row
// riding along. Returns null when no legal tile exists (same contract as
// placeMapCreatures returning []), so the handler layer can report failure
// instead of silently doing nothing.
//
// `world` must be the SAME shape placeMapCreatures already requires
// elsewhere in this codebase (worldPopulation.js, seed-map.js): the
// buildWorldGenConfig(...) output -- carrying camelCase `levelMin`/
// `levelMax` (worldConfig() never derives these; placeMapCreatures reads
// them straight off `world`) plus `tileTypes`/`width`/`height`/etc for tile
// legality -- with a `.id` added for the INSERT statements below. The raw
// `worlds` table row (`entry.row`) is NOT this shape: it carries
// `level_min`/`level_max` (snake_case, straight off the SQL SELECT) and has
// no `tileTypes` at all, so passing it directly would either roll every
// creature at level 1 silently (rollCreatureLevel treats a non-integer bound
// as "no band") or throw ("worldConfig: tileTypes is empty") before ever
// reaching a placement. Callers build this by spreading a cached
// buildWorldGenConfig(...) result (see server.js's entry.mapGenConfig) with
// `.id` added, not by re-deriving it here.
//
// `allowedGuardTypeNames` is a list of entity_type NAMES (e.g. ['Wolf']),
// not row objects. This resolves them to full entity_types rows FIRST
// (needed before placement, not after): placeMapCreatures reads `.hp`/
// `.defense`/`.resistances` off each allowedTypes element to scale the
// creature it ends up placing (see worldPopulation.js's own hostileTypes,
// which is entity_types rows for the exact same reason) -- resolving only
// AFTER placement, from the placed type's bare name, would have nothing to
// look up a name against and would silently scale from hp:10/defense:0
// defaults instead of the real creature's stats.
async function spawnFieldChest(client, world, allowedGuardTypeNames, rngSeed) {
  const et = await client.query(
    'SELECT id, name, hp, defense, resistances FROM entity_types WHERE name = ANY($1::text[])',
    [allowedGuardTypeNames],
  );
  if (et.rowCount === 0) {
    throw new Error(`spawnFieldChest: none of the allowed guard types exist: ${allowedGuardTypeNames.join(', ')}`);
  }

  const placed = placeMapCreatures(world, 1, et.rows, rngSeed);
  if (placed.length === 0) return null;
  const p = placed[0];
  const guardType = et.rows.find((t) => t.name === p.type);

  // world_creatures has no `resistances` column -- resistances live on
  // entity_types and are joined in at creature-load time (see
  // insertVaultChest's header comment above), so naming the right `type` is
  // enough; there is nothing per-instance to write here.
  const guard = await client.query(
    `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, defense)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [world.id, p.type, p.x, p.y, p.hp, p.facing, p.x, p.y, p.level, p.defense],
  );
  const guardCreatureId = guard.rows[0].id;

  const chest = await client.query(
    `INSERT INTO world_chests (world_id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids, state)
     VALUES ($1,$2,$3,'field',$4,$5,$6,'locked') RETURNING *`,
    [world.id, p.x, p.y, guardType.id, p.level, JSON.stringify([guardCreatureId])],
  );
  // `row` (normalized via mapChestRow, the same shape fetchChests produces)
  // lets the `use` handler push straight onto entry.chests without a second
  // query AND without desyncing entry.chests' element shape.
  return { id: chest.rows[0].id, guardCreatureId, row: mapChestRow(chest.rows[0]) };
}

// Mirrors nearestMerchantVillage (server.js:141) exactly: nearest entry
// within radius, or null. Only chests NOT yet fully opened are candidates
// for interaction -- an opened vault chest has nothing left to do. A field
// chest is a one-shot spawn with no further use once opened either, but it
// is left reachable by proximity here (unlike a permanently-spent vault) --
// nothing currently re-visits an opened field chest since openChest itself
// refuses an already-'opened' chest regardless, so excluding vault-only
// keeps the skip narrowly scoped to what the design actually calls out.
function nearestChest(chests, cx, cy, radius) {
  let best = null; let bestDist = Infinity;
  for (const c of chests) {
    if (c.state === 'opened' && c.kind === 'vault') continue; // permanently spent
    const dx = c.x - cx;
    const dy = c.y - cy;
    const dist = Math.sqrt((dx * dx) + (dy * dy));
    if (dist <= radius && dist < bestDist) { best = c; bestDist = dist; }
  }
  return best;
}

// Sweeps field chests past their respawn_at back to a fresh locked state
// with a NEW guard -- same row, same x/y, so a stale in-flight client
// reference to the chest id stays valid. Vault chests are excluded by the
// `kind = 'field'` filter; they never carry a respawn_at in the first place
// (openChest in chestLoot.js only sets one for kind='field').
//
// `getWorld` is injected (not queried inline) so this stays testable against
// a plain mock instead of a real `worlds` row shape. It also lets the caller
// decide what "world" means operationally: the real server.js wiring only
// serves currently-loaded worlds (their cached mapGenConfig), returning null
// for anything not loaded rather than either reconstructing mapGenConfig
// from scratch or eagerly loading an otherwise-empty world into memory (the
// latter would leak -- nothing besides a socket's close handler currently
// evicts an empty world entry, and a background sweep never fires that
// handler). A chest whose world isn't loaded this pass simply stays due and
// is retried on a later sweep.
//
// `world` must be the SAME buildWorldGenConfig shape placeMapCreatures
// already requires elsewhere in this file (see spawnFieldChest's header
// comment above) -- carrying camelCase `levelMin`/`levelMax` and
// `tileTypes`/`width`/`height`/etc, NOT a raw `worlds` table row. Passing the
// raw row would throw ('worldConfig: tileTypes is empty') before ever
// reaching a placement.
//
// `onReset`, called synchronously right after each chest's DB UPDATE commits,
// hands the caller the EXACT patch this function just wrote (mapChestRow-
// shaped: state/openedAt/respawnAt/guardCreatureIds/guardLevel) plus the
// chest's id and worldId. This is what lets a caller with a live in-memory
// cache (server.js's entry.chests) apply an in-place Object.assign to just
// the matching element -- the same convention every other chest write in
// this codebase already follows (spawnFieldChest's caller pushes one row,
// openChest's caller Object.assigns one element) -- instead of requerying
// and replacing the whole cache. A prior version of the server.js wiring did
// exactly that (a full fetchChests + `entry.chests = chests` replace after
// ANY reset), which raced a concurrent openchest handler: if the replace's
// SELECT ran before that handler's commit but resolved after the handler's
// own Object.assign, the just-opened UNRELATED chest's in-memory state would
// silently revert to stale. Driving the patch directly off this function's
// own write, with no intervening read, makes that race structurally
// impossible.
async function respawnDueFieldChests(client, { getWorld, onReset = () => {} }) {
  const due = await client.query(
    "SELECT id, world_id, x, y, guard_entity_type_id FROM world_chests WHERE kind = 'field' AND state = 'opened' AND respawn_at <= now()",
  );
  let reset = 0;
  for (const chest of due.rows) {
    try {
      // Full row (id, name, hp, defense, resistances), matching
      // spawnFieldChest's own entity_types resolve above -- placeMapCreatures
      // reads `.hp`/`.defense`/`.resistances` off each allowedTypes element
      // to scale the guard it places. A name-only row would silently place
      // the respawned guard at hp:10/defense:0/no-resistances fallback stats
      // regardless of what the real creature type carries.
      const et = await client.query(
        'SELECT id, name, hp, defense, resistances FROM entity_types WHERE id = $1',
        [chest.guard_entity_type_id],
      );
      if (et.rowCount === 0) continue; // guard type deleted from the catalog since; leave this chest for manual cleanup

      const world = await getWorld(chest.world_id);
      if (!world) continue; // owning world isn't loaded this pass; respawn_at stays past-due, retried next sweep

      const placed = placeMapCreatures(world, 1, et.rows, Math.floor(Math.random() * 2 ** 31));
      if (placed.length === 0) continue; // no legal tile this pass; try again next sweep
      const p = placed[0];

      // world_creatures has no `resistances` column (see this file's header
      // comment) -- naming the right `type` is enough for the authority to
      // resolve resistances at creature-load time, same as spawnFieldChest.
      const guard = await client.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, defense)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [chest.world_id, p.type, chest.x, chest.y, p.hp, p.facing, chest.x, chest.y, p.level, p.defense],
      );

      await client.query(
        `UPDATE world_chests SET state = 'locked', opened_at = NULL, respawn_at = NULL,
                guard_creature_ids = $1, guard_level = $2
         WHERE id = $3`,
        [JSON.stringify([guard.rows[0].id]), p.level, chest.id],
      );
      reset += 1;
      // Counted above unconditionally: the DB write already committed, so
      // this chest WAS reset regardless of whether the caller's onReset
      // (best-effort cache sync) throws.
      onReset({
        id: chest.id,
        worldId: chest.world_id,
        state: 'locked',
        openedAt: null,
        respawnAt: null,
        guardCreatureIds: [guard.rows[0].id],
        guardLevel: p.level,
      });
    } catch (err) {
      // One bad chest (deleted world, DB hiccup) must not abort the whole
      // sweep -- every other due chest still gets its turn this pass, and
      // this one's respawn_at stays past-due for a retry next sweep.
      console.error(`respawnDueFieldChests: failed to respawn chest ${chest.id}:`, err);
    }
  }
  return reset;
}

module.exports = {
  insertVaultChest, fetchChests, spawnFieldChest, nearestChest, respawnDueFieldChests,
};
