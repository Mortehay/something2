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
  constructor({ pool = null, loadRow = null, clock = () => Date.now(), onKilled = null, log = console } = {}) {
    this.loadRow = loadRow || (pool ? (name) => loadDungeonBossRow(pool, name) : async () => null);
    this.clock = clock;
    // S10 (boss loot) hooks here. S9 awards nothing: there is no world_creatures
    // row for commitCreatureDeath to commit.
    this.onKilled = onKilled;
    this.log = log;
    this.records = new Map(); // worldId -> { creatureId, deadUntil, creature, row, spec }
    this._warned = new Set();
  }

  // Pure id test, so a boss kill is routed here even when the record is gone
  // (it must never fall through to commitCreatureDeath's uuid DELETE).
  isBoss(worldId, creatureId) {
    return typeof creatureId === 'string' && creatureId === bossCreatureId(worldId);
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
    // >>> S2 REBASE (N-1/P6): S2 adds a `quietSpawn` addCreatures input flag
    // that suppresses the boss spawn sound. After rebasing onto S2, set
    // `hydrated.quietSpawn = quiet;` here. Until then there is no spawn sound
    // to suppress and `quiet` is carried but unused. <<<
    void quiet;
    sim.addCreatures([hydrated]);
    const creature = sim.get(id) || null;
    this.records.set(worldId, { creatureId: id, deadUntil: null, creature, row, spec });
    return creature;
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
    return placed;
  }
}

module.exports = {
  DungeonBossManager, parseDungeonBoss, dungeonBossLevel, loadDungeonBossRow, bossCreatureId,
  DUNGEON_BOSS_TIERS,
};
