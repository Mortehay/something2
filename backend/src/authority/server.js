const { URL } = require('node:url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { ServerMap } = require('./collision');
const { World } = require('./world');

const MAP_TILE_SIZE = 100;

// Attach the authoritative WebSocket simulation to an existing http server.
// Returns { close() } so callers/tests can tear it down.
function attachAuthority(httpServer, pool, opts = {}) {
  const jwtSecret = opts.jwtSecret;
  const path = opts.path || '/authority';
  const tickMs = opts.tickMs || 50;
  const flushMs = opts.flushMs || 30000;

  const wss = new WebSocketServer({ noServer: true });
  const worlds = new Map(); // world_id -> { world, row, sockets: Map<userId, ws> }
  const loading = new Map(); // world_id -> in-flight loadWorld promise (cold-start dedupe)

  httpServer.on('upgrade', (req, socket, head) => {
    let userId;
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== path) { socket.destroy(); return; }
      const token = u.searchParams.get('token');
      const payload = jwt.verify(token, jwtSecret);
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
        const tr = await pool.query('SELECT name, walkable, speed FROM tile_types');
        const tileTypes = {};
        for (const t of tr.rows) tileTypes[t.name] = { walkable: t.walkable, speed: t.speed };
        const map = new ServerMap({ seed: Number(row.seed), chunkSize: row.chunk_size, tileTypes });
        const entry = { world: new World(map), row, sockets: new Map() };
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

  wss.on('connection', (ws) => {
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
        send(ws, { type: 'joined', user_id: ws.userId, spawn, tickRate: 1000 / tickMs });
        return;
      }

      if (msg.type === 'input') {
        const entry = worlds.get(ws.worldId);
        if (entry) entry.world.setInput(ws.userId, msg.seq, msg.dx, msg.dy);
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
      if (entry.world.isEmpty()) worlds.delete(ws.worldId);
    });
  });

  let tick = 0;
  const tickTimer = setInterval(() => {
    tick++;
    const dt = tickMs / 1000;
    for (const entry of worlds.values()) {
      if (entry.world.isEmpty()) continue;
      entry.world.tick(dt);
      const snap = entry.world.snapshot();
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        send(ws, { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players });
      }
    }
  }, tickMs);

  const flushTimer = setInterval(() => {
    for (const [worldId, entry] of worlds) {
      for (const [userId] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        if (p) persist(worldId, userId, p).catch(() => {});
      }
    }
  }, flushMs);

  return {
    close() {
      clearInterval(tickTimer);
      clearInterval(flushTimer);
      // Terminate any live client sockets before closing the server. wss.close()
      // alone only stops accepting new connections; open sockets would keep the
      // event loop alive (and hang a clean shutdown / test process).
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

module.exports = { attachAuthority };
