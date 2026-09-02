const { URL } = require('node:url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { currentUserForToken } = require('../auth/tokens.js');
const { ServerMap } = require('./collision');
const { World } = require('./world');
const { loadItemTypes, resolveDefaultWeaponId, resolveGoldItemTypeId, loadInventory, grantStartingLoadout, socketStone, unsocketStone, freeSlots } = require('./items');
const { loadCatalogs, elementsForWire } = require('./catalogs');
const { configureAttackOrigins } = require('./attackOrigin.js');
const { loadProgression, applyDeath } = require('../services/progressionStore.js');
const { withStoneBonuses, socketedBuffStones } = require('../services/stoneBonuses.js');
const { withGearAffixes, equippedAffixGrants } = require('../services/gearAffixes.js');
const { ownedCharacter } = require('../services/characters.js');
const { charmBudget, canSummon, PLAYER_CHARM_MS } = require('../services/charm.js');
// SOMET-473: the PLAYER pacify. applyCharm owns the non-refreshing immunity
// window (effects.js), so this handler never decides whether a charm lands.
const { applyCharm } = require('./effects');
const { recordVisit } = require('../services/visitedWorlds.js');
const { mayJoin, joinPolicyFacts, waypointTravelFacts } = require('../services/joinPolicy.js');
const { derivePlayerStats } = require('../services/playerStats.js');
const { chunkOf, parseKey, neighborhoodKeys, CHUNK_KEY } = require('./coords');
const { loadCreatureTypes, ABILITIES_LATERAL } = require('./creatures');
const { chooseSpawn, edgeOfDoorwayTile, oppositeEdge, arrivalPoint, villageContaining } = require('../services/mapService');
const { fetchLinks } = require('../services/mapLinks');
const { fetchVillages } = require('../services/villages');
const { fetchWaypoints, activateWaypoint, waypointTileKey } = require('../services/waypoints');
const { buildLandmarks } = require('../services/landmarks');
const {
  fetchChests, spawnFieldChest, nearestChest, respawnDueFieldChests,
} = require('../services/chests.js');
const { openChest } = require('./chestLoot.js');
const { getSetting } = require('../services/gameSettings.js');
const { clearOverviewCache } = require('../services/overviewCache.js');
const { fetchShop } = require('../services/merchantStock');
const { fetchChest, depositItem, withdrawItem } = require('../services/accountChest');
const { loadDecorationDefs } = require('../services/decorationDefs');
const { loadBiomes } = require('../services/biomes');
const { buildWorldGenConfig } = require('../services/worldGenConfig');
const { commitCreatureDeath, claimItem, claimGold, dropItem, dropGraceActive, spawnGroundItemTypes } = require('./loot');
const { knockbackPosition } = require('./knockback');
const { buyStock, sellItem } = require('./trade');
const { respawnDueCreatures, enqueueDeficit, CREATURE_SWEEP_MS } = require('../services/creatureRespawn');
const { consumeAmmo, ammoCount } = require('./ammo');
const { PICKUP_RADIUS } = require('./groundItems');

// SOMET-473 -- the Druid's charm (spec 8.2, contract §6.5).
//
// How close a druid must be to charm. Matches the interact radius family rather
// than a weapon reach: charming is an interaction, not an attack.
const CHARM_RANGE = 200;
// How long a creature charm holds before the sim releases it. Long enough to
// walk a pack somewhere with, short enough that a druid must keep re-charming.
const CHARM_DURATION_MS = 120000;
const { awardStoneXp, STONE_XP_PER_HIT } = require('./stoneXp.js');

const MAP_TILE_SIZE = 100;

// Coerce a wire-provided number to a finite value (clients can send NaN/Infinity
// via JSON, e.g. 1e999 parses to Infinity).
function finiteOr(v, fallback) { return Number.isFinite(v) ? v : fallback; }

// Decoration defs feed ServerMap's blocking-decoration overlay (collision.js)
// via the same generateChunkDecorations the /chunk endpoint uses, so server
// collision and client-visible decorations stay in lockstep. Loader lives in
// services/decorationDefs.js and is shared with index.js's /chunk handler --
// see that file for why the ORDER BY matters.

// Should this tick's doorway check be suppressed because the player is still
// standing where it ARRIVED? Extracted (like planTransition below) so the rule
// is unit-testable rather than buried in the tick loop.
//
// The portal path has had an equivalent latch for a while (_lastPortalTile);
// compass doorways had only a 1500ms cooldown, which merely DELAYS a
// transition -- stand still and it fires anyway. That gap made map fast travel
// and plain login-resume bounce: a character's saved position in a world is
// very often the doorway it walked out through, so arriving there threw it
// straight back. Verified live (SOMET-271): TestmageQA's saved x in Old
// Trailhead was 6268 in a 64-tile world, exactly on the east doorway to
// Windwatch Pass.
//
// Releases itself as soon as the player is on a different tile, so it costs
// nothing after the first step and can never wedge a doorway permanently shut.
// Mutates `player` deliberately -- the latch IS per-player state; the return
// value is the decision.
function suppressArrivalDoorway(player, tileKey) {
  if (player._arrivalTile == null) return false;
  if (player._arrivalTile === tileKey) return true;
  player._arrivalTile = null;
  return false;
}

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

// SOMET-294 -- the floor between two player_binds writes for one character.
//
// There are TWO throttles on the bind write and they answer different
// questions. planBind below is the first: it returns null for the village you
// are already bound to, which is what makes standing at a gate -- or walking a
// whole village end to end -- exactly one write rather than one per tick.
//
// This constant is the second, and it exists because the identity gate has a
// hole the home region (SOMET-287) makes reachable: several villages now sit in
// one world, and a player walking the seam between two footprints changes
// village id on nearly every step, which at 20 ticks/sec is a write per tick
// again. Measured on the tick path, not hypothesised: without it, half a second
// of alternating between two footprints issues 25 writes.
//
// Why 5000ms specifically: PLAYER_SPEED is 200 world px/s and MAP_TILE_SIZE is
// 100, so a player covers 2 tiles per second, and VILLAGE_LIMITS.minW/minH is 3
// -- the smallest legal village takes ~1.5s to cross. Five seconds is therefore
// comfortably longer than any oscillation a player can produce at a shared
// boundary, and short enough that somebody who genuinely relocates has a
// durable checkpoint long before their next fight. It is a floor BETWEEN
// writes, never a delay on the first one.
//
// Crucially it throttles only the DATABASE write. The in-memory bind (p.spawn
// and p.bind) moves on the tick the footprint is crossed, so a suppressed write
// can never put a death the player is about to have in the wrong place -- the
// row it lags behind matters only to a LATER session, and the deferred write is
// flushed on the next eligible tick, or on socket close if that comes first.
const BIND_WRITE_MIN_MS = 5000;

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

// The village whose post named by (xKey,yKey) is nearest to (cx,cy) within
// `radius`, or null. Villages without that post are skipped.
//
// Parameterized over the post rather than copied per interactable (SOMET-310
// added the bank beside the merchant): the proximity rule is one rule, and two
// hand-copied versions of this loop would be two places to fix the day it
// changes.
function nearestVillagePost(villages, cx, cy, radius, xKey, yKey) {
  if (!villages || !villages.length) return null;
  let best = null, bd2 = radius * radius;
  for (const v of villages) {
    if (v[xKey] == null || v[yKey] == null) continue;
    const dx = v[xKey] - cx, dy = v[yKey] - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bd2) { bd2 = d2; best = v; }
  }
  return best;
}

function nearestMerchantVillage(villages, cx, cy, radius) {
  return nearestVillagePost(villages, cx, cy, radius, 'merchantX', 'merchantY');
}

// SOMET-443: the village a death should return an UNBOUND player to.
//
// No radius: a bind is earned by standing in a village, so a player without one
// may be anywhere on the map, and "the nearest village unless it is far away"
// would leave exactly the players this exists for standing on the tile that
// killed them. Distance decides which village, never whether there is one.
function nearestVillageSpawn(villages, cx, cy) {
  return nearestVillagePost(villages, cx, cy, Infinity, 'spawnX', 'spawnY');
}

// The fallback home for a death in a world that has no village of its own
// (SOMET-443). The ENTRY world's village, because that is the one place the
// game already guarantees is reachable and safe for a character with no
// history -- joinPolicy's first-join rule rests on the same fact.
//
// Returns null rather than throwing when there is no such village: a database
// with no entry world, or an entry world with no village, is a seeding problem
// that must not turn every dungeon death into an unhandled rejection. The
// caller leaves the player where resolveDeaths() put them, which is today's
// behaviour.
async function entryVillage(db) {
  const r = await db.query(
    `SELECT v.world_id, v.spawn_x, v.spawn_y
       FROM villages v JOIN worlds w ON w.id = v.world_id
      WHERE w.is_entry = true
      ORDER BY v.created_at ASC LIMIT 1`,
  );
  const row = r.rows[0];
  return row ? { worldId: row.world_id, x: Number(row.spawn_x), y: Number(row.spawn_y) } : null;
}

// SOMET-310. Deliberately a SEPARATE proximity pick from the merchant's rather
// than one "nearest interactable" resolver: the two posts sit one tile apart
// and are both usually inside INTERACT_RADIUS at once, so a shared picker would
// make which panel opens depend on sub-tile position. The client names the
// interaction it wants (`interact` vs `openbank`, bound to different keys) and
// each resolves only its own post.
function nearestBankVillage(villages, cx, cy, radius) {
  return nearestVillagePost(villages, cx, cy, radius, 'bankX', 'bankY');
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

// Slice C (SOMET-160). Same stash-and-drain shape as attacks above, and
// bounded by the same constant for the same reason: a crowded fight is
// exactly when this list grows, and it is also exactly when the frame can
// least afford to be large. Impacts past the cap are DROPPED rather than
// queued -- an impact spark that arrives a tick late is worse than one that
// never arrives, because it draws where the target no longer is.
function pushImpacts(entry, impacts) {
  if (!Array.isArray(impacts) || impacts.length === 0) return;
  if (!entry.pendingImpacts) entry.pendingImpacts = [];
  for (const i of impacts) {
    if (entry.pendingImpacts.length >= MAX_PENDING_ATTACKS) return;
    entry.pendingImpacts.push(i);
  }
}

function drainImpacts(entry) {
  const batch = entry.pendingImpacts;
  entry.pendingImpacts = null;
  return Array.isArray(batch) ? batch : [];
}

// Take this tick's batch and clear the stash in one step, so no caller can
// read it and forget to clear it.
function drainAttacks(entry) {
  const batch = entry.pendingAttacks;
  entry.pendingAttacks = null;
  return Array.isArray(batch) ? batch : [];
}

// The joined creature-instance SELECT, shared verbatim by activateChunk's
// per-chunk load (WHERE wc.world_id = ... AND x/y BETWEEN ..., below) and
// injectGuardIntoSim's per-id load (WHERE wc.id = ANY(...), also below).
// Factored out so the two call sites cannot drift apart: see
// activateChunk's own inline comment for the column-by-column rationale
// (dropping any of them silently makes some creature mechanic inert rather
// than throwing). Both call sites append their own WHERE clause.
const CREATURE_JOINED_SELECT = `SELECT wc.id, wc.type, wc.x, wc.y, wc.hp, wc.facing, wc.home_x, wc.home_y,
                wc.level, wc.damage, wc.blocks_portal_id,
                wc.charmed_by_character_id, wc.charm_expires_at, ch.user_id AS charm_owner_user_id,
                COALESCE(wc.defense, et.defense) AS defense,
                et.color, et.resistances, et.faction, et.attack_element,
                -- Slice D (SOMET-161). This is THE loader the live simulation
                -- reads: loadCreatureTypes builds a catalog nothing downstream
                -- ticks (see its own comment). A column added to the schema and
                -- missing from THIS list is the project's documented inertness
                -- trap -- the binding would exist in the database, and every
                -- creature would silently draw the kind default forever.
                et.vfx,
                b.name AS behavior_name, b.aggro_radius, b.leash_radius,
                b.chase_style, b.preferred_range, b.move_speed_mult, b.damage_override,
                b.aura_radius, b.aura_damage_mult, b.aura_defense_mult, b.aura_speed_mult,
                b.gold_min AS behavior_gold_min, b.gold_max AS behavior_gold_max,
                ab.abilities
         FROM world_creatures wc
         LEFT JOIN entity_types et ON et.name = wc.type
         LEFT JOIN characters ch ON ch.id = wc.charmed_by_character_id
         LEFT JOIN creature_behaviors b ON b.id = et.behavior_id${ABILITIES_LATERAL}`;

// SOMET-473 -- persisted charm -> the in-memory shape addCreatures reads.
//
// Called on EVERY row that goes into CreatureSim, at both loader call sites, so
// a pet that survives a chunk reload comes back as a pet instead of turning
// hostile on its owner. Without it the two charm columns would be write-only:
// a durable charm nothing ever reads back is the inertness trap this epic has
// shipped seven times, dressed up as persistence.
//
// TWO conversions happen here, and neither can live in creatures.js (which is
// clock-free and database-free by construction):
//
//   * charm_expires_at is an absolute timestamptz; the sim compares against
//     `world.now`, a monotonic ms counter that starts at 0 when the world was
//     created. The offset between them is (Date.now() - world.now), so the
//     expiry in world-clock terms is world.now + (expiresAt - Date.now()).
//   * charmed_by_character_id names a CHARACTER; the sim keys its owner lookup
//     on the userId the socket carries, which is a STRING (server.js's
//     `String(payload.user_id)`). A numeric user_id here would never match
//     `byId.get(...)` and every restored pet would be released on its first
//     tick -- silently, and with every test green.
//
// An already-lapsed charm is dropped rather than restored, so a row the
// background never got round to clearing cannot resurrect a pet.
function hydrateCharm(row, world) {
  if (row.charmed_by_character_id == null || row.charm_owner_user_id == null) return row;
  const expiresMs = new Date(row.charm_expires_at).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return row;
  return {
    ...row,
    charmOwnerUserId: String(row.charm_owner_user_id),
    charmedByCharacterId: row.charmed_by_character_id,
    charmExpiresAt: world.now + (expiresMs - Date.now()),
  };
}

// Attach the authoritative WebSocket simulation to an existing http server.
// Returns { close() } so callers/tests can tear it down.
function attachAuthority(httpServer, pool, opts = {}) {
  const jwtSecret = opts.jwtSecret;
  const path = opts.path || '/authority';
  const tickMs = opts.tickMs || 50;
  const flushMs = opts.flushMs || 30000;
  const creatureBroadcastEvery = opts.creatureBroadcastEvery || 4; // 4 ticks @50ms = ~5Hz
  // SOMET-354. Half-extent, in world pixels, of the zone that gets FULL
  // creature records. MAP_TILE_SIZE is 100, so 1600 is 16 tiles in each
  // direction: a 33x33-tile box around the player.
  //
  // Sized off the two consumers, not off the chunk grid:
  //   - the game viewport is roughly 15x15 tiles, so its half-extent is ~7.5
  //     and this is over twice that -- a creature is fully tracked well before
  //     it can be seen, and 5Hz updates plus client interpolation never have
  //     to "pop in" a creature that is already on screen;
  //   - the minimap draws creature dots out to ~60 tiles, and keeps doing so,
  //     because far creatures are still SENT (position only) rather than
  //     dropped. This constant decides DETAIL, not visibility.
  //
  // Deliberately NOT the activation radius. Simulation stays on the radius-1
  // chunk neighbourhood so creatures do not freeze at the edge of vision;
  // these two numbers were the same only by accident.
  //
  // Measured in the worst live world (The Abyss: Hub, 224/swarm, ~478
  // creatures in the neighbourhood): 2400 -> 199 KiB/s, 1600 -> 180, 1200 ->
  // 174, against 513 before this change. It flattens because past this point
  // the payload is dominated by the 36-char uuid each record must carry, not
  // by the near/far split -- shrinking the zone further costs detail and buys
  // almost nothing.
  const creatureNearPx = opts.creatureNearPx || 1600;
  // Per-socket record of which creature ids this connection has already been
  // told the immutable fields (type/color/maxHp/level) for. A WeakMap keyed by
  // the socket so a dropped connection cannot leak its id set.
  const creatureKnown = new WeakMap();
  const creatureFlushMs = opts.creatureFlushMs || 3000;
  const heartbeatMs = opts.heartbeatMs || 30000;
  // SOMET-482: 180 seconds (game_settings.ground_item_ttl_seconds), replacing
  // the hardcoded 600000. Held in a mutable local rather than a const because
  // refreshLootTuning re-reads the setting on the sweep cadence -- an admin
  // lowering it must reach live drops without a restart. `opts.groundItemTtlMs`
  // still wins at boot, which is what every existing test passes.
  let groundItemTtlMs = opts.groundItemTtlMs || 180000;
  const itemSweepMs = opts.itemSweepMs || 60000;
  // Its own interval, NOT itemSweepMs (60000): a 30-second respawn queue
  // drained on a 60-second timer would take 30-90s per creature.
  const creatureSweepMs = opts.creatureSweepMs || CREATURE_SWEEP_MS;
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
  // `||` treats an explicit 0 the same as "not provided" -- the tests that
  // pin capacity=0 or refill=0/sec (see authority_server.test.js) got the
  // 60/40 production defaults instead, silently. That let the deterministic
  // "zero refill" tests observe a real extra token trickle in under load
  // (SOMET-275): elapsedSec * 40/sec crossed 1 whole token within the
  // client round-trip between join's ack and the first ping being read,
  // which is more likely, not less, the slower/busier the suite runs. `??`
  // only falls back to the default when the option is actually omitted.
  // `??`, not `||`: a test that pins this at 0 (isolating the identity gate
  // from the time gate) must actually get 0, not the production default -- the
  // exact trap SOMET-275 recorded for the rate-limit options just below.
  const bindWriteMinMs = opts.bindWriteMinMs ?? BIND_WRITE_MIN_MS;
  const RATE_LIMIT_CAPACITY = opts.rateLimitCapacity ?? 60;
  const RATE_LIMIT_PER_SEC = opts.rateLimitPerSec ?? 40;

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
  const pendingArrivals = new Map(); // characterId -> { worldId, x, y } : a doorway-arrival spawn override

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
      let role = null;
      try {
        const user = await currentUserForToken(pool, payload);
        if (!user) { socket.destroy(); return; }
        // Read from the DB row this check already fetched, never from the JWT
        // payload: a token minted before a demotion still carries the old role,
        // and token_version is not bumped on a role change. The join policy
        // treats admin as an unrestricted world picker, so a stale claim there
        // would be a real privilege hold-over.
        role = user.role;
      } catch {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = userId;
        ws.role = role;
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
        // EVERY column buildWorldGenConfig reads must be named here. This is
        // the one caller of it that does NOT use `SELECT *` (index.js's chunk/
        // preview/overview routes and worldPopulation's callers all do), so a
        // column added to that builder and forgotten here comes out at its
        // DEFAULT on the live authority and nowhere else -- green tests, dead
        // feature. That is exactly what happened to safe_road_radius /
        // safe_rects (SOMET-288): both live users of entry.mapGenConfig's
        // placement path -- the loot-map `use` handler and the field-chest
        // respawn sweep -- ran with the road and rectangle legs of isSafeTile
        // permanently off, so a chest guard could seat itself on a village
        // road and the sweep would re-seat it there forever.
        // density, allowed_creature_types (SOMET-309): not read by
        // buildWorldGenConfig, but enqueueDeficit's `row` further down IS this
        // same `row` -- omitting them here would make the load-time backstop
        // silently enqueue 0 for every real world, forever, with no error.
        const wr = await pool.query('SELECT id, seed, chunk_size, width, height, is_entry, entry_spawn, biomes, biome_cell, level_min, level_max, safe_road_radius, safe_rects, authored_roads, density, allowed_creature_types FROM worlds WHERE id = $1', [worldId]);
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
        // SOMET-329: the option catalogs, loaded BEFORE the item types that
        // resolve against them. `configureAttackOrigins` makes an admin's
        // height_fraction edits take effect -- the fractions are data now, not
        // constants in attackOrigin.js.
        const catalogs = await loadCatalogs(pool);
        configureAttackOrigins(catalogs.attackOrigins);
        const itemTypes = await loadItemTypes(pool, catalogs);
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
          // toName (SOMET-297) is display-only -- buildLandmarks turns it into
          // "To <world>" for the marker label. Nothing on the transition path
          // reads it, so a null here degrades a label, never a warp.
          {
            id: l.id, toWorldId: l.to_world_id, toX: l.to_x, toY: l.to_y,
            fromX: l.from_x, fromY: l.from_y, toName: l.to_name,
          },
        ]));
        const villages = await fetchVillages(pool, canonicalId);
        // SOMET-292. Keyed by tile, exactly like portalLinks above, because the
        // tick loop asks the same question of both ("is this player standing on
        // one?") and an O(1) Map is what keeps that question free per player
        // per tick. waypointTileKey derives the key with the same
        // Math.floor(centre / 100) arithmetic the tick loop uses on the player,
        // so the two cannot disagree about which tile a waypoint is on.
        //
        // THIS IS THE ONLY RUNTIME READ of the waypoints table. Nothing else
        // loads them for the sim, so there is no second loader to fall out of
        // step with -- the shape that made a whole creature-behaviour catalog
        // inert in SOMET-249.
        const waypointRows = await fetchWaypoints(pool, canonicalId);
        const waypoints = new Map(waypointRows.map((w) => [waypointTileKey(w.x, w.y), w]));
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
          // SOMET-510: PORTAL endpoints for the blocking-decoration clearance.
          // The SAME rows /api/worlds/:id/chunk passes, so the ServerMap overlay
          // and the REST preview cannot disagree about which tiles block.
          links: linkRows,
        });
        const compassDoorways = compassRows.map((l) => ({ edge: l.edge, toWorldId: l.to_world_id, toName: l.to_name || l.to_world_id }));
        const map = new ServerMap({ ...mapGenConfig, decorationDefs });
        const entry = {
          worldId: canonicalId, world: new World(map, itemTypes, defaultWeaponId, row.chunk_size), row, sockets: new Map(),
          // SOMET-329: kept on the entry so `joined` can ship the element
          // palette without a second query per player.
          catalogs,
          tileTypes, creatureTypes, creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
          goldItemTypeId, links, portalLinks, compassDoorways, villages, waypoints, chests, mapGenConfig,
          activeChunks: new Set(),   // chunk keys currently in the union of player neighborhoods
          chunkLoads: new Set(),     // in-flight activation guard per chunk key
          loadedChunks: new Set(),   // chunk keys whose creatures have been successfully loaded
          claiming: new Set(),       // ground item ids with a claim in flight (avoids wasted queries)
        };
        worlds.set(canonicalId, entry);

        // SOMET-481: prime the rarity inputs NOW rather than waiting for the
        // first item sweep. Without this a freshly loaded world drops nothing
        // but plain white items for up to one sweep interval -- a window a
        // player can very easily kill something in, and one that would be
        // invisible in testing because it closes on its own. Awaited (the
        // world is already in `worlds`, so this fills THIS entry too) but
        // never fatal: an unpopulated weight table is playable, a failed load
        // is not.
        await refreshLootTuning().catch((err) => console.error('loot tuning refresh failed:', err));

        // SOMET-309: a player entering a drained world should have it refill,
        // not stay empty forever. Enqueue the deficit ONLY -- do not drain it
        // here. This is not a race, it is a hard ordering fact: the joining
        // player is not added to entry.world.players until well after
        // loadWorld returns (the `join` handler does that), so a sweep run
        // from inside loadWorld would see getPlayers() = [] and
        // isClearOfPlayers would be vacuously true for every row -- the one
        // guarantee this feature makes (nothing spawns on top of a player)
        // would not hold for the very rows this backstop exists to place.
        // Review finding, SOMET-309 Task 6 round 1.
        //
        // The rows are already respawn_at = now(), so the regular 10s sweep
        // timer (creatureRespawnSweep, registered elsewhere) drains them on
        // its next tick, by which point the join has completed and the
        // player IS in entry.world.players -- so the distance rule applies
        // for real. Cost: a drained world fills within ~10s of the first
        // arrival rather than instantly. Failure here must not prevent the
        // join -- an unpopulated world is playable, a failed join is not.
        try {
          await enqueueDeficit(pool, { worldRow: row, world: entry.mapGenConfig });
        } catch (err) {
          console.error('world load top-up failed:', canonicalId, err);
        }

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

  async function loadSpawn(worldId, characterId, chunkSize, worldRow, entry) {
    // Keyed by CHARACTER: a transition is a fact about the character that
    // walked through the door, not about the account. Keying it by user would
    // hand the arrival point to whichever character next joined on that
    // account.
    const pend = pendingArrivals.get(characterId);
    const pending = (pend && pend.worldId === worldId) ? { x: pend.x, y: pend.y } : null;
    if (pending) pendingArrivals.delete(characterId);
    let persisted = null;
    const r = await pool.query(
      'SELECT x, y FROM world_players WHERE world_id = $1 AND character_id = $2',
      [worldId, characterId]
    );
    if (r.rows.length) persisted = { x: r.rows[0].x, y: r.rows[0].y };
    // SOMET-261: a persisted position that is now out of bounds or inside
    // geometry falls back to the nearest portal rather than to the world
    // centre. Both arguments come from the already-loaded world entry, so this
    // costs no extra query.
    //
    // chooseSpawn defaults both to inert values, so forgetting to pass them
    // here would disable the fallback silently rather than fail -- that is what
    // spawn_portal_fallback.test.js's source-text guard exists to catch.
    const portals = [...entry.portalLinks.values()]
      .map((l) => ({ x: l.fromX, y: l.fromY }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const map = entry.world && entry.world.map;
    const isWalkable = map ? (x, y) => map.isWalkable(x, y) : null;
    const spawn = chooseSpawn({ pending, persisted, worldRow, chunkSize, portals, isWalkable });
    if (spawn.viaPortalFallback) {
      // Worth a line in the log: a spike here means a world was resized or
      // regenerated in a way that stranded the players saved inside it.
      console.log(`spawn: relocated character ${characterId} in world ${worldId} to nearest portal `
        + `(saved position ${persisted && persisted.x},${persisted && persisted.y} is no longer valid)`);
    }
    // SOMET-294: deliberately NOT filtered by world_id any more. player_binds'
    // primary key is character_id alone (re-keyed off user_id by migration
    // 1714440092000), so a character holds at most one bind row and that row
    // already names its own world -- there is nothing to pick between, hence no
    // ORDER BY and no LIMIT. The old `AND world_id = $2` filter is the single
    // reason "death returns you to the last village you entered" only ever
    // worked inside one world: a bind elsewhere simply did not exist as far as
    // this process was concerned.
    const b = await pool.query(
      'SELECT world_id, x, y FROM player_binds WHERE character_id = $1',
      [characterId],
    );
    const bindRow = b.rows[0] || null;
    // TWO facts, not one, and the split is the whole slice.
    //
    // `respawn` is where resolveDeaths() snaps this player WITHIN THIS WORLD.
    // It is the bind when the bind is here, and otherwise the position they
    // just joined at -- exactly today's behaviour for both the no-bind case and
    // (previously) the bind-elsewhere case. A cross-world bind deliberately
    // does NOT leave them where they died: the relocation is a reconnect, and a
    // client that never completes it would otherwise be left alive in the
    // middle of whatever just killed them.
    //
    // `bind` is the row itself, world id included. onPlayerDeath compares its
    // worldId against the world the death happened in; when they agree it is
    // the same point `respawn` already holds and nothing extra happens.
    const bindHere = bindRow != null && bindRow.world_id === worldId;
    spawn.respawn = bindHere ? { x: bindRow.x, y: bindRow.y } : { x: spawn.x, y: spawn.y };
    spawn.bind = bindRow ? { worldId: bindRow.world_id, x: bindRow.x, y: bindRow.y } : null;
    return spawn;
  }

  // Contract §6.3 (SOMET-475): `stats` rides EVERY `progression` frame, not
  // only the refreshPlayerStats push. A client that seeded from a kill push
  // and then rendered derived numbers otherwise showed pre-level-up values
  // with nothing to correct them.
  //
  // Named once here so the six send sites cannot drift into deriving from
  // DIFFERENTLY-buffed rows. It is always the stone-buffed derive: an unbuffed
  // one reports numbers the live world does not use, which is the same silent
  // overwrite SOMET-245 Task 6 fixed inside applyDerivedStats. A player who
  // has already disconnected has no inventory to read, so the buff list is
  // empty and the frame carries the unbuffed bundle -- there is no live
  // session left for it to disagree with.
  // SOMET-486 widened this from "the frame's stats" to THE authority's only
  // derive. It was already the shape three other sites had each hand-inlined
  // (kill level-up, chest level-up, refreshPlayerStats), and adding a second
  // per-player input -- the class base pools -- to four copies is how a
  // Ranger ends up joining at 85 hp and snapping to 100 on its first
  // level-up. There is now exactly ONE derivePlayerStats call in this file,
  // and progression_frame_shape.test.js pins that.
  //
  // `over` exists for the join path alone, which derives BEFORE addPlayer:
  // the player is not in the world yet, so neither its inventory nor its
  // class pools can be read off it.
  //
  // SOMET-496 widened it again, from "the authority's only derive" to "the
  // authority's only FRAME". It now returns the framed progression ROW beside
  // the bundle, because the row picked up a per-session overlay of its own:
  // the rolled affixes on the character's equipped items. A frame that sent
  // the raw row next to gear-aware stats would render a Character tab whose
  // `gear` column reads zero while the pools listed beside it already include
  // the gear -- the same advertise-vs-play split 486 closed, moved onto the
  // wire. Every `{type:'progression'}` send site takes `.progression` from
  // here; progression_frame_shape.test.js pins that none of them sends a row
  // this function did not produce.
  //
  // THE FOLD ORDER IS LOAD-BEARING. withGearAffixes RECOMPOSES the six
  // top-level stat keys out of `sources` plus the tree's modifiers, so it
  // discards anything a previous overlay wrote onto those keys. Gear first,
  // stones on top. Reversed, every socketed buff stone silently stops
  // counting for a player who is also wearing an affixed item.
  const framed = (entry, userId, progression, over = {}) => {
    const p = entry.world.getPlayer(userId);
    const inv = over.inv !== undefined ? over.inv : (p ? p.inv : null);
    const buffs = inv ? socketedBuffStones(inv, entry.world.weapons) : [];
    const affixes = inv ? equippedAffixGrants(inv) : [];
    const classPools = over.classPools !== undefined ? over.classPools : (p ? p.classPools : null);
    const row = withStoneBonuses(withGearAffixes(progression, affixes), buffs);
    return { progression: row, stats: derivePlayerStats(row, classPools) };
  };
  const framedStats = (entry, userId, progression, over = {}) => framed(entry, userId, progression, over).stats;

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
            // framedStats folds in socketed buff-stone bonuses AND the class
            // base pools, so a kill-triggered level-up drops neither: a raw
            // derivePlayerStats(progression) here would overwrite the buffed
            // bundle applyDerivedStats set (SOMET-245 Task 6) and would reset
            // a Ranger's 85 hp to 100 (SOMET-486).
            entry.world.applyDerivedStats(result.killerUserId, framedStats(entry, result.killerUserId, progression));
          }
        }
        // Best-effort: the killer's socket may be gone (disconnected between
        // the kill and this commit finishing) — entry.sockets.get returns
        // undefined and send() itself no-ops on a non-OPEN socket, so this
        // never throws either way.
        const sock = entry.sockets.get(result.killerUserId);
        if (sock) {
          const f = framed(entry, result.killerUserId, progression);
          send(sock, {
            type: 'progression', progression: f.progression, stats: f.stats,
            leveledUp, newLevel, awarded,
          });
        }
      })
      .catch((err) => console.error('death commit failed:', err));

  // Magic Stones (SOMET-245) Task 7: fire-and-forget entry point for a
  // landed spell-stone hit, mirroring onCreatureDeath's exact shape just
  // above -- both the sync `attack` message handler and the tick loop's
  // tickProjectiles consumer are on the hot path and must not await a DB
  // round trip, and an unhandled rejection here would kill the process the
  // same way an unhandled onCreatureDeath rejection would. No player-facing
  // frame is sent on success (unlike onCreatureDeath's 'progression' push) --
  // a stone's xp/level are read on demand (inventory/socket UI), not pushed
  // live every hit, so there is nothing to notify here yet.
  const onStoneHit = (stoneItemId) => awardStoneXp(pool, stoneItemId, STONE_XP_PER_HIT)
    .catch((err) => console.error('stone xp award failed:', err));

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
  // The XP penalty is per-character; the socket lookup is per-account. The
  // caller passes the in-memory userId, so the character id is resolved off
  // the live player here.
  const onPlayerDeath = (entry, userId) => {
    const p = entry.world.getPlayer(userId);
    const characterId = (p || {}).characterId;
    // No live player means the socket closed between the killing blow and
    // this call. There is no character to penalise and applyDeath(undefined)
    // would throw inside a fire-and-forget promise.
    if (characterId == null) return Promise.resolve();

    // SOMET-294 -- death returns you to the last village you entered, even when
    // that village is in another world.
    //
    // WHY IT IS HERE AND NOT IN resolveDeaths(). The double-fire guarantee this
    // whole path rests on (see the comment above, and world.js:555-563) is that
    // resolveDeaths() heals to full hp in the SAME synchronous pass it reports
    // the death, so the next tick cannot report it again. It is not a lock. A
    // cross-world respawn cannot happen on that pass -- changing worlds is a
    // client reconnect and a DB-backed join -- so putting it there would mean
    // either awaiting on the tick path or leaving the player un-healed until
    // the reconnect landed, and the second option breaks the guarantee outright:
    // every tick in between would re-report the same death. So resolveDeaths()
    // is untouched, it still heals and still snaps the player to their LOCAL
    // respawn point, and only the relocation defers to here. This code inherits
    // the once-per-death property rather than competing with it.
    //
    // Synchronous, and BEFORE the applyDeath round trip below: nothing awaits
    // between resolveDeaths() returning and this running, so there is no window
    // in which another tick could observe the player still dead.
    //
    // pendingArrivals + `transition` is the exact pair the doorway and portal
    // paths already use, which also means joinPolicy's `transition` leg is what
    // authorizes the arrival -- server-side state, never the client's claim.
    //
    // recordVisit rides along, as it does at both of those call sites. The
    // tempting argument against it here is that it is redundant: a bind can only
    // be earned by physically standing in a village, so the visit row already
    // exists. That argument is exactly what visited_worlds_db.test.js's
    // source-text guard exists to refuse, and it is already fragile -- the
    // waypoint slices (SOMET-292/293) add other ways to reach a world, and a
    // live visit-row loss has happened before (SOMET-265). Holding the invariant
    // by construction is cheaper than re-arguing it every slice.
    //
    // The socket send is best-effort, same as every other push in this file: it
    // may already be gone. The arrival stays enqueued either way, so a player
    // who reconnects later still lands at their village rather than where they
    // died -- exactly how an un-consumed doorway arrival already behaves.
    // Relocating to ANOTHER world: the doorway/portal machinery, reused whole.
    const relocate = (worldId, x, y) => {
      pendingArrivals.set(characterId, { worldId, x, y });
      const sock = entry.sockets.get(userId);
      if (sock) send(sock, { type: 'transition', toWorldId: worldId, arriveX: x, arriveY: y });
      recordVisit(pool, characterId, worldId)
        .catch((e) => console.error('recordVisit (death respawn)', e));
    };

    if (p.bind && p.bind.worldId !== entry.worldId) {
      relocate(p.bind.worldId, p.bind.x, p.bind.y);
    } else if (!p.bind) {
      // SOMET-443. No bind at all -- a character that has never stood in a
      // village. resolveDeaths() has just snapped them to p.spawn, which for
      // this player is the point they JOINED at, so without this they get up
      // inside whatever killed them and die again. Send them to the nearest
      // village instead, measured from where they actually died.
      //
      // Same world is the common case and is handled synchronously: they are
      // already alive and healed, so moving them is one assignment plus a
      // persist. No transition frame is needed or wanted -- the client stays in
      // the world it is already in and the next state broadcast carries the new
      // position, exactly as it does for the bind-here case.
      const from = p.deathAt || { x: p.x, y: p.y };
      const village = nearestVillageSpawn(entry.villages, from.x, from.y);
      if (village) {
        p.x = village.spawnX;
        p.y = village.spawnY;
        persist(entry.worldId, characterId, p)
          .catch((e) => console.error('persist (death respawn)', e));
      } else {
        // A world with no village at all -- every dungeon. Fall back to the
        // entry world's village, through the same authorized relocation the
        // bind case uses. Asynchronous, deliberately: the player is already
        // healed and standing somewhere safe-ish, and an un-consumed arrival
        // behaves exactly like an un-consumed doorway (they land there on the
        // next connect), so nothing is lost if the socket has gone.
        entryVillage(pool)
          .then((home) => { if (home) relocate(home.worldId, home.x, home.y); })
          .catch((e) => console.error('entryVillage (death respawn)', e));
      }
    }

    return applyDeath(pool, characterId, { rng })
      .then(({ progression, lost }) => {
      if (lost <= 0) return; // at the level floor: nothing changed, nothing to push
      // Best-effort: the player's socket may be gone (disconnected between
      // the death and this commit finishing) — entry.sockets.get returns
      // undefined and send() itself no-ops on a non-OPEN socket either way.
      const sock = entry.sockets.get(userId);
      if (sock) {
        const f = framed(entry, userId, progression);
        send(sock, { type: 'progression', progression: f.progression, stats: f.stats, lost });
      }
    })
      .catch((err) => console.error('death penalty commit failed:', err));
  };

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

  async function persist(worldId, characterId, p) {
    await pool.query(
      `INSERT INTO world_players (world_id, character_id, x, y, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (world_id, character_id) DO UPDATE SET x = $3, y = $4, updated_at = now()`,
      [worldId, characterId, p.x, p.y]
    );
  }

  async function upsertBind(characterId, worldId, x, y) {
    await pool.query(
      `INSERT INTO player_binds (character_id, world_id, x, y, updated_at)
         VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (character_id) DO UPDATE SET world_id = $2, x = $3, y = $4, updated_at = now()`,
      [characterId, worldId, x, y],
    );
  }

  // The ONE place the tick path (and socket close) turns an in-memory bind into
  // a row. Every write goes through the BIND_WRITE_MIN_MS floor described at
  // that constant, except the `force` on disconnect: a bind suppressed by the
  // floor is DEFERRED, never dropped, so a player who crosses into a second
  // village and immediately logs out must still take the newer village with
  // them. `_bindDirty` is what makes that a deferral -- it survives every
  // suppressed tick and clears only when the write is actually issued.
  //
  // Fire-and-forget with a mandatory .catch (this is a bare setInterval
  // callback; an unhandled rejection would kill the process). The promise is
  // returned so the close handler can await it best-effort -- it can never
  // reject, having already been caught here.
  function flushBind(p, now, force = false) {
    if (!p._bindDirty || !p.bind) return null;
    if (!force && p._bindWroteAt != null && now - p._bindWroteAt < bindWriteMinMs) return null;
    // Cleared BEFORE the write resolves, so the ticks that elapse while it is in
    // flight do not queue a second write for the same crossing -- and therefore
    // re-armed if it rejects, or "DEFERRED, never dropped" above would be a lie
    // the first time the DB hiccups: the flag would stay clean for the rest of
    // the session and the forced close-flush would no-op too. Same posture as
    // flushAndPrune's creature writes (keep dirty -> retried). The retry re-reads
    // p.bind rather than replaying these arguments, so a bind that moved on in
    // the meantime wins instead of being overwritten by a stale one.
    p._bindDirty = false;
    p._bindWroteAt = now;
    return upsertBind(p.characterId, p.bind.worldId, p.bind.x, p.bind.y)
      .catch((e) => { p._bindDirty = true; console.error('upsertBind', e); });
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
      //
      // The SELECT/FROM/JOIN text lives in CREATURE_JOINED_SELECT (module
      // scope, above attachAuthority) rather than inline here, so
      // injectGuardIntoSim below shares this EXACT shape instead of
      // maintaining a second, driftable copy -- see that function's header
      // comment for why it needs the identical columns.
      const rows = await pool.query(
        `${CREATURE_JOINED_SELECT}
         WHERE wc.world_id = $1 AND wc.x >= $2 AND wc.x < $3 AND wc.y >= $4 AND wc.y < $5`,
        [entry.worldId, cx * span, cx * span + span, cy * span, cy * span + span],
      );
      entry.world.creatures.addCreatures(rows.rows.map((r) => hydrateCharm(r, entry.world)));
      const itemRows = await pool.query(
        // `rarity` is NOT optional in this list (SOMET-490). This SELECT is
        // the ONLY way an item re-enters the sim after flushAndPrune's
        // pruneInactive forgot it, so a column dropped here does not merely
        // lose a field -- it makes a foxy drop lose its glow the moment the
        // player walks a chunk away and comes back, which reads as a render
        // flicker rather than as a missing column.
        `SELECT id, item_type_id, x, y, expires_at, rarity FROM world_items
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

  // Final-review fix (SOMET-244): the ONLY path that ever puts a
  // world_creatures row into the live entry.world.creatures sim is
  // activateChunk above, triggered exclusively by an unloaded->loaded chunk
  // transition. Every world in the live DB fits inside a single player's
  // 3x3 chunk neighborhood, so a chunk holding a player never unloads --
  // meaning a guard INSERTed mid-session (spawnFieldChest's `use`-handler
  // spawn, or respawnDueFieldChests' sweep) would otherwise stay DB-only:
  // invisible, unkillable, and openChest's guard-alive check would refuse
  // forever ("guard is still alive") since the DB row it counts never dies.
  //
  // Fix: after such an INSERT commits, re-run the SAME joined SELECT
  // activateChunk uses (CREATURE_JOINED_SELECT, so the two can never
  // disagree on shape) for just the new id(s) and feed the row(s) straight
  // into addCreatures. addCreatures dedupes by id (creatures.js:427), so
  // this is safe to call even if the id somehow already made it into the
  // sim by another path.
  async function injectGuardIntoSim(entry, ids) {
    if (!entry || !ids || ids.length === 0) return;
    try {
      const rows = await pool.query(
        `${CREATURE_JOINED_SELECT}
         WHERE wc.id = ANY($1::uuid[])`,
        [ids],
      );
      entry.world.creatures.addCreatures(rows.rows.map((r) => hydrateCharm(r, entry.world)));
    } catch (err) {
      // Best-effort, same posture as activateChunk's own catch: log so a
      // persistently failing injection is visible to an operator instead of
      // silently leaving a guard unkillable, but never let it take down the
      // caller (a field-chest `use`, or a background respawn sweep pass).
      console.error('injectGuardIntoSim failed:', ids, err);
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

  // SOMET-494. A refused attack has always been silently dropped, and that was
  // fine while every attack was one deliberate click. "Constant attack" holds
  // the button down, so the client now has to know WHY a shot was refused:
  // a cooldown refusal is the normal rhythm of holding and the hold continues
  // through it, but running out of mana / life / stamina must stop it.
  //
  // Only the resource refusal is announced. Cooldown refusals happen many times
  // a second under a held button and carry no information the client can act
  // on, so putting them on the wire would be pure noise. Ammo is NOT announced
  // here either: it is refused further down, after ammo is actually consumed,
  // and already has its own richer `noammo` frame carrying the item type.
  function refuseAttack(ws, gate) {
    if (gate && gate.reason === 'resource') send(ws, { type: 'attackrefused', reason: 'resource' });
  }

  function broadcastCreatures(entry) {
    const N = entry.row.chunk_size;
    for (const [userId, ws] of entry.sockets) {
      const p = entry.world.getPlayer(userId);
      if (!p) continue;
      const { cx, cy } = chunkOf(p.x, p.y, N);
      const keys = neighborhoodKeys(cx, cy, 1);
      // SOMET-354. Per SOCKET, not per player row: this is wire state (which
      // ids this connection has already been told the immutable fields for),
      // so it must die with the connection. Lazily created and never removed
      // by hand -- `entry.sockets` is the lifetime, and a reconnect gets a
      // fresh Set and therefore a full re-introduction of every creature.
      let known = creatureKnown.get(ws);
      if (!known) { known = new Set(); creatureKnown.set(ws, known); }
      // world.now, not Date.now(): the creature snapshot's effect keys are
      // decided against the same clock that applied and ticks those effects.
      send(ws, {
        type: 'creatures',
        creatures: entry.world.creatures.snapshotAOI(
          keys, entry.world.now, p.x, p.y, creatureNearPx, known),
      });
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
      if (r && !r.ok) { send(ws, { type: 'error', message: r.reason || `cannot ${msg.type}` }); return; }

      // SOMET-496. An item's rolled affixes are a per-session overlay
      // (services/gearAffixes.js), so the paper doll changing is exactly the
      // moment they have to be re-folded -- otherwise a +6 INT staff raises
      // nothing until the player's next kill, chest or level-up happens to
      // re-derive, and unequipping it leaves the bonus live until then too.
      //
      // Same shape and same guards as the socket/unsocket handlers below,
      // which had to solve this for buff stones: reload the row, frame it
      // once, push that ONE result into both the world and the wire. The
      // hp > 0 guard is not optional -- applyDerivedStats clamps current hp to
      // a floor of 1, so calling it on a player currently sitting at <= 0
      // awaiting resolveDeaths() would cancel their death.
      const p = entry.world.getPlayer(ws.userId);
      if (!p || p.hp <= 0) return;
      const currentProgression = await loadProgression(pool, p.characterId);
      const f = framed(entry, ws.userId, currentProgression);
      entry.world.applyDerivedStats(ws.userId, f.stats);
      send(ws, {
        type: 'progression', progression: f.progression, stats: f.stats,
        leveledUp: false, newLevel: currentProgression.level, awarded: 0,
      });
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

      // SOMET-260: a client-supplied character id is checked against the
      // token's user before anything is loaded. There is deliberately NO
      // "default to the account's first character" fallback — a silent default
      // would turn a client bug, or a forged frame, into a successful join as
      // somebody else's character rather than a refusal.
      const character = await ownedCharacter(pool, Number(ws.userId), msg.character_id)
        .catch(() => null);
      if (!character) { send(ws, { type: 'error', message: 'unknown character' }); return; }

      const entry = await loadWorld(msg.world_id).catch(() => null);
      if (!entry) { send(ws, { type: 'error', message: 'unknown world' }); return; }

      // Plan B slice 3: may this character be in this world at all? Until now
      // the answer was "yes, always" -- any world id in a join frame was a
      // successful arrival, which makes click-to-travel's visited+flagged offer
      // a suggestion rather than a rule. See services/joinPolicy.js for why the
      // check is not keyed on a client-supplied `fast_travel` intent.
      //
      // Placed AFTER loadWorld so the policy sees entry.worldId (the canonical
      // spelling, F-014) -- keying it on msg.world_id would compare the client's
      // raw string against ids that came out of the database, and a differently
      // spelled uuid would be refused for the wrong reason.
      //
      // pendingArrivals is READ, not consumed: loadSpawn below is what clears
      // it, and taking it here would leave a refused-then-retried join with no
      // arrival point.
      const pending = pendingArrivals.get(character.id);
      // Fail CLOSED on a lookup error: an authorization check that defaults to
      // "allow" when the database hiccups is not a check. Logged separately so
      // a refusal caused by an outage is distinguishable in the logs from one
      // caused by the rule.
      let facts = null;
      try {
        facts = await joinPolicyFacts(pool, character.id, entry.worldId);
      } catch (e) {
        console.error('join policy lookup failed:', e);
      }
      const verdict = mayJoin({
        isAdmin: ws.role === 'admin',
        pendingWorldId: pending ? pending.worldId : null,
        worldId: entry.worldId,
        facts,
      });
      if (!verdict.allowed) {
        // Generic on the wire. `verdict.reason` distinguishes "you have not been
        // there" from "that world does not exist", and handing that back would
        // let a client map the world graph by probing ids.
        console.warn('join refused:', verdict.reason, 'character', character.id, 'world', entry.worldId);
        send(ws, { type: 'error', message: 'you cannot travel there' });
        return;
      }

      try {
        // entry.worldId, not msg.world_id: loadWorld canonicalizes the id
        // (F-014), and pendingArrivals (set from entry.links, itself built
        // off the canonical id) is matched by strict worldId equality in
        // loadSpawn — passing the client's raw spelling back in here would
        // silently reintroduce the same split for doorway arrivals.
        const spawn = await loadSpawn(entry.worldId, character.id, entry.row.chunk_size, entry.row, entry);
        if (ws.readyState !== ws.OPEN) return; // client vanished while we awaited spawn

        // SOMET-499, the SECOND window of the same ghost. `entry` was resolved
        // from the registry BEFORE the policy lookup and loadSpawn above, and
        // the outgoing session's close can complete its teardown during those
        // awaits: it removes ITS player, the world then reads empty, and
        // `worlds.delete` runs while this join is still holding the object.
        // Registering into a detached entry is the same frozen client by
        // another route -- the join succeeds and the player is added, but the
        // tick loop iterates `worlds`, not this object, so no `state` frame is
        // ever sent. The close-side re-check below cannot cover this one: at
        // the moment that teardown ran, this session had not registered yet.
        // Measured over 90 close-then-rejoin runs, this route accounted for
        // every ghost left after the close-side guard.
        //
        // Re-attaching the SAME object, rather than reloading the world: the
        // entry is intact (the eviction's flushAndPrune is the same routine
        // flush the creature timer already runs against live worlds), and the
        // spawn computed above was derived from this entry's row.
        if (!worlds.has(entry.worldId)) {
          worlds.set(entry.worldId, entry);
        } else if (worlds.get(entry.worldId) !== entry) {
          // A concurrent load re-created this world while we were away, so a
          // DIFFERENT object is the live one now. Re-attaching would orphan
          // that object's players -- refuse loudly instead of joining a dead
          // entry silently, which is the failure this whole block exists to
          // stop happening.
          console.warn('join raced a world reload:', entry.worldId, 'character', character.id);
          send(ws, { type: 'error', message: 'join failed' });
          return;
        }

        // One live session per account: the newest join wins. (Refusing instead
        // would lock a user out for up to a full heartbeat cycle after a crash,
        // since the dead-socket reaper needs one interval to notice.)
        const prev = sessionsByUser.get(ws.userId);
        if (prev && prev !== ws) {
          // Flush the outgoing session's durable state HERE rather than leaving
          // it to that socket's own 'close' handler. That handler is
          // identity-checked against entry.sockets, and when the new session
          // joins the SAME world it overwrites that key (a few lines below)
          // before the terminated socket's close event can fire -- so the
          // handler returns early and neither persist nor flushBind ever runs.
          // Live shape: bind in one village, walk into a second inside the write
          // floor, lose the network, reconnect to the same world; the durable
          // bind stays at the first village.
          //
          // Read synchronously and written fire-and-forget: nothing is awaited
          // between the lookup and the writes, so the player object is still the
          // KICKED session's own (the new one is not added until after the
          // inventory awaits below) and prev.characterId still names it. An
          // await here would also open a window for a third join to see the same
          // `prev` and kick it twice.
          const prevEntry = worlds.get(prev.worldId);
          const prevP = prevEntry && prevEntry.world.getPlayer(prev.userId);
          if (prevP && prev.characterId != null) {
            persist(prev.worldId, prev.characterId, prevP)
              .catch((e) => console.error('persist (kicked session)', e));
            // Forced, same as the close handler's: "the player is leaving" is
            // exactly when the write floor stops saving writes and starts losing
            // data. A cross-world kick reaches the close handler too, where this
            // is then a no-op on an already-clean bind.
            flushBind(prevP, Date.now(), true);
          }
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

        let inv = await loadInventory(pool, character.id);
        // Unconditional, no longer gated on an empty inventory. The gate was
        // only ever a cheap pre-filter in front of grantStartingLoadout's real
        // once-ever check, and it is now actively wrong: a second character on
        // an account can legitimately have items in the world while this one
        // has never been granted anything.
        const granted = await grantStartingLoadout(pool, character, entry.world.weapons);
        if (granted) inv = await loadInventory(pool, character.id);
        // Attached AFTER the possible re-load above, or the grant would drop
        // it. Every capacity check reads inv.capacity, so the value has to
        // ride the same object the rules already hold.
        inv.capacity = character.inventorySlots;
        // Gold stays per-ACCOUNT (SOMET-257 left it on users), so this is the
        // one lookup in the join path still keyed by user rather than character.
        const gr = await pool.query('SELECT gold FROM users WHERE id = $1', [ws.userId]);
        const gold = gr.rows.length ? Number(gr.rows[0].gold) || 0 : 0;
        const progression = await loadProgression(pool, character.id);
        // Magic Stones (SOMET-245) Task 6: `inv` (loaded above) already has
        // its socketedStoneTypeId cache hydrated by loadInventory for EVERY
        // join, including a reconnect that finds a buff stone still socketed
        // from a previous session -- fold that bonus in here too, or a
        // rejoining player would sit at the wrong maxHp/maxMana/etc until
        // their next kill, chest, or socket/unsocket action re-derives it.
        //
        // SOMET-486: `character.classPools` is what finally makes the class
        // real. Before this, every class joined at HP_BASE/MANA_BASE and
        // character select's 100/85/75 was decoration. `over` is needed
        // because addPlayer has not run yet -- there is no player in the world
        // to read either the inventory or the pools off.
        // SOMET-496: the joined frame must carry the FRAMED row, not the bare
        // composed one -- it is the client's first (and, until the next kill,
        // only) progression object, so a raw row here leaves the Character tab
        // showing a zero `gear` column for the whole session.
        const framedJoin = framed(entry, ws.userId, progression, {
          inv, classPools: character.classPools,
        });
        const stats = framedJoin.stats;
        // SOMET-472 (spec 8.3). ONE derivation, read twice below -- once for
        // the sim and once for the wire -- so the server and the client can
        // never disagree about which bar is spent and which bar is drawn.
        //
        // Keyed on the class NAME rather than on main_stat: main_stat is the
        // passive tree's start position and two classes could legitimately
        // share one, while the life-cost substitution is a fact about the
        // Cultist specifically. HOW MUCH a cast costs is not decided here --
        // that is stats.lifeCostMultiplier, folded in by derivePlayerStats
        // from the tree rules the line above already composed.
        const usesLifeCost = character.className === 'Cultist';

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
        ws.characterId = character.id;
        // spawn.bind (SOMET-294) is the player_binds row as loaded, world id and
        // all -- distinct from spawn.respawn, which is always a point in THIS
        // world. See loadSpawn for why the two are separate facts.
        entry.world.addPlayer(ws.userId, spawn, inv, spawn.respawn, gold, stats, character.id, spawn.bind, character.classPools, usesLifeCost);

        // Latch the tile this join landed on, for EVERY join -- not just a
        // doorway arrival. A resume or a map fast-travel spawns the character
        // at its saved position in that world, and that position is very often
        // the doorway it walked out through, which then fires on the next tick
        // and throws it straight back where it came from. See the tick loop's
        // arrival-latch comment for the live case that found this.
        {
          const p = entry.world.getPlayer(ws.userId);
          if (p) {
            const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
            p._arrivalTile = `${Math.floor(cy / MAP_TILE_SIZE)},${Math.floor(cx / MAP_TILE_SIZE)}`;
          }
        }

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
        // Which waypoints THIS character has lit, for the landmark payload
        // below. Once per join, never per tick: the tick loop's activation
        // check writes through activateWaypoint and does not read this.
        //
        // Not scoped to this world -- the set is only ever membership-tested
        // against ids that came out of `entry.waypoints`, which is already one
        // world's worth. A world filter here would buy nothing and add a join.
        //
        // Failure is non-fatal, exactly like recordVisit below: a character who
        // cannot read their activations should still join, seeing every
        // waypoint as unlit rather than seeing a join error.
        let activatedWaypointIds = new Set();
        try {
          const actRows = await pool.query(
            'SELECT waypoint_id FROM character_waypoints WHERE character_id = $1',
            [character.id],
          );
          activatedWaypointIds = new Set(actRows.rows.map((r) => r.waypoint_id));
        } catch (e) {
          console.error('landmarks: reading activations failed', e);
        }
        send(ws, {
          type: 'joined', user_id: ws.userId, character_id: character.id, spawn, tickRate: 1000 / tickMs,
          itemTypes: [...entry.world.weapons.values()],
          // SOMET-329: the element palette. The ONE catalog the client needs —
          // it draws projectiles, trails, blast rings, status tints and impact
          // bursts in element colours, and those colours used to be hardcoded
          // client-side in two separate literals. Everything else about an
          // element stays server-side.
          elements: elementsForWire(entry.catalogs),
          items: inv.items,
          equipment: inv.equipment,
          // The panel renders used/capacity in its title bar. Nothing in play
          // changes the cap, so it rides the join frame only. DISPLAY ONLY:
          // the rule that refuses an item runs server-side, against this same
          // number, in authority/items.js.
          inventorySlots: inv.capacity,
          // Server-authoritative: addPlayer always resets this to false, but
          // read it back off the player rather than hardcoding — the wire
          // value must always reflect whatever World actually holds, not an
          // assumption about what addPlayer currently does.
          autoLoot: entry.world.getPlayer(ws.userId).autoLoot,
          gold,
          progression: framedJoin.progression,
          // SOMET-472, presentation only: the client hides the mana orb for a
          // life-cost class, because a Cultist has a mana pool the server
          // never spends and an inert bar is one the player learns to ignore.
          // The rule that actually spends the pool runs server-side, in
          // world.js's resourceRefusal/spendResources.
          usesLifeCost,
          merchants: (entry.villages || [])
            .filter((v) => v.merchantX != null && v.merchantY != null)
            .map((v) => ({ villageId: v.id, x: v.merchantX, y: v.merchantY })),
          // SOMET-310. Same shape and same join-time delivery as `merchants`
          // above: a bank post is static village geometry, so it never needs a
          // live update frame. fetchVillages derives bankX/bankY for every
          // village, so unlike merchants this list is never partial -- the
          // filter is kept anyway so a village row that somehow arrives
          // without one is skipped rather than drawn at (undefined, undefined).
          banks: (entry.villages || [])
            .filter((v) => v.bankX != null && v.bankY != null)
            .map((v) => ({ villageId: v.id, x: v.bankX, y: v.bankY })),
          // SOMET-297. Built from the Maps loadWorld already holds, plus one
          // per-join read of this character's activations -- no second loader.
          //
          // ONLY on `joined`, deliberately not on `transition`: GameShell.jsx:342
          // routes onTransition straight into enterWorld, which performs a fresh
          // join. Every entry path -- first join, resume, transition, waypoint
          // travel -- terminates in this frame, so a copy on `transition` would
          // be payload nothing reads.
          landmarks: buildLandmarks({
            waypoints: entry.waypoints,
            portalLinks: entry.portalLinks,
            activatedIds: activatedWaypointIds,
          }),
          doorways: entry.compassDoorways || [],
        });
        // Fog of war (SOMET-263). Fire-and-forget: a failed bookkeeping write
        // must never break a join. Call site 1 of 2 -- the other is the
        // transition path below, and visited_worlds_db.test.js asserts both.
        recordVisit(pool, character.id, entry.worldId)
          .catch((e) => console.error('recordVisit (join)', e));
      } catch (err) {
        console.error('join failed:', err);
        if (entry.sockets.get(ws.userId) === ws) entry.sockets.delete(ws.userId);
        if (sessionsByUser.get(ws.userId) === ws) sessionsByUser.delete(ws.userId);
        send(ws, { type: 'error', message: 'join failed' });
      }
    },

    // Waypoint travel (SOMET-293). The frame is `{type:'travel', waypointId}`
    // and that id is the ONLY thing on it -- there is deliberately no "I am
    // standing on X" field, because a forged frame would simply set it. Where
    // the player is standing comes from this process's own World object,
    // matched against the waypoint Map loadWorld built with the same
    // fetchWaypoints the activation block reads. One loader, so there is no
    // second copy for travel and activation to disagree about.
    //
    // The trip is authorized by joinPolicy.mayJoin, exactly like a join: passing
    // `travel` narrows it to the single leg that may answer a travel request.
    // The ARRIVAL then reuses pendingArrivals + the `transition` frame, which is
    // the same pair every portal and doorway crossing already uses -- so the
    // rejoin is authorized by the untouched `transition` leg and there is one
    // arrival mechanism in this server rather than one per way of setting off.
    travel(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      // Serialized through the socket's op chain like every other DB-backed
      // handler: two travel frames in flight at once would otherwise race to
      // write pendingArrivals, and the loser's destination would silently win.
      chainOp(ws, 'travel', async () => {
        const characterId = ws.characterId;
        // Re-read the player INSIDE the chain rather than before it. The chain
        // may have been waiting on an earlier op, and "where you are standing"
        // has to be true at the moment the trip is authorized, not when the
        // frame arrived.
        const p = entry.world.getPlayer(ws.userId);
        if (characterId == null || !p) return;

        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const origin = entry.waypoints ? entry.waypoints.get(waypointTileKey(cx, cy)) : null;

        // A null origin (standing on open ground) is a legal input, not a
        // shortcut: it reaches mayJoin as standingOnActivatedWaypoint === false,
        // the same fact standing on an unlit waypoint produces. Refusing here
        // instead would put half the rule outside joinPolicy.js.
        const travel = await waypointTravelFacts(
          pool, characterId, origin ? origin.id : null, msg.waypointId);
        const dest = travel.destination;
        // Generic on the wire, and identical to the join refusal below it on
        // purpose: distinguishing "that is not a waypoint" from "you have not
        // lit it" would let a client enumerate the network by probing ids.
        const refuse = (why) => {
          console.warn('travel refused:', why, 'character', characterId, 'waypoint', msg.waypointId);
          send(ws, { type: 'error', message: 'you cannot travel there' });
        };
        if (!dest) { refuse('unknown-waypoint'); return; }

        const facts = await joinPolicyFacts(pool, characterId, dest.worldId);
        const verdict = mayJoin({
          isAdmin: ws.role === 'admin',
          // Deliberately null, not the character's real pending arrival. A
          // pending entry left over from a doorway the player walked through
          // would otherwise stand in for a waypoint they have never lit -- the
          // trip would be allowed by `transition` rather than by the waypoint
          // rule, which is not the same permission at all.
          pendingWorldId: null,
          worldId: dest.worldId, facts, travel,
        });
        if (!verdict.allowed) { refuse(verdict.reason); return; }

        // The destination waypoint's own pixels, so the player lands on that
        // TILE rather than at a world spawn -- the whole difference between this
        // and the world-granularity fast travel it replaces. chooseSpawn takes
        // `pending` ahead of the persisted position, so this wins even for a
        // world the character has stood in before.
        // NO COOLDOWN HERE, unlike the doorway (_doorwayCdUntil) and portal
        // (_portalCdUntil) paths a few hundred lines down (SOMET-293 review).
        // Those two are commented "suppress duplicate sends during reconnect"
        // and they need to be: both are fired by the TICK LOOP off the tile the
        // player is standing on, so without a timer the server re-sends the same
        // transition every tick for as long as the client takes to reconnect.
        // This handler has no such re-evaluation -- nothing fires it but an
        // explicit `travel` frame, and the popup closes itself on the request.
        // A timer here would only rate-limit a client asking twice, which every
        // other frame in this file is equally free to do, and it would need a
        // third answer on the wire (refused-for-cooldown) that the deliberately
        // generic refusal above has no room for.
        pendingArrivals.set(characterId, { worldId: dest.worldId, x: dest.x, y: dest.y });
        send(ws, { type: 'transition', toWorldId: dest.worldId, arriveX: dest.x, arriveY: dest.y });
        // Fog of war, like every other transition push: the server has committed
        // the move, so the destination is visited whether or not the client
        // completes its rejoin. Almost always a no-op here (you cannot light a
        // waypoint without having stood in its world), but "almost always" is
        // not the invariant visited_worlds_db.test.js pins.
        recordVisit(pool, characterId, dest.worldId)
          .catch((e) => console.error('recordVisit (waypoint travel)', e));
      });
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
      if (!gate.ok) { refuseAttack(ws, gate); return; }

      // Ammo-free weapons (all melee, all staves, darts) keep the fully
      // synchronous path: no DB round trip on the hot path.
      if (gate.weapon.ammo_type_id == null) {
        const { kills, attacks, impacts, stoneHit } = entry.world.attack(ws.userId, ax, ay);
        pushAttacks(entry, attacks);
        pushImpacts(entry, impacts);
        for (const k of dedupeKillsById(kills)) onCreatureDeath(entry, k.id, k.killerUserId);
        // Magic Stones (SOMET-245) Task 7: a landed melee spell-stone hit is
        // known synchronously (world.js's attack() already confirmed the
        // swing connected) -- fire-and-forget the award the same way kills
        // are, just off a single flag rather than a list.
        if (stoneHit) onStoneHit(stoneHit.stoneItemId);
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
        if (!g.ok) { refuseAttack(ws, g); return; } // nothing spent
        // The equipped weapon may have changed too (an equip frame can be
        // chained between the two): always spend the CURRENT weapon's
        // ammo, and fall back to the sync path if it now needs none.
        const ammoTypeId = g.weapon.ammo_type_id;
        if (ammoTypeId != null && !(await consumeAmmo(pool, ws.characterId, ammoTypeId))) {
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
        const { kills, attacks, impacts, stoneHit } = cur.world.attack(ws.userId, ax, ay);
        pushAttacks(cur, attacks);
        pushImpacts(cur, impacts);
        for (const k of dedupeKillsById(kills)) onCreatureDeath(cur, k.id, k.killerUserId);
        // Same fire-and-forget award as the ammo-free branch above -- always
        // null on THIS path in practice (ammo-gated weapons are projectile
        // weapons, whose stoneHit only resolves later via tickProjectiles),
        // but wired identically for shape consistency and so this stays
        // correct if a melee weapon ever legitimately carries an ammo cost.
        if (stoneHit) onStoneHit(stoneHit.stoneItemId);
        // The shot is already committed above (ammo spent, kills
        // resolved) — pushing the client its new count is best-effort on
        // top of that, not a condition of it. Isolated in its own
        // try/catch so a failed COUNT query can never look like a failed
        // attack, and placed after attack()/onCreatureDeath so it cannot
        // delay or skip the resolution that already succeeded.
        if (ammoTypeId != null) {
          try {
            const count = await ammoCount(pool, ws.characterId, ammoTypeId);
            send(ws, { type: 'ammo', item_type_id: ammoTypeId, count });
          } catch (err) {
            console.error('ammoCount failed:', err);
          }
        }
      }, { notify: false });
    },

    castSkill(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      const { ok, kills } = entry.world.castSkill(
        ws.userId,
        msg.skillId,
        finiteOr(msg.targetX, 0),
        finiteOr(msg.targetY, 0),
        finiteOr(msg.ax, 0),
        finiteOr(msg.ay, 0)
      );
      if (ok && kills && kills.length > 0) {
        for (const k of dedupeKillsById(kills)) {
          onCreatureDeath(entry, k.id, k.killerUserId);
        }
      }
    },

    equip: equipOrUnequip,
    unequip: equipOrUnequip,

    // Socket a stone into a host item (weapon/armor). itemTypes comes from
    // entry.world.weapons -- the brief's draft assumed a field named
    // entry.itemTypes, which does not exist on the loaded world entry
    // (grepped: no entry\.\w*[Ii]tem[Tt]ype anywhere in this file); the real
    // catalog map is threaded through the World constructor and lives at
    // this.weapons (world.js:127), the exact map equipOrUnequip's own
    // World#setEquipment already resolves against internally, and the one
    // `use`'s handler above reads directly (entry.world.weapons.get(...)).
    // characterId comes from ws.characterId (set at join, server.js:1027),
    // matching drop/use/buy/sell's own direct-call handlers below rather
    // than equip/unequip's indirection through a World wrapper method --
    // socketStone/unsocketStone take the same low-level (pool, characterId,
    // inv, ..., itemTypes) shape items.js's own equip/unequip do, so no new
    // World method is needed to bridge them.
    socket(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.stoneId !== 'string' || typeof msg.hostId !== 'string') return; // wire hygiene, matches drop/use
      chainOp(ws, 'socket', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        // Magic Stones (SOMET-245) Task 6: capture whether this is a BUFF
        // stone (stat_bonus_stat set) before socketStone runs, off the
        // stone's own item -- socketStone only mutates the HOST item's
        // socketedStoneTypeId cache, and this stone item's own typeId never
        // changes across the call either way, so pre- or post-call both work
        // here; pre-call matches unsocket's shape (below), which has no
        // choice but to read it before the call.
        const stoneItem = p.inv.items.find((it) => it.id === msg.stoneId);
        const stoneType = stoneItem ? entry.world.weapons.get(stoneItem.typeId) : null;
        const isBuffStone = !!(stoneType && stoneType.stat_bonus_stat != null);
        const r = await socketStone(pool, ws.characterId, p.inv, msg.stoneId, msg.hostId, entry.world.weapons);
        if (r.ok) {
          send(ws, { type: 'socketed', stoneId: msg.stoneId, hostId: msg.hostId });
          // Trigger an immediate re-derive so a socketed buff stone's effect
          // applies right away, not just at the next level-up/kill -- same
          // hp>0 guard as every other applyDerivedStats call site (a dying
          // player must not be revived by this). Skipped entirely for a
          // spell stone: no stat changed, so there is nothing to re-derive or
          // push.
          if (isBuffStone && p.hp > 0) {
            const currentProgression = await loadProgression(pool, p.characterId);
            // ONE derive, used for both the live apply and the frame: two
            // calls could drift into differently-buffed rows, which is
            // exactly what contract §6.3 exists to stop.
            const f = framed(entry, ws.userId, currentProgression);
            entry.world.applyDerivedStats(ws.userId, f.stats);
            send(ws, {
              type: 'progression', progression: f.progression, stats: f.stats,
              leveledUp: false, newLevel: currentProgression.level, awarded: 0,
            });
          }
        } else send(ws, { type: 'error', message: r.reason });
      });
    },

    // Unsocket requires an explicit confirm:true frame field -- a client
    // that omits it is refused before any DB call (checked inside
    // unsocketStone itself, ahead of the destroy roll).
    unsocket(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.stoneId !== 'string') return;
      chainOp(ws, 'unsocket', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        // Magic Stones (SOMET-245) Task 6: must capture whether this was a
        // BUFF stone BEFORE unsocketStone runs -- on a destroy roll it
        // deletes the stone's player_items row outright (filtered out of
        // p.inv.items), and on survival it still clears the host's
        // socketedStoneTypeId cache, so there is no way to recover "was this
        // a buff stone" from p.inv AFTER the call either way.
        const stoneItem = p.inv.items.find((it) => it.id === msg.stoneId);
        const stoneType = stoneItem ? entry.world.weapons.get(stoneItem.typeId) : null;
        const wasBuffStone = !!(stoneType && stoneType.stat_bonus_stat != null);
        const r = await unsocketStone(pool, ws.characterId, p.inv, msg.stoneId, { confirm: msg.confirm === true });
        if (r.ok) {
          send(ws, { type: 'unsocketed', stoneId: msg.stoneId, destroyed: r.destroyed });
          // Trigger an immediate re-derive so removing a buff stone's effect
          // applies right away, whether it survived (ejected, no longer
          // socketed anywhere) or was destroyed (gone outright) -- either way
          // socketedBuffStones(p.inv, ...) below no longer counts it.
          if (wasBuffStone && p.hp > 0) {
            const currentProgression = await loadProgression(pool, p.characterId);
            // ONE derive, used for both the live apply and the frame: two
            // calls could drift into differently-buffed rows, which is
            // exactly what contract §6.3 exists to stop.
            const f = framed(entry, ws.userId, currentProgression);
            entry.world.applyDerivedStats(ws.userId, f.stats);
            send(ws, {
              type: 'progression', progression: f.progression, stats: f.stats,
              leveledUp: false, newLevel: currentProgression.level, awarded: 0,
            });
          }
        } else send(ws, { type: 'error', message: r.reason });
      });
    },

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
          const got = await claimItem(pool, entry, ws.userId, ws.characterId, target.id);
          // A DELIBERATE pickup gets told why nothing happened; the auto-loot
          // sweep below stays silent for the same condition.
          if (got && got.full) send(ws, { type: 'error', message: 'Inventory full' });
          else if (got) send(ws, { type: 'picked', item: got });
        }
      }, { notify: false });
    },

    autoloot(ws, msg) {
      const entry = worlds.get(ws.worldId);
      // Strict boolean — a truthy string from the wire must not enable it.
      if (entry) entry.world.setAutoLoot(ws.userId, msg.on === true);
    },

    // SOMET-473 -- the Druid's charm (spec 8.2). ONE message, TWO targets, and
    // they are deliberately different mechanics:
    //
    //   creature_id -> full control transfer, budgeted, 120s, persisted.
    //   player_id   -> a 4s PACIFY. No control transfer, no budget, no roster
    //                  row, nothing persisted. It is a debuff, not a summon.
    //
    // The message names its target explicitly rather than the server picking a
    // "nearest interactable": SOMET-487 is what happens when one key has to
    // guess between two things a tile apart. A caller may name exactly one.
    //
    // Refusals, in order: not a Druid, no target named, nothing in range,
    // already someone's pet, or over budget. Only "not a Druid" and the budget
    // say anything -- a miss is silent, exactly like `pickup` with nothing in
    // range, and so is a pacify that bounces off the immunity window (the
    // target's protection is not the caster's business).
    //
    // The budget is composed from the DATABASE every time rather than cached on
    // the player. Charisma is a COMPOSED number (class base + passive tree +
    // gear), and a budget cached at join would be wrong the moment a point is
    // allocated -- which is a live HTTP route, not a reconnect.
    charm(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      // wire hygiene: ids are strings, and exactly one target kind per message.
      const wantsCreature = typeof msg.creature_id === 'string';
      const wantsPlayer = typeof msg.player_id === 'string';
      if (wantsCreature === wantsPlayer) return;
      chainOp(ws, 'charm', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const character = await ownedCharacter(pool, Number(ws.userId), ws.characterId);
        if (!character || character.className !== 'Druid') {
          return send(ws, { type: 'error', message: 'Only a Druid can charm' });
        }
        const pc = { x: p.x + p.width / 2, y: p.y + p.height / 2 };

        if (wantsPlayer) {
          const other = entry.world.getPlayer(msg.player_id);
          // Never yourself: a self-pacify would make you unable to damage
          // yourself, which is nothing, and would repel you from your own
          // position, which is a jitter loop.
          if (!other || other === p) return;
          const oc = { x: other.x + other.width / 2, y: other.y + other.height / 2 };
          if (Math.hypot(oc.x - pc.x, oc.y - pc.y) > CHARM_RANGE) return;
          // applyCharm ITSELF decides whether this lands -- the non-refreshing
          // immunity window lives there, next to the shock interrupt it copies,
          // so no caller can chain-lock a player by calling more often. A
          // refusal is silent: it is the TARGET's guarantee, not a fact the
          // caster is owed.
          //
          // Nothing else happens here. No budget is consulted (a pacified
          // player is not a summon and never costs a level), no
          // character_summons row is written, and nothing is persisted -- a 4s
          // debuff that outlived a restart would be a bug, not a feature.
          if (applyCharm(other, ws.userId, entry.world.now)) {
            send(ws, {
              type: 'charmed', userId: other.userId,
              expiresAt: entry.world.now + PLAYER_CHARM_MS,
            });
          }
          return;
        }

        const c = entry.world.creatures.get(msg.creature_id);
        if (!c) return; // gone: silent, like pickup with nothing in range
        const cc = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
        if (Math.hypot(cc.x - pc.x, cc.y - pc.y) > CHARM_RANGE) return;
        if (c.charmOwnerUserId != null) return; // already someone's pet

        // COMPOSED, not raw, and both halves come off the SAME object.
        // loadProgression already folds the tree in (it ends in
        // passiveTreeStore's composeProgression), so `progression.charisma` is
        // the EFFECTIVE total -- class base + allocated nodes + gear -- and
        // `progression.rules.treeCharmBonus` is the summed rule the Druid's own
        // start node (+1) and the ks_cha_pack_leader keystone (+3) grant.
        //
        // Reading the raw player_progression.charisma column here instead would
        // make every charisma point the tree grants invisible to the budget:
        // the exact dead-grant shape SOMET-472 had to go back and fix, and the
        // seventh time this epic would have shipped it.
        //
        // `?? 0` is a degradation, not a default: composeStats always returns a
        // `rules` object with treeCharmBonus at its 0 identity, so this only
        // fires for a progression bundle that failed to compose at all.
        const progression = await loadProgression(pool, character.id);
        const budget = charmBudget(progression.charisma, (progression.rules || {}).treeCharmBonus ?? 0);
        // BY LEVEL SUM, never by count -- see charm.js's canSummon. Read off
        // the live sim rather than the roster table: `character_summons` is the
        // "every creature ever charmed" set (spec 8.2), not the list of what is
        // held right now, and summing that would refuse a druid's second charm
        // of the session forever.
        const held = entry.world.creatures.all()
          .filter((x) => x.charmedByCharacterId === character.id)
          .map((x) => x.level);
        const verdict = canSummon(held, c.level, budget);
        if (!verdict.ok) {
          return send(ws, { type: 'error', message: `Charm refused: ${verdict.reason}` });
        }

        const expiresAt = entry.world.now + CHARM_DURATION_MS;
        entry.world.creatures.charm(msg.creature_id, {
          userId: ws.userId, characterId: character.id, expiresAt,
        });
        // Durable, in one statement each, and AFTER the in-memory charm: a
        // failed write leaves a pet that lapses on its own timer, while a
        // failed charm followed by a successful write would leave a durable
        // pet the sim knows nothing about.
        await pool.query(
          `UPDATE world_creatures
              SET charmed_by_character_id = $1,
                  charm_expires_at = now() + ($2::int * interval '1 millisecond')
            WHERE id = $3`,
          [character.id, CHARM_DURATION_MS, msg.creature_id]);
        // "Every creature ever charmed is recorded" (spec 8.2). ON CONFLICT DO
        // NOTHING because the roster is a set, not a log -- see the migration.
        await pool.query(
          `INSERT INTO character_summons (character_id, creature_type, level)
           VALUES ($1, $2, $3)
           ON CONFLICT (character_id, creature_type, level) DO NOTHING`,
          [character.id, c.type, c.level]);
        send(ws, { type: 'charmed', creatureId: msg.creature_id, expiresAt });
      });
    },

    drop(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.itemId !== 'string') return; // wire hygiene: ids are strings
      chainOp(ws, 'drop', async () => {
        const r = await dropItem(pool, entry, ws.userId, ws.characterId, msg.itemId, { ttlMs: groundItemTtlMs });
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
    // still what's actually authoritative (guarded by character_id, mirrors
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
          // character_id, not user_id (SOMET-257/260 merge): player_items lost
          // its user_id column when inventory moved to characters, so this
          // DELETE threw `column "user_id" does not exist` and using a loot
          // map failed outright. The chests branch was written against the
          // account-keyed schema and the merge of the two lines is textually
          // clean but semantically wrong.
          const del = await client.query(
            'DELETE FROM player_items WHERE id = $1 AND character_id = $2 RETURNING quantity',
            [msg.itemId, ws.characterId],
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
          // Final-review fix (SOMET-244 Critical #1): without this, the
          // guard spawnFieldChest just wrote to world_creatures stays
          // DB-only for the rest of the session -- see
          // injectGuardIntoSim's header comment. Uses the outer `pool`, not
          // `client`: the transaction already committed above, and this
          // query has nothing to do inside it.
          await injectGuardIntoSim(entry, [spawned.guardCreatureId]);
          // Final-review fix (SOMET-244 Important #4): matches the
          // open/respawn paths' own clearOverviewCache call -- a newly
          // spawned field chest is a state change /overview must reflect
          // too, or it stays invisible on an already-cached window
          // indefinitely (no TTL, only explicit clear or FIFO eviction).
          clearOverviewCache(entry.worldId);
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
        // ws.userId, not ws.characterId: merchant_stock.seller_user_id is a
        // users.id and buyback is account-scoped (SOMET-280 — see fetchShop).
        const shop = await fetchShop(pool, village.id, ws.userId);
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

        // The opener's remaining room decides how much of the roll can be
        // granted; whatever does not fit comes back as overflowTypeIds and is
        // spawned on the ground below rather than lost.
        const room = freeSlots(p.inv, entry.world.weapons);
        // SOMET-481: the same weight table and affix pool a creature kill in
        // this world rolls against, cached on the entry by refreshLootTuning.
        // Passing entry.world.weapons as the catalog is what lets an affix's
        // allowed_slots filter apply to a chest grant at all -- without it
        // every slot-restricted affix would be eligible on every chest item.
        const result = await openChest(pool, chest.id, ws.characterId, {
          freeSlots: room,
          rarityAnchors: entry.rarityAnchors || null,
          affixPool: entry.affixPool || [],
          itemTypes: entry.world.weapons,
        });
        if (!result.ok) { send(ws, { type: 'error', message: result.reason }); return; }

        // Final-review fix (SOMET-244 Important #2): openChest now returns
        // full player_items rows ({id, item_type_id, quantity} each), not
        // bare item_type_ids -- push each onto p.inv.items the same way
        // claimItem does at loot.js:232 ("so a later equip validates
        // without a reload"). Without this a chest-granted item could not
        // be equipped/dropped/sold for the rest of the session (canEquip/
        // dropItem/sellItem all validate against p.inv.items).
        //
        // SOMET-481: the push now mirrors claimItem's ENTIRE shape, not just
        // its id/typeId/quantity. equipRequirements#gearStatGrants reads
        // `affixes[].effect` off THIS object and silently skips an affix that
        // has none, so a chest-granted foxy item pushed without them would
        // grant its stats in the database and nothing at all in play until the
        // next reconnect -- the same inert-feature shape claimItem's own
        // comment calls out.
        for (const it of result.items) {
          p.inv.items.push({
            id: it.id,
            typeId: it.item_type_id,
            quantity: Number(it.quantity) || 1,
            rarity: it.rarity || 'white',
            itemLevel: Number(it.item_level ?? 1),
            soulbound: it.soulbound === true,
            affixes: Array.isArray(it.affixes) ? it.affixes : [],
          });
        }

        // Overflow: one toast, not one per item, and the loot lands where the
        // player is standing so it can be collected after making room.
        if (result.overflowTypeIds && result.overflowTypeIds.length) {
          await spawnGroundItemTypes(pool, entry, result.overflowTypeIds, cx, cy, { ttlMs: groundItemTtlMs });
          send(ws, { type: 'error', message: 'Inventory full - some loot dropped on the ground' });
        }

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

        // Final-review fix (SOMET-244 Important #3): mirrors onCreatureDeath's
        // own leveledUp handling (server.js:426-463) exactly -- same call,
        // same hp>0 guard (a level-up landing while this player is
        // currently sitting at hp<=0 awaiting resolveDeaths() must not have
        // applyDerivedStats revive them; it clamps current hp to a floor of
        // 1 unconditionally). Without this, a chest-open level-up raised
        // max HP in the DB but never in the running game until reconnect --
        // "the exact defect A1's review caught."
        if (result.leveledUp && p.hp > 0) {
          // Same fold-in as onCreatureDeath's level-up path above -- a chest-XP
          // level-up must not overwrite an already-live buff-stone bonus, nor a
          // class's base pools, with the unbuffed class-blind bundle.
          entry.world.applyDerivedStats(ws.userId, framedStats(entry, ws.userId, result.progression));
        }
        send(ws, {
          type: 'chestOpened', chestId: chest.id, items: result.items,
          awarded: result.awarded, leveledUp: result.leveledUp, newLevel: result.newLevel,
        });
        // Separate progression frame, matching the kill path's own frame
        // shape (onCreatureDeath sends `{type:'progression', progression,
        // leveledUp, newLevel, awarded}`) so the client's existing
        // progression handling (built for kills) also picks up chest XP
        // without a second, chest-specific client-side path.
        const chestFrame = framed(entry, ws.userId, result.progression);
        send(ws, {
          type: 'progression', progression: chestFrame.progression,
          stats: chestFrame.stats,
          leveledUp: result.leveledUp, newLevel: result.newLevel, awarded: result.awarded,
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
        const r = await buyStock(pool, entry, ws.userId, ws.characterId, msg.stockId, village.id);
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
        const r = await sellItem(pool, entry, ws.userId, ws.characterId, village.id, msg.itemId);
        if (r.ok) {
          send(ws, { type: 'sold', itemId: msg.itemId, price: r.price, gold: r.gold });
          send(ws, { type: 'wallet', gold: r.gold });
        } else send(ws, { type: 'error', message: r.reason });
      });
    },

    // SOMET-310 — the account chest. Three handlers mirroring interact/buy/sell
    // one for one, because the bank IS the merchant's shape with a different
    // counterparty: a proximity-gated opener plus two movers, each re-sending
    // the whole chest so the panel never has to reconcile a delta.
    //
    // Every one of them re-resolves the bank post from the player's CURRENT
    // position rather than trusting a villageId the client sends. The opener
    // proving proximity once is not enough -- a crafted `deposit` frame never
    // goes near `openbank`, exactly the gap SOMET-199 closed on the merchant
    // side by scoping buy/sell to the village the caller was gated against.
    //
    // ws.userId, not ws.characterId, for the chest itself: account_items is
    // keyed on users.id and that is the whole point of the feature. The
    // characterId alongside it is the OTHER end of the move -- which of the
    // account's characters the item comes from or goes to.
    openbank(ws) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      chainOp(ws, 'openbank', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const village = nearestBankVillage(entry.villages, cx, cy, INTERACT_RADIUS);
        if (!village) { send(ws, { type: 'error', message: 'no bank nearby' }); return; }
        const chest = await fetchChest(pool, ws.userId);
        send(ws, {
          type: 'bank', villageId: village.id, items: chest.items, capacity: chest.capacity,
        });
      });
    },

    deposit(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.itemId !== 'string') return;
      chainOp(ws, 'deposit', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const village = nearestBankVillage(entry.villages, cx, cy, INTERACT_RADIUS);
        if (!village) { send(ws, { type: 'error', message: 'no bank nearby' }); return; }
        const r = await depositItem(pool, entry, ws.userId, ws.characterId, msg.itemId);
        if (!r.ok) { send(ws, { type: 'error', message: r.reason }); return; }
        // `deposited` carries the id the client must drop from its inventory
        // mirror; the `bank` frame after it is the fresh chest. Two frames
        // rather than one because they update two different client stores, and
        // the inventory one must land even if the panel is already closed.
        send(ws, { type: 'deposited', itemId: r.itemId });
        const chest = await fetchChest(pool, ws.userId);
        send(ws, {
          type: 'bank', villageId: village.id, items: chest.items, capacity: chest.capacity,
        });
      });
    },

    withdraw(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.itemId !== 'string') return;
      chainOp(ws, 'withdraw', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const village = nearestBankVillage(entry.villages, cx, cy, INTERACT_RADIUS);
        if (!village) { send(ws, { type: 'error', message: 'no bank nearby' }); return; }
        const r = await withdrawItem(pool, entry, ws.userId, ws.characterId, msg.itemId);
        if (!r.ok) { send(ws, { type: 'error', message: r.reason }); return; }
        send(ws, { type: 'withdrawn', item: r.item });
        const chest = await fetchChest(pool, ws.userId);
        send(ws, {
          type: 'bank', villageId: village.id, items: chest.items, capacity: chest.capacity,
        });
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
      if (p) {
        try { await persist(ws.worldId, ws.characterId, p); } catch { /* best-effort */ }
        // SOMET-294: a bind still sitting inside the write floor when the
        // socket goes must not be lost -- forced, because "the player is
        // leaving" is exactly the moment the floor stops being a saving and
        // starts being a data loss. No-ops when nothing is pending.
        try { await flushBind(p, Date.now(), true); } catch { /* best-effort */ }
      }
      // SOMET-499: RE-check, because the two awaits above are a window. The
      // guard at the top of this handler proved nothing about this moment --
      // a new session for the same account (entry.sockets and world.players
      // are keyed by userId only) can have registered while persist and
      // flushBind were in flight, and tearing down here would delete ITS
      // socket, ITS player and -- the world now looking empty -- the whole
      // world entry, leaving a client that is still OPEN and still in
      // wss.clients but never sent another `state` frame. Measured at roughly
      // one close-then-rejoin in seven before this guard existed.
      //
      // Deliberately narrow: only the TEARDOWN is conditional. persist and
      // flushBind above are the outgoing session's own durable state and are
      // always correct to run -- a stale close must not skip saving.
      //
      // Checked against entry.sockets and NOT against sessionsByUser: the top
      // of this handler already deleted this socket's sessionsByUser row, so
      // re-reading that map would report "stale" on EVERY close, including a
      // genuine last one, and the leak this teardown prevents (an orphaned
      // player plus a world that is never evicted) would reopen wholesale.
      if (entry.sockets.get(ws.userId) !== ws) return;
      entry.world.removePlayer(ws.userId);
      entry.sockets.delete(ws.userId);
      if (entry.world.isEmpty()) {
        await flushAndPrune(entry).catch(() => {});
        // Re-checked AFTER that await (SOMET-499), which is a window of exactly
        // the same kind as the persist/flushBind one above: measured, an entire
        // join fits inside flushAndPrune, so an unconditional delete here
        // detaches a world that has a live, freshly-added player in it -- and
        // the tick loop iterates `worlds`, so that player is never sent another
        // `state` frame.
        //
        // Each clause earns its place:
        //   isEmpty()      -- a player was added while we flushed;
        //   sockets.size   -- a session REGISTERS several awaits before its
        //                     player reaches addPlayer, so an empty world is
        //                     not an empty room. This is the leg that covers a
        //                     DIFFERENT account's close landing in that gap;
        //   worlds.get()   -- the world was evicted and reloaded while we
        //                     flushed, so the registered entry belongs to
        //                     somebody else and is not ours to delete.
        if (entry.world.isEmpty() && entry.sockets.size === 0
            && worlds.get(ws.worldId) === entry) {
          worlds.delete(ws.worldId);
        }
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
      const {
        kills: killedByEffects, attacks: creatureAttacks, impacts: creatureImpacts,
      } = entry.world.tick(dt);
      // Slice D: a wolf bite goes onto the same stash a halberd swing does,
      // and is bounded by the same cap -- creatures are the numerous actors,
      // so leaving them unbounded would be the one thing able to blow the
      // frame in a pack fight.
      pushAttacks(entry, creatureAttacks);
      pushImpacts(entry, creatureImpacts);
      for (const k of dedupeKillsById(killedByEffects)) onCreatureDeath(entry, k.id, k.killerUserId);
      if (entry.links && entry.links.size > 0) {
        const now = Date.now();
        for (const p of entry.world.players.values()) {
          // A corpse does not open doors. world.tick above applies burn damage
          // and deliberately LEAVES a player it killed at hp<=0 for this tick's
          // resolveDeaths() -- while still moving them -- so without this a
          // player can cross an edge on the very tick they die. That emits two
          // `transition` frames in one tick with different destinations: this
          // one, then SOMET-294's respawn relocation, which overwrites the
          // pendingArrivals entry the doorway just wrote. The client calls
          // enterWorld for both and the joins race; the doorway's join is
          // usually then REFUSED outright (pendingWorldId no longer matches, a
          // compass neighbour is not fast-travel and is not the last world),
          // leaving the player on a canvas that never receives `joined`.
          //
          // Cannot wedge: hp<=0 lasts at most the remainder of this tick, since
          // resolveDeaths() runs at the end of it and heals in the same pass.
          if (p.hp <= 0) continue;
          const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
          const tileName = entry.world.map.getTileAt(cx, cy);
          const gRow = Math.floor(cy / MAP_TILE_SIZE), gCol = Math.floor(cx / MAP_TILE_SIZE);

          // Do not fire a doorway the player is standing on BECAUSE it just
          // arrived there -- see suppressArrivalDoorway's own comment.
          if (suppressArrivalDoorway(p, `${gRow},${gCol}`)) continue;

          const t = planTransition({
            tileName, gRow, gCol,
            worldRow: entry.row, links: entry.links, now, cdUntil: p._doorwayCdUntil,
          });
          if (t) {
            p._doorwayCdUntil = now + 1500;                       // suppress duplicate sends during reconnect
            pendingArrivals.set(p.characterId, { worldId: t.toWorldId, x: t.arriveX, y: t.arriveY });
            const ws = entry.sockets.get(p.userId);
            if (ws) send(ws, { type: 'transition', toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY });
            // Fog of war: the destination is visited the moment the server
            // commits the move, not when the client re-joins -- a client that
            // never completes the rejoin has still been there.
            recordVisit(pool, p.characterId, t.toWorldId)
              .catch((e) => console.error('recordVisit (transition)', e));
          }
        }
      }
      if (entry.portalLinks && entry.portalLinks.size > 0) {
        const now = Date.now();
        const liveCreatures = entry.world.creatures.all();
        for (const p of entry.world.players.values()) {
          // Same reason as the doorway block above, plus two of its own: a
          // corpse that steps on a portal also takes a cooldown stamp it will
          // carry past its respawn, and a BLOCKED portal knocks it back --
          // moving a position resolveDeaths() is about to overwrite anyway.
          if (p.hp <= 0) continue;
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
          pendingArrivals.set(p.characterId, { worldId: t.toWorldId, x: t.arriveX, y: t.arriveY });
          const ws = entry.sockets.get(p.userId);
          if (ws) send(ws, { type: 'transition', toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY });
          recordVisit(pool, p.characterId, t.toWorldId)
            .catch((e) => console.error('recordVisit (transition)', e));
        }
      }
      if (entry.villages && entry.villages.length) {
        const bindNow = Date.now();
        for (const p of entry.world.players.values()) {
          const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
          const gRow = Math.floor(cy / MAP_TILE_SIZE), gCol = Math.floor(cx / MAP_TILE_SIZE);
          const v = planBind({ villages: entry.villages, gRow, gCol, boundVillageId: p._boundVillageId });
          if (v) {
            p._boundVillageId = v.id;
            p.spawn = { x: v.spawnX, y: v.spawnY };
            // SOMET-294: p.spawn and p.bind move together here, because
            // entering a village in the world you are standing in is exactly
            // what turns a bind elsewhere back into a bind here. Deliberately
            // NOT throttled -- the write below is. Keeping the in-memory pair in
            // step with the footprint crossing is what guarantees a death one
            // tick after walking through a gate lands in the village that was
            // just entered, whatever the write floor is doing.
            p.bind = { worldId: entry.worldId, x: v.spawnX, y: v.spawnY };
            p._bindDirty = true;
          }
          // Outside the `if` on purpose: a write deferred by the floor on an
          // earlier tick has to land on a LATER one, and that tick is by
          // definition one where planBind returned null (the player is still in
          // the same village).
          flushBind(p, bindNow);
        }
      }
      // Waypoint activation (SOMET-292). Modelled on the village-bind block
      // directly above, and throttled the same way it is.
      //
      // ACTIVATION IS PHYSICAL. There is deliberately no socket message that
      // lights a waypoint: a client-claimed activation would be a free travel
      // target, which is the same shape of hole joinPolicy exists to close.
      // Walking onto the tile is the only way, and this is the only place that
      // decides it happened.
      //
      // WRITE THROTTLING, on a hot path. planBind's answer is an in-memory
      // latch (_boundVillageId) so a player loitering by the gate costs one
      // write rather than one per tick; a waypoint's latch is a Set, because
      // activation is permanent and per-waypoint rather than a single current
      // value. The id goes into the Set BEFORE the query is issued -- the tick
      // does not await, so a latch set afterwards would let the next tick fire
      // a second INSERT while the first is still in flight, which is the
      // realistic duplicate here rather than the theoretical one.
      //
      // The latch is NOT primed from the database on join, matching
      // _boundVillageId, which is not either. Cost: one no-op INSERT per
      // session per waypoint re-walked. That is cheaper than the query priming
      // would need, and character_waypoints' composite primary key -- not this
      // latch -- is what actually makes a repeat harmless.
      if (entry.waypoints && entry.waypoints.size) {
        for (const p of entry.world.players.values()) {
          const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
          // The SAME function loadWorld keyed the Map with, rather than the
          // inline Math.floor pair the doorway and portal blocks use. Those two
          // sites are one expression apart and still had to be reconciled by
          // hand; here the lookup and the key cannot disagree by construction.
          const wp = entry.waypoints.get(waypointTileKey(cx, cy));
          if (!wp) continue;
          if (!p._litWaypoints) p._litWaypoints = new Set();
          if (p._litWaypoints.has(wp.id)) continue;
          p._litWaypoints.add(wp.id);
          const characterId = p.characterId;
          const userId = p.userId;
          activateWaypoint(pool, characterId, wp.id)
            .then(({ firstTime }) => {
              // Socket looked up AFTER the round trip, never captured before
              // it: a reconnect mid-write would otherwise send this to the dead
              // socket and the new session would never hear about it. Same
              // discipline the auto-loot notify below already follows.
              const ws = entry.sockets.get(userId);
              if (!ws) return;
              // firstTime is the INSERT's own rowCount, i.e. a database fact.
              // A server that merely REMEMBERS having seen this waypoint would
              // get it wrong after a restart, which is exactly when a player
              // would notice a "waypoint discovered" banner for one they lit
              // last week.
              send(ws, { type: 'waypointActivated', waypoint: wp, firstTime });
            })
            .catch((e) => {
              // Drop the latch so the next tick retries: a failed write must
              // not leave the player standing on a waypoint the server has
              // decided it already handled.
              if (p._litWaypoints) p._litWaypoints.delete(wp.id);
              console.error('activateWaypoint', e);
            });
        }
      }
      // aggro/chase/contact damage + respawns (before state). Guard kills route
      // through onCreatureDeath like every other kill site, so the DELETE +
      // drop roll stay authoritative.
      const { kills: killedByGuards } = entry.world.tickCreatures(dt, entry.activeChunks);
      for (const k of dedupeKillsById(killedByGuards)) onCreatureDeath(entry, k.id, k.killerUserId);
      const {
        kills: killedByProjectiles, detonations, stoneHits, blocks,
      } = entry.world.tickProjectiles(dt);
      for (const k of dedupeKillsById(killedByProjectiles)) onCreatureDeath(entry, k.id, k.killerUserId);
      // SOMET-286: a shot that passed through a guard. Blocks ARE impacts on
      // the wire (see authority/vfx.js's blockedImpact), so they go onto the
      // same stash a landed hit does and inherit its cap and its drain --
      // there is no second frame key and no second lifetime.
      pushImpacts(entry, blocks);
      // Magic Stones (SOMET-245) Task 7: a projectile's landed spell-stone
      // hit is only known HERE, at actual impact (see projectiles.js'
      // step()/`_detonate` -- world.js's attack() itself only spawns the
      // shot and cannot know yet whether it will connect). Each entry is a
      // real distinct landed hit (including multiple from one piercing
      // projectile, or multiple targets in one AoE blast) -- no dedup like
      // `kills` needs, since there is no shared id to collide on here.
      for (const h of stoneHits) onStoneHit(h.stoneItemId);
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
            claims.push(claimItem(pool, entry, p.userId, p.characterId, it.id));
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
              // A full inventory is SILENT here, and skipped before the shape
              // test below -- otherwise `{full:true}` would fall through to
              // the else and be sent as a `picked` item the player never got.
              // The sweep re-runs at 20Hz for as long as the player stands
              // near the item, so a toast per result would be a stream of
              // them; the panel's used/capacity counter is where a player
              // learns they are full.
              if (r.value.full) continue;
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
      const imps = drainImpacts(entry);
      const hasImps = imps.length > 0;
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        const frame = { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players, projectiles: snap.projectiles };
        // SOMET-528. `waves` is copied ACROSS EXPLICITLY, and this line is the
        // third place a new snapshot field can be lost.
        //
        // The frame is assembled from a NAMED FIELD LIST, not a spread of
        // `snap`. That is deliberate -- the frame is per-socket and must not
        // leak whatever the snapshot happens to carry -- but it means a field
        // the authority sends and this line does not name vanishes SILENTLY,
        // with the server and the client both correct. SOMET-523 was the same
        // shape one hop later (Game._onWorldState), and the lingering wave hit
        // this hop: world.snapshot() emitted `waves`, worldWaves.js read
        // `waves`, both were unit-tested, and nothing reached the browser.
        //
        // Omitted when empty, like detonations/attacks/impacts below: a quiet
        // tick must cost no bytes.
        if (snap.waves) frame.waves = snap.waves;
        if (hasDets) frame.detonations = dets;
        if (hasAtks) frame.attacks = atks;
        // Omitted entirely when nothing was hit, exactly as detonations and
        // attacks already are -- a quiet tick must cost no bytes.
        if (hasImps) frame.impacts = imps;
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
        // p.characterId, not the map key: the socket map is keyed by account,
        // but world_players is keyed by character.
        if (p) persist(worldId, p.characterId, p).catch(() => {});
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
        onReset: async ({ id, worldId, ...patch }) => {
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
          // Final-review fix (SOMET-244 Critical #1): the respawn sweep's
          // INSERT into world_creatures has the identical gap the `use`
          // handler's field-chest spawn has -- see injectGuardIntoSim's
          // header comment. `await`ed (respawnDueFieldChests now awaits
          // onReset itself) so the `_chestRespawnSweep` test seam observes
          // the new guard in entry.world.creatures once the sweep resolves.
          await injectGuardIntoSim(entry, patch.guardCreatureIds);
        },
      });
    } catch (err) {
      console.error('field chest respawn sweep failed:', err);
    }
  }

  // SOMET-309. getWorld/getPlayers both read the live `worlds` Map and return
  // null/[] for an unloaded world, so the sweep never causes a world to load
  // -- nothing but a socket close handler evicts one, and a sweep-loaded world
  // would stay in memory forever.
  async function creatureRespawnSweep() {
    try {
      await respawnDueCreatures(pool, {
        // Final review, Critical C1: the due-row window is capped and ordered
        // oldest-first, so rows for worlds nobody has loaded must never enter
        // it -- they cannot be actioned, they are never deleted, and they would
        // sit at the head of every pass until the window held nothing else and
        // respawns stopped system-wide. Snapshotted per pass, so a world loaded
        // or evicted between passes is picked up on the next one.
        loadedWorldIds: [...worlds.keys()],
        // The buildWorldGenConfig shape placeMapCreatures requires -- camelCase
        // levelMin/levelMax plus tileTypes -- exactly as chestRespawnSweep
        // passes it. Handing over entry.row instead would throw
        // ('worldConfig: tileTypes is empty') before reaching a placement.
        getWorld: (worldId) => {
          const entry = worlds.get(worldId);
          return entry ? { ...entry.mapGenConfig, id: worldId } : null;
        },
        // Positions come from the live sim, never the database: the persisted
        // character position lags the sim by up to a sync interval, and a
        // stale position is exactly the input that would let a creature spawn
        // in someone's face.
        getPlayers: (worldId) => {
          const entry = worlds.get(worldId);
          if (!entry) return [];
          return [...entry.world.players.values()].map((p) => ({ x: p.x, y: p.y }));
        },
        onSpawn: async ({ worldId, creatureId }) => {
          const entry = worlds.get(worldId);
          if (!entry) return;
          // Despite the name (it predates this feature), injectGuardIntoSim is
          // generic: it re-reads the rows by id through CREATURE_JOINED_SELECT
          // and hands them to creatures.addCreatures. Without it a respawned
          // creature exists in the DB but not in the running sim until the
          // world is reloaded -- present but unkillable.
          await injectGuardIntoSim(entry, [creatureId]);
        },
      });
    } catch (err) {
      console.error('creature respawn sweep failed:', err);
    }
  }

  // SOMET-481: the two inputs a rarity roll needs -- the admin-editable weight
  // table and the affix catalog -- resolved on the sweep cadence, NOT per drop.
  // A query per kill would put game_settings and affix_types on the death
  // path, and an admin's retune reaching live drops within one sweep is fast
  // enough for a tuning knob. Cached on each world entry so spawnDrops and
  // openChest can read them synchronously.
  //
  // The SELECT names every column authority/affixes.js#eligibleAffixes and
  // #affixValue read. A column added to that module and forgotten here comes
  // back undefined and the filter silently stops applying -- the same
  // explicit-column trap loadWorld's own world SELECT carries a warning about.
  //
  // SOMET-482 adds the ground-item TTL to the same refresh, for the same
  // reason and on the same cadence: it is an admin knob, so reading it per
  // drop would put game_settings on the death path, and baking it in at boot
  // would mean a restart before a retune reached a live drop.
  async function refreshLootTuning() {
    if (worlds.size === 0) return;
    const [anchors, affixes, ttlSeconds] = await Promise.all([
      getSetting(pool, 'rarity_weights'),
      // `label` is in the list for SOMET-496: chestLoot.js hands the rolled
      // affixes straight to the client with no second query, and
      // gearAffixes.js captions each gear modifier by label. Without it a
      // chest-opened item's affixes are labelled by their slug until the next
      // reconnect reloads them through loadInventory (which does select it).
      pool.query(`SELECT id, key, label, kind, effect, min_value, max_value,
                         min_item_level, max_item_level, allowed_slots, min_rarity, weight
                    FROM affix_types`),
      getSetting(pool, 'ground_item_ttl_seconds'),
    ]);
    // A junk or non-positive value keeps the PREVIOUS number rather than
    // making every drop vanish instantly or never expire at all: a bad row in
    // game_settings must not be able to empty the world's floor.
    const seconds = Number(ttlSeconds);
    if (Number.isFinite(seconds) && seconds > 0) groundItemTtlMs = Math.round(seconds * 1000);
    for (const entry of worlds.values()) {
      entry.rarityAnchors = anchors;
      entry.affixPool = affixes.rows;
    }
  }

  // Expired ground items: delete from the DB, evict from every live sim, and
  // announce each removal so the client can draw a puff where the item was.
  //
  // Each sim's own removeExpired runs alongside the DB delete so in-sim expiry
  // doesn't lag the sweep; the two are complementary (the DB delete is
  // authoritative across worlds, removeExpired keeps each live sim tidy AND is
  // the only one of the two that still knows where the item stood).
  //
  // A whole function rather than the inline interval body it replaced so
  // `_itemSweep` can drive one pass synchronously in a test instead of racing
  // wall-clock itemSweepMs -- the same seam _chestRespawnSweep already is.
  async function itemSweep() {
    if (worlds.size === 0) return;
    // A failed refresh must not stop the sweep: the entry keeps its last-known
    // tuning (or none, which degrades to plain white drops and the previous
    // TTL) until the next pass.
    await refreshLootTuning().catch((err) => console.error('loot tuning refresh failed:', err));

    const now = Date.now();
    for (const entry of worlds.values()) {
      const removed = entry.world.groundItems.removeExpired(now);
      if (removed.length === 0) continue;
      const N = entry.row.chunk_size;
      // SOMET-482 -- PRESENTATION ONLY. Nothing in this loop touches hp,
      // status effects, knockback or the projectile sim, and
      // ground_despawn_vfx.test.js asserts the ABSENCE of every damage-bearing
      // channel on the frames a despawn produces.
      //
      // Deliberately its own frame rather than a rider on `state`: the state
      // frame is built and drained per TICK, and a despawn happens on the
      // SWEEP cadence. Riding along would mean stashing the puff until the
      // next tick, i.e. a second lifetime to keep in step for a cosmetic cue.
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        if (!p) continue;
        // The same neighbourhood filter broadcastItems uses: a puff for an
        // item three chunks away is bytes for a frame nobody can see.
        const pc = chunkOf(p.x, p.y, N);
        const keys = new Set(neighborhoodKeys(pc.cx, pc.cy, 1));
        for (const it of removed) {
          const ic = chunkOf(it.x, it.y, N);
          if (!keys.has(CHUNK_KEY(ic.cx, ic.cy))) continue;
          send(ws, { type: 'vfx', name: 'item_despawn', x: it.x, y: it.y });
        }
      }
    }

    try {
      const r = await pool.query('DELETE FROM world_items WHERE expires_at <= now() RETURNING id');
      if (r.rowCount) {
        const ids = new Set(r.rows.map((row) => row.id));
        for (const entry of worlds.values()) {
          for (const id of ids) entry.world.groundItems.remove(id);
        }
      }
    } catch (err) {
      console.error('ground item sweep failed:', err);
    }

    chestRespawnSweep();
  }

  const itemSweepTimer = setInterval(() => {
    itemSweep().catch((err) => console.error('item sweep failed:', err));
  }, itemSweepMs);

  const creatureSweepTimer = setInterval(() => {
    // Same guard the item sweep uses: with no world loaded there is nothing
    // this pass could act on, so skip the query entirely.
    if (worlds.size === 0) return;
    creatureRespawnSweep();
  }, creatureSweepMs);

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
    // Test seam, same reasoning as _chestRespawnSweep: run one creature
    // respawn pass synchronously (and await it, unlike the timer's
    // fire-and-forget call) instead of racing wall-clock creatureSweepMs.
    _creatureRespawnSweep: creatureRespawnSweep,
    // SOMET-482 test seams, same reasoning as _chestRespawnSweep: run one
    // ground-item expiry pass (and one tuning refresh) synchronously and await
    // it, instead of racing wall-clock itemSweepMs.
    _itemSweep: itemSweep,
    // SOMET-473 test seam: re-run the joined creature SELECT for specific ids
    // and feed the rows back into the live sim -- the same call a mid-session
    // guard INSERT makes. Exposed so charm_live_db.test.js can prove a
    // PERSISTED charm survives a reload, which is the one thing a unit test
    // over CreatureSim can never show.
    _reloadCreatures: injectGuardIntoSim,
    _refreshLootTuning: refreshLootTuning,
    // Read back the live TTL. A getter, not the value: the whole point of
    // SOMET-482 is that this number CHANGES at runtime, so a test that
    // captured it once could not tell a working refresh from a dead one.
    _groundItemTtlMs: () => groundItemTtlMs,
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
      // Magic Stones (SOMET-245) Task 6: `stats` arrives from
      // progressionRoutes.js, which has no access to this session's
      // inv/itemTypes and so computed it from `progression` alone -- using it
      // as-is here would silently WIPE a buff-stone bonus already live on
      // this player (applied by a prior kill/join/socket) back down to the
      // unbuffed bundle on every allocate/respec. Recompute with the current
      // socketed buff stones folded in, the same way the other three
      // applyDerivedStats call sites do, and push THAT (not the passed-in
      // `stats`) both into the world and onto the wire.
      //
      // SOMET-486: framedStats is what makes the class base pools arrive with
      // the stones rather than being separately remembered here. progression
      // Routes' own derive IS class-aware, but it cannot see this session's
      // sockets, so the recompute stays and must not lose the pools doing it.
      const buffed = framed(entry, uid, progression);
      entry.world.applyDerivedStats(uid, buffed.stats);
      const sock = entry.sockets.get(uid);
      if (sock) send(sock, { type: 'progression', progression: buffed.progression, stats: buffed.stats });
      return true;
    },
    close() {
      clearInterval(tickTimer);
      clearInterval(flushTimer);
      clearInterval(creatureFlushTimer);
      clearInterval(heartbeatTimer);
      clearInterval(itemSweepTimer);
      clearInterval(creatureSweepTimer);
      // Terminate any live client sockets before closing the server. wss.close()
      // alone only stops accepting new connections; open sockets would keep the
      // event loop alive (and hang a clean shutdown / test process).
      //
      // KNOWN GAP, deliberately not closed here (SOMET-294 review): terminate()
      // does not await the 'close' handlers it triggers, and index.js installs
      // no SIGTERM/SIGINT drain, so a restart drops whatever position and bind
      // movement is still inside its write floor -- up to BIND_WRITE_MIN_MS of
      // it. Pre-existing for `persist`; the bind checkpoint now rides the same
      // path. Closing it properly means an async, awaited shutdown drain wired
      // through index.js's signal handling, which is a session-lifecycle change
      // rather than a fix to this slice.
      for (const client of wss.clients) client.terminate();
      wss.close();
      sessionsByUser.clear();
    },
  };
}

module.exports = {
  attachAuthority, planTransition, suppressArrivalDoorway, planBind,
  nearestMerchantVillage, INTERACT_RADIUS,
  planPortalTransition, isPortalBlocked, knockbackPosition,
  // SOMET-290: exported so a DB test can query the EXACT text the live sim
  // reads (activateChunk / injectGuardIntoSim both share this one constant)
  // against a real world_creatures fixture, rather than retyping a third
  // copy of it that could silently drift from what actually runs -- the same
  // drift SOMET-249 already shipped once between this query and
  // loadCreatureTypes's separate one in creatures.js.
  CREATURE_JOINED_SELECT,
  // Stash internals, exported for unit test only. Not part of the module's API.
  __test: { pushAttacks, drainAttacks, MAX_PENDING_ATTACKS },
};
