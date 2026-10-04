// World Boss Event Manager (SOMET-WBOSS).
//
// Spawns a rotating world boss every 10 minutes with a 2-minute global warning.
// Features:
// - English announcements broadcast to all connected sessions.
// - 4 distinct World Bosses with elemental affinities and boss-tier stats.
// - Tracks per-player damage contribution.
// - Top 3 damage contributors receive guaranteed Legendary ('foxy') gear.
// - All damaging participants receive the "Victor's Boon" buff (+15% speed, +20% damage/xp).
// - Identifies the nearest waypoint to the boss so travel UI can display a pulsing boss indicator.

const { rollItemInstance } = require('./affixes.js');

const BOSS_INTERVAL_MS = 10 * 60 * 1000;  // 10 minutes between boss spawns
const BOSS_WARNING_MS = 2 * 60 * 1000;    // 2 minutes warning before spawn
const BOSS_LIFETIME_MS = 8 * 60 * 1000;   // 8 minutes max lifetime before despawning
const VICTORS_BOON_DURATION_MS = 15 * 60 * 1000; // 15 minutes buff duration

const WORLD_BOSS_CATALOG = [
  {
    type: 'Ignis, the Magma Colossus',
    name: 'Ignis, the Magma Colossus',
    element: 'fire',
    maxHp: 12000,
    damage: 42,
    defense: 25,
    speed: 60,
    size: 96,
    xpReward: 3500,
    goldReward: 500,
    description: 'A titan forged from molten core and obsidian armor.',
  },
  {
    type: 'Glacius, the Frost Leviathan',
    name: 'Glacius, the Frost Leviathan',
    element: 'ice',
    maxHp: 14000,
    damage: 35,
    defense: 32,
    speed: 50,
    size: 96,
    xpReward: 3800,
    goldReward: 550,
    description: 'An ancient dread beast encased in eternal permafrost.',
  },
  {
    type: 'Abyssor, the Voidreaver',
    name: 'Abyssor, the Voidreaver',
    element: 'arcane',
    maxHp: 10000,
    damage: 55,
    defense: 18,
    speed: 85,
    size: 80,
    xpReward: 4000,
    goldReward: 600,
    description: 'A harbinger of the astral void who tears reality asunder.',
  },
  {
    type: 'Gorgon, the Thunder Titan',
    name: 'Gorgon, the Thunder Titan',
    element: 'lightning',
    maxHp: 13000,
    damage: 45,
    defense: 24,
    speed: 65,
    size: 96,
    xpReward: 3600,
    goldReward: 520,
    description: 'An electrified colossus crackling with tempest storms.',
  },
];

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
  }

  // Choose a boss, target world, and dedicated boss arena
  _planNextBoss(worlds) {
    const bossIdx = Math.floor(this.rng() * WORLD_BOSS_CATALOG.length);
    this.currentBoss = { ...WORLD_BOSS_CATALOG[bossIdx] };
    
    // Pick from loaded worlds if any exist
    const worldEntries = [...worlds.entries()];
    if (worldEntries.length > 0) {
      const [wId, entry] = worldEntries[Math.floor(this.rng() * worldEntries.length)];
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
  }

  getStatus() {
    const now = Date.now();
    return {
      state: this.state,
      bossName: this.currentBoss ? this.currentBoss.name : null,
      bossElement: this.currentBoss ? this.currentBoss.element : null,
      worldId: this.activeWorldId,
      worldName: this.activeWorldName,
      arenaName: this.activeArenaName,
      nearestWaypointId: this.nearestWaypointId,
      timeToSpawnMs: Math.max(0, this.nextSpawnTime - now),
      currentHp: this.currentBoss ? this.currentBoss.currentHp : 0,
      maxHp: this.currentBoss ? this.currentBoss.maxHp : 0,
      topDamagers: this.getTopDamagers(3),
    };
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
      if (timeRemaining <= this.bossWarningMs) {
        this.state = 'warning';
        if (!this.currentBoss) this._planNextBoss(worlds);

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
            // Auto-broadcast if HP changed or periodically every 1500ms
            if (broadcastFn && (oldHp !== this.currentBoss.currentHp || (now - this._lastBroadcastTime) >= 1500)) {
              this._lastBroadcastHp = this.currentBoss.currentHp;
              this._lastBroadcastTime = now;
              broadcastFn({
                type: 'world_boss_status',
                status: this.getStatus(),
              });
            }
          }
        }
      }
    }
  }

  _spawnBoss(now, worlds, broadcastFn) {
    if (!this.currentBoss) this._planNextBoss(worlds);
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

      const bossCreature = {
        id: cid,
        type: this.currentBoss.type,
        name: this.currentBoss.name,
        x: spawnX,
        y: spawnY,
        width: this.currentBoss.size || 96,
        height: this.currentBoss.size || 96,
        level: 100,
        hp: this.currentBoss.maxHp,
        maxHp: this.currentBoss.maxHp,
        damage: this.currentBoss.damage,
        attackElement: this.currentBoss.element,
        bossElement: this.currentBoss.element,
        speed: this.currentBoss.speed,
        defense: this.currentBoss.defense,
        isWorldBoss: true,
        _playerDamage: this.currentBoss._playerDamage,
      };

      if (worldEntry.world.creatures && worldEntry.world.creatures.addCreatures) {
        worldEntry.world.creatures.addCreatures([bossCreature]);
      }
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

  _despawnBoss(worlds, broadcastFn, reason = 'timeout') {
    if (this.activeWorldId && worlds.has(this.activeWorldId)) {
      const entry = worlds.get(this.activeWorldId);
      if (entry.world && entry.world.creatures && entry.world.creatures.remove) {
        entry.world.creatures.remove(this.bossCreatureId);
      }
    }

    if (broadcastFn && reason === 'timeout') {
      const despawnMsg = `[World Boss] ${this.currentBoss.name} was not defeated in time and retreated into the shadows.`;
      broadcastFn({
        type: 'announcement',
        kind: 'world_boss_despawn',
        text: despawnMsg,
      });
    }

    this.state = 'idle';
    this.currentBoss = null;
    this.bossCreatureId = null;
    this.nextSpawnTime = Date.now() + this.bossIntervalMs;
    this.warningSent = false;
  }

  // Called when any creature dies in the world
  async onCreatureDeath(entry, creature, killerUserId, { pool, broadcastFn, dropLegendaryFn, broadcastChestsFn, broadcastItemsFn } = {}) {
    if (!creature || (!creature.isWorldBoss && creature.id !== this.bossCreatureId)) {
      return null;
    }

    const dbPool = pool || this.pool;
    const now = Date.now();
    const boss = this.currentBoss || creature;
    const damageMap = creature._playerDamage || (this.currentBoss && this.currentBoss._playerDamage) || new Map();

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

    // 2. Grant guaranteed legendary ('foxy') item to Top 3 damagers
    const cx = Math.round(creature.x || 400);
    const cy = Math.round(creature.y || 400);

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

    // 5. Broadcast victory announcement in English
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


    // Reset cycle
    this.state = 'idle';
    this.currentBoss = null;
    this.bossCreatureId = null;
    this.nextSpawnTime = now + this.bossIntervalMs;
    this.warningSent = false;

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
  WORLD_BOSS_CATALOG,
  BOSS_ARENAS,
  BOSS_INTERVAL_MS,
  BOSS_WARNING_MS,
  BOSS_LIFETIME_MS,
  VICTORS_BOON_DURATION_MS,
};


