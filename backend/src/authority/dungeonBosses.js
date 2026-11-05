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
// A post may also hold a WORLD boss (the Spire's gate to Floor 61). It is placed
// like any post boss but fights like a world boss: huge HP, phase shields, ward.
const POST_TIERS = Object.freeze([...DUNGEON_BOSS_TIERS, 'world']);
const balance = require('../services/bossBalance.js');
const { scaleCreature } = require('../services/creatureLevel.js');
const { createBossController } = require('./bossAI.js');
const ID_PREFIX = 'boss:';

// A dead boss respawns when no player stands within this many pixels of its
// post. It used to be the general 1000px creature rule, which the Spire's own
// checkpoint (300px from the post) defeated: anyone waiting at the checkpoint for
// the boss to come back was the thing keeping it from coming back.
const BOSS_RESPAWN_CLEAR_PX = 250;
// The boss is shared but a clear is per character. A player who arrives after
// someone else killed it, and has not cleared it themselves, would otherwise wait
// out the full respawn_s (up to 30 min on Floor 60) behind a sealed door. Such a
// world brings its boss back this soon after the death instead.
const LATE_ARRIVAL_RESPAWN_MS = 30 * 1000;
// Phase adds (bossAI.js): at most this many alive at once, placed on a ring.
const MAX_LIVE_ADDS = 6;
const ADD_RING_PX = 110;

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
  if (tier === 'dungeon_end' || tier === 'world') return hi;
  return Math.min(hi, Math.ceil((lo + hi) / 2) + 1);
}

// The boss TYPE row through the shared catalog SELECT (S1/S3), so behaviour,
// abilities, vfx, auras and the boss fields arrive exactly as for a world boss.
async function loadDungeonBossRow(pool, name) {
  const r = await pool.query(
    `${ENTITY_CATALOG_SELECT}
      WHERE et.name = $1 AND et.is_creature = true AND et.boss_tier = ANY($2::text[])`,
    [name, POST_TIERS],
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
    // Phase notifications (bossAI.js events + the boss name); server.js announces them.
    this.onPhase = null;
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
    if (!row || !POST_TIERS.includes(row.boss_tier)) {
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
    const bossLevel = dungeonBossLevel(row.boss_tier, entry.row.level_min, entry.row.level_max);
    // hp / damage / defense grow with the boss's level exactly as an ordinary
    // creature's do (creatureLevel.scaleCreature). Before this a Floor 35 boss
    // had the very stats of the Floor 5 one. A WORLD-tier post boss is skipped:
    // its numbers are hand-tuned in bossBalance and scaling would multiply them.
    const scaled = row.boss_tier === 'world'
      ? { hp: maxHp, damage: undefined, defense: undefined }
      : scaleCreature({ hp: maxHp, damage: Number(row.base_damage) || 0, defense: Number(row.defense) || 0 }, bossLevel);
    const hydrated = hydrateCreatureRow(row, {
      id, hp: scaled.hp,
      level: bossLevel,
      ...(row.boss_tier === 'world' ? {} : { damage: scaled.damage, defense: scaled.defense }),
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
    // A world-tier post boss carries the same hide as the world boss event.
    if (creature && row.boss_tier === 'world') {
      creature.damageTakenMult = balance.DAMAGE_TAKEN;
      const tuning = balance.WORLD_BOSSES[row.name];
      creature.shieldWeakTo = tuning ? tuning.shieldWeakTo : null;
    }
    const rec = {
      creatureId: id, deadUntil: null, deadAt: null, creature, row, spec, level: bossLevel,
      endurance: { phase: 1, lastWardAt: null }, minionRow: null, addIds: new Set(), addSeq: 0,
    };
    this.records.set(worldId, rec);
    // Boss AI (bossAI.js): attack selector, telegraphs, HP-threshold phases. Its
    // phase events (adds, arena, announcements) come back through here.
    if (creature) {
      creature.bossAI = createBossController(row, { seed: worldId });
      creature.bossAI.onEvent = (evt) => this._onBossEvent(entry, worldId, evt);
    }
    // SOMET-626 (S13). Fresh placement only, same as the boss above -- never
    // re-summons a minion that is just on its own (short) cooldown.
    rec.minionRow = await this._placeMinions(entry, worldId, row, spec, quiet);
    return creature;
  }

  // Escort minions, placed once alongside a fresh boss placement and
  // thereafter respawning independently and much faster than the boss
  // itself (see sweep()). Never throws: a missing/renamed minion type row
  // degrades to "no minion", exactly like a malformed boss spec.
  async _placeMinions(entry, worldId, bossRow, spec, quiet) {
    const sim = entry.world && entry.world.creatures;
    if (!sim) return null;
    const typeName = minionTypeNameFor(bossRow.element);
    const minionRow = await this.loadMinionRow(typeName);
    if (!minionRow) {
      this._warnOnce(`minion-row:${worldId}:${typeName}`,
        `dungeon boss: minion type "${typeName}" (world ${worldId}) is missing from the catalog; no minions placed`);
      return null;
    }
    const count = MINION_COUNT_BY_TIER[bossRow.boss_tier] || 0;
    const level = dungeonBossLevel(bossRow.boss_tier, entry.row.level_min, entry.row.level_max);
    for (let i = 0; i < count; i += 1) {
      const key = `${worldId}:${i}`;
      const id = minionId(worldId, i);
      // Skip a minion that is on its own cooldown, or already alive in THIS sim.
      // A record alone is not proof: the world may have been evicted and loaded
      // again, leaving a record whose creature died with the old sim -- that
      // minion has to be placed again or it is gone until a process restart.
      const known = this.minionRecords.get(key);
      if (known && (known.deadUntil != null || sim.get(id))) continue;
      const [dx, dy] = MINION_OFFSETS[i % MINION_OFFSETS.length];
      const x = spec.x + dx;
      const y = spec.y + dy;
      sim.addCreatures([this._hydrateMinion(minionRow, id, level, x, y, quiet)]);
      this.minionRecords.set(key, { creatureId: id, deadUntil: null, row: minionRow, x, y, level });
    }
    return minionRow;
  }

  // One minion at (x, y) (a centre), scaled to `level` like any ordinary creature.
  // Shared by the first placement, the respawn sweep and the phase adds, so they
  // can never disagree about level again (a respawned minion used to come back at
  // the catalogue level instead of its floor's).
  _hydrateMinion(row, id, level, x, y, quiet = false) {
    const base = Number(row.max_hp) || Number(row.hp) || 1;
    const scaled = scaleCreature({
      hp: base, damage: Number(row.base_damage) || 0, defense: Number(row.defense) || 0,
    }, level);
    const hydrated = hydrateCreatureRow(row, {
      id, hp: scaled.hp, level,
      ...(Number(row.base_damage) > 0 ? { damage: scaled.damage } : {}),
      defense: scaled.defense,
    });
    const size = hydrated.hitboxSize ?? CREATURE_SIZE;
    hydrated.x = x - size / 2;
    hydrated.y = y - size / 2;
    if (quiet) hydrated.quietSpawn = true;
    return hydrated;
  }

  // Events from a boss's controller (bossAI.js), raised from inside the sim tick.
  // Synchronous on purpose: everything it needs (the minion row) was loaded when
  // the boss was placed.
  _onBossEvent(entry, worldId, evt) {
    const rec = this.records.get(worldId);
    if (!rec || !evt) return;
    if (evt.type === 'phase' && evt.adds > 0) this._spawnAdds(entry, worldId, rec, evt);
    if (this.onPhase) {
      try { this.onPhase(entry, { ...evt, boss: rec.row.name }); } catch (err) { this.log.error(`dungeon boss onPhase failed: ${err && err.message}`); }
    }
  }

  // Phase adds: a ring of the boss's escort type around it, capped so a long
  // fight cannot pile up unbounded. Ids reuse the minion prefix so the death
  // router (server.js onCreatureDeath) treats them as minions -- no database row,
  // no commitCreatureDeath.
  _spawnAdds(entry, worldId, rec, evt) {
    const sim = entry.world && entry.world.creatures;
    if (!sim || !rec.minionRow) return;
    for (const id of [...rec.addIds]) if (!sim.get(id)) rec.addIds.delete(id);
    const room = MAX_LIVE_ADDS - rec.addIds.size;
    const n = Math.min(evt.adds, Math.max(0, room));
    for (let i = 0; i < n; i += 1) {
      rec.addSeq += 1;
      const id = `${MINION_ID_PREFIX}${worldId}:add${rec.addSeq}`;
      const ang = (i / Math.max(1, n)) * Math.PI * 2;
      const x = evt.x + Math.cos(ang) * ADD_RING_PX;
      const y = evt.y + Math.sin(ang) * ADD_RING_PX;
      sim.addCreatures([this._hydrateMinion(rec.minionRow, id, rec.level, x, y)]);
      rec.addIds.add(id);
    }
  }

  // True once this world has had a boss placed. The sealed-door rule asks it: a
  // floor whose boss could not be placed (malformed spec, renamed catalog row)
  // must not lock the way forward for good.
  hasBoss(worldId) { return this.records.has(worldId); }

  // The boss died (it is already out of the sim, creatures.js _removeKilled).
  // Start the respawn timer and hand S10 the kill. Returns the kill record, or
  // null for a duplicate report / unknown id.
  onDeath(entry, creatureId, killerUserId = null) {
    const worldId = entry && entry.worldId;
    const rec = this.records.get(worldId);
    if (!rec || rec.creatureId !== creatureId || rec.deadUntil != null) return null;
    rec.deadAt = this.clock();
    rec.deadUntil = rec.deadAt + rec.spec.respawnS * 1000;
    // The phase adds die with their master (silent removal, no death credit).
    const sim = entry.world && entry.world.creatures;
    if (sim) for (const id of rec.addIds) sim.remove(id);
    rec.addIds.clear();
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
      // Who hurt it, for the clear/XP rules (damage.js tags every player hit).
      damagedBy: c._playerDamage instanceof Map ? new Map(c._playerDamage) : new Map(),
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

  // World-tier post bosses: enter each phase behind a shield and refill it with
  // the ward on a timer (same rules and numbers as WorldBossManager, from
  // services/bossBalance.js). Cheap enough for the 20 Hz tick: one Map lookup per
  // world that has a post.
  tickEndurance(worldId, now = this.clock()) {
    const rec = this.records.get(worldId);
    if (!rec || rec.deadUntil != null || !rec.creature || rec.row.boss_tier !== 'world') return null;
    const c = rec.creature;
    if (!(c.hp > 0)) return null;
    return balance.enduranceStep(rec.endurance, c, now);
  }

  // A minion or phase add died (already out of the sim). A fixed escort starts
  // ITS OWN short respawn timer -- independent of the boss's, and of its
  // sibling's. A phase add just leaves the live set. Returns true when handled,
  // false for an unknown/duplicate id.
  onMinionDeath(entry, creatureId) {
    const worldId = entry && entry.worldId;
    const boss = this.records.get(worldId);
    if (boss && boss.addIds.delete(creatureId)) return true;
    for (const [key, rec] of this.minionRecords) {
      if (!key.startsWith(`${worldId}:`) || rec.creatureId !== creatureId || rec.deadUntil != null) continue;
      rec.deadUntil = this.clock() + MINION_RESPAWN_MS;
      return true;
    }
    return false;
  }

  // Re-place every due boss in a LOADED world whose post is clear of players.
  // An unloaded world stays due and its next load places the boss.
  //
  // `needsBoss(worldId)` says a player in that world has not beaten this boss.
  // Such a world is due after LATE_ARRIVAL_RESPAWN_MS instead of the full
  // respawn_s: the door in front of that player stays sealed until they kill it.
  // Returns how many were placed.
  async sweep(worlds, getPlayers = () => [], needsBoss = () => false) {
    let placed = 0;
    const now = this.clock();
    for (const [worldId, rec] of this.records) {
      if (rec.deadUntil == null) continue;
      const late = rec.deadAt != null && now >= rec.deadAt + LATE_ARRIVAL_RESPAWN_MS && needsBoss(worldId);
      if (now < rec.deadUntil && !late) continue;
      const entry = worlds.get(worldId);
      if (!entry) continue;
      if (!isClearOfPlayers(rec.spec.x, rec.spec.y, getPlayers(worldId) || [], BOSS_RESPAWN_CLEAR_PX)) continue;
      if (late) rec.deadUntil = now; // place() refuses while the timer is running
      // Count real placements only: place() returns an already-present boss too.
      const sim = entry.world && entry.world.creatures;
      const had = sim ? sim.get(bossCreatureId(worldId)) : null;
      const c = await this.place(entry); // a respawn is loud (quiet: false)
      if (c && !had) placed += 1;
    }
    placed += await this._sweepMinions(worlds, getPlayers);
    return placed;
  }

  // SOMET-626 (S13). Same shape as the boss sweep above, against minionRecords and
  // MINION_RESPAWN_MS. An escort does not come back while its boss is dead: it
  // would stand around an empty post, and place() brings the fresh pair with the
  // boss anyway.
  async _sweepMinions(worlds, getPlayers) {
    let placed = 0;
    const now = this.clock();
    for (const [key, rec] of this.minionRecords) {
      if (rec.deadUntil == null || now < rec.deadUntil) continue;
      const worldId = key.slice(0, key.lastIndexOf(':'));
      const bossRec = this.records.get(worldId);
      if (bossRec && bossRec.deadUntil != null) continue;
      const entry = worlds.get(worldId);
      if (!entry) continue;
      const sim = entry.world && entry.world.creatures;
      if (!sim) continue;
      if (!isClearOfPlayers(rec.x, rec.y, getPlayers(worldId) || [], RESPAWN_MIN_PLAYER_DISTANCE)) continue;
      sim.addCreatures([this._hydrateMinion(rec.row, rec.creatureId, rec.level ?? 1, rec.x, rec.y)]);
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
