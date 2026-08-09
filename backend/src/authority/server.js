const { URL } = require('node:url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { currentUserForToken } = require('../auth/tokens.js');
const { ServerMap } = require('./collision');
const { World } = require('./world');
const { loadItemTypes, resolveDefaultWeaponId, resolveGoldItemTypeId, loadInventory, grantStartingLoadout } = require('./items');
const { loadProgression, applyDeath } = require('../services/progressionStore.js');
const { derivePlayerStats } = require('../services/playerStats.js');
const { chunkOf, parseKey, neighborhoodKeys, CHUNK_KEY } = require('./coords');
const { loadCreatureTypes, ABILITIES_LATERAL } = require('./creatures');
const { chooseSpawn, edgeOfDoorwayTile, oppositeEdge, arrivalPoint, villageContaining } = require('../services/mapService');
const { fetchLinks } = require('../services/mapLinks');
const { fetchVillages } = require('../services/villages');
const {
  fetchChests, spawnFieldChest, nearestChest, respawnDueFieldChests,
} = require('../services/chests.js');
const { openChest } = require('./chestLoot.js');
const { clearOverviewCache } = require('../services/overviewCache.js');
const { fetchShop } = require('../services/merchantStock');
const { loadDecorationDefs } = require('../services/decorationDefs');
const { loadBiomes } = require('../services/biomes');
const { buildWorldGenConfig } = require('../services/worldGenConfig');
const { commitCreatureDeath, claimItem, claimGold, dropItem, dropGraceActive } = require('./loot');
const { knockbackPosition } = require('./knockback');
const { buyStock, sellItem } = require('./trade');
const { consumeAmmo, ammoCount } = require('./ammo');
const { PICKUP_RADIUS } = require('./groundItems');

const MAP_TILE_SIZE = 100;

// Coerce a wire-provided number to a finite value (clients can send NaN/Infinity
// via JSON, e.g. 1e999 parses to Infinity).
function finiteOr(v, fallback) { return Number.isFinite(v) ? v : fallback; }

// Decoration defs feed ServerMap's blocking-decoration overlay (collision.js)
// via the same generateChunkDecorations the /chunk endpoint uses, so server
// collision and client-visible decorations stay in lockstep. Loader lives in
// services/decorationDefs.js and is shared with index.js's /chunk handler --
// see that file for why the ORDER BY matters.

// Pure: given a player's current tile + this world's links, decide whether to
// teleport. Returns { toWorldId, arriveX, arriveY } or null.
function planTransition({ tileName, gRow, gCol, worldRow, links, now, cdUntil }) {
  if (tileName !== 'map_doorway') return null;
  if (now < cdUntil) return null;
  const edge = edgeOfDoorwayTile(gRow, gCol, worldRow.width, worldRow.height);
  if (!edge) return null;
  const link = links.get(edge);
  if (!link) return null;
  const { x, y } = arrivalPoint(link.toWidth, link.toHeight, oppositeEdge(edge));
  return { toWorldId: link.toWorldId, arriveX: x, arriveY: y };
}

// Pure: given a player's current tile + this world's villages, decide whether
// to (re)bind them to a village. Returns the village to bind to, or null when
// already bound to the village covering this point or when outside every
// village.
function planBind({ villages, gRow, gCol, boundVillageId }) {
  const v = villageContaining(gRow, gCol, villages);
  if (!v) return null;
  if (v.id === boundVillageId) return null;
  return v;
}

// Pure: does any LIVE creature reference this exact portal link? A pack
// blocks until its last member dies -- there is no separate "pack cleared"
// flag, it falls straight out of this scan every time it is asked.
function isPortalBlocked(creatures, linkId) {
  for (const c of creatures) {
    if (c.blocksPortalId === linkId && c.hp > 0) return true;
  }
  return false;
}

// Pure: given a player's current tile + this world's portal links, decide
// whether to teleport, block, or do nothing. Mirrors planTransition's
// shape and cooldown convention but keys off tile-coordinate equality
// (portalLinks is keyed "gRow,gCol") rather than edge-doorway membership --
// a portal has no compass edge, it is a specific interior point.
//
// Two extra gates beyond "is a live guard blocking this link", both added
// after review caught live races the original guard-only check missed:
//
// - `lastPortalTile`: a mirrored portal pair's arrival tile IS the return
//   portal's own trigger tile (setPortalLink writes the mirror's from_x/
//   from_y as the forward row's to_x/to_y, by construction). Without this,
//   a player arriving on an unguarded mirrored portal bounces straight back
//   the instant the tick loop next runs -- there is no time window to do
//   anything. This is a latch, not a timer: it suppresses the portal ONLY
//   while the player's current tile still equals the tile they arrived on,
//   and the caller re-arms it (clears it) the moment their tile changes --
//   so it blocks forever if they stand still, and never blocks again once
//   they've actually walked off, however long that takes.
// - `loadedChunks`/`chunkSize`/`playerX`/`playerY`: a creature's chunk loads
//   asynchronously (activateChunk), so `creatures` can be an INCOMPLETE
//   snapshot for a chunk that hasn't finished loading yet -- a guard that
//   is very much alive in the DB can be invisible to `isPortalBlocked` for
//   the first tick(s) after a player joins or reconnects next to a guarded
//   portal. Fail closed instead: require the player's own radius-1 chunk
//   neighborhood to be loaded before trusting the creature scan.
//
//   That neighborhood is anchored on the player's TOP-LEFT position
//   (`playerX`/`playerY`, i.e. raw `p.x`/`p.y`) via the SAME `chunkOf` call
//   `recomputeActive` uses to decide what to load -- not on `gRow`/`gCol`
//   (the player's CENTRE tile, also used to match the portal). Those two
//   anchors disagree by up to one whole chunk whenever the player happens
//   to stop near the low edge of a chunk-boundary tile (PLAYER_W/H is 64,
//   so centre-minus-half-width can floor into the chunk BELOW the one the
//   centre itself resolves to) -- an earlier version of this gate computed
//   the required neighborhood from the portal's own (i.e. the player's
//   CENTRE) tile instead, which could then demand a chunk recomputeActive's
//   top-left-anchored `want` set would NEVER include, leaving that portal
//   permanently blocked (confirmed by direct probe: a portal on a chunk's
//   first column/row, approached so the player's centre lands near the low
//   edge of its tile, needed chunks recomputeActive never requested -- see
//   task-8-report.md's third fix pass). Anchoring on the SAME variable
//   recomputeActive itself reads removes the mismatch by construction: this
//   player's own neighborhood is always a subset of whatever `want`
//   recomputeActive computes for them, so the requirement is guaranteed
//   satisfiable, just possibly not yet loaded (an ordinary, resolving race,
//   not a permanent one). It is also wide enough to always contain a guard
//   spread up to +/-60px by insertPortalGuards' RING_OFFSETS -- swept
//   exhaustively across every stop position in a boundary tile, in both
//   axes, confirming zero gaps.
function planPortalTransition({
  gRow, gCol, portalLinks, now, cdUntil, creatures, loadedChunks, chunkSize, lastPortalTile, playerX, playerY,
}) {
  if (now < cdUntil) return null;
  const key = `${gRow},${gCol}`;
  const link = portalLinks.get(key);
  if (!link) return null;
  if (lastPortalTile === key) return null; // just arrived here via a warp; inert until they leave the tile
  const { cx, cy } = chunkOf(playerX, playerY, chunkSize);
  const neighborhoodLoaded = neighborhoodKeys(cx, cy, 1).every((k) => loadedChunks.has(k));
  if (!neighborhoodLoaded) return { blocked: true, linkId: link.id };
  if (isPortalBlocked(creatures, link.id)) return { blocked: true, linkId: link.id };
  return { toWorldId: link.toWorldId, arriveX: link.toX, arriveY: link.toY };
}

const INTERACT_RADIUS = 120; // px: how close a player must stand to trade

// The village whose merchant is nearest to (cx,cy) within `radius`, or null.
// Villages without a merchant position are skipped.
function nearestMerchantVillage(villages, cx, cy, radius) {
  if (!villages || !villages.length) return null;
  let best = null, bd2 = radius * radius;
  for (const v of villages) {
    if (v.merchantX == null || v.merchantY == null) continue;
    const dx = v.merchantX - cx, dy = v.merchantY - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bd2) { bd2 = d2; best = v; }
  }
  return best;
}

// Guard-type allowlist for a field chest spawned via `use`ing a loot_map.
// Content decision (which creature types can guard a field chest) is out of
// scope for this task -- see the design spec; a single, always-present
// creature type keeps the wire behavior testable without depending on a
// content decision.
const ALLOWED_FIELD_CHEST_GUARDS = ['Wolf'];

// Cap on a single world's un-broadcast attack batch. Attacks arrive from the
// socket handler BETWEEN ticks, so unlike pendingDetonations (produced inside
// the tick and replaced wholesale) this stash must ACCUMULATE — replacing it
// would drop every swing but the last one in a tick interval. Accumulation has
// no natural bound, hence the cap; overflow drops the newest, since the oldest
// swings are the ones already on screen for other players.
const MAX_PENDING_ATTACKS = 64;

function pushAttacks(entry, attacks) {
  if (!Array.isArray(attacks) || attacks.length === 0) return;
  if (!entry.pendingAttacks) entry.pendingAttacks = [];
  for (const a of attacks) {
    if (entry.pendingAttacks.length >= MAX_PENDING_ATTACKS) return;
    entry.pendingAttacks.push(a);
  }
}

// Take this tick's batch and clear the stash in one step, so no caller can
// read it and forget to clear it.
function drainAttacks(entry) {
  const batch = entry.pendingAttacks;
  entry.pendingAttacks = null;
  return Array.isArray(batch) ? batch : [];
}

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

  // Every inbound frame this protocol defines is a small flat JSON object
  // (join/attack/equip/pickup/drop/interact/buy/sell/input/ping) — the
  // largest legitimate one (`equip`, carrying a uuid itemId + a slot name)
  // measures ~85 bytes. `ws` defaults maxPayload to 100 MiB with none set
  // (F-015 / SOMET-195): one authenticated socket could send repeated
  // ~100 MiB text frames, each buffered and JSON.parse'd, exhausting the
  // container heap and OOM-killing the whole process (every player + the
  // co-hosted HTTP API). 4096 bytes is ~48x the largest real frame —
  // generous enough that no legitimate client can ever brush it, tight
  // enough that an oversized frame is rejected (socket closed, code 1009)
  // before it is ever buffered.
  const MAX_INBOUND_FRAME_BYTES = opts.maxPayload || 4096;
  // Per-socket token bucket applied to EVERY inbound frame, before any
  // handler runs. This is the actual bound on the second attack vector F-015
  // describes: several handlers (attack-with-ammo, equip/unequip, pickup,
  // drop, interact, buy, sell) chain a DB round trip onto `ws._opChain` with
  // no depth limit, so a client streaming frames faster than the chain
  // drains grows an ever-deeper promise chain of retained closures while
  // monopolizing a pool connection. Sizing (confirmed against the live
  // client, WorldAuthorityClient.js): a well-behaved client's highest
  // steady-state rate is `input` at a fixed 20 Hz (client-throttled to a
  // 50ms interval, independent of frame rate); `attack` has NO client-side
  // throttle and is additionally gated only by the equipped weapon's
  // cooldown, which for a fast weapon can also approach ~20 Hz. Every other
  // type is one frame per discrete UI action (click/keypress) and is far
  // slower in practice. RATE_LIMIT_PER_SEC=40 is 2x the highest recorded
  // legitimate steady rate — comfortable headroom for input+attack running
  // together, plus incidental UI actions, with no observed play pattern
  // that approaches it. RATE_LIMIT_CAPACITY=60 is a burst allowance on top
  // of that for frames that land bunched by scheduling/network jitter. This
  // does not attempt to rate-limit a SPECIFIC message type (e.g. a stricter
  // cap on `interact` alone) — that would need real play data to size
  // without risking legitimate combat/movement, which this fix does not
  // have; a uniform, generous cap is the defensible bound given what is
  // known.
  const RATE_LIMIT_CAPACITY = opts.rateLimitCapacity || 60;
  const RATE_LIMIT_PER_SEC = opts.rateLimitPerSec || 40;

  // Refills `ws`'s bucket for elapsed time, then consumes one token if
  // available. Returns false (frame dropped, nothing else runs — no parse
  // work has happened yet beyond JSON.parse, no handler, no DB query) when
  // the bucket is empty.
  function consumeRateToken(ws, now = Date.now()) {
    if (ws._rateTokens === undefined) {
      ws._rateTokens = RATE_LIMIT_CAPACITY;
      ws._rateStamp = now;
    } else {
      const elapsedSec = Math.max(0, now - ws._rateStamp) / 1000;
      ws._rateTokens = Math.min(RATE_LIMIT_CAPACITY, ws._rateTokens + elapsedSec * RATE_LIMIT_PER_SEC);
      ws._rateStamp = now;
    }
    if (ws._rateTokens < 1) return false;
    ws._rateTokens -= 1;
    return true;
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_FRAME_BYTES });
  const worlds = new Map(); // world_id -> { world, row, sockets: Map<userId, ws> }
  const loading = new Map(); // world_id -> in-flight loadWorld promise (cold-start dedupe)
  const sessionsByUser = new Map(); // userId -> ws (exactly one live authority session per account)
  const pendingArrivals = new Map(); // userId -> { worldId, x, y } : a doorway-arrival spawn override

  httpServer.on('upgrade', (req, socket, head) => {
    // The whole handler is wrapped so an async rejection (a DB error from the
    // token_version lookup below) can never escape as an unhandled rejection —
    // Node exits by default on that, and this codebase has hit it before. Any
    // failure path destroys the socket instead.
    (async () => {
      let userId;
      let payload;
      try {
        const u = new URL(req.url, 'http://localhost');
        if (u.pathname !== path) { socket.destroy(); return; }
        const token = u.searchParams.get('token');
        payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
        userId = String(payload.user_id);
      } catch {
        socket.destroy();
        return;
      }

      // Signature-valid is not enough: reject a token whose tv is behind the
      // account's CURRENT token_version. This is what makes logout-all / bans
      // also kill a live game socket instead of only future HTTP requests.
      // currentUserForToken is the SAME check auth/middleware.js's HTTP guard
      // runs (F-021 / SOMET-201) — one indexed query per CONNECT (not per
      // tick), shared so the two transports cannot silently drift apart. A DB
      // error or a revoked/missing user must destroy the socket, never throw out.
      try {
        const user = await currentUserForToken(pool, payload);
        if (!user) { socket.destroy(); return; }
      } catch {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = userId;
        ws.worldId = null;
        wss.emit('connection', ws, req);
      });
    })().catch(() => { try { socket.destroy(); } catch { /* already gone */ } });
  });

  async function loadWorld(worldId) {
    const existing = worlds.get(worldId);
    if (existing) return existing;

    let pending = loading.get(worldId);
    if (!pending) {
      pending = (async () => {
        const wr = await pool.query('SELECT id, seed, chunk_size, width, height, is_entry, entry_spawn, biomes, biome_cell, level_min, level_max FROM worlds WHERE id = $1', [worldId]);
        if (wr.rows.length === 0) return null;
        const row = wr.rows[0];
        // Postgres uuid input is case-insensitive and also accepts braced /
        // hyphenless spellings, but `row.id` — what the SELECT actually
        // returns — is always the single canonical lowercase-hyphenated text
        // form, regardless of how the client spelled it. Key the in-memory
        // registry (and everything downstream: ws.worldId, persist(),
        // pendingArrivals, evictWorld) off THIS value, never the client's raw
        // string, or a client that spells the same world differently creates
        // a second, invisible shard of it (F-014 / SOMET-194): confirmed
        // live — two accounts joining the same world with different id
        // casing each got a `joined` reply but never saw each other in a
        // `state` frame, while a same-case control correctly saw both.
        const canonicalId = row.id;
        // Re-check under the canonical id: a concurrent load of a DIFFERENT
        // spelling of this same world may have already resolved and inserted
        // it while this one's SELECT was in flight.
        const already = worlds.get(canonicalId);
        if (already) return already;
        const tr = await pool.query('SELECT name, walkable, speed FROM tile_types ORDER BY id ASC');
        const tileTypes = {};
        for (const t of tr.rows) tileTypes[t.name] = { walkable: t.walkable, speed: t.speed };
        const {
          creatureTypes, creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
        } = await loadCreatureTypes(pool);
        const itemTypes = await loadItemTypes(pool);
        const defaultWeaponId = resolveDefaultWeaponId(itemTypes);
        const goldItemTypeId = resolveGoldItemTypeId(itemTypes);
        const linkRows = await fetchLinks(pool, canonicalId);
        const compassRows = linkRows.filter((l) => l.edge !== 'PORTAL');
        const portalRows = linkRows.filter((l) => l.edge === 'PORTAL');
        const links = new Map(compassRows.map((l) => [l.edge, { toWorldId: l.to_world_id, toWidth: l.to_width, toHeight: l.to_height }]));
        // Keyed by the portal's OWN tile, floored to grid cells -- matches how
        // planPortalTransition looks players up (gRow/gCol from Math.floor(y|x /
        // MAP_TILE_SIZE)), the same granularity planTransition already uses for
        // doorway tiles.
        const portalLinks = new Map(portalRows.map((l) => [
          `${Math.floor(l.from_y / MAP_TILE_SIZE)},${Math.floor(l.from_x / MAP_TILE_SIZE)}`,
          { id: l.id, toWorldId: l.to_world_id, toX: l.to_x, toY: l.to_y, fromX: l.from_x, fromY: l.from_y },
        ]));
        const villages = await fetchVillages(pool, canonicalId);
        const decorationDefs = await loadDecorationDefs(pool);
        const biomes = await loadBiomes(pool, row.biomes);
        const chests = await fetchChests(pool, canonicalId);
        // Cached once here, rather than rebuilt per spawnFieldChest call, so
        // the `use` handler can hand placeMapCreatures the exact same
        // tile-legality config the map itself was generated from. `row`
        // alone is NOT this shape: it's missing tileTypes/doorways/villages/
        // biomes entirely, and its level band is `level_min`/`level_max`
        // (snake_case, straight off the SQL SELECT) where placeMapCreatures
        // reads camelCase `levelMin`/`levelMax` off its `world` argument
        // directly (worldConfig() never derives these -- see
        // worldGenConfig.js's own comment on that exact silent-undefined
        // trap). Passing `row` as-is would throw ("worldConfig: tileTypes is
        // empty") before ever reaching a placement.
        const mapGenConfig = buildWorldGenConfig({
          row, tileTypes, doorways: [...links.keys()], villages, biomes,
        });
        const map = new ServerMap({ ...mapGenConfig, decorationDefs });
        const entry = {
          worldId: canonicalId, world: new World(map, itemTypes, defaultWeaponId, row.chunk_size), row, sockets: new Map(),
          tileTypes, creatureTypes, creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
          goldItemTypeId, links, portalLinks, villages, chests, mapGenConfig,
          activeChunks: new Set(),   // chunk keys currently in the union of player neighborhoods
          chunkLoads: new Set(),     // in-flight activation guard per chunk key
          loadedChunks: new Set(),   // chunk keys whose creatures have been successfully loaded
          claiming: new Set(),       // ground item ids with a claim in flight (avoids wasted queries)
        };
        worlds.set(canonicalId, entry);
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

  async function loadSpawn(worldId, userId, chunkSize, worldRow) {
    const pend = pendingArrivals.get(userId);
    const pending = (pend && pend.worldId === worldId) ? { x: pend.x, y: pend.y } : null;
    if (pending) pendingArrivals.delete(userId);
    let persisted = null;
    const r = await pool.query(
      'SELECT x, y FROM world_players WHERE world_id = $1 AND user_id = $2',
      [worldId, userId]
    );
    if (r.rows.length) persisted = { x: r.rows[0].x, y: r.rows[0].y };
    const spawn = chooseSpawn({ pending, persisted, worldRow, chunkSize });
    const b = await pool.query(
      'SELECT x, y FROM player_binds WHERE user_id = $1 AND world_id = $2',
      [userId, worldId],
    );
    spawn.respawn = b.rows.length ? { x: b.rows[0].x, y: b.rows[0].y } : { x: spawn.x, y: spawn.y };
    return spawn;
  }

  // Single fire-and-forget entry point for a killed creature: named once here
  // so every kill site (melee attack handler, burn tick, guard tick,
  // projectile tick) shares the same options instead of repeating them. The
  // tick loop must not await this (it's on the hot path), so the .catch is
  // mandatory — an unhandled rejection here would kill the process.
  // `killerUserId` is threaded straight through to commitCreatureDeath, which
  // returns `null` when the rowCount gate refused (already finalized
  // elsewhere) or `{ awarded, leveledUp, newLevel, progression, killerUserId
  // }` when it committed the death. This is where the DB-level XP award
  // becomes a LIVE consequence: without moving the session's pools here, a
  // level-up would raise max HP in the database and nothing in the running
  // game (the exact defect A1's review caught).
  const onCreatureDeath = (entry, id, killerUserId) =>
    commitCreatureDeath(pool, entry, id, { rng, ttlMs: groundItemTtlMs, killerUserId })
      .then((result) => {
        if (!result || result.killerUserId == null) return; // no commit, or no player to credit
        const { progression, leveledUp, newLevel, awarded } = result;
        if (leveledUp) {
          const p = entry.world.getPlayer(result.killerUserId);
          // Guard against reviving a player who is CURRENTLY sitting at
          // hp <= 0 awaiting the tick loop's resolveDeaths(). applyDerivedStats
          // clamps current hp to a floor of 1 unconditionally, so calling it
          // on a dying player would cancel their death.
          //
          // This is reachable, not hypothetical: world.attack()'s melee
          // branch deals PvP damage directly (no toggle gates it) from the
          // synchronous `attack` message handler, which never calls
          // resolveDeaths() itself — only the tick loop does, once per tick,
          // after every kill site for that tick has run. A player dropped to
          // <=0 hp by that PvP hit stays at <=0 hp until the NEXT tick's
          // resolveDeaths(), and this promise (an async DB round trip) can
          // resolve inside that window. Because JS never preempts a running
          // synchronous block, this callback can only ever run BETWEEN ticks
          // — never mid-tick — so a player killed by this tick's OWN
          // creature/projectile damage is already respawned (resolveDeaths
          // always finishes before the tick's synchronous body yields). The
          // PvP path is the one gap that check does not cover, hence this
          // guard rather than relying on tick timing alone.
          if (p && p.hp > 0) {
            entry.world.applyDerivedStats(result.killerUserId, derivePlayerStats(progression));
          }
        }
        // Best-effort: the killer's socket may be gone (disconnected between
        // the kill and this commit finishing) — entry.sockets.get returns
        // undefined and send() itself no-ops on a non-OPEN socket, so this
        // never throws either way.
        const sock = entry.sockets.get(result.killerUserId);
        if (sock) send(sock, { type: 'progression', progression, leveledUp, newLevel, awarded });
      })
      .catch((err) => console.error('death commit failed:', err));

  // Fire-and-forget entry point for a PLAYER death: resolveDeaths() (the
  // single player-death path, world.js) is synchronous and on the tick
  // path, so it cannot await the DB round trip itself. It returns the ids
  // it just resolved instead, and the tick loop calls this once per id,
  // following onCreatureDeath's exact shape (fire-and-forget + mandatory
  // .catch — an unhandled rejection here would kill the process).
  //
  // Once per death, not once per tick spent dead: resolveDeaths() only ever
  // returns an id on the call where it transitions that player from hp<=0 to
  // healed, because it heals to full hp in that SAME pass. The very next
  // tick's resolveDeaths() sees p.hp > 0 for that player and will not report
  // them again. That is the whole guarantee — it holds only because respawn
  // heals synchronously before this promise can even be scheduled; it is not
  // a lock or a de-dup set, so it would NOT survive resolveDeaths ever being
  // changed to not heal immediately.
  // `rng` is the same injectable draw the loot roll uses (opts.rng, defaulted
  // above), threaded through so the death penalty's 0.5%-10% roll can be
  // pinned in a test instead of leaving these assertions to chance.
  const onPlayerDeath = (entry, userId) => applyDeath(pool, userId, { rng })
    .then(({ progression, lost }) => {
      if (lost <= 0) return; // at the level floor: nothing changed, nothing to push
      // Best-effort: the player's socket may be gone (disconnected between
      // the death and this commit finishing) — entry.sockets.get returns
      // undefined and send() itself no-ops on a non-OPEN socket either way.
      const sock = entry.sockets.get(userId);
      if (sock) send(sock, { type: 'progression', progression, lost });
    })
    .catch((err) => console.error('death penalty commit failed:', err));

  // Every kill channel now reports { id, killerUserId } objects rather than
  // bare ids (Task 5), so the `new Set(...)` de-dup this file used everywhere
  // is WRONG as of this refactor: Set dedupes by object IDENTITY, and no two
  // kill objects are ever the same reference, so it would stop de-duping
  // anything and let the same creature id reach commitCreatureDeath twice in
  // one tick (e.g. a pierce-through projectile hit and an AoE detonation both
  // finishing the same creature). De-dup by `id` explicitly instead, keeping
  // the first killer credited for that id.
  function dedupeKillsById(kills) {
    const seen = new Map();
    for (const k of kills) if (!seen.has(k.id)) seen.set(k.id, k);
    return [...seen.values()];
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

  async function upsertBind(userId, worldId, x, y) {
    await pool.query(
      `INSERT INTO player_binds (user_id, world_id, x, y, updated_at)
         VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET world_id = $2, x = $3, y = $4, updated_at = now()`,
      [userId, worldId, x, y],
    );
  }

  // Materialize + load a chunk's creatures into the sim. Creature placement
  // itself no longer happens here (SOMET-246): bounded worlds have their
  // creatures written to world_creatures once, at world-creation/re-roll
  // time, by populateWorld -- this function only persists the chunk's
  // generated terrain and then loads whatever world_creatures rows already
  // fall inside it.
  async function activateChunk(entry, chunkKey) {
    if (entry.chunkLoads.has(chunkKey)) return;
    entry.chunkLoads.add(chunkKey);
    try {
      const { cx, cy } = parseKey(chunkKey);
      const N = entry.row.chunk_size;
      const grid = entry.world.map.getChunk(cx, cy); // deterministic terrain

      // BEGIN/COMMIT/ROLLBACK + client.release() kept deliberately (SOMET-246)
      // even though this now wraps a single INSERT: same pool.connect() shape
      // as trade.js, and collapsing it is out of scope for retiring the dead
      // per-chunk spawn path this transaction used to also gate.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO world_chunks (world_id, cx, cy, data) VALUES ($1, $2, $3, $4)
           ON CONFLICT (world_id, cx, cy) DO NOTHING RETURNING id`,
          [entry.worldId, cx, cy, JSON.stringify(grid)],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const span = N * 100;
      // et.resistances feeds CreatureSim's `mit`; dropping it from this
      // SELECT loads it as undefined and silently makes every creature
      // resistance inert. et.faction/wc.home_x/wc.home_y are the same kind
      // of column: drop them and guards silently revert to ordinary
      // roaming hostiles with no anchor. wc.level/wc.damage are that kind
      // of column too now: drop either and a spawned creature's level and
      // per-instance damage silently fall back to 1 / CREATURE_DAMAGE.
      //
      // defense is COALESCEd, and ALIASED, for two separate reasons.
      // Aliased because selecting wc.defense beside et.defense returns ONE
      // "defense" key to node-postgres and the later column silently wins —
      // the exact class of silent bug this comment warns about for the
      // other columns above. COALESCEd because wc.defense is NULL for every
      // creature that predates level scaling, and those must keep falling
      // back to the entity type's base value.
      //
      // SOMET-249: LEFT JOIN creature_behaviors b ON b.id = et.behavior_id,
      // the same shape loadCreatureTypes uses, for the same reason -- an
      // INNER JOIN would make a creature whose type has no assigned profile
      // vanish from the world entirely (it would just never spawn) instead of
      // resolving to the faction-aware fallback in
      // creatures.js's resolveInstanceBehavior. `b.name` MUST be aliased
      // `behavior_name`: that is the exact key both resolveBehavior and
      // resolveInstanceBehavior read to decide whether a real profile was
      // found at all -- get the alias wrong and every creature silently takes
      // the fallback, with nothing appearing broken (no error, no red test,
      // the world just never uses the twelve profiles an admin configured).
      // et.attack_element is the same kind of column as et.faction above:
      // drop it and every creature's element silently reverts to 'physical'.
      //
      // SOMET-253: this query is the SECOND of the two creature-loading paths
      // and carries ABILITIES_LATERAL for the same reason it carries the
      // behaviour join -- loadCreatureTypes feeds the TYPE catalog (gold
      // ranges, name -> id) while THIS query is what feeds live INSTANCES
      // into CreatureSim.addCreatures. Wiring only the other one is how the
      // previous sub-project nearly shipped its whole catalog inert with a
      // fully green suite: every test constructs creatures directly, so
      // neither query is exercised by anything but its own guard test. The
      // fragment is imported, never re-typed, so the two cannot drift.
      //
      // These rationale comments are deliberately kept OUTSIDE the query
      // template literal (as JS `//` comments, not SQL `--` comments): this
      // exact SELECT is guarded by a substring test
      // (authority_creatures_integration.test.js) that scans the live SQL
      // text for each column name. Writing the words "defense"/"level"/
      // "damage"/"chase_style"/etc inside the string itself — even in a SQL
      // comment — would make that guard pass whether or not the real column
      // is still there.
      //
      // SOMET-253 Task 4: b.gold_min/b.gold_max are aliased AS
      // behavior_gold_min/behavior_gold_max here too, even though this row
      // carries no competing et.gold_min/et.gold_max to collide with --
      // resolveBehavior (shared with loadCreatureTypes, where the collision
      // IS real) reads that one alias unconditionally, so both SELECTs must
      // agree on it. b.aura_* columns have no collision anywhere and stay
      // unaliased, same as aggro_radius/leash_radius/etc.
      const rows = await pool.query(
        `SELECT wc.id, wc.type, wc.x, wc.y, wc.hp, wc.facing, wc.home_x, wc.home_y,
                wc.level, wc.damage, wc.blocks_portal_id,
                COALESCE(wc.defense, et.defense) AS defense,
                et.color, et.resistances, et.faction, et.attack_element,
                b.name AS behavior_name, b.aggro_radius, b.leash_radius,
                b.chase_style, b.preferred_range, b.move_speed_mult, b.damage_override,
                b.aura_radius, b.aura_damage_mult, b.aura_defense_mult, b.aura_speed_mult,
                b.gold_min AS behavior_gold_min, b.gold_max AS behavior_gold_max,
                ab.abilities
         FROM world_creatures wc
         LEFT JOIN entity_types et ON et.name = wc.type
         LEFT JOIN creature_behaviors b ON b.id = et.behavior_id${ABILITIES_LATERAL}
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
    } catch (err) {
      // best-effort: left out of loadedChunks so recomputeActive retries it.
      // Logged (previously silent) so a persistently failing chunk is at
      // least visible to an operator instead of only manifesting as an
      // empty-looking world (F-018 / SOMET-198).
      console.error('chunk activation failed:', chunkKey, err);
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

  // Live minimap/AOI chest markers. Unlike creatures/items, entry.chests is a
  // plain array (not a chunk-indexed Sim class -- chests are map-spec-authored
  // or field-spawned, never numerous enough per world to warrant one), so the
  // neighborhood filter is inlined here rather than via a snapshotForNeighborhood
  // method. Same field-naming/coordinate convention as creatures/items ({id, x,
  // y, ...} in world-pixel space): a chest's x/y is a real stored position
  // (mapChestRow), not a derived center like a village's, so it belongs with the
  // point-entity family, not the bounding-box-marker family. `state` rides along
  // (not just kind) so the client can render locked/unlocked/opened distinctly.
  function broadcastChests(entry) {
    const N = entry.row.chunk_size;
    for (const [userId, ws] of entry.sockets) {
      const p = entry.world.getPlayer(userId);
      if (!p) continue;
      const { cx, cy } = chunkOf(p.x, p.y, N);
      const keys = new Set(neighborhoodKeys(cx, cy, 1));
      const chests = (entry.chests || [])
        .filter((c) => {
          const { cx: ccx, cy: ccy } = chunkOf(c.x, c.y, N);
          return keys.has(CHUNK_KEY(ccx, ccy));
        })
        .map((c) => ({ id: c.id, x: c.x, y: c.y, kind: c.kind, state: c.state }));
      send(ws, { type: 'chests', chests });
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

  // Shared serialize-on-ws._opChain + try/catch wrapper. Six message-type
  // branches below (equip/unequip, pickup, drop, interact, buy, sell) — plus
  // the ammo-attack sub-path — repeated this identically before (F-020 /
  // SOMET-200): the chain read/write and the try/catch/log/notify shape were
  // verbatim. Serializing per-socket mutations on the ws itself matters
  // because two frames sent back-to-back (e.g. two equip frames) would
  // otherwise start concurrently and race on the same DB write; the
  // try/catch is what keeps an unhandled rejection here from propagating out
  // and crashing the whole process (Node exits by default on
  // unhandledRejection — confirmed live, once, before this existed).
  // `notify: false` matches the two call sites (pickup, attack/ammo) whose
  // original catch body logged the error but never sent the client an
  // `error` frame.
  function chainOp(ws, label, fn, { notify = true } = {}) {
    ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
      try {
        await fn();
      } catch (err) {
        console.error(`${label} failed:`, err);
        if (notify) send(ws, { type: 'error', message: `${label} failed` });
      }
    });
  }

  // equip/unequip share one handler (as they did as a combined if-branch
  // before): only which World method runs, and the fallback error message,
  // differ by msg.type.
  function equipOrUnequip(ws, msg) {
    const entry = worlds.get(ws.worldId);
    if (!entry) return;
    chainOp(ws, msg.type, async () => {
      const r = msg.type === 'equip'
        ? await entry.world.setEquipment(pool, ws.userId, msg.itemId, msg.slot)
        : await entry.world.clearEquipment(pool, ws.userId, msg.slot);
      if (r && !r.ok) send(ws, { type: 'error', message: r.reason || `cannot ${msg.type}` });
    });
  }

  // Dispatch table (F-020 / SOMET-200), replacing an eleven-branch if-chain.
  // Every handler here is a verbatim move of that branch's body — this is a
  // structural extraction, not a behavior change: no handler gained a check
  // it didn't already have, and none lost one. An unrecognized msg.type is
  // silently ignored below, same as falling off the end of the old if-chain.
  const messageHandlers = {
    // A second join on an already-joined socket bypasses the "newest
    // session wins" kick (prev === ws skips it) and re-runs addPlayer, which
    // resets hp/mana to max and teleports to spawn — a free full
    // heal/exploit now that combat is real. One join per socket; a client
    // that wants a different world must reconnect.
    async join(ws, msg) {
      if (ws.worldId != null) { send(ws, { type: 'error', message: 'already joined' }); return; }

      const entry = await loadWorld(msg.world_id).catch(() => null);
      if (!entry) { send(ws, { type: 'error', message: 'unknown world' }); return; }

      try {
        // entry.worldId, not msg.world_id: loadWorld canonicalizes the id
        // (F-014), and pendingArrivals (set from entry.links, itself built
        // off the canonical id) is matched by strict worldId equality in
        // loadSpawn — passing the client's raw spelling back in here would
        // silently reintroduce the same split for doorway arrivals.
        const spawn = await loadSpawn(entry.worldId, ws.userId, entry.row.chunk_size, entry.row);
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
        const gr = await pool.query('SELECT gold FROM users WHERE id = $1', [ws.userId]);
        const gold = gr.rows.length ? Number(gr.rows[0].gold) || 0 : 0;
        const progression = await loadProgression(pool, ws.userId);
        const stats = derivePlayerStats(progression);

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

        ws.worldId = entry.worldId; // canonical (F-014), not the client's raw spelling
        entry.world.addPlayer(ws.userId, spawn, inv, spawn.respawn, gold, stats);
        if (spawn.viaDoorway) {
          const p = entry.world.getPlayer(ws.userId);
          if (p) {
            p._doorwayCdUntil = Date.now() + 1500;
            // Latch the tile this warp-in landed the player on (see
            // planPortalTransition's comment). Set unconditionally for any
            // doorway-style arrival, not just portals -- harmless for a
            // compass-doorway arrival (arrivalPoint() lands them off the
            // doorway tile, so this key won't coincide with a portalLinks
            // entry anyway), and it's the ONLY place a freshly-created
            // player object in the DESTINATION world can record "I just
            // arrived here" -- a same-world timer like _portalCdUntil
            // cannot cross worlds, since the arriving player is a brand
            // new object with no memory of the trip.
            const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
            const gRow = Math.floor(cy / MAP_TILE_SIZE), gCol = Math.floor(cx / MAP_TILE_SIZE);
            p._lastPortalTile = `${gRow},${gCol}`;
          }
        }
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
          gold,
          progression,
          merchants: (entry.villages || [])
            .filter((v) => v.merchantX != null && v.merchantY != null)
            .map((v) => ({ villageId: v.id, x: v.merchantX, y: v.merchantY })),
        });
      } catch (err) {
        console.error('join failed:', err);
        if (entry.sockets.get(ws.userId) === ws) entry.sockets.delete(ws.userId);
        if (sessionsByUser.get(ws.userId) === ws) sessionsByUser.delete(ws.userId);
        send(ws, { type: 'error', message: 'join failed' });
      }
    },

    input(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (entry) entry.world.setInput(ws.userId, msg.seq, finiteOr(msg.dx, 0), finiteOr(msg.dy, 0));
    },

    attack(ws, msg) {
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
        const { kills, attacks } = entry.world.attack(ws.userId, ax, ay);
        pushAttacks(entry, attacks);
        for (const k of dedupeKillsById(kills)) onCreatureDeath(entry, k.id, k.killerUserId);
        return;
      }

      // Ammo is spent LAST, after every other gate has passed, so a refused
      // attack can never destroy a unit. Serialized on chainOp for the same
      // reason as equip/pickup/drop; `notify: false` since a refused shot
      // sends its own `noammo` frame below, not a generic error.
      chainOp(ws, 'attack/ammo', async () => {
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
        const { kills, attacks } = cur.world.attack(ws.userId, ax, ay);
        pushAttacks(cur, attacks);
        for (const k of dedupeKillsById(kills)) onCreatureDeath(cur, k.id, k.killerUserId);
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
      }, { notify: false });
    },

    equip: equipOrUnequip,
    unequip: equipOrUnequip,

    pickup(ws) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      chainOp(ws, 'pickup', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const target = entry.world.groundItems.nearest(cx, cy, PICKUP_RADIUS);
        if (!target) return; // nothing in range: silent no-op, not an error
        if (target.typeId === entry.goldItemTypeId) {
          const got = await claimGold(pool, entry, ws.userId, target.id);
          if (got) send(ws, { type: 'wallet', gold: got.gold });
        } else {
          const got = await claimItem(pool, entry, ws.userId, target.id);
          if (got) send(ws, { type: 'picked', item: got });
        }
      }, { notify: false });
    },

    autoloot(ws, msg) {
      const entry = worlds.get(ws.worldId);
      // Strict boolean — a truthy string from the wire must not enable it.
      if (entry) entry.world.setAutoLoot(ws.userId, msg.on === true);
    },

    drop(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.itemId !== 'string') return; // wire hygiene: ids are strings
      chainOp(ws, 'drop', async () => {
        const r = await dropItem(pool, entry, ws.userId, msg.itemId, { ttlMs: groundItemTtlMs });
        if (r.ok) send(ws, { type: 'dropped', itemId: msg.itemId });
        else send(ws, { type: 'error', message: r.reason });
      });
    },

    // Consumes a `consumable`-category item (currently only `loot_map`) to
    // spawn a field chest + its guard on a legal tile. Ownership/category/
    // name checks happen against the in-memory catalog/inventory first
    // (entry.world.weapons and p.inv.items -- same source `joined`'s own
    // `itemTypes`/`items` payload comes from, no extra DB round trip needed
    // just to look category up), the same way dropItem's equipped-guard
    // check reads p.inv rather than querying first; the DB DELETE below is
    // still what's actually authoritative (guarded by user_id, mirrors
    // dropItem), so a stale in-memory snapshot can only ever cause a
    // spurious rejection, never a double-spend.
    use(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.itemId !== 'string') return; // wire hygiene: ids are strings, matches drop's guard
      chainOp(ws, 'use', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p || !p.inv) return;
        const item = p.inv.items.find((it) => it.id === msg.itemId);
        if (!item) { send(ws, { type: 'error', message: 'you do not own that item' }); return; }
        const itemType = entry.world.weapons.get(item.typeId);
        if (!itemType || itemType.category !== 'consumable') {
          send(ws, { type: 'error', message: 'this item has no use action' });
          return;
        }
        if (itemType.name !== 'loot_map') {
          send(ws, { type: 'error', message: 'unrecognized consumable' });
          return;
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const spawned = await spawnFieldChest(
            client,
            { ...entry.mapGenConfig, id: entry.worldId },
            ALLOWED_FIELD_CHEST_GUARDS,
            Math.floor(rng() * 2 ** 31),
          );
          if (!spawned) {
            await client.query('ROLLBACK');
            send(ws, { type: 'error', message: 'no legal spot for a chest right now' });
            return;
          }
          const del = await client.query(
            'DELETE FROM player_items WHERE id = $1 AND user_id = $2 RETURNING quantity',
            [msg.itemId, ws.userId],
          );
          if (del.rowCount !== 1) {
            await client.query('ROLLBACK');
            send(ws, { type: 'error', message: 'you do not own that item' });
            return;
          }
          // Mirrors sellItem's own guard in trade.js against the SAME table
          // and the SAME failure shape: `loot_map` is seeded `stackable:
          // true` (1714440152000_loot_map_item.js), and nothing here prices
          // or consumes per-unit -- a stacked row would have this DELETE
          // (already run above) destroy every unit in the stack while only
          // spawning ONE chest. Unreachable today (nothing grants loot_map
          // with quantity > 1 yet), but refuse rather than leave a second
          // unguarded copy of a failure mode this codebase already paid down
          // once. The DELETE already ran, so this must roll back, not just
          // error.
          const quantity = Number(del.rows[0].quantity) || 1;
          if (quantity !== 1) {
            await client.query('ROLLBACK');
            send(ws, { type: 'error', message: 'cannot use a stacked item' });
            return;
          }
          await client.query('COMMIT');
          // Keep the in-memory caches in sync, the same reason claimItem/
          // dropItem mutate p.inv.items / entry.world.groundItems directly
          // rather than waiting for a reload.
          p.inv.items = p.inv.items.filter((it) => it.id !== msg.itemId);
          entry.chests.push(spawned.row);
          send(ws, { type: 'used', itemId: msg.itemId, spawnedChestId: spawned.id });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });
    },

    interact(ws) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      chainOp(ws, 'interact', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const village = nearestMerchantVillage(entry.villages, cx, cy, INTERACT_RADIUS);
        if (!village) { send(ws, { type: 'error', message: 'no merchant nearby' }); return; }
        const shop = await fetchShop(pool, village.id);
        send(ws, { type: 'shop', villageId: village.id, catalog: shop.catalog, buyback: shop.buyback });
      });
    },

    // Opens the nearest in-range chest (proximity-picked, same pattern as
    // `interact` above -- the client sends no chest id). openChest owns the
    // guard-check/CAS/loot-roll/XP-award transaction; this handler only
    // finds the target and keeps entry.chests in sync with the DB write
    // openChest just committed, the same reason `use`'s handler pushes onto
    // entry.chests after spawnFieldChest commits.
    openchest(ws) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      chainOp(ws, 'openchest', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const chest = nearestChest(entry.chests, cx, cy, INTERACT_RADIUS);
        if (!chest) { send(ws, { type: 'error', message: 'no chest nearby' }); return; }

        const result = await openChest(pool, chest.id, ws.userId);
        if (!result.ok) { send(ws, { type: 'error', message: result.reason }); return; }

        // openedAt/respawnAt (undefined for a vault chest -- openChest
        // returns respawnAt: null there) must land on entry.chests too, not
        // just the DB row openChest just committed: the respawn sweep below
        // (itemSweepTimer) acts on the DB's respawn_at directly, but without
        // this, entry.chests would never show a respawn_at at all, and a
        // chest the sweep later relocks would look permanently 'opened' to
        // an already-connected player until a full world reload.
        Object.assign(chest, { state: 'opened', openedAt: result.openedAt, respawnAt: result.respawnAt });
        // openChest's own transaction may have flipped state locked ->
        // unlocked -> opened in one shot (the guard-dead check folds the
        // unlock into the same call) -- either way this chest's `state` on
        // the /overview payload is now stale wherever it was cached. One
        // call covers both transitions since they already committed
        // atomically before this handler ever resumes.
        clearOverviewCache(entry.worldId);
        send(ws, {
          type: 'chestOpened', chestId: chest.id, items: result.items,
          awarded: result.awarded, leveledUp: result.leveledUp, newLevel: result.newLevel,
        });
      });
    },

    buy(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.stockId !== 'string') return;
      chainOp(ws, 'buy', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const village = nearestMerchantVillage(entry.villages, cx, cy, INTERACT_RADIUS);
        if (!village) { send(ws, { type: 'error', message: 'no merchant nearby' }); return; }
        const r = await buyStock(pool, entry, ws.userId, msg.stockId, village.id);
        if (r.ok) {
          send(ws, { type: 'bought', item: r.item, gold: r.gold });
          send(ws, { type: 'wallet', gold: r.gold });
        } else send(ws, { type: 'error', message: r.reason });
      });
    },

    sell(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.itemId !== 'string') return;
      chainOp(ws, 'sell', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const village = nearestMerchantVillage(entry.villages, cx, cy, INTERACT_RADIUS);
        if (!village) { send(ws, { type: 'error', message: 'no merchant nearby' }); return; }
        const r = await sellItem(pool, entry, ws.userId, village.id, msg.itemId);
        if (r.ok) {
          send(ws, { type: 'sold', itemId: msg.itemId, price: r.price, gold: r.gold });
          send(ws, { type: 'wallet', gold: r.gold });
        } else send(ws, { type: 'error', message: r.reason });
      });
    },

    ping(ws) { send(ws, { type: 'pong' }); },
  };

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Swallow socket-level errors (e.g. a malformed inbound frame) so they
    // don't surface as an uncaught 'error' event that crashes the process.
    ws.on('error', () => {});

    // The whole handler body is wrapped in an IIFE + .catch (mirrors the
    // upgrade handler above) so that no branch below — however deep, however
    // future — can escape as an unhandled rejection. Without this, a plain
    // `async (data) => { ... }` callback handed to ws's EventEmitter has its
    // rejections silently dropped by 'ws', which Node 22 then turns into an
    // uncaught exception that exits the process (confirmed live: a bare
    // `null` frame did exactly this via the `msg.type` dereference below).
    ws.on('message', (data) => {
      (async () => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      // JSON.parse succeeds on non-object top-level values too (`null`,
      // `"str"`, `123`, `true`, arrays) without throwing, so the try/catch
      // above does not catch them. Every handler above dereferences
      // `msg.type`, which throws on a non-object `msg` (TypeError on null,
      // undefined `.type` on primitives/arrays just falls through harmlessly
      // — but null is fatal). Reject anything that isn't a plain object here.
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

      // Rate limit BEFORE any handler runs (F-015 / SOMET-195): a frame that
      // loses here does zero further work — no world lookup, no DB query, no
      // ws._opChain append. Dropped silently, matching this handler's
      // existing house style for benign no-ops (e.g. pickup with nothing in
      // range) — a flood is adversarial or a client bug either way, and an
      // error reply for every dropped frame would itself be free work handed
      // to whoever is flooding.
      if (!consumeRateToken(ws)) return;

      // An unrecognized msg.type is silently ignored — same as falling off
      // the end of the old if-chain.
      const handler = messageHandlers[msg.type];
      if (handler) await handler(ws, msg);
      })().catch((err) => {
        console.error('message handler failed:', err);
      });
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
      const { kills: killedByEffects } = entry.world.tick(dt);
      for (const k of dedupeKillsById(killedByEffects)) onCreatureDeath(entry, k.id, k.killerUserId);
      if (entry.links && entry.links.size > 0) {
        const now = Date.now();
        for (const p of entry.world.players.values()) {
          const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
          const tileName = entry.world.map.getTileAt(cx, cy);
          const t = planTransition({
            tileName, gRow: Math.floor(cy / MAP_TILE_SIZE), gCol: Math.floor(cx / MAP_TILE_SIZE),
            worldRow: entry.row, links: entry.links, now, cdUntil: p._doorwayCdUntil,
          });
          if (t) {
            p._doorwayCdUntil = now + 1500;                       // suppress duplicate sends during reconnect
            pendingArrivals.set(p.userId, { worldId: t.toWorldId, x: t.arriveX, y: t.arriveY });
            const ws = entry.sockets.get(p.userId);
            if (ws) send(ws, { type: 'transition', toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY });
          }
        }
      }
      if (entry.portalLinks && entry.portalLinks.size > 0) {
        const now = Date.now();
        const liveCreatures = entry.world.creatures.all();
        for (const p of entry.world.players.values()) {
          const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
          const gRow = Math.floor(cy / MAP_TILE_SIZE), gCol = Math.floor(cx / MAP_TILE_SIZE);
          const hereKey = `${gRow},${gCol}`;
          // Re-arm the just-arrived latch the moment the player's tile no
          // longer matches where a warp last dropped them -- see
          // planPortalTransition's comment for why this exists (mirrored
          // portal pairs share a tile with their own trigger).
          if (p._lastPortalTile && p._lastPortalTile !== hereKey) p._lastPortalTile = null;
          const t = planPortalTransition({
            gRow, gCol, portalLinks: entry.portalLinks, now, cdUntil: p._portalCdUntil, creatures: liveCreatures,
            loadedChunks: entry.loadedChunks, chunkSize: entry.row.chunk_size, lastPortalTile: p._lastPortalTile,
            // Raw top-left position, NOT cx/cy above (the player's centre) --
            // must match recomputeActive's own chunkOf(p.x, p.y, N) call
            // exactly, see planPortalTransition's comment.
            playerX: p.x, playerY: p.y,
          });
          if (!t) continue;
          if (t.blocked) {
            p._portalCdUntil = now + 800; // shorter than the doorway cooldown: a blocked bump should feel snappy, not sticky
            // Same key just looked up inside planPortalTransition -- O(1) and
            // guaranteed to exist (it's exactly what produced t.linkId), unlike
            // a [...values()].find() re-scan which allocates every blocked
            // player every tick and would throw on the next line if it ever
            // missed, uncaught, inside this bare setInterval callback.
            const link = entry.portalLinks.get(hereKey);
            const pushed = knockbackPosition({
              px: cx, py: cy, fromX: link.fromX, fromY: link.fromY, distance: 60, map: entry.world.map,
            });
            p.x = pushed.x - p.width / 2;
            p.y = pushed.y - p.height / 2;
            const ws = entry.sockets.get(p.userId);
            if (ws) send(ws, { type: 'portalBlocked', message: 'Guards block the way.' });
            continue;
          }
          p._portalCdUntil = now + 1500;
          pendingArrivals.set(p.userId, { worldId: t.toWorldId, x: t.arriveX, y: t.arriveY });
          const ws = entry.sockets.get(p.userId);
          if (ws) send(ws, { type: 'transition', toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY });
        }
      }
      if (entry.villages && entry.villages.length) {
        for (const p of entry.world.players.values()) {
          const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
          const gRow = Math.floor(cy / MAP_TILE_SIZE), gCol = Math.floor(cx / MAP_TILE_SIZE);
          const v = planBind({ villages: entry.villages, gRow, gCol, boundVillageId: p._boundVillageId });
          if (v) {
            p._boundVillageId = v.id;
            p.spawn = { x: v.spawnX, y: v.spawnY };
            upsertBind(p.userId, entry.worldId, v.spawnX, v.spawnY).catch((e) => console.error('upsertBind', e));
          }
        }
      }
      // aggro/chase/contact damage + respawns (before state). Guard kills route
      // through onCreatureDeath like every other kill site, so the DELETE +
      // drop roll stay authoritative.
      const { kills: killedByGuards } = entry.world.tickCreatures(dt, entry.activeChunks);
      for (const k of dedupeKillsById(killedByGuards)) onCreatureDeath(entry, k.id, k.killerUserId);
      const { kills: killedByProjectiles, detonations } = entry.world.tickProjectiles(dt);
      for (const k of dedupeKillsById(killedByProjectiles)) onCreatureDeath(entry, k.id, k.killerUserId);
      // Stashed for this tick's broadcast (below). REPLACED, not appended, so
      // an unconsumed stash can never grow without bound.
      entry.pendingDetonations = detonations;
      for (const userId of entry.world.resolveDeaths()) onPlayerDeath(entry, userId);
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
          if (it.typeId === entry.goldItemTypeId) {
            claims.push(claimGold(pool, entry, p.userId, it.id));
          } else {
            claims.push(claimItem(pool, entry, p.userId, it.id));
          }
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
            if (r.status === 'fulfilled' && r.value) {
              // claimGold resolves { gold }; claimItem resolves { id, typeId, quantity }.
              // Distinguishing by shape (rather than tagging each push) keeps this
              // loop untouched for the non-gold path.
              if ('gold' in r.value) send(sock, { type: 'wallet', gold: r.value.gold });
              else send(sock, { type: 'picked', item: r.value });
            }
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
      // Same contract as detonations: this tick's batch or it is lost, cleared
      // before the send loop, and omitted entirely when empty so an idle world
      // pays nothing per frame.
      const atks = drainAttacks(entry);
      const hasAtks = atks.length > 0;
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        const frame = { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players, projectiles: snap.projectiles };
        if (hasDets) frame.detonations = dets;
        if (hasAtks) frame.attacks = atks;
        send(ws, frame);
      }
      if (tick % creatureBroadcastEvery === 0) {
        recomputeActive(entry);
        broadcastCreatures(entry);
        broadcastItems(entry);
        broadcastChests(entry);
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

  // Field chest respawn: rides the ground-item sweep's interval below rather
  // than a second, independently-scheduled one. Named (like heartbeatSweep
  // above) so it can be exposed as `_chestRespawnSweep`: a test seam that
  // lets tests drive one sweep pass deterministically and await its
  // completion, instead of racing wall-clock itemSweepMs.
  //
  // getWorld only serves CURRENTLY LOADED worlds (the `worlds` map) --
  // reconstructing mapGenConfig for an unloaded world here would either
  // duplicate loadWorld's tileTypes/villages/biomes assembly or, if done by
  // calling loadWorld() itself, leak a permanently-loaded empty world
  // (nothing besides a socket's close handler currently evicts an empty
  // entry, and this sweep never fires that handler). A chest whose world is
  // offline simply stays due and is retried on a later sweep.
  //
  // onReset patches ONLY the matching entry.chests element in place
  // (Object.assign, same convention every other chest write already follows
  // -- the `use` handler's push, the `openchest` handler's Object.assign)
  // rather than replacing entry.chests wholesale from a fresh fetchChests
  // query. A full-array replace raced a concurrent openchest handler's
  // in-memory write for an UNRELATED chest in the same world: if the
  // replace's fetchChests SELECT ran before that handler's commit but its
  // `.then()` resolved after the handler's own Object.assign, the
  // just-opened chest's in-memory state would silently revert to stale.
  // Per-chest, per-object patching driven directly off what THIS sweep pass
  // itself just wrote (see respawnDueFieldChests' onReset contract) makes
  // that race structurally impossible: there is no separate read to race
  // against, and an unrelated chest's object is never touched.
  async function chestRespawnSweep() {
    try {
      await respawnDueFieldChests(pool, {
        getWorld: (worldId) => {
          const entry = worlds.get(worldId);
          return entry ? { ...entry.mapGenConfig, id: worldId } : null;
        },
        onReset: ({ id, worldId, ...patch }) => {
          // Same reasoning as the openchest handler's own clearOverviewCache
          // call: the DB write already committed (respawnDueFieldChests'
          // header comment on `reset` being counted unconditionally applies
          // here too), so the cache is stale regardless of whether the
          // owning world is even loaded right now to receive the in-memory
          // patch below.
          clearOverviewCache(worldId);
          const entry = worlds.get(worldId);
          if (!entry) return;
          const chest = entry.chests.find((c) => c.id === id);
          if (chest) Object.assign(chest, patch);
        },
      });
    } catch (err) {
      console.error('field chest respawn sweep failed:', err);
    }
  }

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

    chestRespawnSweep();
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
    // Test seam, same reasoning as _heartbeatSweep above: run one field
    // chest respawn pass synchronously (and await its completion, unlike the
    // real itemSweepTimer's fire-and-forget call) instead of waiting for or
    // racing wall-clock itemSweepMs.
    _chestRespawnSweep: chestRespawnSweep,
    // Evict an IDLE world from the in-memory cache so the next entry reloads it
    // from the DB (fresh seed + creatures). Refuses to evict a world with live
    // sockets to avoid tearing down active sessions.
    evictWorld(worldId) {
      const entry = worlds.get(worldId);
      if (!entry) return false;
      if (entry.sockets && entry.sockets.size > 0) return false;
      worlds.delete(worldId);
      return true;
    },
    // True iff `worldId` is currently loaded AND has at least one connected
    // socket. evictWorld() alone cannot distinguish "refused because a
    // player is connected" from "there was nothing loaded to evict" — both
    // return false — so admin routes that need to tell an operator WHY their
    // world-content edit did not reach the live simulation (F-017 / SOMET-197)
    // call this after evictWorld() returns false.
    isWorldLive(worldId) {
      const entry = worlds.get(worldId);
      return !!(entry && entry.sockets && entry.sockets.size > 0);
    },
    // Pushes a freshly-derived stat bundle from the progression HTTP API
    // (allocate, respec — SOMET-242) into the LIVE authority session, the
    // same live-consequence step onCreatureDeath's level-up path already
    // does for kill XP (see the DELETE FROM world_creatures handler above:
    // "without moving the session's pools here, a level-up would raise max
    // hp in the database and nothing in the running game"). Without this, a
    // point spent or a respec applied mid-session would only take effect in
    // the database, invisible until the player reconnects.
    //
    // Looked up via sessionsByUser (one live session per account) rather
    // than scanning every world's socket map — the natural shortcut when a
    // userId, not a worldId, is the only thing the caller has.
    //
    // Same hp<=0 guard as onCreatureDeath's level-up path, for the identical
    // reason: World#applyDerivedStats clamps current hp to a floor of 1
    // UNCONDITIONALLY, so calling it on a player currently sitting at hp<=0
    // (mid-death, awaiting the tick loop's resolveDeaths()) would incorrectly
    // revive them. A respec that LOWERS max hp (a lower CON) still moves
    // current hp by the same (now negative) delta, but that same floor of 1
    // — not 0 — is what stops a respec from being able to kill anyone.
    //
    // Returns false (a no-op, never a throw) when the user has no live
    // session, isn't in any loaded world, or is currently at hp<=0 — the
    // caller (progressionRoutes.js, via index.js's `?.` forwarding) treats
    // "was this reflected live" as best-effort, not a requirement for the
    // HTTP response, which already reflects the database write either way.
    refreshPlayerStats(userId, progression, stats) {
      // Root cause of a real, browser-verified miss (SOMET-242 review round
      // 3): every live registry here (sessionsByUser, entry.sockets,
      // World#players) is keyed by the STRING the WS upgrade handler mints
      // at connect time — `userId = String(payload.user_id)`, a few hundred
      // lines up. `userId` reaching THIS function instead comes from the
      // HTTP side (progressionRoutes.js's `req.user.id`, threaded through
      // index.js's `refreshLivePlayerStats`), which is
      // auth/tokens.js#currentUserForToken's `{ id: payload.user_id, ... }`
      // — the RAW JWT payload value, a NUMBER, never stringified. Every
      // Map.get below silently missed on that type mismatch: no error, no
      // guard fired, just a permanent no-op that returned `false` and got
      // swallowed by index.js's `?? false`. `applyDerivedStats` DID run at
      // join time (through the WS path, correctly string-keyed), which is
      // exactly why the HUD showed a correct number on join and then never
      // moved again after an allocate. Normalize ONCE, here, at the
      // boundary this function IS — the same place the WS upgrade handler
      // normalizes on ITS boundary — so no caller on either side has to
      // know or agree on a key type.
      const uid = String(userId);
      const ws = sessionsByUser.get(uid);
      if (!ws || !ws.worldId) return false;
      const entry = worlds.get(ws.worldId);
      if (!entry) return false;
      const p = entry.world.getPlayer(uid);
      if (!p || p.hp <= 0) return false;
      entry.world.applyDerivedStats(uid, stats);
      const sock = entry.sockets.get(uid);
      if (sock) send(sock, { type: 'progression', progression, stats });
      return true;
    },
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

module.exports = {
  attachAuthority, planTransition, planBind, nearestMerchantVillage, INTERACT_RADIUS,
  planPortalTransition, isPortalBlocked, knockbackPosition,
  // Stash internals, exported for unit test only. Not part of the module's API.
  __test: { pushAttacks, drainAttacks, MAX_PENDING_ATTACKS },
};
