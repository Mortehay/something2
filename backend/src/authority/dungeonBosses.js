// SOMET-609 (S9, spec §4.1). Dungeon End/Elite bosses: placed when their world
// loads, brought back once after respawn_s. THE single owner of a dungeon
// boss's life -- the creature_respawns queue never sees one (a boss has no
// world_creatures row, and loot.js / respawnDueCreatures refuse boss-tier
// types as a backstop), and server.js's onCreatureDeath routes every `boss:`
// id here BEFORE commitCreatureDeath or WorldBossManager.
//
// State is in memory, keyed by world id, and outlives the world entry: a world
// evicted while its boss is dead and reloaded before due stays bossless. A
// process restart resets it -- boss instances are not persisted (spec §1).
const { hydrateCreatureRow, ENTITY_CATALOG_SELECT, CREATURE_SIZE } = require('./creatures.js');
const { isClearOfPlayers, RESPAWN_MIN_PLAYER_DISTANCE } = require('../services/creatureRespawn.js');

const DUNGEON_BOSS_TIERS = Object.freeze(['dungeon_end', 'dungeon_elite']);
const ID_PREFIX = 'boss:';

function bossCreatureId(worldId) {
  return `${ID_PREFIX}${worldId}`;
}

// SOMET-626 (S13, grilled 2026-10-11). Helper minions escorting a dungeon
// boss. Deliberately NOT routed through creature_respawns (SOMET-309) --
// that queue is DB-backed and built for the wipe-and-refill population
// pipeline, and wiring a new creature class into it is a bigger change than
// this ticket's "quick respawn" ask needs. Instead this copies the pattern
// DungeonBossManager already uses for the boss itself: pure in-memory
// records, swept on the SAME 10s timer as the boss and the regular creature
// queue (server.js's one dungeonBosses.sweep() call site), just with a far
// shorter respawn delay. A minion is never persisted and resets on a process
// restart, same caveat the boss itself already carries.
//
// Reuses the EXISTING 4 elemental guard types world bosses already seed
// (SOMET-602/S1 "4 minion types") rather than authoring new ones -- no new
// catalog rows, no new art needed. Physical dungeon bosses (Bone Regent,
// Ossuary Warden) have no elemental guard to match, so they get Skeleton
// instead: both are explicitly skeletal/undead in their own catalog prompt
// ("a crowned skeletal monarch", "a towering armoured skeleton"), not an
// arbitrary fallback.
//
// Scope note: minibosses were part of the same request but do NOT get
// escort minions here. A dungeon boss has a manager with a clear "placed
// here" hook; a miniboss is a regular population-spawned creature with no
// such hook (SOMET-624/S11 deliberately kept it that way, reusing the
// ordinary biome spawn path rather than a new manager). Giving every
// miniboss INSTANCE an escort would need a hook into worldPopulation.js's
// wipe-and-refill pass across every world sharing that biome -- meaningfully
// bigger scope, left for a follow-up rather than forced into this ticket.
const MINION_ID_PREFIX = 'dminion:';
const MINION_OFFSETS = Object.freeze([[40, 40], [-40, -40]]); // same offsets worldBoss.js's phase minions use
const MINION_COUNT_BY_TIER = Object.freeze({ dungeon_end: 2, dungeon_elite: 1 });
const MINION_RESPAWN_MS = 20000; // "quick" against the boss's own 600-900s
const MINION_TYPE_BY_ELEMENT = Object.freeze({
  fire: 'Fire Elemental Guard', ice: 'Ice Elemental Guard',
  lightning: 'Lightning Elemental Guard', arcane: 'Arcane Elemental Guard',
});
const PHYSICAL_MINION_TYPE = 'Skeleton';

function minionId(worldId, i) {
  return `${MINION_ID_PREFIX}${worldId}:${i}`;
}

function minionTypeNameFor(element) {
  return MINION_TYPE_BY_ELEMENT[element] || PHYSICAL_MINION_TYPE;
}

// Unlike loadDungeonBossRow, no boss_tier filter -- the elemental guards and
// Skeleton are ordinary (non-boss) catalog rows.
async function loadMinionRow(pool, name) {
  const r = await pool.query(`${ENTITY_CATALOG_SELECT} WHERE et.name = $1 AND et.is_creature = true`, [name]);
  return r.rows[0] || null;
}

// worlds.dungeon_boss -> a placement, or null when absent or malformed.
function parseDungeonBoss(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { entity, x, y, respawn_s: respawnS } = raw;
  if (typeof entity !== 'string' || entity === '') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  if (!Number.isInteger(respawnS) || respawnS <= 0) return null;
  return { entity, x, y, respawnS };
}

// Spec §3.8: End = the room's level_band ceiling, Elite = "midpoint+". Derived
// from the LIVE world row, so a re-banded room re-levels its boss on next load.
function dungeonBossLevel(tier, levelMin, levelMax) {
  const lo = Number.isInteger(levelMin) && levelMin >= 1 ? levelMin : 1;
  const hi = Number.isInteger(levelMax) && levelMax >= lo ? levelMax : lo;
  if (tier === 'dungeon_end') return hi;
  return Math.min(hi, Math.ceil((lo + hi) / 2) + 1);
}

// The boss TYPE row through the shared catalog SELECT (S1/S3), so behaviour,
// abilities, vfx, auras and the boss fields arrive exactly as for a world boss.
async function loadDungeonBossRow(pool, name) {
  const r = await pool.query(
    `${ENTITY_CATALOG_SELECT}
      WHERE et.name = $1 AND et.is_creature = true AND et.boss_tier = ANY($2::text[])`,
    [name, DUNGEON_BOSS_TIERS],
  );
  return r.rows[0] || null;
}

class DungeonBossManager {
  constructor({
    pool = null, loadRow = null, loadMinionRow: loadMinionRowOpt = null,
    clock = () => Date.now(), onKilled = null, log = console,
  } = {}) {
    this.loadRow = loadRow || (pool ? (name) => loadDungeonBossRow(pool, name) : async () => null);
    this.loadMinionRow = loadMinionRowOpt || (pool ? (name) => loadMinionRow(pool, name) : async () => null);
    this.clock = clock;
    // S10 (boss loot) hooks here. S9 awards nothing: there is no world_creatures
    // row for commitCreatureDeath to commit.
    this.onKilled = onKilled;
    this.log = log;
    this.records = new Map(); // worldId -> { creatureId, deadUntil, creature, row, spec }
    // SOMET-626 (S13). `${worldId}:${i}` -> { creatureId, deadUntil, row, x, y }
    this.minionRecords = new Map();
    this._warned = new Set();
  }

  // Pure id test, so a boss kill is routed here even when the record is gone
  // (it must never fall through to commitCreatureDeath's uuid DELETE).
  isBoss(worldId, creatureId) {
    return typeof creatureId === 'string' && creatureId === bossCreatureId(worldId);
  }

  // Same shape as isBoss: a minion kill must never reach commitCreatureDeath
  // either (it has no world_creatures row, same reason as the boss).
  isMinion(worldId, creatureId) {
    return typeof creatureId === 'string' && creatureId.startsWith(`${MINION_ID_PREFIX}${worldId}:`);
  }

  _warnOnce(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this.log.warn(msg);
  }

  _deadNow(worldId) {
    const rec = this.records.get(worldId);
    return !!rec && rec.deadUntil != null && this.clock() < rec.deadUntil;
  }

  // Place this world's boss unless it is dead and not yet due. Idempotent:
  // addCreatures skips a known id, so a double load, or a load racing the
  // sweep, still leaves one instance. Never throws for bad data.
  //
  // `quiet` is true for world-load placement (loadWorld) and false for a sweep
  // respawn: a room that simply loads with its boss in it plays no spawn
  // sound, a boss coming BACK after its timer does (controller ruling N-1/P6).
  async place(entry, { quiet = false } = {}) {
    const raw = entry && entry.row ? entry.row.dungeon_boss : null;
    if (raw == null) return null;
    const worldId = entry.worldId;
    const spec = parseDungeonBoss(raw);
    if (!spec) {
      this._warnOnce(`spec:${worldId}`,
        `dungeon boss: world ${worldId} has a malformed dungeon_boss ${JSON.stringify(raw)}; no boss placed`);
      return null;
    }
    if (this._deadNow(worldId)) return null;
    const sim = entry.world && entry.world.creatures;
    if (!sim) return null;
    const id = bossCreatureId(worldId);
    const existing = sim.get(id);
    if (existing) return existing;

    const row = await this.loadRow(spec.entity);
    if (!row || !DUNGEON_BOSS_TIERS.includes(row.boss_tier)) {
      this._warnOnce(`row:${worldId}:${spec.entity}`,
        `dungeon boss: "${spec.entity}" (world ${worldId}) is not a dungeon_end/dungeon_elite creature; no boss placed`);
      return null;
    }
    // Re-check after the await: the boss may have been placed AND killed by a
    // concurrent caller while this one waited on the catalog.
    if (this._deadNow(worldId)) return null;
    // A concurrent caller may have placed it while this one awaited; keep its
    // record (addCreatures would skip the duplicate id anyway).
    const raced = sim.get(id);
    if (raced) return raced;

    const maxHp = Number(row.max_hp) || Number(row.hp) || 1;
    const hydrated = hydrateCreatureRow(row, {
      id, hp: maxHp,
      level: dungeonBossLevel(row.boss_tier, entry.row.level_min, entry.row.level_max),
      // In-memory leash post (never persisted): the boss holds its room
      // instead of roaming the whole world after a player.
      home_x: spec.x, home_y: spec.y,
    });
    // Ruling P1: the post is a tile CENTRE and the sim reads `home` as a
    // centre (snap-home sets x = home.x - width/2), while x/y are top-left.
    // Offsetting by half the catalog hitbox stands the boss ON its post instead
    // of 36-56px down-right of it (and snapping on its first walk home).
    const size = hydrated.hitboxSize ?? CREATURE_SIZE;
    hydrated.x = spec.x - size / 2;
    hydrated.y = spec.y - size / 2;
    // N-1/P6: `quietSpawn` is an addCreatures INPUT flag (S2, SOMET-605) that
    // suppresses the boss spawn sound; addCreatures never copies it onto the
    // sim creature.
    if (quiet) hydrated.quietSpawn = true;
    sim.addCreatures([hydrated]);
    const creature = sim.get(id) || null;
    this.records.set(worldId, { creatureId: id, deadUntil: null, creature, row, spec });
    // SOMET-626 (S13). Fresh placement only, same as the boss above -- never
    // re-summons a minion that is just on its own (short) cooldown.
    await this._placeMinions(entry, worldId, row, spec, quiet);
    return creature;
  }

  // Escort minions, placed once alongside a fresh boss placement and
  // thereafter respawning independently and much faster than the boss
  // itself (see sweep()). Never throws: a missing/renamed minion type row
  // degrades to "no minion", exactly like a malformed boss spec.
  async _placeMinions(entry, worldId, bossRow, spec, quiet) {
    const sim = entry.world && entry.world.creatures;
    if (!sim) return;
    const typeName = minionTypeNameFor(bossRow.element);
    const minionRow = await this.loadMinionRow(typeName);
    if (!minionRow) {
      this._warnOnce(`minion-row:${worldId}:${typeName}`,
        `dungeon boss: minion type "${typeName}" (world ${worldId}) is missing from the catalog; no minions placed`);
      return;
    }
    const count = MINION_COUNT_BY_TIER[bossRow.boss_tier] || 0;
    for (let i = 0; i < count; i += 1) {
      const key = `${worldId}:${i}`;
      if (this.minionRecords.has(key)) continue; // already tracked (placed or on cooldown)
      const [dx, dy] = MINION_OFFSETS[i % MINION_OFFSETS.length];
      const x = spec.x + dx;
      const y = spec.y + dy;
      const id = minionId(worldId, i);
      const hydrated = hydrateCreatureRow(minionRow, {
        id, hp: Number(minionRow.max_hp) || Number(minionRow.hp) || 1,
        level: dungeonBossLevel(bossRow.boss_tier, entry.row.level_min, entry.row.level_max),
      });
      const size = hydrated.hitboxSize ?? CREATURE_SIZE;
      hydrated.x = x - size / 2;
      hydrated.y = y - size / 2;
      if (quiet) hydrated.quietSpawn = true;
      sim.addCreatures([hydrated]);
      this.minionRecords.set(key, { creatureId: id, deadUntil: null, row: minionRow, x, y });
    }
  }

  // The boss died (it is already out of the sim, creatures.js _removeKilled).
  // Start the respawn timer and hand S10 the kill. Returns the kill record, or
  // null for a duplicate report / unknown id.
  onDeath(entry, creatureId, killerUserId = null) {
    const worldId = entry && entry.worldId;
    const rec = this.records.get(worldId);
    if (!rec || rec.creatureId !== creatureId || rec.deadUntil != null) return null;
    rec.deadUntil = this.clock() + rec.spec.respawnS * 1000;
    const c = rec.creature || {};
    const half = (c.width || CREATURE_SIZE) / 2;
    const kill = {
      entry, worldId, creatureId, killerUserId: killerUserId ?? null,
      entityName: rec.row.name, entityTypeId: rec.row.id ?? null, bossTier: rec.row.boss_tier,
      // SOMET-611 (S10): the full catalog row, so onKilled can resolve the
      // entity's loot profile (bossLoot.js's resolveLootProfile) without a
      // second query -- this.loadRow already fetched it via
      // ENTITY_CATALOG_SELECT, which now carries the four loot_* columns.
      row: rec.row,
      level: c.level ?? 1,
      // The CENTRE of the boss's last position (a drop lands where it stood,
      // as loot.js's dropX = dead.x + size/2 does for a wild creature).
      x: Number.isFinite(c.x) ? c.x + half : rec.spec.x,
      y: Number.isFinite(c.y) ? c.y + half : rec.spec.y,
    };
    if (this.onKilled) {
      try {
        Promise.resolve(this.onKilled(kill)).catch((err) => this.log.error(`dungeon boss onKilled failed: ${err && err.message}`));
      } catch (err) {
        this.log.error(`dungeon boss onKilled failed: ${err && err.message}`);
      }
    }
    return kill;
  }

  // A minion died (already out of the sim). Starts ITS OWN short respawn
  // timer -- independent of the boss's, and independent of its sibling
  // minion's. Returns true when handled, false for an unknown/duplicate id
  // (the boss death dispatcher falls through to commitCreatureDeath on
  // false, same contract as onDeath's null return for the boss itself).
  onMinionDeath(entry, creatureId) {
    const worldId = entry && entry.worldId;
    for (const [key, rec] of this.minionRecords) {
      if (!key.startsWith(`${worldId}:`) || rec.creatureId !== creatureId || rec.deadUntil != null) continue;
      rec.deadUntil = this.clock() + MINION_RESPAWN_MS;
      return true;
    }
    return false;
  }

  // Re-place every due boss in a LOADED world whose post is clear of players
  // (the same 1000px rule as creature respawn). An unloaded world stays due and
  // its next load places the boss. Returns how many were placed.
  async sweep(worlds, getPlayers = () => []) {
    let placed = 0;
    const now = this.clock();
    for (const [worldId, rec] of this.records) {
      if (rec.deadUntil == null || now < rec.deadUntil) continue;
      const entry = worlds.get(worldId);
      if (!entry) continue;
      if (!isClearOfPlayers(rec.spec.x, rec.spec.y, getPlayers(worldId) || [], RESPAWN_MIN_PLAYER_DISTANCE)) continue;
      // Count real placements only: place() returns an already-present boss too.
      const sim = entry.world && entry.world.creatures;
      const had = sim ? sim.get(bossCreatureId(worldId)) : null;
      const c = await this.place(entry); // a respawn is loud (quiet: false)
      if (c && !had) placed += 1;
    }
    placed += await this._sweepMinions(worlds, getPlayers);
    return placed;
  }

  // SOMET-626 (S13). Same shape as the boss sweep above, just against
  // minionRecords and MINION_RESPAWN_MS instead of a boss's own respawn_s.
  async _sweepMinions(worlds, getPlayers) {
    let placed = 0;
    const now = this.clock();
    for (const [key, rec] of this.minionRecords) {
      if (rec.deadUntil == null || now < rec.deadUntil) continue;
      const worldId = key.slice(0, key.lastIndexOf(':'));
      const entry = worlds.get(worldId);
      if (!entry) continue;
      const sim = entry.world && entry.world.creatures;
      if (!sim) continue;
      if (!isClearOfPlayers(rec.x, rec.y, getPlayers(worldId) || [], RESPAWN_MIN_PLAYER_DISTANCE)) continue;
      const hydrated = hydrateCreatureRow(rec.row, { id: rec.creatureId, hp: Number(rec.row.max_hp) || Number(rec.row.hp) || 1 });
      const size = hydrated.hitboxSize ?? CREATURE_SIZE;
      hydrated.x = rec.x - size / 2;
      hydrated.y = rec.y - size / 2;
      sim.addCreatures([hydrated]);
      rec.deadUntil = null;
      placed += 1;
    }
    return placed;
  }
}

module.exports = {
  DungeonBossManager, parseDungeonBoss, dungeonBossLevel, loadDungeonBossRow, bossCreatureId,
  DUNGEON_BOSS_TIERS, minionId, minionTypeNameFor, loadMinionRow,
  MINION_COUNT_BY_TIER, MINION_RESPAWN_MS, MINION_TYPE_BY_ELEMENT, PHYSICAL_MINION_TYPE,
};
