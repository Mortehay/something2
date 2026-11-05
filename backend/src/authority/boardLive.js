// SOMET-720. The live view behind the board's internal listener (api/boardInternal.js):
// who is online, what they have killed, and each boss as its OWNER sees it. Read only
// on request, never from the tick; the one write is summon, which goes through the
// managers that own a boss's life.
const { parseDungeonBoss, POST_TIERS } = require('./dungeonBosses.js');

const MAX_NAME = 120;
const SUMMON_KEYS = ['name', 'owner', 'world'];

const REFUSAL_TEXT = {
  not_loaded: (r) => `${r.world} is not loaded: nobody is in it, so there is nothing to summon the boss into. Enter that world first.`,
  no_placement: (r) => `${r.world} no longer has a valid boss placement.`,
  no_catalog_row: (r) => `${r.name} is not a dungeon boss in the catalog.`,
};

const round1 = (n) => Math.round(n * 10) / 10;
const playersIn = (entry) => {
  let n = 0;
  for (const userId of entry.sockets.keys()) if (entry.world.getPlayer(userId)) n += 1;
  return n;
};

// -> { owner, name, world } or null. Exactly these keys, nothing else reaches the managers.
function parseSummon(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).sort().join() !== SUMMON_KEYS.join()) return null;
  const { owner, name, world } = body;
  if (owner !== 'world' && owner !== 'dungeon') return null;
  const okText = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME;
  if (!okText(name) || !okText(world)) return null;
  return { owner, name, world };
}

function createBoardLive({ pool, worlds, worldBossManager, dungeonBosses, gameStats, broadcast = () => {}, now = Date.now }) {
  // Every player standing in a world right now, with their socket.
  function online() {
    const out = [];
    for (const entry of worlds.values()) {
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        if (p && p.characterId != null) out.push({ entry, ws, p });
      }
    }
    return out;
  }

  function counters() {
    return { online: online().length, ...gameStats.totals() };
  }

  async function players() {
    const list = online();
    const ids = list.map((x) => x.p.characterId);
    if (ids.length === 0) return { players: [] };
    const [names, lifetime] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, COALESCE(pp.level, 1) AS level
           FROM characters c LEFT JOIN player_progression pp ON pp.character_id = c.id
          WHERE c.id = ANY($1::int[])`,
        [ids],
      ),
      gameStats.lifetime(ids),
    ]);
    const byId = new Map(names.rows.map((r) => [r.id, r]));
    const t = now();
    return {
      players: list.map(({ entry, ws, p }) => {
        const s = gameStats.session(p.characterId);
        const row = byId.get(p.characterId) || {};
        const sessionSeconds = s ? Math.max(0, Math.floor((t - s.startedAt) / 1000)) : 0;
        // A rate over less than a minute says nothing, and would read as a huge number.
        const minutes = Math.max(1, sessionSeconds / 60);
        const mobKills = s ? s.mobKills : 0;
        const pvpKills = s ? s.pvpKills : 0;
        return {
          name: row.name ?? null,
          level: row.level ?? null,
          world: entry.row ? entry.row.name : null,
          sessionStart: s ? new Date(s.startedAt).toISOString() : null,
          sessionSeconds,
          mobKills,
          pvpKills,
          mobKillsPerMin: round1(mobKills / minutes),
          pvpKillsPerMin: round1(pvpKills / minutes),
          deaths: s ? s.deaths : 0,
          lifetime: lifetime.get(p.characterId),
          pingMs: ws.pingMs ?? null,
        };
      }),
    };
  }

  function worldBossRows() {
    const m = worldBossManager;
    const active = m.state === 'active' && m.currentBoss;
    const summonId = m.summonWorldId(worlds);
    const summonEntry = summonId != null ? worlds.get(summonId) : null;
    const summonWorld = summonEntry ? { name: summonEntry.row.name, players: playersIn(summonEntry) } : null;
    return m.catalog.bosses.map((b) => {
      const base = {
        owner: 'world', name: b.name, tier: 'world', summonWorld,
        replaces: active ? m.currentBoss.name : null,
      };
      if (active && m.currentBoss.name === b.name) {
        const entry = worlds.get(m.activeWorldId);
        const c = entry && entry.world.creatures.get(m.bossCreatureId);
        const hp = c ? c.hp : m.currentBoss.currentHp;
        const maxHp = (c && c.maxHp) || m.currentBoss.maxHp || 1;
        const damage = (c && c._playerDamage) || m.currentBoss._playerDamage;
        return {
          ...base,
          world: m.activeWorldName,
          players: entry ? playersIn(entry) : 0,
          status: 'alive',
          hpPct: round1((Math.max(0, hp) / maxHp) * 100),
          fighters: damage ? damage.size : 0,
        };
      }
      // While a boss is up the rotation is paused: the next one is timed from its end.
      return {
        ...base,
        world: null,
        players: null,
        status: 'not_spawned',
        nextRotationSeconds: active ? null : Math.max(0, Math.ceil((m.nextSpawnTime - now()) / 1000)),
      };
    });
  }

  async function dungeonBossRows() {
    const r = await pool.query(
      `SELECT w.id, w.name, w.dungeon_boss, et.boss_tier
         FROM worlds w
         LEFT JOIN entity_types et ON et.is_creature = true AND et.name = w.dungeon_boss->>'entity'
        WHERE w.dungeon_boss IS NOT NULL
        ORDER BY w.name ASC`,
    );
    const rows = [];
    for (const w of r.rows) {
      const spec = parseDungeonBoss(w.dungeon_boss);
      // A placement the manager would refuse is not a boss anyone can meet.
      if (!spec || !POST_TIERS.includes(w.boss_tier)) continue;
      const entry = worlds.get(w.id);
      const base = { owner: 'dungeon', name: spec.entity, tier: w.boss_tier, world: w.name };
      if (!entry) rows.push({ ...base, players: 0, status: 'not_loaded' });
      else rows.push({ ...base, players: playersIn(entry), ...dungeonBosses.statusOf(entry) });
    }
    return rows;
  }

  async function bosses() {
    // The catalog loads in the background at boot; a first request may beat it.
    if (worldBossManager.catalog.bosses.length === 0) await worldBossManager.refreshCatalog();
    return { bosses: [...worldBossRows(), ...(await dungeonBossRows())] };
  }

  // -> { status, body } with status the HTTP answer.
  async function summon(raw) {
    const req = parseSummon(raw);
    const refuse = (status, error, message) => ({ status, body: { ok: false, error, message } });
    if (!req) return refuse(400, 'bad_request', 'A summon is { owner, name, world } and nothing else.');
    const { bosses: rows } = await bosses();

    if (req.owner === 'world') {
      const row = rows.find((b) => b.owner === 'world' && b.name === req.name);
      if (!row) return refuse(404, 'unknown_boss', `${req.name} is not a world boss in the catalog.`);
      if (!row.summonWorld) return refuse(409, 'not_loaded', 'No world is loaded: nobody is playing, so a world boss would have nowhere to stand.');
      if (row.summonWorld.name !== req.world) {
        return refuse(409, 'stale', `${req.name} would now land in ${row.summonWorld.name}, not ${req.world}. Look at the list again and retry.`);
      }
      const spawned = worldBossManager.forceSpawn(now(), worlds, {
        bossName: req.name, preferredWorldId: worldBossManager.summonWorldId(worlds),
      }, broadcast);
      if (!spawned) return refuse(409, 'refused', `${req.name} could not be summoned.`);
      return {
        status: 200,
        body: {
          ok: true, owner: 'world', name: req.name, world: worldBossManager.activeWorldName, replaced: row.replaces,
          message: `${req.name} summoned in ${worldBossManager.activeWorldName}${row.replaces ? `, replacing ${row.replaces}` : ''}.`,
        },
      };
    }

    const row = rows.find((b) => b.owner === 'dungeon' && b.name === req.name && b.world === req.world);
    if (!row) return refuse(404, 'unknown_boss', `${req.name} is not placed in ${req.world}.`);
    if (row.status === 'not_loaded') return refuse(409, 'not_loaded', REFUSAL_TEXT.not_loaded(row));
    const entry = [...worlds.values()].find((e) => e.row && e.row.name === req.world);
    if (!entry) return refuse(409, 'not_loaded', REFUSAL_TEXT.not_loaded(row));
    const out = await dungeonBosses.forceRespawn(entry);
    if (!out.ok) return refuse(409, out.reason, (REFUSAL_TEXT[out.reason] || REFUSAL_TEXT.no_catalog_row)(row));
    return {
      status: 200,
      body: { ok: true, owner: 'dungeon', name: req.name, world: req.world, message: `${req.name} summoned in ${req.world} at full health.` },
    };
  }

  return { players, counters, bosses, summon };
}

module.exports = { createBoardLive, parseSummon };
