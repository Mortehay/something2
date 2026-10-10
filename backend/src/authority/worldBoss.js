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
  hydrateCreatureRow, ENTITY_CATALOG_SELECT, CREATURE_SPEED, CREATURE_DAMAGE,
} = require('./creatures.js');
const { pushSfxEvent, bossSfx } = require('./sfxEvents.js');

const BOSS_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes between boss spawns
const BOSS_WARNING_MS = 2 * 60 * 1000;    // 2 minutes warning before spawn
const BOSS_LIFETIME_MS = 20 * 60 * 1000;  // 20 minutes max lifetime before despawning
// SOMET-605 (spec §4.3): enrage at < 10% HP or in the last minute of the
// boss's lifetime. "Near the lifetime limit" is not quantified by the spec;
// 60 s is this slice's reading (plan decision D2).
const ENRAGE_HP_RATIO = 0.10;
const ENRAGE_LEAD_MS = 60 * 1000;
const VICTORS_BOON_DURATION_MS = 15 * 60 * 1000; // 15 minutes buff duration

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

// Dedicated Boss Arenas across key regions so bosses don't spawn at map center
const BOSS_ARENAS = [
  {
    matchKeys: ['vale_hub', 'vale crossing', 'vale-crossing'],
    arenaName: 'Colossus Caldera',
    x: 8800,
    y: 8800,
  },
  {
    matchKeys: ['vale_dunes', 'sunscar flats', 'sunscar'],
    arenaName: 'Scorched Arena',
    x: 7500,
    y: 2500,
  },
  {
    matchKeys: ['vale_frozen', 'rimehollow'],
    arenaName: 'Glacier Throne',
    x: 2500,
    y: 7500,
  },
  {
    matchKeys: ['vale_forest', 'thornbriar reach', 'thornbriar'],
    arenaName: 'Thundergrove Glade',
    x: 2200,
    y: 2200,
  },
  {
    matchKeys: ['vale_mire', 'blackfen sinks', 'blackfen'],
    arenaName: 'Abyssal Chasm',
    x: 7200,
    y: 7200,
  },
];

function resolveArena(worldKey, worldName) {
  const normKey = (worldKey || '').toLowerCase();
  const normName = (worldName || '').toLowerCase();
  for (const arena of BOSS_ARENAS) {
    if (arena.matchKeys.some((k) => normKey.includes(k) || normName.includes(k))) {
      return arena;
    }
  }
  return null;
}

class WorldBossManager {
  constructor({
    pool,
    bossIntervalMs = BOSS_INTERVAL_MS,
    bossWarningMs = BOSS_WARNING_MS,
    bossLifetimeMs = BOSS_LIFETIME_MS,
    rng = Math.random,
    loadCatalog = null,
  } = {}) {
    this.pool = pool;
    this.bossIntervalMs = bossIntervalMs;
    this.bossWarningMs = bossWarningMs;
    this.bossLifetimeMs = bossLifetimeMs;
    this.rng = rng;

    this.state = 'idle'; // 'idle' | 'warning' | 'active'
    this.nextSpawnTime = Date.now() + this.bossIntervalMs;
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
    this._spawnBoss(now, worlds, broadcastFn);
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

  // Choose a boss, target world, and dedicated boss arena
  _planNextBoss(worlds, preferredWorldId = null, bossName = null) {
    const bosses = this.catalog.bosses;
    if (bosses.length === 0) {
      this.currentBoss = null;
      return false;
    }
    const named = bossName ? bosses.find((b) => b.name === bossName) : null;
    this.currentBoss = bossFromRow(named || bosses[Math.floor(this.rng() * bosses.length)]);
    
    // Pick from loaded worlds if any exist
    const worldEntries = [...worlds.entries()];
    if (worldEntries.length > 0) {
      const arenaWorlds = worldEntries.filter(([wId, entry]) => {
        const wName = (entry.row && entry.row.name) || '';
        const wKey = (entry.row && (entry.row.key || entry.row.canonical_id)) || '';
        return resolveArena(wKey, wName) !== null;
      });

      let chosen = null;
      if (preferredWorldId && worlds.has(preferredWorldId)) {
        const prefEntry = worlds.get(preferredWorldId);
        const prefKey = (prefEntry.row && (prefEntry.row.key || prefEntry.row.canonical_id)) || '';
        const prefName = (prefEntry.row && prefEntry.row.name) || '';
        if (resolveArena(prefKey, prefName)) {
          chosen = [preferredWorldId, prefEntry];
        }
      }

      if (!chosen) {
        if (arenaWorlds.length > 0) {
          chosen = arenaWorlds[Math.floor(this.rng() * arenaWorlds.length)];
        } else {
          chosen = worldEntries[Math.floor(this.rng() * worldEntries.length)];
        }
      }

      const [wId, entry] = chosen;
      this.activeWorldId = wId;
      const wName = (entry.row && entry.row.name) || 'The Wilds';
      const wKey = (entry.row && (entry.row.key || entry.row.canonical_id)) || '';
      this.activeWorldName = wName;
      
      const arena = resolveArena(wKey, wName);
      if (arena) {
        this.activeArenaName = arena.arenaName;
        this.targetSpawnX = arena.x;
        this.targetSpawnY = arena.y;
      } else if (entry.row && entry.row.width && entry.row.height) {
        this.activeArenaName = 'Outer Arena';
        this.targetSpawnX = Math.floor(entry.row.width * 100 * 0.75);
        this.targetSpawnY = Math.floor(entry.row.height * 100 * 0.75);
      } else {
        this.activeArenaName = 'Boss Arena';
        this.targetSpawnX = 400;
        this.targetSpawnY = 400;
      }

      // Find nearest waypoint in this world to the chosen arena
      if (entry.waypoints && entry.waypoints.size > 0) {
        let bestWp = null;
        let bestDistSq = Infinity;
        for (const wp of entry.waypoints.values()) {
          const dx = (wp.x || 0) - this.targetSpawnX;
          const dy = (wp.y || 0) - this.targetSpawnY;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestWp = wp;
          }
        }
        this.nearestWaypointId = bestWp ? bestWp.id : null;
      } else {
        this.nearestWaypointId = null;
      }
    } else {
      this.activeWorldId = null;
      this.activeWorldName = 'The Outer Realm';
      this.activeArenaName = 'Celestial Arena';
      this.targetSpawnX = 400;
      this.targetSpawnY = 400;
      this.nearestWaypointId = null;
    }
    return true;
  }

  getStatus() {
    const now = Date.now();
    const hpRatio = (this.currentBoss && this.currentBoss.maxHp > 0)
      ? (this.currentBoss.currentHp / this.currentBoss.maxHp)
      : 1;
    const phaseInfo = this._calculatePhase(hpRatio);

    return {
      state: this.state,
      bossName: this.currentBoss ? this.currentBoss.name : null,
      bossCreatureId: this.bossCreatureId,
      bossElement: this.currentBoss ? this.currentBoss.element : null,
      worldId: this.activeWorldId,
      worldName: this.activeWorldName,
      arenaName: this.activeArenaName,
      nearestWaypointId: this.nearestWaypointId,
      timeToSpawnMs: Math.max(0, this.nextSpawnTime - now),
      currentHp: this.currentBoss ? this.currentBoss.currentHp : 0,
      maxHp: this.currentBoss ? this.currentBoss.maxHp : 0,
      phase: this.currentBoss ? (this.currentBoss.phase || phaseInfo.phase) : 1,
      phaseName: phaseInfo.name,
      phaseBonus: phaseInfo.bonus,
      hpRatio,
      enraged: Boolean(this.currentBoss && this.currentBoss.enraged),
      topDamagers: this.getTopDamagers(3),
    };
  }

  _calculatePhase(hpRatio) {
    if (hpRatio <= 0.25) return { phase: 4, name: 'Frenzy Overload', bonus: '+50% Damage & Catastrophic Blasts' };
    if (hpRatio <= 0.50) return { phase: 3, name: 'Elemental Nova', bonus: '+25% Defense & Minion Summons' };
    if (hpRatio <= 0.75) return { phase: 2, name: 'Enraged Surge', bonus: '+20% Speed & Shockwave' };
    return { phase: 1, name: 'Standard', bonus: 'Base Stats' };
  }

  _checkPhaseTransition(creature, worldEntry, broadcastFn) {
    if (!this.currentBoss || !creature) return;
    const hpRatio = Math.max(0, creature.hp) / (creature.maxHp || 1);
    const phaseInfo = this._calculatePhase(hpRatio);
    const currentPhase = this.currentBoss.phase || 1;

    if (phaseInfo.phase > currentPhase) {
      this.currentBoss.phase = phaseInfo.phase;
      creature.phase = phaseInfo.phase;

      // Apply stat boosts per phase
      if (phaseInfo.phase === 2) {
        creature.speed = Math.round((this.currentBoss.speed || 60) * 1.2);
        creature.damage = Math.round((this.currentBoss.damage || 40) * 1.1);
      } else if (phaseInfo.phase === 3) {
        creature.defense = Math.round((this.currentBoss.defense || 25) * 1.25);
        creature.damage = Math.round((this.currentBoss.damage || 40) * 1.25);
        this._spawnPhaseMinions(creature, worldEntry);
      } else if (phaseInfo.phase === 4) {
        creature.damage = Math.round((this.currentBoss.damage || 40) * 1.5);
        creature.speed = Math.round((this.currentBoss.speed || 60) * 1.3);
        this._spawnPhaseMinions(creature, worldEntry);
      }

      this._emitBossSfx(worldEntry, creature, 'phase'); // SOMET-605

      if (broadcastFn) {
        const phaseMsg = `[World Boss Phase ${phaseInfo.phase}] ${this.currentBoss.name} enters ${phaseInfo.name}! (${phaseInfo.bonus})`;
        broadcastFn({
          type: 'announcement',
          kind: 'world_boss_phase',
          text: phaseMsg,
          phase: phaseInfo.phase,
          phaseName: phaseInfo.name,
          bossName: this.currentBoss.name,
        });
        broadcastFn({
          type: 'world_boss_status',
          status: this.getStatus(),
        });
      }
    }
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
    const stamp = Date.now();
    // SOMET-603: hydrated like every other creature (behaviour, element
    // and damage all arrive the one shared way). No `damage` here: an explicit
    // instance damage would beat the row's base_damage (ruling P1).
    const minions = MINION_OFFSETS.map(([dx, dy], i) => hydrateCreatureRow(row, {
      id: `wb_minion_${stamp}_${i + 1}`,
      x: creature.x + dx,
      y: creature.y + dy,
      level: MINION_LEVEL,
      hp: Number(row.max_hp) || Number(row.hp) || 1,
    }));
    worldEntry.world.creatures.addCreatures(minions);
  }

  getTopDamagers(limit = 3) {
    if (!this.currentBoss || !this.currentBoss._playerDamage) return [];
    const list = [];
    for (const [userId, dmg] of this.currentBoss._playerDamage.entries()) {
      list.push({ userId, damage: Math.round(dmg) });
    }
    list.sort((a, b) => b.damage - a.damage);
    return list.slice(0, limit);
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

  tick(now, worlds, broadcastFn) {
    // Clean expired player buffs
    for (const [uid, b] of this.playerBuffs.entries()) {
      if (b.expiresAt <= now) this.playerBuffs.delete(uid);
    }

    // 1. Idle state -> check if warning should be sent
    if (this.state === 'idle') {
      const timeRemaining = this.nextSpawnTime - now;
      if (timeRemaining <= this.bossWarningMs && !this.currentBoss && !this._planNextBoss(worlds)) {
        this._skipRotation(now);
      } else if (timeRemaining <= this.bossWarningMs) {
        this.state = 'warning';

        if (broadcastFn) {
          const alertMsg = `[World Boss Alert] A massive tremor shakes the realm! ${this.currentBoss.name} will emerge in 2 minutes at ${this.activeArenaName} (${this.activeWorldName})! Prepare for battle!`;
          broadcastFn({
            type: 'announcement',
            kind: 'world_boss_warning',
            text: alertMsg,
            bossName: this.currentBoss.name,
            worldName: this.activeWorldName,
            arenaName: this.activeArenaName,
            timeToSpawnMs: timeRemaining,
            nearestWaypointId: this.nearestWaypointId,
          });
        }
      }
    }

    // 2. Warning state -> check if boss should spawn
    if (this.state === 'warning' && now >= this.nextSpawnTime) {
      this._spawnBoss(now, worlds, broadcastFn);
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
            const oldHp = this.currentBoss.currentHp;
            this.currentBoss.currentHp = Math.max(0, c.hp);
            if (c._playerDamage) {
              this.currentBoss._playerDamage = c._playerDamage;
            }
            this._checkPhaseTransition(c, entry, broadcastFn);
            this._checkEnrage(c, entry, now, broadcastFn); // SOMET-605
            // Auto-broadcast if HP changed or periodically every 1500ms
            if (broadcastFn && (oldHp !== this.currentBoss.currentHp || (now - this._lastBroadcastTime) >= 1500)) {
              this._lastBroadcastHp = this.currentBoss.currentHp;
              this._lastBroadcastTime = now;
              broadcastFn({
                type: 'world_boss_status',
                status: this.getStatus(),
              });
            }
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
      }
    }
  }

  _spawnBoss(now, worlds, broadcastFn) {
    if (!this.currentBoss && !this._planNextBoss(worlds)) {
      this._skipRotation(now);
      return;
    }
    this.state = 'active';
    this.spawnedAt = now;
    this.currentBoss.currentHp = this.currentBoss.maxHp;
    this.currentBoss._playerDamage = new Map();
    this._lastBroadcastHp = this.currentBoss.maxHp;
    this._lastBroadcastTime = now;

    const worldEntry = this.activeWorldId ? worlds.get(this.activeWorldId) : null;
    const cid = `wb_${Date.now()}_${Math.floor(this.rng() * 1000)}`;
    this.bossCreatureId = cid;

    if (worldEntry && worldEntry.world) {
      // Use resolved dedicated arena coordinates
      let spawnX = this.targetSpawnX || 400;
      let spawnY = this.targetSpawnY || 400;

      // If not yet resolved, resolve now
      if (!this.targetSpawnX && worldEntry.row) {
        const arena = resolveArena(worldEntry.row.key || worldEntry.row.canonical_id, worldEntry.row.name);
        if (arena) {
          this.activeArenaName = arena.arenaName;
          spawnX = arena.x;
          spawnY = arena.y;
        } else {
          this.activeArenaName = 'Colosseum Arena';
          spawnX = Math.floor(worldEntry.row.width * 100 * 0.75);
          spawnY = Math.floor(worldEntry.row.height * 100 * 0.75);
        }
      }
      this.currentBoss.spawnX = spawnX;
      this.currentBoss.spawnY = spawnY;
      this._placeBossCreature(worldEntry, this.currentBoss.maxHp);
    }

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
  }

  // The ONE place a boss creature is built and put into a world sim: the
  // spawn (at max hp) and the lost-boss re-place in tick (at current hp).
  // SOMET-603: hydrated from the catalog row like every other creature, so
  // boss_tier/element/hitbox_size/behaviour/vfx (and S3's auras) arrive the
  // one shared way. No `damage` here: an explicit instance damage would beat
  // the row's base_damage (ruling P1).
  _placeBossCreature(worldEntry, hp, quiet = false) {
    const sim = worldEntry && worldEntry.world && worldEntry.world.creatures;
    if (!sim || !sim.addCreatures || !this.currentBoss) return null;
    const bossCreature = hydrateCreatureRow(this.currentBoss.row, {
      id: this.bossCreatureId,
      x: this.currentBoss.spawnX ?? this.targetSpawnX ?? 400,
      y: this.currentBoss.spawnY ?? this.targetSpawnY ?? 400,
      level: WORLD_BOSS_LEVEL,
      hp,
    });
    // SOMET-605: a lost-boss re-place must not replay the spawn sound.
    if (quiet) bossCreature.quietSpawn = true;
    sim.addCreatures([bossCreature]);
    const placed = sim.get ? sim.get(this.bossCreatureId) : null;
    if (placed) {
      // addCreatures takes maxHp from hp; a re-placed boss keeps its real max.
      placed.maxHp = this.currentBoss.maxHp;
      if (this.currentBoss._playerDamage) placed._playerDamage = this.currentBoss._playerDamage;
    }
    return placed;
  }

  _despawnBoss(worlds, broadcastFn, reason = 'timeout') {
    if (this.activeWorldId && worlds.has(this.activeWorldId)) {
      const entry = worlds.get(this.activeWorldId);
      if (entry.world && entry.world.creatures && entry.world.creatures.remove) {
        entry.world.creatures.remove(this.bossCreatureId);
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

  // Called when any creature dies in the world
  async onCreatureDeath(entry, creature, killerUserId, { pool, broadcastFn, dropLegendaryFn, broadcastChestsFn, broadcastItemsFn } = {}) {
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
    const contributors = [];
    for (const [userId, dmg] of damageMap.entries()) {
      contributors.push({ userId: String(userId), damage: dmg });
    }
    contributors.sort((a, b) => b.damage - a.damage);

    // If no damage was registered (e.g. killed by single hit or admin tool), credit the killer
    if (contributors.length === 0 && killerUserId) {
      contributors.push({ userId: String(killerUserId), damage: boss.maxHp || 10000 });
    }

    const top3 = contributors.slice(0, 3);

    // 2. Grant guaranteed legendary ('foxy') item to Top 3 damagers
    const cx = Math.round((creature && creature.x) || (boss && boss.spawnX) || this.targetSpawnX || 400);
    const cy = Math.round((creature && creature.y) || (boss && boss.spawnY) || this.targetSpawnY || 400);

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

    const dropFn = dropLegendaryFn || ((e, uId, x, y, lvl) => dropLegendaryItemForPlayer(dbPool, e, uId, x, y, lvl));

    // 1. Grant Victor's Boon buff to ALL players who dealt damage
    for (const contrib of contributors) {
      this.playerBuffs.set(contrib.userId, {
        active: true,
        expiresAt: now + VICTORS_BOON_DURATION_MS,
        speedBonus: 0.15,
        damageBonus: 0.20,
        xpBonus: 0.20,
        bossName: boss.name || 'World Boss',
      });
    }

    const recipients = top3.length > 0 ? top3 : [{ userId: String(killerUserId || '1'), damage: 1000 }];
    let itemOffset = -40;
    for (const rec of recipients) {
      await dropFn(entry, rec.userId, cx + itemOffset, cy + 30, 100);
      itemOffset += 40;
    }

    // Drop large gold pile at boss location
    if (dbPool && entry.goldItemTypeId) {
      try {
        const goldAmt = boss.goldReward || 600;
        const goldIns = await dbPool.query(
          `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity, rarity, item_level)
           VALUES ($1, $2, $3, $4, now() + (600000 * interval '1 millisecond'), $5, 'white', 1)
           RETURNING id, item_type_id, x, y, expires_at, quantity, rarity, item_level`,
          [entry.worldId, entry.goldItemTypeId, cx, cy + 20, goldAmt],
        );
        if (goldIns.rows.length && entry.world && entry.world.groundItems) {
          entry.world.groundItems.add(goldIns.rows);
        }
      } catch (err) {
        console.error('Failed to drop boss gold pile:', err);
      }
    }

    // 3. Spawn a Boss Victory Chest at the boss death location
    if (dbPool) {
      try {
        const chestRes = await dbPool.query(
          `INSERT INTO world_chests (world_id, x, y, kind, guard_level, guard_creature_ids, state)
           VALUES ($1, $2, $3, 'vault', 100, '[]'::jsonb, 'unlocked')
           RETURNING id, x, y, kind, guard_level, guard_creature_ids, state, opened_at, respawn_at`,
          [entry.worldId, cx, cy],
        );
        if (chestRes.rows && chestRes.rows.length) {
          const row = chestRes.rows[0];
          const bossChest = {
            id: row.id,
            x: Number(row.x),
            y: Number(row.y),
            kind: 'vault',
            guardLevel: 100,
            guardCreatureIds: [],
            state: 'unlocked',
            isBossChest: true,
          };
          if (!entry.chests) entry.chests = [];
          entry.chests.push(bossChest);

          // Fallback cleanup if chest is abandoned for 10 minutes
          setTimeout(async () => {
            try {
              if (entry && entry.chests) {
                entry.chests = entry.chests.filter((c) => c.id !== bossChest.id);
                await dbPool.query('DELETE FROM world_chests WHERE id = $1', [bossChest.id]).catch(() => {});
                if (broadcastChestsFn) broadcastChestsFn(entry);
              }
            } catch (_) {}
          }, 10 * 60 * 1000);
        }
      } catch (err) {
        console.error('Failed to create Boss Victory Chest:', err);
      }
    }

    // 4. Broadcast chest and item updates immediately to zone
    if (broadcastChestsFn) broadcastChestsFn(entry);
    if (broadcastItemsFn) broadcastItemsFn(entry);

    // 5. Broadcast victory announcement and idle status
    if (broadcastFn) {
      const victoryMsg = `[World Boss Defeated] ${boss.name || 'The World Boss'} has been slain! Top contributors receive legendary loot and the Victor's Boon! A Boss Victory Chest has appeared!`;
      broadcastFn({
        type: 'announcement',
        kind: 'world_boss_slain',
        text: victoryMsg,
        bossName: boss.name,
        topDamagers: top3,
      });
      broadcastFn({
        type: 'world_boss_status',
        status: this.getStatus(),
      });
    }

    return {
      slain: true,
      topDamagers: top3,
      allContributors: contributors,
    };
  }
}

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
  BOSS_INTERVAL_MS,
  BOSS_WARNING_MS,
  BOSS_LIFETIME_MS,
  VICTORS_BOON_DURATION_MS,
};


