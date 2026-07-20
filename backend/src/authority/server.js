const { URL } = require('node:url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { ServerMap } = require('./collision');
const { World } = require('./world');
const { loadItemTypes, resolveDefaultWeaponId, loadInventory, grantStartingLoadout } = require('./items');
const { chunkOf, parseKey, neighborhoodKeys } = require('./coords');
const { loadCreatureTypes } = require('./creatures');
const { spawnChunkCreatures } = require('../services/mapService');
const { commitCreatureDeath, claimItem, dropItem, dropGraceActive } = require('./loot');
const { consumeAmmo, ammoCount } = require('./ammo');
const { PICKUP_RADIUS } = require('./groundItems');

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
  const groundItemTtlMs = opts.groundItemTtlMs || 600000; // 10 min
  const itemSweepMs = opts.itemSweepMs || 60000;
  const rng = opts.rng || Math.random;

  const wss = new WebSocketServer({ noServer: true });
  const worlds = new Map(); // world_id -> { world, row, sockets: Map<userId, ws> }
  const loading = new Map(); // world_id -> in-flight loadWorld promise (cold-start dedupe)
  const sessionsByUser = new Map(); // userId -> ws (exactly one live authority session per account)

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
        const { creatureTypes, creatureTypeIds } = await loadCreatureTypes(pool);
        const itemTypes = await loadItemTypes(pool);
        const defaultWeaponId = resolveDefaultWeaponId(itemTypes);
        const map = new ServerMap({ seed: Number(row.seed), chunkSize: row.chunk_size, tileTypes });
        const entry = {
          worldId, world: new World(map, itemTypes, defaultWeaponId, row.chunk_size), row, sockets: new Map(),
          tileTypes, creatureTypes, creatureTypeIds,
          activeChunks: new Set(),   // chunk keys currently in the union of player neighborhoods
          chunkLoads: new Set(),     // in-flight activation guard per chunk key
          loadedChunks: new Set(),   // chunk keys whose creatures have been successfully loaded
          claiming: new Set(),       // ground item ids with a claim in flight (avoids wasted queries)
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

  // Single fire-and-forget entry point for a killed creature id: named once
  // here so both kill sites (melee attack handler, projectile tick) share the
  // same options instead of repeating them. The tick loop must not await this
  // (it's on the hot path), so the .catch is mandatory — an unhandled
  // rejection here would kill the process.
  const onCreatureDeath = (entry, id) =>
    commitCreatureDeath(pool, entry, id, { rng, ttlMs: groundItemTtlMs })
      .catch((err) => console.error('death commit failed:', err));

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
        // et.defense/et.resistances feed CreatureSim's `mit`; dropping either
        // from this SELECT loads it as undefined and silently makes every
        // creature resistance inert.
        `SELECT wc.id, wc.type, wc.x, wc.y, wc.hp, wc.facing, et.color, et.defense, et.resistances
         FROM world_creatures wc LEFT JOIN entity_types et ON et.name = wc.type
         WHERE wc.world_id = $1 AND wc.x >= $2 AND wc.x < $3 AND wc.y >= $4 AND wc.y < $5`,
        [entry.worldId, cx * span, cx * span + span, cy * span, cy * span + span],
      );
      entry.world.creatures.addCreatures(rows.rows);
      const itemRows = await pool.query(
        `SELECT id, item_type_id, x, y, expires_at FROM world_items
         WHERE world_id = $1 AND x >= $2 AND x < $3 AND y >= $4 AND y < $5 AND expires_at > now()`,
        [entry.worldId, cx * span, cx * span + span, cy * span, cy * span + span],
      );
      entry.world.groundItems.add(itemRows.rows);
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
      // world.now, not Date.now(): the creature snapshot's effect keys are
      // decided against the same clock that applied and ticks those effects.
      send(ws, { type: 'creatures', creatures: entry.world.creatures.snapshotForNeighborhood(keys, entry.world.now) });
    }
  }

  function broadcastItems(entry) {
    const N = entry.row.chunk_size;
    for (const [userId, ws] of entry.sockets) {
      const p = entry.world.getPlayer(userId);
      if (!p) continue;
      const { cx, cy } = chunkOf(p.x, p.y, N);
      const keys = neighborhoodKeys(cx, cy, 1);
      send(ws, { type: 'items', items: entry.world.groundItems.snapshotForNeighborhood(keys) });
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
    entry.world.groundItems.pruneInactive(entry.activeChunks);
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
        // A second join on an already-joined socket bypasses the "newest
        // session wins" kick (prev === ws skips it) and re-runs addPlayer,
        // which resets hp/mana to max and teleports to spawn — a free full
        // heal/exploit now that combat is real. One join per socket; a
        // client that wants a different world must reconnect.
        if (ws.worldId != null) { send(ws, { type: 'error', message: 'already joined' }); return; }

        const entry = await loadWorld(msg.world_id).catch(() => null);
        if (!entry) { send(ws, { type: 'error', message: 'unknown world' }); return; }

        try {
          const spawn = await loadSpawn(msg.world_id, ws.userId, entry.row.chunk_size);
          if (ws.readyState !== ws.OPEN) return; // client vanished while we awaited spawn

          // One live session per account: the newest join wins. (Refusing instead
          // would lock a user out for up to a full heartbeat cycle after a crash,
          // since the dead-socket reaper needs one interval to notice.)
          const prev = sessionsByUser.get(ws.userId);
          if (prev && prev !== ws) {
            try { send(prev, { type: 'kicked', reason: 'signed_in_elsewhere' }); } catch { /* best-effort */ }
            prev.terminate();
          }
          sessionsByUser.set(ws.userId, ws);
          // Reserve socket ownership synchronously too (mirrors sessionsByUser
          // above), before the inventory awaits below hit the DB. Otherwise a
          // kicked socket's 'close' can fire during that window and find
          // entry.sockets still pointing at the OLD socket (nothing reassigned
          // it yet), so its identity guard passes and it tears down the world
          // entry the new session is about to join. The tick loop and
          // broadcastCreatures already tolerate a registered socket with no
          // player yet (they null-check getPlayer), so this is safe.
          entry.sockets.set(ws.userId, ws);

          let inv = await loadInventory(pool, ws.userId);
          if (inv.items.length === 0) {
            const granted = await grantStartingLoadout(pool, ws.userId, entry.world.weapons);
            if (granted) inv = await loadInventory(pool, ws.userId);
          }

          // A newer session for this same account may have won (and kicked
          // us) while we awaited inventory above. If so, our reservation was
          // already overwritten — mutating world state now would clobber the
          // newer session's already-added player with our stale snapshot,
          // leaving it soft-locked (entry.sockets now points at us, so it
          // stops receiving 'state') with no way to recover: its own later
          // close() checks identity against entry.sockets, finds us there
          // instead of itself, and no-ops instead of cleaning up — an
          // unremovable ghost player. Bail instead of mutating shared state.
          if (sessionsByUser.get(ws.userId) !== ws || entry.sockets.get(ws.userId) !== ws || ws.readyState !== ws.OPEN) {
            if (entry.sockets.get(ws.userId) === ws) entry.sockets.delete(ws.userId);
            return;
          }

          ws.worldId = msg.world_id;
          entry.world.addPlayer(ws.userId, spawn, inv);
          send(ws, {
            type: 'joined', user_id: ws.userId, spawn, tickRate: 1000 / tickMs,
            itemTypes: [...entry.world.weapons.values()],
            items: inv.items,
            equipment: inv.equipment,
            // Server-authoritative: addPlayer always resets this to false, but
            // read it back off the player rather than hardcoding — the wire
            // value must always reflect whatever World actually holds, not an
            // assumption about what addPlayer currently does.
            autoLoot: entry.world.getPlayer(ws.userId).autoLoot,
          });
        } catch (err) {
          console.error('join failed:', err);
          if (entry.sockets.get(ws.userId) === ws) entry.sockets.delete(ws.userId);
          if (sessionsByUser.get(ws.userId) === ws) sessionsByUser.delete(ws.userId);
          send(ws, { type: 'error', message: 'join failed' });
        }
        return;
      }

      if (msg.type === 'input') {
        const entry = worlds.get(ws.worldId);
        if (entry) entry.world.setInput(ws.userId, msg.seq, finiteOr(msg.dx, 0), finiteOr(msg.dy, 0));
        return;
      }

      if (msg.type === 'attack') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        const ax = finiteOr(msg.ax, 0), ay = finiteOr(msg.ay, 0);

        // Cheap synchronous reject: cooldown / mana / stamina. Nothing has
        // been spent, and a refused attack must not consume the cooldown.
        const gate = entry.world.canAttack(ws.userId);
        if (!gate.ok) return;

        // Ammo-free weapons (all melee, all staves, darts) keep the fully
        // synchronous path: no DB round trip on the hot path.
        if (gate.weapon.ammo_type_id == null) {
          const { killedCreatureIds } = entry.world.attack(ws.userId, ax, ay);
          for (const id of new Set(killedCreatureIds)) onCreatureDeath(entry, id);
          return;
        }

        // Ammo is spent LAST, after every other gate has passed, so a refused
        // attack can never destroy a unit. Serialized on the op chain for the
        // same reason as equip/pickup/drop, and with the same try/catch: an
        // unhandled rejection out of this async handler kills the process.
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            // Everything is re-read INSIDE the chain. The `entry`/`gate`
            // captured above were computed when the frame was parsed, which
            // can be arbitrarily long before this callback runs — and the
            // stale gate is exactly the bug that loses arrows. Two attack
            // frames in one socket read are both parsed (and both gated)
            // before either chained callback runs, so both would see
            // _attackCd === 0; the second would then consume a unit and hand
            // it to an attack() that refuses for the cooldown the first one
            // just started. Re-gating here keeps canAttack → consume →
            // attack a true sequence under every interleaving. The world
            // entry can also have been swapped/evicted (rejoin, world
            // teardown) across the await, so re-read that too.
            const cur = worlds.get(ws.worldId);
            if (!cur) return;
            const g = cur.world.canAttack(ws.userId);
            if (!g.ok) return; // nothing spent
            // The equipped weapon may have changed too (an equip frame can be
            // chained between the two): always spend the CURRENT weapon's
            // ammo, and fall back to the sync path if it now needs none.
            const ammoTypeId = g.weapon.ammo_type_id;
            if (ammoTypeId != null && !(await consumeAmmo(pool, ws.userId, ammoTypeId))) {
              // The type id is carried so the client can zero ITS displayed
              // count for exactly this ammo type. Without it the HUD keeps
              // rendering whatever it last believed while the server refuses
              // every shot, and the client would have to guess which type was
              // refused from its own equipment state — which can already have
              // moved on. A refusal is the server stating there is none of
              // this type left; say which type.
              send(ws, { type: 'noammo', item_type_id: ammoTypeId }); // no cooldown consumed
              return;
            }
            const { killedCreatureIds } = cur.world.attack(ws.userId, ax, ay);
            for (const id of new Set(killedCreatureIds)) onCreatureDeath(cur, id);
            // The shot is already committed above (ammo spent, kills
            // resolved) — pushing the client its new count is best-effort on
            // top of that, not a condition of it. Isolated in its own
            // try/catch so a failed COUNT query can never look like a failed
            // attack, and placed after attack()/onCreatureDeath so it cannot
            // delay or skip the resolution that already succeeded.
            if (ammoTypeId != null) {
              try {
                const count = await ammoCount(pool, ws.userId, ammoTypeId);
                send(ws, { type: 'ammo', item_type_id: ammoTypeId, count });
              } catch (err) {
                console.error('ammoCount failed:', err);
              }
            }
          } catch (err) {
            console.error('attack/ammo failed:', err);
          }
        });
        return;
      }

      if (msg.type === 'equip' || msg.type === 'unequip') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        // Serialize per-socket mutations on the ws itself: without this, two
        // equip/unequip frames sent back-to-back start concurrently, and the
        // second's canEquip() check reads an inventory snapshot the first is
        // still in the middle of writing (e.g. both see main_hand empty and
        // both INSERT the same one-handed weapon instance), so the second
        // write violates player_equipment_item_unique. pool.query then
        // rejects; with no catch that propagated out of this async handler
        // as an unhandled rejection and crashed the whole process (Node
        // exits by default on unhandledRejection).
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            const r = msg.type === 'equip'
              ? await entry.world.setEquipment(pool, ws.userId, msg.itemId, msg.slot)
              : await entry.world.clearEquipment(pool, ws.userId, msg.slot);
            if (r && !r.ok) send(ws, { type: 'error', message: r.reason || `cannot ${msg.type}` });
          } catch (err) {
            console.error(`${msg.type} failed:`, err);
            send(ws, { type: 'error', message: `${msg.type} failed` });
          }
        });
        return;
      }

      if (msg.type === 'pickup') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        // Same per-socket serialisation and try/catch as equip: an unhandled
        // rejection in an async ws handler kills the process on Node 20.
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            const p = entry.world.getPlayer(ws.userId);
            if (!p) return;
            const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
            const target = entry.world.groundItems.nearest(cx, cy, PICKUP_RADIUS);
            if (!target) return; // nothing in range: silent no-op, not an error
            const got = await claimItem(pool, entry, ws.userId, target.id);
            if (got) send(ws, { type: 'picked', item: got });
          } catch (err) {
            console.error('pickup failed:', err);
          }
        });
        return;
      }

      if (msg.type === 'autoloot') {
        const entry = worlds.get(ws.worldId);
        // Strict boolean — a truthy string from the wire must not enable it.
        if (entry) entry.world.setAutoLoot(ws.userId, msg.on === true);
        return;
      }

      if (msg.type === 'drop') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        if (typeof msg.itemId !== 'string') return; // wire hygiene: ids are strings
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            const r = await dropItem(pool, entry, ws.userId, msg.itemId, { ttlMs: groundItemTtlMs });
            if (r.ok) send(ws, { type: 'dropped', itemId: msg.itemId });
            else send(ws, { type: 'error', message: r.reason });
          } catch (err) {
            console.error('drop failed:', err);
            send(ws, { type: 'error', message: 'drop failed' });
          }
        });
        return;
      }

      if (msg.type === 'ping') { send(ws, { type: 'pong' }); return; }
    });

    ws.on('close', async () => {
      // Identity-checked: a kicked socket's late close must not evict the
      // new session's registry entry (it already overwrote this key).
      if (sessionsByUser.get(ws.userId) === ws) sessionsByUser.delete(ws.userId);
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      // Identity-checked, same reason: if a newer session for this account
      // already re-registered in this world (entry.sockets/world.players are
      // keyed by userId only), this stale close must not tear down its
      // player/world state.
      if (entry.sockets.get(ws.userId) !== ws) return;
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
      // Status effects tick inside world.tick. A creature killed by a burn
      // tick is reported here and goes through the SAME death commit as a
      // melee or projectile kill — burn must not become a fourth way to die
      // that skips loot or deletes twice.
      const { killedCreatureIds: killedByEffects } = entry.world.tick(dt);
      for (const id of new Set(killedByEffects)) onCreatureDeath(entry, id);
      entry.world.tickCreatures(dt, entry.activeChunks); // aggro/chase/contact damage + respawns (before state)
      const { killedCreatureIds: killedByProjectiles, detonations } = entry.world.tickProjectiles(dt);
      for (const id of new Set(killedByProjectiles)) onCreatureDeath(entry, id);
      // Stashed for this tick's broadcast (below). REPLACED, not appended, so
      // an unconsumed stash can never grow without bound.
      entry.pendingDetonations = detonations;
      entry.world.resolveDeaths();
      // Auto-loot: fire claims off-tick. The tick is synchronous and must never
      // await; `claiming` de-dups the repeats this produces across ticks while
      // a claim is still in flight.
      const autoLootNow = Date.now();
      for (const p of entry.world.players.values()) {
        if (!p.autoLoot) continue;
        const pcx = p.x + p.width / 2, pcy = p.y + p.height / 2;
        const claims = [];
        for (const it of entry.world.groundItems.within(pcx, pcy, PICKUP_RADIUS)) {
          // A player's own just-dropped item sits in their own grace window:
          // skip it so auto-loot doesn't instantly re-vacuum a drop. Manual
          // pickup (the 'pickup' handler above) never consults this — a
          // deliberate keypress always succeeds.
          if (dropGraceActive(p, it.id, autoLootNow)) continue;
          claims.push(claimItem(pool, entry, p.userId, it.id));
        }
        if (claims.length === 0) continue;
        // Settled once per PLAYER, not per item: the socket is looked up
        // after every claim for this player has resolved, inside the .then —
        // never captured before the claim round trip starts. Captured early
        // (the old bug), a reconnect mid-claim sends 'picked' to the dead
        // socket and the new session never sees the item. allSettled (not
        // all) so one failed claim can't swallow the notification for the
        // player's other, successful claims in the same tick.
        Promise.allSettled(claims).then((results) => {
          const sock = entry.sockets.get(p.userId);
          if (!sock) return;
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) send(sock, { type: 'picked', item: r.value });
            else if (r.status === 'rejected') console.error('auto-loot failed:', r.reason);
          }
        }).catch((err) => console.error('auto-loot notify failed:', err));
      }
      const snap = entry.world.snapshot();
      // Detonations are per-tick and the stash is REPLACED each tick, so they
      // must ride out on THIS tick's broadcast or they are lost. Omitted from
      // the frame entirely when empty (the common case) to keep it small.
      const dets = entry.pendingDetonations;
      // Cleared immediately after the read, not after the broadcast loop: if
      // send() throws partway through, the stash must not survive to be
      // re-broadcast (as stale, already-shown blasts) on the next tick.
      entry.pendingDetonations = null;
      const hasDets = Array.isArray(dets) && dets.length > 0;
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        const frame = { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players, projectiles: snap.projectiles };
        if (hasDets) frame.detonations = dets;
        send(ws, frame);
      }
      if (tick % creatureBroadcastEvery === 0) {
        recomputeActive(entry);
        broadcastCreatures(entry);
        broadcastItems(entry);
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

  // Named (rather than inlined into setInterval) so it can also be exposed as
  // `_heartbeatSweep` below: a test seam that lets tests drive the reaper by
  // explicit call instead of racing wall-clock heartbeatMs, the same way
  // other modules take `now` as a parameter instead of reading the clock.
  function heartbeatSweep() {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
  const heartbeatTimer = setInterval(heartbeatSweep, heartbeatMs);

  // Expired ground items: delete from the DB and evict from every live sim.
  // Also run each sim's own removeExpired so in-sim expiry doesn't lag the DB
  // sweep by up to itemSweepMs; the two are complementary (DB delete is
  // authoritative across worlds, removeExpired just keeps each sim tidy).
  const itemSweepTimer = setInterval(() => {
    if (worlds.size === 0) return;
    const now = Date.now();
    for (const entry of worlds.values()) entry.world.groundItems.removeExpired(now);
    pool.query('DELETE FROM world_items WHERE expires_at <= now() RETURNING id')
      .then((r) => {
        if (!r.rowCount) return;
        const ids = new Set(r.rows.map((row) => row.id));
        for (const entry of worlds.values()) {
          for (const id of ids) entry.world.groundItems.remove(id);
        }
      })
      .catch((err) => console.error('ground item sweep failed:', err));
  }, itemSweepMs);

  return {
    // Live world registry (worldId -> { world, sockets, row }). Exposed for
    // introspection/tests that need to assert on authoritative state the wire
    // does not carry (e.g. a player's attack cooldown). Read-only by
    // convention — the server owns every mutation.
    worlds,
    // Test seam: run one reaper sweep synchronously instead of waiting for
    // the real heartbeatTimer to fire. Boot with a very large heartbeatMs so
    // the automatic interval never fires during the test, then call this to
    // advance the reaper deterministically. The actual ping/pong round trip
    // still crosses a real socket and event loop turn — that part cannot be
    // faked without mocking the transport — so tests should await the real
    // 'pong' event (observable via `worlds.get(id).sockets`) between calls
    // rather than sleeping a guessed duration.
    _heartbeatSweep: heartbeatSweep,
    close() {
      clearInterval(tickTimer);
      clearInterval(flushTimer);
      clearInterval(creatureFlushTimer);
      clearInterval(heartbeatTimer);
      clearInterval(itemSweepTimer);
      // Terminate any live client sockets before closing the server. wss.close()
      // alone only stops accepting new connections; open sockets would keep the
      // event loop alive (and hang a clean shutdown / test process).
      for (const client of wss.clients) client.terminate();
      wss.close();
      sessionsByUser.clear();
    },
  };
}

module.exports = { attachAuthority };
