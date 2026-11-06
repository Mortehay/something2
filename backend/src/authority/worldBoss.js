// World Boss Event Manager (SOMET-WBOSS).
//
// Spawns a rotating world boss every 10 minutes with a 2-minute global warning.
// Features:
// - English announcements broadcast to all connected sessions.
// - World bosses are entity_types rows (boss_tier = 'world', SOMET-603), hydrated
//   like every other creature; an empty catalog idles the event.
// - Tracks per-player damage contribution.
// - Top 3 damage contributors receive guaranteed Legendary ('foxy') gear.
// - All damaging participants receive the "Victor's Boon" buff (+15% speed, +20% damage/xp).
// - Identifies the nearest waypoint to the boss so travel UI can display a pulsing boss indicator.

const { rollItemInstance } = require('./affixes.js');
const {
  hydrateCreatureRow, ENTITY_CATALOG_SELECT, CREATURE_SPEED, CREATURE_DAMAGE, CREATURE_SIZE,
} = require('./creatures.js');
const { pushSfxEvent, bossSfx } = require('./sfxEvents.js');
const { resolveLootProfile, spawnBossLootItems, spawnBossChest } = require('./bossLoot.js');
const balance = require('../services/bossBalance.js');
const { findArena, resolveArena, BOSS_ARENAS } = require('./bossArena.js');
const { grantTimedBuff } = require('./skillBalance.js');

const BOSS_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes between boss spawns
const BOSS_WARNING_MS = 2 * 60 * 1000;    // 2 minutes warning before spawn
// 30 minutes: a world boss is tuned so top-end gear needs 5+ minutes and ordinary
// gear far longer (services/bossBalance.js), so 20 would despawn most fights.
const BOSS_LIFETIME_MS = 30 * 60 * 1000;  // 30 minutes max lifetime before despawning
// SOMET-605 (spec §4.3): enrage at < 10% HP or in the last minute of the
// boss's lifetime. "Near the lifetime limit" is not quantified by the spec;
// 60 s is this slice's reading (plan decision D2).
const ENRAGE_HP_RATIO = 0.10;
const ENRAGE_LEAD_MS = 60 * 1000;
const VICTORS_BOON_DURATION_MS = 15 * 60 * 1000; // 15 minutes buff duration
// Victor's Boon is a REAL buff (skillBalance.grantTimedBuff): +20% damage dealt,
// +15% movement speed, +20% XP from kills, the numbers the announcement promises.
const BOON_FX = Object.freeze({ dealt: 1.2, speed: 1.15, xp: 1.2 });
const BOON_META = Object.freeze({
  id: 'wb_victors_boon', nameEn: "Victor's Boon", nameUk: 'Благословення переможця', icon: '🏆', iconColor: '#facc15',
});
// Phase minions of the boss all carry this id prefix (cleanup removes by it).
const MINION_ID_PREFIX = 'wb_minion_';
// Nowhere to put a boss (no loaded world): ask again after this long.
const NO_WORLD_RETRY_MS = 30 * 1000;
// A restart that finds the spawn overdue gives players this long, on top of the
// warning, before the boss appears.
const RESTORE_GRACE_MS = 60 * 1000;
// Status traffic: the warning countdown refresh, and the active-fight throttle.
const WARNING_STATUS_MS = 5 * 1000;
const STATUS_MIN_INTERVAL_MS = 1000;
const STATUS_HEARTBEAT_MS = 3000;
const STATUS_HP_STEP = 0.005;     // 0.5% of max hp
const STATUS_SHIELD_STEP = 0.01;  // 1% of max hp
// Who earns loot (see _eligible): 1% of the boss's hp, or a quarter of the top
// damager's total, whichever is lower.
const MIN_CONTRIBUTION_FRACTION = 0.01;
const MIN_CONTRIBUTION_OF_TOP = 0.25;
// Drops are held for their owner for as long as they live on the ground (10 min).
const DROP_RESERVE_MS = 10 * 60 * 1000;
const MAX_GOLD_PILES = 10;

// SOMET-603 (S1): bosses are entity_types rows now (boss_tier = 'world');
// the JS catalog that used to live here is gone. Level and minion layout are
// event rules, not catalog data, so they stay here.
const WORLD_BOSS_LEVEL = 100;
const MINION_LEVEL = 80;
const MINION_OFFSETS = [[40, 40], [-40, -40]];
// Phase minions per boss element. Resolved BY NAME (the spec names these four
// rows); a renamed or deleted row means no minions for that element plus one
// log line per phase, never a crash.
const MINION_TYPE_BY_ELEMENT = Object.freeze({
  fire: 'Fire Elemental Guard',
  ice: 'Ice Elemental Guard',
  arcane: 'Arcane Elemental Guard',
  lightning: 'Lightning Elemental Guard',
});

async function loadWorldBossCatalog(pool) {
  const r = await pool.query(
    `${ENTITY_CATALOG_SELECT}
      WHERE et.is_creature = true AND (et.boss_tier = 'world' OR et.name = ANY($1::text[]))
      ORDER BY et.id ASC`,
    [Object.values(MINION_TYPE_BY_ELEMENT)],
  );
  const bosses = r.rows.filter((row) => row.boss_tier === 'world');
  const minionsByElement = new Map();
  for (const [element, name] of Object.entries(MINION_TYPE_BY_ELEMENT)) {
    const row = r.rows.find((x) => x.name === name && x.boss_tier !== 'world');
    if (row) minionsByElement.set(element, row);
  }
  return { bosses, minionsByElement };
}

// The event's view of one catalog row. `speed` is the sim's base speed: that is
// what the boss actually moves at (addCreatures has always forced
// CREATURE_SPEED), and the phase multipliers scale it.
//
// `damage` is the HYDRATED damage (ruling P1: base_damage -> damage lives only
// in hydrateCreatureRow), falling back to addCreatures' own CREATURE_DAMAGE
// default when the row sets none -- the same number the spawned creature gets.
// It is read here only as the base the phase multipliers scale; the spawned
// instance gets its damage from the hydration itself, never from this field.
function bossFromRow(row) {
  const hydrated = hydrateCreatureRow(row);
  return {
    row,
    type: hydrated.type,
    name: hydrated.name,
    element: hydrated.element,
    maxHp: Number(row.max_hp) || Number(row.hp) || 1,
    damage: Number.isFinite(hydrated.damage) ? hydrated.damage : CREATURE_DAMAGE,
    defense: Number(row.defense) || 0,
    speed: CREATURE_SPEED,
    xpReward: Number(row.xp_reward) || 0,
    goldReward: Number(row.gold_max) || 0,
    description: row.prompt || '',
  };
}

// The arenas (BOSS_ARENAS, resolveArena) and the search that validates them live in
// bossArena.js; they are re-exported at the bottom of this file.

class WorldBossManager {
  constructor({
    pool,
    bossIntervalMs = BOSS_INTERVAL_MS,
    bossWarningMs = BOSS_WARNING_MS,
    bossLifetimeMs = BOSS_LIFETIME_MS,
    rng = Math.random,
    loadCatalog = null,
    // userId -> the character's name, for the HUD and the announcements.
    nameOf = null,
    // Save/restore the spawn schedule (world_boss_state). Off by default so a bare
    // manager (every unit test) never touches a database; server.js turns it on.
    persistSchedule = false,
  } = {}) {
    this.pool = pool;
    this.bossIntervalMs = bossIntervalMs;
    this.bossWarningMs = bossWarningMs;
    this.bossLifetimeMs = bossLifetimeMs;
    this.rng = rng;
    this.nameOf = nameOf;
    this.persistSchedule = persistSchedule;

    this.state = 'idle'; // 'idle' | 'warning' | 'active'
    this._nextSpawnTime = Date.now() + this.bossIntervalMs;
    this._lastSavedSpawn = null;
    this.warningSent = false;
    this.currentBoss = null;
    this.activeWorldId = null;
    this.activeWorldName = 'The Wilds';
    this.activeArenaName = 'Boss Arena';
    this.targetSpawnX = 400;
    this.targetSpawnY = 400;
    this.bossCreatureId = null;
    this.spawnedAt = null;
    this.nearestWaypointId = null;
    // The arena the current/planned boss fights in: { x, y, radius, name, source } (bossArena.js).
    this.arena = null;
    this._noWorld = false;       // the last plan failed for want of a loaded world
    this._deferred = false;      // a spawn was postponed for want of one
    this._warnBroadcastAt = 0;
    this._lastBroadcastShield = 0;
    this._lastBroadcastHp = null;
    this._lastBroadcastTime = 0;

    // Track active buffs: userId -> { expiresAt, damageBonus, speedBonus, xpBonus }
    this.playerBuffs = new Map();

    // SOMET-603: catalog rows, refreshed at startup and after every rotation.
    // Injectable so unit tests need no database.
    this.loadCatalog = loadCatalog || (pool ? () => loadWorldBossCatalog(pool) : null);
    this.catalog = { bosses: [], minionsByElement: new Map() };
    // Why the last skipped rotation was skipped, so each cause is logged once
    // and a failed load is never reported as an empty catalog.
    this._catalogLoadError = null;
    this._skipLoggedCause = null;
  }

  // The spawn time is persisted (world_boss_state) when persistSchedule is on, so a
  // restart no longer resets the countdown to a fresh 30 minutes. A boss that is
  // ALREADY on the field is still lost on a restart: creatures are not persisted, and
  // the event comes back with the next scheduled spawn.
  get nextSpawnTime() { return this._nextSpawnTime; }

  set nextSpawnTime(t) {
    this._nextSpawnTime = t;
    this._saveSchedule();
  }

  _saveSchedule() {
    if (!this.pool || !this.persistSchedule || this._nextSpawnTime === this._lastSavedSpawn) return;
    this._lastSavedSpawn = this._nextSpawnTime;
    const at = new Date(this._nextSpawnTime);
    Promise.resolve()
      .then(() => this.pool.query(
        `INSERT INTO world_boss_state (id, next_spawn_at, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET next_spawn_at = EXCLUDED.next_spawn_at, updated_at = now()`,
        [at],
      ))
      .catch((err) => console.warn('[world boss] could not save the spawn schedule:', err && err.message));
  }

  // Read the saved schedule at startup. A time already in the past (the server was
  // down across it) does not spawn a boss on the first tick with no warning: it
  // becomes warning + a short grace. Never throws; false when there is nothing saved.
  async restoreSchedule(now = Date.now()) {
    if (!this.pool || !this.persistSchedule) return false;
    try {
      const r = await this.pool.query('SELECT next_spawn_at FROM world_boss_state WHERE id = 1');
      const raw = r && r.rows && r.rows[0] && r.rows[0].next_spawn_at;
      const at = raw ? new Date(raw).getTime() : NaN;
      if (!Number.isFinite(at)) return false;
      this._nextSpawnTime = at > now ? at : now + this.bossWarningMs + RESTORE_GRACE_MS;
      this._lastSavedSpawn = this._nextSpawnTime;
      return true;
    } catch (err) {
      console.warn('[world boss] could not read the spawn schedule:', err && err.message);
      return false;
    }
  }

  // Never throws: a failed load keeps the previous catalog (the tick loop must
  // not lose a working rotation to one DB hiccup).
  async refreshCatalog() {
    if (!this.loadCatalog) return this.catalog;
    try {
      const next = await this.loadCatalog();
      if (next && Array.isArray(next.bosses)) {
        this.catalog = { bosses: next.bosses, minionsByElement: next.minionsByElement || new Map() };
        this._catalogLoadError = null;
        if (next.bosses.length > 0) this._skipLoggedCause = null;
      }
    } catch (err) {
      this._catalogLoadError = (err && err.message) || String(err);
      console.error('[world boss] catalog load failed; keeping the previous catalog:', err);
    }
    return this.catalog;
  }

  _refreshInBackground() {
    if (this.loadCatalog) this.refreshCatalog();
  }

  // No boss to spawn: stay idle, try again next interval, say why once per
  // cause. A failed load and a genuinely empty catalog are different faults
  // with different fixes, so they are logged as such.
  _skipRotation(now) {
    this.state = 'idle';
    this.currentBoss = null;
    this.nextSpawnTime = now + this.bossIntervalMs;
    const cause = this._catalogLoadError
      ? `[world boss] the boss catalog failed to load (${this._catalogLoadError}); rotation skipped`
      : "[world boss] no entity_types rows with boss_tier = 'world'; rotation skipped";
    if (this._skipLoggedCause !== cause) {
      console.warn(cause);
      this._skipLoggedCause = cause;
    }
    this._refreshInBackground();
  }

  // A debug caller's boss name must be one the catalog holds; null means
  // "any boss" and is always acceptable.
  _knowsBoss(bossName) {
    return bossName == null || this.catalog.bosses.some((b) => b.name === bossName);
  }

  // Debug/test-panel spawn. Returns false (and changes nothing) for a boss
  // name the catalog does not hold; returns false (and stays idle) when the
  // catalog is empty.
  forceSpawn(now, worlds, { bossName = null, preferredWorldId = null } = {}, broadcastFn = null) {
    if (!this._knowsBoss(bossName)) return false;
    if (this.state === 'active') this._despawnBoss(worlds, null, 'replaced');
    this.currentBoss = null;
    if (!this._planNextBoss(worlds, preferredWorldId, bossName)) {
      this.state = 'idle';
      return false;
    }
    this.state = 'warning';
    this.nextSpawnTime = now - 1;
    // False (and idle) when the boss could not be put on the ground.
    if (!this._spawnBoss(now, worlds, broadcastFn)) {
      if (this.state !== 'active') { this.state = 'idle'; this.currentBoss = null; }
      return false;
    }
    return true;
  }

  forceWarning(now, worlds, { bossName = null, seconds = 120 } = {}, broadcastFn = null) {
    if (!this._knowsBoss(bossName)) return false;
    if (this.state === 'active') this._despawnBoss(worlds, null, 'replaced');
    this.state = 'idle';
    this.currentBoss = null;
    this.nextSpawnTime = now + Math.max(0, Number(seconds) || 0) * 1000;
    if (!this._planNextBoss(worlds, null, bossName)) return false;
    this.tick(now, worlds, broadcastFn);
    return true;
  }

  // Choose a boss, a target world, and the arena in it.
  //
  // Returns false when there is no boss to spawn, or no loaded world to spawn it in
  // (`_noWorld` tells the two apart). A boss with no world has no creature, and an
  // event that is "active" with no creature is a boss nobody can find; callers retry
  // later instead of announcing it. The arena is FOUND (bossArena.js): the old
  // hard-coded point is only where the search starts.
  _planNextBoss(worlds, preferredWorldId = null, bossName = null) {
    this._noWorld = false;
    const bosses = this.catalog.bosses;
    if (bosses.length === 0) {
      this.currentBoss = null;
      return false;
    }
    const worldEntries = [...(worlds ? worlds.entries() : [])].filter(([, entry]) => entry && entry.world);
    if (worldEntries.length === 0) {
      this.currentBoss = null;
      this._noWorld = true;
      return false;
    }
    const named = bossName ? bosses.find((b) => b.name === bossName) : null;
    this.currentBoss = bossFromRow(named || bosses[Math.floor(this.rng() * bosses.length)]);
    this.currentBoss.currentHp = this.currentBoss.maxHp;

    const keyOf = (entry) => (entry.row && (entry.row.key || entry.row.canonical_id)) || '';
    const nameOfWorld = (entry) => (entry.row && entry.row.name) || '';
    const isRegion = (entry) => resolveArena(keyOf(entry), nameOfWorld(entry)) !== null;
    // The regions with a hand-picked arena are preferred, as before; any other world
    // can host a boss now, because its arena is found rather than looked up.
    const regionWorlds = worldEntries.filter(([, entry]) => isRegion(entry));

    let chosen = null;
    if (preferredWorldId && worlds.has(preferredWorldId) && worlds.get(preferredWorldId).world) {
      const prefEntry = worlds.get(preferredWorldId);
      // SOMET-720: with no region world loaded at all, the caller's choice stands
      // (the tab has already named this world in its confirm dialog).
      if (isRegion(prefEntry) || regionWorlds.length === 0) chosen = [preferredWorldId, prefEntry];
    }
    if (!chosen) {
      const pool = regionWorlds.length > 0 ? regionWorlds : worldEntries;
      chosen = pool[Math.floor(this.rng() * pool.length)];
    }
    const [wId, entry] = chosen;
    this.activeWorldId = wId;
    this.activeWorldName = nameOfWorld(entry) || 'The Wilds';
    this._setArena(findArena(entry), entry);
    return true;
  }

  // The arena a boss will fight in, and the waypoint nearest to it (the travel UI
  // points players there).
  _setArena(arena, entry) {
    this.arena = arena;
    this.activeArenaName = arena.name;
    this.targetSpawnX = arena.x;
    this.targetSpawnY = arena.y;
    this.nearestWaypointId = null;
    if (entry && entry.waypoints && entry.waypoints.size > 0) {
      let best = null;
      let bestD = Infinity;
      for (const wp of entry.waypoints.values()) {
        const d = ((wp.x || 0) - arena.x) ** 2 + ((wp.y || 0) - arena.y) ** 2;
        if (d < bestD) { bestD = d; best = wp; }
      }
      this.nearestWaypointId = best ? best.id : null;
    }
  }

  // SOMET-720. The world a summon lands in, the one forceSpawn honours as
  // preferredWorldId: where the current boss stands if it is an arena world, else the
  // loaded arena world with the most players, else the loaded world with the most.
  // Null when no world is loaded: a boss spawned then would have no creature.
  summonWorldId(worlds) {
    if (!worlds || worlds.size === 0) return null;
    const isArena = (entry) => Boolean(resolveArena(
      entry.row && (entry.row.key || entry.row.canonical_id), entry.row && entry.row.name,
    ));
    if (this.state === 'active' && worlds.has(this.activeWorldId) && isArena(worlds.get(this.activeWorldId))) {
      return this.activeWorldId;
    }
    const list = [...worlds.entries()];
    const arenas = list.filter(([, e]) => isArena(e));
    const players = (e) => (e.sockets ? e.sockets.size : 0);
    const best = (arenas.length ? arenas : list).reduce((a, b) => (players(b[1]) > players(a[1]) ? b : a));
    return best[0];
  }

  getStatus() {
    const now = Date.now();
    const boss = this.currentBoss;
    // A boss that is only PLANNED (the warning state) has no hp yet: read it as full
    // rather than letting undefined / max turn the ratio into NaN.
    const cur = boss && Number.isFinite(boss.currentHp) ? boss.currentHp : (boss ? boss.maxHp : 0);
    const hpRatio = (boss && boss.maxHp > 0) ? cur / boss.maxHp : 1;
    const phaseInfo = this._calculatePhase(hpRatio);

    return {
      state: this.state,
      bossName: boss ? boss.name : null,
      bossCreatureId: this.bossCreatureId,
      bossElement: boss ? boss.element : null,
      worldId: this.activeWorldId,
      worldName: this.activeWorldName,
      arenaName: this.activeArenaName,
      // The ground the fight is on, for the minimap ring and the world marker.
      arena: this.arena && this.state !== 'idle'
        ? { x: this.arena.x, y: this.arena.y, r: this.arena.radius, name: this.arena.name } : null,
      nearestWaypointId: this.nearestWaypointId,
      timeToSpawnMs: Math.max(0, this.nextSpawnTime - now),
      currentHp: cur,
      maxHp: boss ? boss.maxHp : 0,
      phase: boss ? (boss.phase || phaseInfo.phase) : 1,
      phaseName: phaseInfo.name,
      phaseBonus: phaseInfo.bonus,
      hpRatio,
      shield: boss ? Math.round(boss.shield || 0) : 0,
      shieldMax: boss ? Math.round(boss.maxHp * balance.SHIELD_CAP_FRACTION) : 0,
      shieldWeakTo: boss && balance.WORLD_BOSSES[boss.name] ? balance.WORLD_BOSSES[boss.name].shieldWeakTo : null,
      enraged: Boolean(boss && boss.enraged),
      topDamagers: this.getTopDamagers(3),
    };
  }

  // The status one world's sockets get. The full card (hp, shield, phase, top
  // damagers) matters only in the world the boss is in; everywhere else the HUD shows
  // at most the "emerges in ..." warning, so the rest of the world gets the few
  // fields that need. This was the full status, with topDamagers, to every socket of
  // every world on every hp change.
  statusFor(status, worldId) {
    if (!status || status.state === 'idle') return status;
    if (status.state === 'active' && String(status.worldId) === String(worldId)) return status;
    return {
      state: status.state,
      bossName: status.bossName,
      bossElement: status.bossElement,
      worldId: status.worldId,
      worldName: status.worldName,
      arenaName: status.arenaName,
      nearestWaypointId: status.nearestWaypointId,
      timeToSpawnMs: status.timeToSpawnMs,
    };
  }

  // Adds `fraction` of max HP as shield, never above the cap. The shield lives on
  // the creature (damage.js applyDamage spends it before HP).
  _addShield(creature, fraction) {
    if (!creature) return;
    if (!creature.maxHp && this.currentBoss) creature.maxHp = this.currentBoss.maxHp;
    balance.addShield(creature, fraction);
  }

  // The Ward: from phase 2 on, the shield is topped up on a timer, so damage has
  // to arrive in bursts that break it rather than as a slow trickle.
  _tickWard(creature, now) {
    const boss = this.currentBoss;
    if (!boss || (boss.phase || 1) < 2) return;
    if (boss.lastWardAt == null) boss.lastWardAt = now;
    if (now - boss.lastWardAt < balance.WARD_INTERVAL_MS) return;
    boss.lastWardAt = now;
    this._addShield(creature, balance.WARD_FRACTION);
  }

  _calculatePhase(hpRatio) {
    if (balance.phaseForRatio(hpRatio) === 4) return { phase: 4, name: 'Frenzy Overload', bonus: '+50% Damage, Catastrophic Blasts & Ward Shield' };
    if (balance.phaseForRatio(hpRatio) === 3) return { phase: 3, name: 'Elemental Nova', bonus: '+25% Defense, Minions & Ward Shield' };
    if (balance.phaseForRatio(hpRatio) === 2) return { phase: 2, name: 'Enraged Surge', bonus: '+20% Speed, Shockwave & Ward Shield' };
    return { phase: 1, name: 'Standard', bonus: 'Base Stats' };
  }

  // The multipliers a phase puts on the boss's base stats. CUMULATIVE by phase (a boss
  // in phase 4 is as fast as phase 4 says, whatever order it got there in), so the
  // same function serves a normal transition and a boss that is re-placed mid-fight.
  _phaseStats(phase) {
    return {
      speed: phase >= 4 ? 1.3 : (phase >= 2 ? 1.2 : 1),
      damage: phase >= 4 ? 1.5 : (phase >= 3 ? 1.25 : (phase >= 2 ? 1.1 : 1)),
      defense: phase >= 3 ? 1.25 : 1,
    };
  }

  _applyPhaseStats(creature, phase) {
    const boss = this.currentBoss;
    if (!boss || !creature) return;
    const m = this._phaseStats(phase);
    creature.speed = Math.round((boss.speed || 60) * m.speed);
    creature.damage = Math.round((boss.damage || 40) * m.damage);
    // Defence is the creature's mitigation (creatureMitigation reads row.defense).
    if (creature.mit) creature.mit.defense = Math.round((boss.defense || 25) * m.defense * 100) / 100;
    creature.defense = Math.round((boss.defense || 25) * m.defense);
  }

  // The hp the boss may not be taken below until the NEXT phase has been applied
  // (damage.js honours `_hpFloor`). The manager only looks every ~1.5 s, so without
  // this a burst could carry the boss across a threshold, or across several, before
  // the phase was ever applied. null after the last phase.
  _hpFloorFor(creature, phase) {
    const t = balance.PHASE_THRESHOLDS[phase - 1];
    return t == null ? null : (creature.maxHp || (this.currentBoss && this.currentBoss.maxHp) || 1) * t;
  }

  // ONE phase's entry: its shield, its stats, its minions, its announcement. Phases
  // are applied in order, one call each, so a boss that fell from 80% to 20% still
  // goes through the shields and the minions of 2 and 3 on its way to 4.
  _stepPhase(creature, worldEntry, broadcastFn, phase) {
    const info = this._calculatePhase(balance.PHASE_THRESHOLDS[phase - 2] != null ? balance.PHASE_THRESHOLDS[phase - 2] : 1);
    this.currentBoss.phase = phase;
    creature.phase = phase;
    // Each new phase arrives behind a fresh shield that has to be broken.
    this._addShield(creature, balance.PHASE_SHIELD[phase] || 0);
    this.currentBoss.lastWardAt = Date.now();
    this._applyPhaseStats(creature, phase);
    if (phase === 3 || phase === 4) this._spawnPhaseMinions(creature, worldEntry);
    this._emitBossSfx(worldEntry, creature, 'phase'); // SOMET-605

    if (broadcastFn) {
      const phaseMsg = `[World Boss Phase ${phase}] ${this.currentBoss.name} enters ${info.name}! (${info.bonus})`;
      broadcastFn({
        type: 'announcement',
        kind: 'world_boss_phase',
        text: phaseMsg,
        phase,
        phaseName: info.name,
        bossName: this.currentBoss.name,
      });
    }
  }

  _checkPhaseTransition(creature, worldEntry, broadcastFn) {
    if (!this.currentBoss || !creature) return;
    const hpRatio = Math.max(0, creature.hp) / (creature.maxHp || 1);
    const target = this._calculatePhase(hpRatio).phase;
    const from = this.currentBoss.phase || 1;
    if (target > from) {
      for (let p = from + 1; p <= target; p += 1) this._stepPhase(creature, worldEntry, broadcastFn, p);
      if (broadcastFn) broadcastFn({ type: 'world_boss_status', status: this.getStatus() });
    }
    creature._hpFloor = this._hpFloorFor(creature, this.currentBoss.phase || 1);
  }

  // SOMET-605: put a boss event on the boss's own sim sfx buffer, at its box
  // centre; World#drainSfx carries it into the next frame.
  _emitBossSfx(worldEntry, creature, e) {
    const sim = worldEntry && worldEntry.world && worldEntry.world.creatures;
    if (!sim || !Array.isArray(sim.sfx) || !creature) return false;
    return pushSfxEvent(sim.sfx, bossSfx(e, creature,
      creature.x + (creature.width || 0) / 2, creature.y + (creature.height || 0) / 2));
  }

  _checkEnrage(creature, worldEntry, now, broadcastFn) {
    if (!this.currentBoss || !creature || this.currentBoss.enraged) return false;
    const hpRatio = Math.max(0, creature.hp) / (creature.maxHp || 1);
    const nearTimeout = now - this.spawnedAt >= this.bossLifetimeMs - ENRAGE_LEAD_MS;
    if (hpRatio >= ENRAGE_HP_RATIO && !nearTimeout) return false;
    return this._enrage(creature, worldEntry, broadcastFn);
  }

  _enrage(creature, worldEntry, broadcastFn) {
    this.currentBoss.enraged = true;
    creature.enraged = true;
    this._emitBossSfx(worldEntry, creature, 'enrage');
    if (broadcastFn) {
      broadcastFn({
        type: 'announcement', kind: 'world_boss_enrage',
        text: `[World Boss] ${this.currentBoss.name} is enraged!`, bossName: this.currentBoss.name,
      });
      broadcastFn({ type: 'world_boss_status', status: this.getStatus() });
    }
    return true;
  }

  // The live boss creature and its world entry, or {} when there is none.
  _liveBoss(worlds) {
    if (this.state !== 'active' || !this.currentBoss || !this.activeWorldId || !worlds) return {};
    const entry = worlds.get(this.activeWorldId);
    const sim = entry && entry.world && entry.world.creatures;
    const creature = sim && sim.get ? sim.get(this.bossCreatureId) : null;
    return creature ? { entry, creature } : {};
  }

  // Test panel (spec §5): advance exactly one phase. HP is lowered to the
  // first whole percent _calculatePhase puts in the next phase -- the real
  // thresholds, read rather than copied -- and the normal transition runs.
  forcePhase(worlds, broadcastFn = null) {
    const { entry, creature } = this._liveBoss(worlds);
    if (!creature) return false;
    const before = this.currentBoss.phase || 1;
    const maxHp = creature.maxHp || 1;
    for (let pct = Math.floor((Math.max(0, creature.hp) / maxHp) * 100); pct >= 1; pct -= 1) {
      if (this._calculatePhase(pct / 100).phase > before) {
        creature.hp = Math.floor((maxHp * pct) / 100);
        break;
      }
    }
    this.currentBoss.currentHp = Math.max(0, creature.hp);
    this._checkPhaseTransition(creature, entry, broadcastFn);
    return (this.currentBoss.phase || 1) > before;
  }

  forceEnrage(worlds, broadcastFn = null) {
    const { entry, creature } = this._liveBoss(worlds);
    if (!creature || this.currentBoss.enraged) return false;
    return this._enrage(creature, entry, broadcastFn);
  }

  _spawnPhaseMinions(creature, worldEntry) {
    if (!worldEntry || !worldEntry.world || !worldEntry.world.creatures || !worldEntry.world.creatures.addCreatures) return;
    const row = this.catalog.minionsByElement.get(this.currentBoss.element);
    if (!row) {
      console.warn(`[world boss] no minion row for element ${this.currentBoss.element}; phase minions skipped`);
      return;
    }
    this._minionSeq = (this._minionSeq || 0) + 1;
    const stamp = `${Date.now()}_${this._minionSeq}`;
    // SOMET-603: hydrated like every other creature (behaviour, element
    // and damage all arrive the one shared way). No `damage` here: an explicit
    // instance damage would beat the row's base_damage (ruling P1).
    const minions = MINION_OFFSETS.map(([dx, dy], i) => hydrateCreatureRow(row, {
      id: `${MINION_ID_PREFIX}${stamp}_${i + 1}`,
      x: creature.x + dx,
      y: creature.y + dy,
      level: MINION_LEVEL,
      hp: Number(row.max_hp) || Number(row.hp) || 1,
    }));
    worldEntry.world.creatures.addCreatures(minions);
  }

  // The boss's phase minions, silently: no kill, no loot, no XP. They are the boss's,
  // so they go when it does -- slain, timed out, replaced or force-despawned. Only
  // a replacement used to clear them, and a retreating boss left level-80 guards
  // standing on the map.
  _removePhaseMinions(worldEntry) {
    const sim = worldEntry && worldEntry.world && worldEntry.world.creatures;
    if (!sim || !sim.all || !sim.remove) return 0;
    let n = 0;
    for (const c of sim.all()) {
      if (String(c.id).startsWith(MINION_ID_PREFIX)) { sim.remove(c.id); n += 1; }
    }
    return n;
  }

  // Who a userId is, for the HUD and the announcements: the character's name, not
  // the account id that used to go to every socket in the game.
  _name(userId) {
    let n = null;
    if (this.nameOf) {
      try { n = this.nameOf(userId); } catch { n = null; }
    }
    return n || 'Adventurer';
  }

  getTopDamagers(limit = 3) {
    if (!this.currentBoss || !this.currentBoss._playerDamage) return [];
    const list = [];
    for (const [userId, dmg] of this.currentBoss._playerDamage.entries()) {
      list.push({ userId, name: this._name(userId), damage: Math.round(dmg) });
    }
    list.sort((a, b) => b.damage - a.damage);
    // The wire carries a rank, a name and a number, never the account id (the payout
    // reads the damage map directly).
    return list.slice(0, limit).map(({ name, damage }, i) => ({ rank: i + 1, name, damage }));
  }

  hasBuff(userId, now = Date.now()) {
    const buff = this.playerBuffs.get(String(userId));
    if (!buff) return false;
    if (buff.expiresAt <= now) {
      this.playerBuffs.delete(String(userId));
      return false;
    }
    return true;
  }

  getBuff(userId, now = Date.now()) {
    if (!this.hasBuff(userId, now)) return null;
    return this.playerBuffs.get(String(userId));
  }

  // Victor's Boon. Recorded per account with a wall-clock expiry, then put on the live
  // player through the ordinary buff machinery (skillBalance.grantTimedBuff), so the
  // damage and speed it promises are real and the buff ceilings apply. A player who
  // is offline or in another world when it is granted gets it from restoreBoon when
  // they next join, for whatever time is left.
  grantBoon(userId, bossName, now = Date.now()) {
    this.playerBuffs.set(String(userId), {
      active: true,
      expiresAt: now + VICTORS_BOON_DURATION_MS,
      speedBonus: BOON_FX.speed - 1,
      damageBonus: BOON_FX.dealt - 1,
      xpBonus: BOON_FX.xp - 1,
      bossName: bossName || 'World Boss',
    });
  }

  // Put the Boon on `player` (a live world player) if their account holds one.
  // `worldNow` is that world's clock, which is what the buff's expiry is measured in.
  applyBoon(player, worldNow, now = Date.now()) {
    if (!player) return false;
    const b = this.getBuff(player.userId, now);
    if (!b) return false;
    return grantTimedBuff(player, BOON_META, BOON_FX, b.expiresAt - now, worldNow);
  }

  tick(now, worlds, broadcastFn) {
    // Clean expired player buffs
    for (const [uid, b] of this.playerBuffs.entries()) {
      if (b.expiresAt <= now) this.playerBuffs.delete(uid);
    }

    // 1. Idle state -> check if warning should be sent
    if (this.state === 'idle') {
      const timeRemaining = this.nextSpawnTime - now;
      if (timeRemaining <= this.bossWarningMs) {
        let planned = Boolean(this.currentBoss);
        if (!planned) {
          planned = this._planNextBoss(worlds);
          if (!planned) {
            if (this._noWorld) {
              // Nobody is playing in a loaded world: there is nowhere to put a boss.
              // Ask again soon instead of burning this rotation, and give the full
              // warning once a world is there.
              this.nextSpawnTime = now + NO_WORLD_RETRY_MS;
              this._deferred = true;
            } else {
              this._skipRotation(now);
            }
          } else if (this._deferred) {
            this._deferred = false;
            this.nextSpawnTime = now + this.bossWarningMs;
          }
        }
        if (planned) {
          this.state = 'warning';
          this._warnBroadcastAt = now;
          if (broadcastFn) {
            const left = Math.max(0, this.nextSpawnTime - now);
            const minutes = Math.max(1, Math.round(left / 60000));
            const alertMsg = `[World Boss Alert] A massive tremor shakes the realm! ${this.currentBoss.name} will emerge in ${minutes} minute${minutes === 1 ? '' : 's'} at ${this.activeArenaName} (${this.activeWorldName}).`;
            broadcastFn({
              type: 'announcement',
              kind: 'world_boss_warning',
              text: alertMsg,
              bossName: this.currentBoss.name,
              worldName: this.activeWorldName,
              arenaName: this.activeArenaName,
              timeToSpawnMs: left,
              nearestWaypointId: this.nearestWaypointId,
            });
            // The announcement is a one-off line in the chat; the status is what the
            // HUD's warning banner and its countdown are drawn from. Without it every
            // connected client stayed "idle" until the boss actually spawned.
            broadcastFn({ type: 'world_boss_status', status: this.getStatus() });
          }
        }
      }
    }

    // 2. Warning state -> keep the countdown fresh, then spawn when it is time
    if (this.state === 'warning') {
      if (now >= this.nextSpawnTime) {
        this._spawnBoss(now, worlds, broadcastFn);
      } else if (broadcastFn && now - this._warnBroadcastAt >= WARNING_STATUS_MS) {
        this._warnBroadcastAt = now;
        broadcastFn({ type: 'world_boss_status', status: this.getStatus() });
      }
    }

    // 3. Active state -> sync HP and broadcast real-time status
    if (this.state === 'active') {
      if (now - this.spawnedAt >= this.bossLifetimeMs) {
        // Despawn boss
        this._despawnBoss(worlds, broadcastFn, 'timeout');
      } else {
        // Keep HP synced from the live creature object in the world sim
        if (this.activeWorldId && worlds.has(this.activeWorldId)) {
          const entry = worlds.get(this.activeWorldId);
          const c = entry.world && entry.world.creatures && entry.world.creatures.get
            ? entry.world.creatures.get(this.bossCreatureId)
            : null;
          if (c && this.currentBoss) {
            this.currentBoss.currentHp = Math.max(0, c.hp);
            // Where it stands now: if it dies before the next tick the loot lands
            // here, and a boss that chased players away from its post dies away
            // from it.
            this.currentBoss.lastX = c.x + (c.width || 0) / 2;
            this.currentBoss.lastY = c.y + (c.height || 0) / 2;
            if (c._playerDamage) {
              this.currentBoss._playerDamage = c._playerDamage;
            }
            this._tickWard(c, now);
            this.currentBoss.shield = Math.max(0, c.shield || 0);
            this._checkPhaseTransition(c, entry, broadcastFn);
            this._checkEnrage(c, entry, now, broadcastFn); // SOMET-605
            this._maybeBroadcastStatus(now, broadcastFn);
          } else if (!c && this.currentBoss) {
            // SOMET-603: missing is NOT a kill. Every real kill reaches
            // onCreatureDeath synchronously, which idles the manager before
            // this tick can run, so a boss still tracked here was lost (world
            // evicted and reloaded, or removed out of band). Put it back at
            // its current hp; never announce it slain or pay out.
            console.warn(`[World Boss] ${this.currentBoss.name} (${this.bossCreatureId}) missing from its world; re-placing at ${this.currentBoss.currentHp} hp`);
            this._placeBossCreature(entry, this.currentBoss.currentHp, true);
          }
        }
        // (A boss whose world has been evicted is simply not in `worlds` here: it comes
        // back, at the hp it had, when the world loads again -- the branch above.)
      }
    }
  }

  // The live status goes out when something that matters moved, no more than once a
  // second, and as a heartbeat every few seconds otherwise. It used to go out on any
  // hp change at every tick (to every socket of every world).
  _maybeBroadcastStatus(now, broadcastFn) {
    const boss = this.currentBoss;
    if (!broadcastFn || !boss) return;
    const max = boss.maxHp || 1;
    const hpMoved = Math.abs(boss.currentHp - (this._lastBroadcastHp ?? boss.currentHp)) >= STATUS_HP_STEP * max;
    const shield = boss.shield || 0;
    const lastShield = this._lastBroadcastShield || 0;
    const shieldMoved = Math.abs(shield - lastShield) >= STATUS_SHIELD_STEP * max || ((shield > 0) !== (lastShield > 0));
    const since = now - this._lastBroadcastTime;
    if (((hpMoved || shieldMoved) && since >= STATUS_MIN_INTERVAL_MS) || since >= STATUS_HEARTBEAT_MS) {
      this._lastBroadcastHp = boss.currentHp;
      this._lastBroadcastShield = shield;
      this._lastBroadcastTime = now;
      broadcastFn({ type: 'world_boss_status', status: this.getStatus() });
    }
  }

  // The spawn could not happen (no loaded world to put the boss in, or the planned
  // one is gone): try again shortly. The event never goes 'active' without a boss on
  // the ground.
  _postponeSpawn(now) {
    this.nextSpawnTime = now + NO_WORLD_RETRY_MS;
    this._deferred = true;
    if (!this.currentBoss) this.state = 'idle';
    this.activeWorldId = this.currentBoss ? this.activeWorldId : null;
  }

  // -> true when the boss is on the ground; false (event not active) when it could not
  // be placed.
  _spawnBoss(now, worlds, broadcastFn) {
    if (!this.currentBoss && !this._planNextBoss(worlds)) {
      if (this._noWorld) this._postponeSpawn(now);
      else this._skipRotation(now);
      return false;
    }
    // The world chosen during the warning may have been evicted since: choose again
    // (the same boss) rather than announcing one that has nowhere to stand.
    let worldEntry = this.activeWorldId ? worlds.get(this.activeWorldId) : null;
    if (!worldEntry || !worldEntry.world || !worldEntry.world.creatures) {
      const name = this.currentBoss.name;
      this.currentBoss = null;
      if (!this._planNextBoss(worlds, null, name)) {
        this._postponeSpawn(now);
        return false;
      }
      worldEntry = worlds.get(this.activeWorldId);
    }
    if (!this.arena) this._setArena(findArena(worldEntry), worldEntry);

    this.currentBoss.currentHp = this.currentBoss.maxHp;
    this.currentBoss._playerDamage = new Map();
    this.currentBoss.phase = 1;
    this.currentBoss.shield = 0;
    this.currentBoss.enraged = false;
    this.currentBoss.spawnX = this.arena.x;
    this.currentBoss.spawnY = this.arena.y;
    this.bossCreatureId = `wb_${Date.now()}_${Math.floor(this.rng() * 1000)}`;
    const placed = this._placeBossCreature(worldEntry, this.currentBoss.maxHp);
    if (!placed) {
      this.bossCreatureId = null;
      this._postponeSpawn(now);
      return false;
    }
    this.state = 'active';
    this.spawnedAt = now;
    this._lastBroadcastHp = this.currentBoss.maxHp;
    this._lastBroadcastShield = 0;
    this._lastBroadcastTime = now;

    if (broadcastFn) {
      const spawnMsg = `[World Boss] ${this.currentBoss.name} has awakened at ${this.activeWorldName}! (${this.activeArenaName}) Slay the titan!`;
      broadcastFn({
        type: 'announcement',
        kind: 'world_boss_spawn',
        text: spawnMsg,
        bossName: this.currentBoss.name,
        worldName: this.activeWorldName,
        arenaName: this.activeArenaName,
        nearestWaypointId: this.nearestWaypointId,
      });
      broadcastFn({
        type: 'world_boss_status',
        status: this.getStatus(),
      });
    }
    return true;
  }

  // The ONE place a boss creature is built and put into a world sim: the
  // spawn (at max hp) and the lost-boss re-place in tick (at current hp).
  // SOMET-603: hydrated from the catalog row like every other creature, so
  // boss_tier/element/hitbox_size/behaviour/vfx (and S3's auras) arrive the
  // one shared way. No `damage` here: an explicit instance damage would beat
  // the row's base_damage (ruling P1).
  //
  // The boss stands ON the arena's centre (spawnX/Y is a centre, the sim's x/y a
  // top-left), and the centre is also its leash post, so it holds the arena rather
  // than wandering off after whoever hit it first -- the way a dungeon boss holds its
  // room.
  _placeBossCreature(worldEntry, hp, quiet = false) {
    const sim = worldEntry && worldEntry.world && worldEntry.world.creatures;
    if (!sim || !sim.addCreatures || !this.currentBoss) return null;
    const ax = this.currentBoss.spawnX ?? this.targetSpawnX ?? 400;
    const ay = this.currentBoss.spawnY ?? this.targetSpawnY ?? 400;
    const bossCreature = hydrateCreatureRow(this.currentBoss.row, {
      id: this.bossCreatureId,
      level: WORLD_BOSS_LEVEL,
      hp,
      home_x: ax,
      home_y: ay,
    });
    const size = bossCreature.hitboxSize ?? CREATURE_SIZE;
    // A boss put back mid-fight stands where it last stood, not back on its post.
    const resume = quiet && Number.isFinite(this.currentBoss.lastX) && Number.isFinite(this.currentBoss.lastY);
    bossCreature.x = (resume ? this.currentBoss.lastX : ax) - size / 2;
    bossCreature.y = (resume ? this.currentBoss.lastY : ay) - size / 2;
    // SOMET-605: a lost-boss re-place must not replay the spawn sound.
    if (quiet) bossCreature.quietSpawn = true;
    sim.addCreatures([bossCreature]);
    const placed = sim.get ? sim.get(this.bossCreatureId) : null;
    if (placed) {
      // addCreatures takes maxHp from hp; a re-placed boss keeps its real max.
      placed.maxHp = this.currentBoss.maxHp;
      placed.shield = this.currentBoss.shield || 0;
      placed.damageTakenMult = balance.DAMAGE_TAKEN;
      const tuning = balance.WORLD_BOSSES[this.currentBoss.name];
      placed.shieldWeakTo = tuning ? tuning.shieldWeakTo : null;
      if (this.currentBoss._playerDamage) placed._playerDamage = this.currentBoss._playerDamage;
      // A boss that comes back mid-fight is in the phase it was in: its stats, its
      // enrage, its minions. Only hp, shield and damage credit used to survive, so a
      // boss re-placed in phase 4 fought as phase 1 for the rest of the fight.
      const phase = this.currentBoss.phase || 1;
      if (phase > 1) this._applyPhaseStats(placed, phase);
      if (this.currentBoss.enraged) placed.enraged = true;
      if (quiet && phase >= 3) this._spawnPhaseMinions(placed, worldEntry);
      placed._hpFloor = this._hpFloorFor(placed, phase);
    }
    return placed;
  }

  _despawnBoss(worlds, broadcastFn, reason = 'timeout') {
    if (this.activeWorldId && worlds.has(this.activeWorldId)) {
      const entry = worlds.get(this.activeWorldId);
      if (entry.world && entry.world.creatures && entry.world.creatures.remove) {
        const sim = entry.world.creatures;
        // The phase minions go with the boss, whatever the reason (they count as
        // nobody's kill and drop nothing). A replaced boss also takes its summons.
        this._removePhaseMinions(entry);
        if (reason === 'replaced' && sim.all) {
          const summons = `skillsummon:${this.bossCreatureId}:`;
          for (const c of sim.all()) {
            if (String(c.id).startsWith(summons)) sim.remove(c.id);
          }
        }
        sim.remove(this.bossCreatureId);
      }
    }
    const oldBoss = this.currentBoss;
    this.state = 'idle';
    this.currentBoss = null;
    this.bossCreatureId = null;
    this.nextSpawnTime = Date.now() + this.bossIntervalMs;
    this.warningSent = false;
    this._refreshInBackground();

    if (broadcastFn && reason === 'timeout') {
      const despawnMsg = `[World Boss] ${oldBoss?.name || 'World Boss'} was not defeated in time and retreated into the shadows.`;
      broadcastFn({
        type: 'announcement',
        kind: 'world_boss_despawn',
        text: despawnMsg,
      });
    }

    if (broadcastFn) {
      broadcastFn({
        type: 'world_boss_status',
        status: this.getStatus(),
      });
    }
  }

  // Where the boss died, as a centre: the death snapshot the sim took when it removed
  // the creature (a real kill), else the live creature (the debug tools), else the
  // last place the manager saw it, else the arena. Before this the real path -- the
  // creature is already gone from the sim -- fell straight through to the arena post,
  // so loot landed where the fight started, not where it ended.
  _deathPosition(creature, killed) {
    if (killed && Number.isFinite(killed.x) && Number.isFinite(killed.y)) return { x: killed.x, y: killed.y };
    if (creature && Number.isFinite(creature.x) && Number.isFinite(creature.y)) {
      return { x: creature.x + (creature.width || 0) / 2, y: creature.y + (creature.height || 0) / 2 };
    }
    const boss = this.currentBoss;
    if (boss && Number.isFinite(boss.lastX) && Number.isFinite(boss.lastY)) return { x: boss.lastX, y: boss.lastY };
    return {
      x: (boss && boss.spawnX) || this.targetSpawnX || 400,
      y: (boss && boss.spawnY) || this.targetSpawnY || 400,
    };
  }

  // Hold ground items for one account (groundItems.reserve): nobody else can pick them
  // up for as long as they live, and the owner can come back for them -- a top damager
  // who logged out or left the world still gets what they earned. Before this every
  // drop was a free-for-all for whoever stood nearest.
  _reserve(entry, rows, userId) {
    const gi = entry && entry.world && entry.world.groundItems;
    if (!gi || typeof gi.reserve !== 'function' || userId == null) return;
    const until = Date.now() + DROP_RESERVE_MS;
    for (const r of rows || []) if (r && r.id != null) gi.reserve(r.id, userId, until);
  }

  // Who has earned a share of the loot. Dealing damage at all is not enough: an
  // account that lands a single hit used to take a top-3 slot (a free legendary) and
  // three gear rolls. The bar is 1% of the boss's hp, or a quarter of the top
  // damager's total when that is lower (so a crowd that splits the damage thinly
  // still qualifies, and a one-hit tourist never does). `damage` is what the boss
  // actually lost to the player -- damage.js credits only half of what a shield soaks.
  _eligible(contributors, maxHp) {
    if (contributors.length === 0) return [];
    const top = contributors[0].damage;
    const bar = Math.min(MIN_CONTRIBUTION_FRACTION * (maxHp || 1), MIN_CONTRIBUTION_OF_TOP * top);
    return contributors.filter((c) => c.damage >= bar);
  }

  // Called when any creature dies in the world
  async onCreatureDeath(entry, creature, killerUserId, {
    pool, broadcastFn, dropLegendaryFn, broadcastChestsFn, broadcastItemsFn, killed = null, allPlayers = null,
  } = {}) {
    if (this.state !== 'active' && !this.currentBoss) {
      return null;
    }
    if (creature && creature.bossTier !== 'world' && creature.id !== this.bossCreatureId) {
      return null;
    }

    const dbPool = pool || this.pool;
    const now = Date.now();
    const boss = this.currentBoss || creature;
    if (!boss) return null;

    const damageMap = (creature && creature._playerDamage) || (this.currentBoss && this.currentBoss._playerDamage) || new Map();

    // Sort contributors descending by damage
    const everyone = [];
    for (const [userId, dmg] of damageMap.entries()) {
      everyone.push({ userId: String(userId), damage: dmg });
    }
    everyone.sort((a, b) => b.damage - a.damage);

    // If no damage was registered (e.g. killed by single hit or admin tool), credit the killer
    if (everyone.length === 0 && killerUserId != null) {
      everyone.push({ userId: String(killerUserId), damage: boss.maxHp || 10000 });
    }
    const contributors = this._eligible(everyone, boss.maxHp);
    const top3 = contributors.slice(0, 3);
    const named = (list) => list.map((c, i) => ({ rank: i + 1, name: this._name(c.userId), damage: Math.round(c.damage) }));

    // Where the loot goes: where the boss died.
    const pos = this._deathPosition(creature, killed);
    const cx = Math.round(pos.x);
    const cy = Math.round(pos.y);

    // SOMET-603: claim the death BEFORE the first await. Everything below
    // reads the locals captured above, so a tick that runs during the reward
    // awaits sees an idle manager and cannot pay this kill out twice (or
    // re-place a boss that was just slain).
    this.state = 'idle';
    this.currentBoss = null;
    this.bossCreatureId = null;
    this.nextSpawnTime = now + this.bossIntervalMs;
    this.warningSent = false;
    this._refreshInBackground();
    // Its minions die with it, silently (they pay no XP and drop nothing).
    this._removePhaseMinions(entry);

    const dropFn = dropLegendaryFn || ((e, uId, x, y, lvl) => dropLegendaryItemForPlayer(dbPool, e, uId, x, y, lvl));

    // 1. Victor's Boon for everyone who earned a share, put on the ones online now
    // (the rest get it when they next join: restoreBoon).
    for (const contrib of contributors) this.grantBoon(contrib.userId, boss.name, now);
    const live = allPlayers ? [...allPlayers()] : [...((entry.world && entry.world.players) ? entry.world.players.values() : [])]
      .map((player) => ({ player, worldNow: entry.world.now }));
    for (const { player, worldNow } of live) this.applyBoon(player, worldNow, now);

    for (let i = 0; i < top3.length; i += 1) {
      const rec = top3[i];
      const row = await dropFn(entry, rec.userId, cx + (i - 1) * 40, cy + 30, 100);
      this._reserve(entry, row ? [row] : [], rec.userId);
    }

    // SOMET-611 (S10, spec §3.7): "3 per damaging participant" -- EVERY
    // eligible contributor, not just the top3 who already received a guaranteed
    // legendary above. `resolveLootProfile` reads the boss's own loot_*
    // overrides off its catalog row (ENTITY_CATALOG_SELECT); a row with none
    // set falls back to the 'world' tier default (3 rolls / yellow floor /
    // 0.5 bias). `boss.row` is absent only in the defensive `boss = creature`
    // fallback a few lines up (no live `this.currentBoss`) -- a bare
    // `{boss_tier:'world'}` stand-in still resolves to the same tier default.
    const lootRecipients = contributors;
    const lootProfile = resolveLootProfile(boss.row || { boss_tier: 'world' });
    // The boss's OWN creature_drops/behavior_drops rows belong to the kill,
    // not to each recipient (spec: loot_rolls are extras "on top of" the
    // normal drop rows) -- rolled with the first recipient only, and held for them.
    if (dbPool) {
      for (let i = 0; i < lootRecipients.length; i += 1) {
        if (i > 0 && lootProfile.rolls <= 0) break;
        try {
          const rows = await spawnBossLootItems(dbPool, entry, {
            entityTypeId: (boss.row && boss.row.id) ?? null,
            behaviorId: (boss.row && boss.row.behavior_id) ?? null,
            profile: lootProfile,
            itemLevel: WORLD_BOSS_LEVEL,
            x: cx,
            y: cy,
            includeOwnDrops: i === 0,
            rng: this.rng,
          });
          this._reserve(entry, rows, lootRecipients[i].userId);
        } catch (err) {
          console.error('Failed to roll world boss participant loot:', err);
        }
      }
    }

    // The gold: one pile per eligible contributor, each held for its owner, instead of
    // a single pile for whoever got there first.
    if (dbPool && entry.goldItemTypeId && lootRecipients.length > 0) {
      const share = Math.max(1, Math.round((boss.goldReward || 600) / Math.min(lootRecipients.length, MAX_GOLD_PILES)));
      for (let i = 0; i < Math.min(lootRecipients.length, MAX_GOLD_PILES); i += 1) {
        try {
          const goldIns = await dbPool.query(
            `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity, rarity, item_level)
             VALUES ($1, $2, $3, $4, now() + (600000 * interval '1 millisecond'), $5, 'white', 1)
             RETURNING id, item_type_id, x, y, expires_at, quantity, rarity, item_level`,
            [entry.worldId, entry.goldItemTypeId, cx + (i % 5) * 24 - 48, cy + 20 + Math.floor(i / 5) * 24, share],
          );
          if (goldIns.rows.length && entry.world && entry.world.groundItems) {
            entry.world.groundItems.add(goldIns.rows);
            this._reserve(entry, goldIns.rows, lootRecipients[i].userId);
          }
        } catch (err) {
          console.error('Failed to drop boss gold pile:', err);
        }
      }
    }

    // 3. Spawn a Boss Victory Chest at the boss death location. SOMET-611
    // (S10): this INSERT used to omit guard_entity_type_id, a NOT NULL FK
    // with no default -- it has been failing silently (caught by the
    // try/catch below, logged, nothing else) since the column was added.
    // spawnBossChest fixes it by naming the defeated boss's OWN entity type
    // as the guard (there is no live guard to point at instead), and its
    // return is already in the camelCase shape broadcastChests/mapChestRow
    // expect. loot_chest respects a per-boss override (lootProfile.chest) the
    // same way the item rolls above do. The chest's lifetime is a DB deadline
    // (world_chests.expires_at, 10 min; shortened to 30 s on open). It is the one
    // drop that is NOT reserved: a world chest has no owner, anyone can open it.
    let bossChest = null;
    const guardEntityTypeId = (boss.row && boss.row.id) ?? null;
    if (dbPool && lootProfile.chest && guardEntityTypeId != null) {
      try {
        bossChest = await spawnBossChest(dbPool, entry, {
          x: cx, y: cy, guardEntityTypeId, guardLevel: WORLD_BOSS_LEVEL,
        });
      } catch (err) {
        console.error('Failed to create Boss Victory Chest:', err);
      }
    }

    // 4. Broadcast chest and item updates immediately to zone
    if (broadcastChestsFn) broadcastChestsFn(entry);
    if (broadcastItemsFn) broadcastItemsFn(entry);

    // 5. Broadcast victory announcement and idle status
    if (broadcastFn) {
      const chestLine = bossChest ? ' A Boss Victory Chest has appeared!' : '';
      const victoryMsg = `[World Boss Defeated] ${boss.name || 'The World Boss'} has been slain! Top contributors receive legendary loot and the Victor's Boon!${chestLine}`;
      broadcastFn({
        type: 'announcement',
        kind: 'world_boss_slain',
        text: victoryMsg,
        bossName: boss.name,
        topDamagers: named(top3),
      });
      broadcastFn({
        type: 'world_boss_status',
        status: this.getStatus(),
      });
    }

    return {
      slain: true,
      topDamagers: top3,
      allContributors: everyone,
      eligibleContributors: contributors,
    };
  }
}

// A guaranteed-legendary drop for one account. Held for that account (groundItems
// reserve) for the whole life of the item: it used to be an unowned row any passer-by
// could take, and `userId` was ignored.
async function dropLegendaryItemForPlayer(pool, entry, userId, x, y, level = 100) {
  if (!pool || !entry) return null;
  try {
    let gRes = await pool.query(
      `SELECT id, name, category, tier, req_level FROM item_types
       WHERE category IN ('weapon', 'armor')
         AND name NOT LIKE 'test-%'
       ORDER BY req_level DESC NULLS LAST
       LIMIT 20`,
    );
    if (!gRes.rows || gRes.rows.length === 0) {
      gRes = await pool.query(`SELECT id, name, category, tier, req_level FROM item_types LIMIT 10`);
    }
    if (!gRes.rows || gRes.rows.length === 0) return null;

    const pickedType = gRes.rows[Math.floor(Math.random() * gRes.rows.length)];
    const itemType = (entry.world && entry.world.weapons ? entry.world.weapons.get(pickedType.id) : null) || pickedType;
    const rolled = rollItemInstance({
      itemType,
      itemLevel: level,
      rarity: 'foxy',
      affixPool: entry.affixPool || [],
    }, Math.random);

    const affixJson = JSON.stringify(
      (rolled.affixes || []).map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    );

    const ins = await pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity, rarity, item_level, affixes)
       VALUES ($1, $2, $3, $4, now() + (600000 * interval '1 millisecond'), 1, 'foxy', $5, $6::jsonb)
       RETURNING id, item_type_id, x, y, expires_at, quantity, rarity, item_level`,
      [entry.worldId, pickedType.id, Math.round(x), Math.round(y), level, affixJson],
    );
    if (ins.rows && ins.rows.length && entry.world && entry.world.groundItems) {
      entry.world.groundItems.add(ins.rows);
      if (userId != null && typeof entry.world.groundItems.reserve === 'function') {
        entry.world.groundItems.reserve(ins.rows[0].id, userId, Date.now() + DROP_RESERVE_MS);
      }
    }
    return ins.rows[0];
  } catch (err) {
    console.error('Failed to drop legendary item for world boss:', err);
    return null;
  }
}

module.exports = {
  WorldBossManager,
  dropLegendaryItemForPlayer,
  resolveArena,
  loadWorldBossCatalog,
  bossFromRow,
  MINION_TYPE_BY_ELEMENT,
  WORLD_BOSS_LEVEL,
  MINION_LEVEL,
  BOSS_ARENAS,
  findArena,
  BOSS_INTERVAL_MS,
  BOSS_WARNING_MS,
  BOSS_LIFETIME_MS,
  VICTORS_BOON_DURATION_MS,
};


