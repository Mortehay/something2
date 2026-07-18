const { URL } = require('node:url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { ServerMap } = require('./collision');
const { World } = require('./world');
const { loadWeaponTypes, resolveDefaultWeaponId } = require('./weapons');
const { chunkOf, parseKey, neighborhoodKeys } = require('./coords');
const { spawnChunkCreatures } = require('../services/mapService');

const MAP_TILE_SIZE = 100;

// Coerce a wire-provided number to a finite value (clients can send NaN/Infinity
// via JSON, e.g. 1e999 parses to Infinity).
function finiteOr(v, fallback) { return Number.isFinite(v) ? v : fallback; }

// Attach the authoritative WebSocket simulation to an existing http server.
// Returns { close() } so callers/tests can tear it down.
function attachAuthority(httpServer, pool, opts = {}) {
  const jwtSecret = opts.jwtSecret;
  const path = opts.path || '/authority';
  const tickMs = opts.tickMs || 50;
  const flushMs = opts.flushMs || 30000;
  const creatureBroadcastEvery = opts.creatureBroadcastEvery || 4; // 4 ticks @50ms = ~5Hz
  const creatureFlushMs = opts.creatureFlushMs || 3000;
  const heartbeatMs = opts.heartbeatMs || 30000;

  const wss = new WebSocketServer({ noServer: true });
  const worlds = new Map(); // world_id -> { world, row, sockets: Map<userId, ws> }
  const loading = new Map(); // world_id -> in-flight loadWorld promise (cold-start dedupe)

  httpServer.on('upgrade', (req, socket, head) => {
    let userId;
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== path) { socket.destroy(); return; }
      const token = u.searchParams.get('token');
      const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
      userId = String(payload.user_id);
    } catch {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = userId;
      ws.worldId = null;
      wss.emit('connection', ws, req);
    });
  });

  async function loadWorld(worldId) {
    const existing = worlds.get(worldId);
    if (existing) return existing;

    let pending = loading.get(worldId);
    if (!pending) {
      pending = (async () => {
        const wr = await pool.query('SELECT id, seed, chunk_size FROM worlds WHERE id = $1', [worldId]);
        if (wr.rows.length === 0) return null;
        const row = wr.rows[0];
        const tr = await pool.query('SELECT name, walkable, speed FROM tile_types ORDER BY id ASC');
        const tileTypes = {};
        for (const t of tr.rows) tileTypes[t.name] = { walkable: t.walkable, speed: t.speed };
        const cr = await pool.query('SELECT name, color, hp FROM entity_types WHERE is_creature = true ORDER BY id ASC');
        const creatureTypes = cr.rows.map((r) => ({ name: r.name, hp: r.hp, color: r.color }));
        const weaponsById = await loadWeaponTypes(pool);
        const defaultWeaponId = resolveDefaultWeaponId(weaponsById);
        const map = new ServerMap({ seed: Number(row.seed), chunkSize: row.chunk_size, tileTypes });
        const entry = {
          worldId, world: new World(map, weaponsById, defaultWeaponId), row, sockets: new Map(),
          tileTypes, creatureTypes,
          activeChunks: new Set(),   // chunk keys currently in the union of player neighborhoods
          chunkLoads: new Set(),     // in-flight activation guard per chunk key
          loadedChunks: new Set(),   // chunk keys whose creatures have been successfully loaded
        };
        worlds.set(worldId, entry);
        return entry;
      })();
      loading.set(worldId, pending);
    }

    try {
      return await pending;
    } finally {
      loading.delete(worldId);
    }
  }

  async function loadSpawn(worldId, userId, chunkSize) {
    const r = await pool.query(
      'SELECT x, y FROM world_players WHERE world_id = $1 AND user_id = $2',
      [worldId, userId]
    );
    if (r.rows.length) return { x: r.rows[0].x, y: r.rows[0].y };
    const center = (chunkSize * MAP_TILE_SIZE) / 2;
    return { x: center, y: center };
  }

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  async function persist(worldId, userId, p) {
    await pool.query(
      `INSERT INTO world_players (world_id, user_id, x, y, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (world_id, user_id) DO UPDATE SET x = $3, y = $4, updated_at = now()`,
      [worldId, userId, p.x, p.y]
    );
  }

  // Materialize + spawn (once) + load a chunk's creatures into the sim.
  async function activateChunk(entry, chunkKey) {
    if (entry.chunkLoads.has(chunkKey)) return;
    entry.chunkLoads.add(chunkKey);
    try {
      const { cx, cy } = parseKey(chunkKey);
      const N = entry.row.chunk_size;
      const grid = entry.world.map.getChunk(cx, cy); // deterministic terrain
      const ins = await pool.query(
        `INSERT INTO world_chunks (world_id, cx, cy, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (world_id, cx, cy) DO NOTHING RETURNING id`,
        [entry.worldId, cx, cy, JSON.stringify(grid)],
      );
      if (ins.rowCount > 0 && entry.creatureTypes.length) {
        const spawned = spawnChunkCreatures(
          { seed: Number(entry.row.seed), chunkSize: N, tileTypes: entry.tileTypes },
          cx, cy, entry.creatureTypes,
        );
        for (const c of spawned) {
          await pool.query(
            `INSERT INTO world_creatures (world_id, type, x, y, hp, facing) VALUES ($1,$2,$3,$4,$5,$6)`,
            [entry.worldId, c.type, c.x, c.y, c.hp, c.facing],
          );
        }
      }
      const span = N * 100;
      const rows = await pool.query(
        `SELECT wc.id, wc.type, wc.x, wc.y, wc.hp, wc.facing, et.color
         FROM world_creatures wc LEFT JOIN entity_types et ON et.name = wc.type
         WHERE wc.world_id = $1 AND wc.x >= $2 AND wc.x < $3 AND wc.y >= $4 AND wc.y < $5`,
        [entry.worldId, cx * span, cx * span + span, cy * span, cy * span + span],
      );
      entry.world.creatures.addCreatures(rows.rows);
      entry.loadedChunks.add(chunkKey);
    } catch {
      // best-effort: left out of loadedChunks so recomputeActive retries it
    } finally {
      entry.chunkLoads.delete(chunkKey);
    }
  }

  // Recompute the active chunk set from player positions; activate newly-entered
  // chunks. Removal is handled by flushAndPrune (confirm-before-drop).
  function recomputeActive(entry) {
    const N = entry.row.chunk_size;
    const want = new Set();
    for (const p of entry.world.players.values()) {
      const { cx, cy } = chunkOf(p.x, p.y, N);
      for (const k of neighborhoodKeys(cx, cy, 1)) want.add(k);
    }
    entry.activeChunks = want;
    // Activate any desired chunk not yet loaded (retries failures, since
    // loadedChunks is only set on success). The chunkLoads in-flight guard
    // inside activateChunk prevents duplicate concurrent loads.
    for (const k of want) {
      if (!entry.loadedChunks.has(k)) activateChunk(entry, k);
    }
    // Forget chunks no longer desired so a later re-entry reloads them (their
    // creatures are dropped by flushAndPrune's pruneInactive).
    for (const k of entry.loadedChunks) {
      if (!want.has(k)) entry.loadedChunks.delete(k);
    }
  }

  function broadcastCreatures(entry) {
    const N = entry.row.chunk_size;
    for (const [userId, ws] of entry.sockets) {
      const p = entry.world.getPlayer(userId);
      if (!p) continue;
      const { cx, cy } = chunkOf(p.x, p.y, N);
      const keys = neighborhoodKeys(cx, cy, 1);
      send(ws, { type: 'creatures', creatures: entry.world.creatures.snapshotForNeighborhood(keys) });
    }
  }

  async function flushAndPrune(entry) {
    const dirty = entry.world.creatures.getDirty();
    if (dirty.length) {
      const ok = [];
      for (const c of dirty) {
        try {
          await pool.query(
            `UPDATE world_creatures SET x=$1, y=$2, facing=$3, updated_at=now() WHERE id=$4`,
            [c.x, c.y, c.facing, c.id],
          );
          ok.push(c.id);
        } catch { /* keep dirty → retried */ }
      }
      entry.world.creatures.clearDirty(ok);
    }
    entry.world.creatures.pruneInactive(entry.activeChunks);
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Swallow socket-level errors (e.g. a malformed inbound frame) so they
    // don't surface as an uncaught 'error' event that crashes the process.
    ws.on('error', () => {});

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'join') {
        const entry = await loadWorld(msg.world_id).catch(() => null);
        if (!entry) { send(ws, { type: 'error', message: 'unknown world' }); return; }
        const spawn = await loadSpawn(msg.world_id, ws.userId, entry.row.chunk_size);
        ws.worldId = msg.world_id;
        entry.world.addPlayer(ws.userId, spawn);
        entry.sockets.set(ws.userId, ws);
        send(ws, {
          type: 'joined', user_id: ws.userId, spawn, tickRate: 1000 / tickMs,
          weapons: [...entry.world.weapons.values()].map((w) => ({ id: w.id, name: w.name, kind: w.kind, element: w.element })),
        });
        return;
      }

      if (msg.type === 'input') {
        const entry = worlds.get(ws.worldId);
        if (entry) entry.world.setInput(ws.userId, msg.seq, finiteOr(msg.dx, 0), finiteOr(msg.dy, 0));
        return;
      }

      if (msg.type === 'attack') {
        const entry = worlds.get(ws.worldId);
        if (entry) {
          const { killedCreatureIds } = entry.world.attack(ws.userId, finiteOr(msg.ax, 0), finiteOr(msg.ay, 0));
          for (const id of new Set(killedCreatureIds)) {
            pool.query('DELETE FROM world_creatures WHERE id = $1', [id]).catch(() => {});
          }
        }
        return;
      }

      if (msg.type === 'equip') {
        const entry = worlds.get(ws.worldId);
        if (entry) entry.world.setWeapon(ws.userId, msg.weaponId);
        return;
      }

      if (msg.type === 'ping') { send(ws, { type: 'pong' }); return; }
    });

    ws.on('close', async () => {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      const p = entry.world.getPlayer(ws.userId);
      if (p) { try { await persist(ws.worldId, ws.userId, p); } catch { /* best-effort */ } }
      entry.world.removePlayer(ws.userId);
      entry.sockets.delete(ws.userId);
      if (entry.world.isEmpty()) {
        await flushAndPrune(entry).catch(() => {});
        worlds.delete(ws.worldId);
      }
    });
  });

  let tick = 0;
  const tickTimer = setInterval(() => {
    tick++;
    const dt = tickMs / 1000;
    for (const entry of worlds.values()) {
      if (entry.world.isEmpty()) continue;
      entry.world.tick(dt);
      entry.world.tickCreatures(dt, entry.activeChunks); // aggro/chase/contact damage + respawns (before state)
      const killedByProjectiles = entry.world.tickProjectiles(dt);
      for (const id of new Set(killedByProjectiles)) {
        pool.query('DELETE FROM world_creatures WHERE id = $1', [id]).catch(() => {});
      }
      entry.world.resolveDeaths();
      const snap = entry.world.snapshot();
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        send(ws, { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players, projectiles: snap.projectiles });
      }
      if (tick % creatureBroadcastEvery === 0) {
        recomputeActive(entry);
        broadcastCreatures(entry);
      }
    }
  }, tickMs);

  const creatureFlushTimer = setInterval(() => {
    for (const entry of worlds.values()) {
      if (entry.world.isEmpty()) continue;
      flushAndPrune(entry).catch(() => {});
    }
  }, creatureFlushMs);

  const flushTimer = setInterval(() => {
    for (const [worldId, entry] of worlds) {
      for (const [userId] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        if (p) persist(worldId, userId, p).catch(() => {});
      }
    }
  }, flushMs);

  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);

  return {
    close() {
      clearInterval(tickTimer);
      clearInterval(flushTimer);
      clearInterval(creatureFlushTimer);
      clearInterval(heartbeatTimer);
      // Terminate any live client sockets before closing the server. wss.close()
      // alone only stops accepting new connections; open sockets would keep the
      // event loop alive (and hang a clean shutdown / test process).
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

module.exports = { attachAuthority };
