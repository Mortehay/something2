const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { attachAuthority } = require('./authority/server');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { generateWorld, placeEntities, detectPathTile, uniqueTileNames, generateChunk, generateChunkDecorations, generateWorldPreview, isBoundedWorld, CREATURE_TILE_PX, generateWorldOverview, overviewOrigin } = require('./services/mapService');
const { fetchLinks, setLink, clearLink } = require('./services/mapLinks');
const { fetchVillages, createVillage, insertVillageGuards, GUARD_TYPE, VILLAGE_LIMITS } = require('./services/villages');
const { seedItemAcrossVillages } = require('./services/merchantStock');
const { populateWorld } = require('./services/worldPopulation');
const { MAX_WORLD_CREATURES } = require('./services/densityTiers');
const { loadDecorationDefs } = require('./services/decorationDefs');
const { loadBiomes } = require('./services/biomes');
const { composeBiomePrompt } = require('./services/biomePrompt');
const { buildWorldGenConfig } = require('./services/worldGenConfig');
const { loadTileTypes } = require('./services/tileTypes');
const { ATTACK_KINDS, CHASE_STYLES, ELEMENTS } = require('./services/creatureBehaviors');
const { ABILITIES_LATERAL } = require('./authority/creatures');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3101;

// Helper to get tile types in the format expected by the game engine.
// One-line adapter over services/tileTypes.js's loadTileTypes so the ~dozen
// existing call sites below keep working unchanged.
const getTileTypesMap = () => loadTileTypes(pool);

// Middleware
//
// exposedHeaders: the API is cross-origin (frontend :15173 -> backend
// :13101), and per the Fetch spec a cross-origin response only exposes the
// safelisted response headers (content-type, content-length, etc.) to JS
// unless the server explicitly lists more via Access-Control-Expose-Headers
// -- plain cors() never sets that header. X-Live-World-Pending
// (F-017/SOMET-197's liveWarning signal on the two 204 routes, see
// evictOrWarn below) was invisible to the browser as a result: confirmed
// live, a fetch from the running app saw only content-length/content-type,
// and useMapsAdmin.js's `res.headers.get('X-Live-World-Pending')` read null
// even though the server demonstrably sent it -- silently dropping the
// warning that a village-delete/link-clear edit did not reach a connected
// player's live session.
app.use(cors({ exposedHeaders: ['X-Live-World-Pending'] }));

// A modest global rate limit in front of the whole router (SOMET-189 /
// F-009). /api/auth already has its own tighter, credential-aware limiter
// (auth/routes.js authRateLimiter); this one is the backstop for every other
// route, none of which had any limiter at all. Factored out (default limit
// applied below) so a test can build a much lower-ceiling instance on a
// scratch app instead of firing 300 real requests to prove it works.
function apiRateLimiter(limit = 300, windowMs = 60 * 1000) {
  return rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false });
}
app.use(apiRateLimiter());

// Body-size ceiling (SOMET-189 / F-009). express.json/urlencoded ran as
// app-level middleware ahead of routing AND ahead of every auth guard at a
// 50mb limit, so it applied to unauthenticated requests against ANY path --
// including ones with no route at all. Confirmed live: a single
// unauthenticated ~44MB JSON POST to /api/health (a route that accepts no
// body) was fully buffered and parsed before the 404 was produced, and
// backend RSS jumped from ~37MiB to ~181MiB for that one request.
//
// 256kb comfortably covers every route's legitimate payload except the
// map-entities bulk upload, which needs headroom for a full map's obstacle
// array. That route gets its own larger, path-scoped parser registered
// FIRST: body-parser no-ops on a second parse attempt once req._body is set
// (node_modules/body-parser/lib/types/json.js), so registering the tighter
// global limit first would silently pre-empt any larger per-route override
// declared later inside the route itself -- the ordering here, not just the
// limit, is what makes the exception real.
const ENTITY_UPLOAD_PATH = '/api/maps/:id/entities';
app.use(ENTITY_UPLOAD_PATH, express.json({ limit: '10mb' }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ limit: '256kb', extended: true }));

// Database setup
let pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
// Test seam: lets tests swap in a mock pool so routes don't need a live DB.
const __setPool = (impl) => { pool = impl; };

// Guards and auth routes must see the CURRENT pool (tests swap it via
// __setPool), so hand them a proxy that forwards to the live `pool` binding
// rather than whatever value existed at module-load time. `connect` is
// included (not just `query`) because progressionStore.respec opens its own
// transaction via pool.connect() -- without it, a router built from this
// proxy would work for every other route and only fail, at request time, the
// moment a real respec call was made.
const guardPool = {
  query: (sql, params) => pool.query(sql, params),
  connect: (...args) => pool.connect(...args),
};
const { requireAdmin } = require('./auth/middleware.js');
const { assertJwtSecretOrExit } = require('./auth/assertJwtSecret.js');
const authRouter = require('./auth/routes.js');
const progressionRoutes = require('./api/progressionRoutes.js');
// Single admin guard applied to every mutating admin route below.
const adminGuard = requireAdmin(guardPool);

// Job ids returned by sprite-gen's /generate. These three routes proxy an
// unauthenticated :jobId straight into a sprite-gen path segment (services/
// spriteGen.js getJob), so a caller who slips in an encoded "../" can escape
// /jobs/ and reach arbitrary GET endpoints on the internal service (SOMET-182).
// Reject anything that isn't a bare job id before it ever reaches the proxy.
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Shared cap for the "name" field on every admin catalog (tile-types,
// entity-types, item-types, worlds) (SOMET-223 / F-043). Without this, a
// pathologically long name either raw-500s the generic catch-all on a
// varchar(255) column (tile_types, entity_types) or is silently accepted
// with no limit on a text column (item_types, worlds) -- confirmed live: a
// 10,000-character name 500'd on tile-types/entity-types and was persisted
// verbatim on item-types/worlds. Neither is "rejected, not truncated or
// 500'd", which is what an admin should see from any of the four identical
// "Name" text fields.
const MAX_CATALOG_NAME_LEN = 200;
function catalogNameTooLong(name) {
  return typeof name === 'string' && name.length > MAX_CATALOG_NAME_LEN;
}

// Postgres unique_violation. worlds.name gained a unique constraint
// (SOMET-224 / F-044, migration 1714440037000) matching the one
// tile_types/entity_types/item_types have always had; this turns the raw
// constraint error into a clean 409 instead of the generic 500 catch-all.
function isUniqueViolation(err) {
  return !!err && err.code === '23505';
}

// A route param destined for an `id` (integer, serial-PK) column. Express
// hands every :id through as a string with no type coercion, so a
// non-numeric value (or a float like "1.5") used to reach Postgres as-is and
// come back as a raw integer-cast 500 instead of a 400 naming the actual
// problem (SOMET-254, first fixed for /api/creature-behaviors).
function invalidId(id) {
  return !/^[0-9]+$/.test(String(id));
}

// Upper bound for PUT /api/worlds/:id creature_count (SOMET-188 / F-008).
// ONE number, defined in densityTiers.js: that is where it now does the real
// work, clamping the count resolveDensity hands to both population callers.
// Two literal 2000s would let the API's advertised limit and the limit
// actually enforced during placement drift apart.
const MAX_CREATURE_COUNT = MAX_WORLD_CREATURES;
// Upper bound for POST /api/maps/generate rows/cols. This route eagerly
// builds an rows*cols in-memory array and JSON.stringifies the whole thing
// into a single row, unlike chunked worlds -- an unvalidated 100000x100000
// request exhausts the heap (SOMET-188 / F-008).
const MAX_MAP_DIM = 500;

// World preview memo
const PREVIEW_DIM = 64;
const worldPreviewCache = new Map(); // world_id -> data (dim x dim biome+path grid)

// World overview memo (player-centered minimap window, SOMET minimap HUD)
const OVERVIEW_SPAN = 256;   // tiles per side of the player-centered window
const OVERVIEW_STEP = 4;     // downsample factor -> 64x64 coarse cells
// Unlike worldPreviewCache (one entry per world), a roaming player can mint one
// overview entry per 64-tile snap region, unbounded across every world/player
// on a long-running server -- so this cache needs a size cap (SOMET minimap
// HUD final review).
const OVERVIEW_CACHE_MAX = 64;
const worldOverviewCache = new Map(); // "worldId:snappedCol:snappedRow" -> payload

function clearOverviewCache(worldId) {
  for (const key of worldOverviewCache.keys()) {
    if (key.startsWith(`${worldId}:`)) worldOverviewCache.delete(key);
  }
}

// Insert into a Map with a FIFO size cap: once it exceeds `max`, evict the
// oldest-inserted entry (Map preserves insertion order). Re-setting an
// existing key updates its value without evicting anything.
function boundedCacheSet(map, key, value, max) {
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return map;
}

// Handle to the running authority (set only when this module is the entrypoint;
// null under tests, or under a test that injects a fake one via
// __setAuthorityHandle — see the F-017/SOMET-197 tests). Lets admin mutations
// evict an idle cached world so its next load re-reads regenerated
// terrain/creatures from the DB.
let authorityHandle = null;
const __setAuthorityHandle = (impl) => { authorityHandle = impl; };
function evictAuthorityWorld(worldId) {
  return authorityHandle?.evictWorld?.(worldId) ?? false;
}
// True iff `worldId` is currently loaded in the live authority AND has a
// connected player. evictWorld() returning false is ambiguous — it means
// EITHER "nothing was loaded" (fine: the DB is the source of truth, the next
// join reads the fresh row) OR "a player is connected, so the eviction was
// refused" (not fine: that world's live simulation just went stale). This
// distinguishes the two so a caller can warn only in the second case.
function isWorldLive(worldId) {
  return authorityHandle?.isWorldLive?.(worldId) ?? false;
}
// Pushes a progression HTTP API write (allocate, respec — SOMET-242) into the
// live authority session, same `?.` fallback idiom as the two helpers above:
// authorityHandle is null under every test that mounts the app without a
// real authority attached, and this must never turn that absence into a 500.
// See authority/server.js's refreshPlayerStats for what "reflected live"
// actually means (world stat update + a pushed 'progression' message) and
// its hp<=0 guard.
function refreshLivePlayerStats(userId, progression, stats) {
  return authorityHandle?.refreshPlayerStats?.(userId, progression, stats) ?? false;
}
// A world-content admin mutation calls this right after its own DB writes.
// Returns a warning string when the edit could NOT reach a live simulation
// (a player is connected, so evictWorld refused), or undefined when there is
// nothing to warn about — either the eviction succeeded or the world was
// never loaded in the first place. Every one of these mutations previously
// discarded evictWorld's return value outright and replied with a plain
// success, so a re-roll (or village/link edit) against a world with even one
// player online silently never reached that player's live session (F-017 /
// SOMET-197) — confirmed live via the real admin re-roll route, with a
// stronger consequence than the finding's own repro: a sustained
// hp-oscillating death loop against ~1600 creatures the DB no longer had,
// and zero drops/gold on every kill (commitCreatureDeath's DELETE matched no
// row). This does not make the live simulation reconcile itself — the DB
// write already happened either way — it only stops the admin response from
// lying about whether that write actually reached the world people are
// playing in.
function evictOrWarn(worldId) {
  if (evictAuthorityWorld(worldId)) return undefined;
  return isWorldLive(worldId)
    // The DB write already happened; only the live authority is stale. The
    // caller (invalidateWorld) also deletes this world's cached chunks as
    // part of the same edit, so a connected client can go on to refetch NEW
    // terrain from a REST route while the authority's WebSocket session
    // keeps serving its old, frozen map -- the two would then visibly
    // disagree, not just "not yet be updated". Say so plainly, and say what
    // fixes it (the world must empty and be reloaded), rather than wording
    // that reads as "this edit was simply skipped, nothing else to know".
    ? 'a player is connected to this world; the running simulation is still serving the old, pre-edit map and will not reflect this change until the world is emptied and reloaded'
    : undefined;
}

// Sprite-gen HTTP bridge (mutable holder so tests can mock the outbound calls).
let spriteGen = require('./services/spriteGen');
const __setSpriteGen = (impl) => { spriteGen = impl; };
const assetStore = require('./services/assetStore');

const runner = require('node-pg-migrate').default;

// Run migrations
async function runMigrations() {
  try {
    await runner({
      databaseUrl: process.env.DATABASE_URL,
      dir: path.join(__dirname, '..', 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: true,
    });
    console.log('Migrations completed successfully');
  } catch (err) {
    console.error('Migration error:', err);
  }
}

// Only run migrations (and later, app.listen) when this file is executed
// directly, not when it's required (e.g. by tests importing `app`). Same
// guard protects the JWT_SECRET boot check: tests import `app` with their
// own short, deterministic secret and must not trip it.
if (require.main === module) {
  assertJwtSecretOrExit();
  runMigrations();
}

// Decoration defs for GET /chunk's generateChunkDecorations call. Shared with
// authority/server.js via services/decorationDefs.js so the REST preview and
// the authority's blocking overlay place decorations identically (see that
// file for why the ORDER BY matters).

// Helper to get entity types
async function getEntityTypesMap() {
  const result = await pool.query('SELECT * FROM entity_types ORDER BY id ASC');
  const entityTypes = {};
  result.rows.forEach(row => {
    entityTypes[row.name] = {
      id: row.id,
      color: row.color,
      walkable: row.walkable,
      spawnTiles: row.spawn_tiles || [],
      chance: row.chance,
      strength: row.strength,
      dexterity: row.dexterity,
      constitution: row.constitution,
      intelligence: row.intelligence,
      wisdom: row.wisdom,
      charisma: row.charisma,
      hp: row.hp,
      maxHp: row.max_hp,
      hpRegenRate: row.hp_regen_rate,
      mana: row.mana,
      maxMana: row.max_mana,
      manaRegenRate: row.mana_regen_rate,
      image: row.image,
      displayWidth: row.display_width,
      displayHeight: row.display_height,
      isCreature: row.is_creature,
      // Visual fields the renderer needs to draw a generated sprite instead of
      // a flat rectangle. Omitting these was why approved entity textures never
      // showed up in game (tile_types has always exposed its equivalents).
      render_mode: row.render_mode,
      sprite: row.sprite,
      prompt: row.prompt,
      // See getTileTypesMap: versions the client's asset URLs so an approved
      // regeneration is fetched instead of served stale from the browser cache.
      updated_at: row.updated_at,
      place_order: row.place_order ?? 0
    };
  });
  return entityTypes;
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Authentication routes: register / login / logout-all / me / admin role.
app.use('/api/auth', authRouter(guardPool));

// Character-sheet API (SOMET-242): GET the derived progression bundle, POST
// an allocation or a respec. Every route is behind requireAuth and acts on
// req.user.id -- see api/progressionRoutes.js's header comment.
app.use('/api/progression', progressionRoutes(guardPool, refreshLivePlayerStats));

// The /api/dev-token endpoint was removed: it minted a correctly-signed JWT for
// any user_id with no credentials — a verified account-takeover primitive.
// Use POST /api/auth/login instead.

// List all maps
app.get('/api/maps', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        m.id, m.name, m.description, m.created_at, m.updated_at,
        EXISTS(SELECT 1 FROM map_entities me WHERE me.map_id = m.id) as has_entities
      FROM maps m 
      ORDER BY m.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch maps' });
  }
});

// List all map configuration (tiles + entities)
app.get('/api/map/config', async (req, res) => {
  try {
    const tileTypes = await getTileTypesMap();
    const entityTypes = await getEntityTypesMap();
    res.json({ tileTypes, entityTypes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch map configuration' });
  }
});

// List all map tiles (legacy/backward compatibility)
app.get('/api/map/tiles', async (req, res) => {
  try {
    const tileTypes = await getTileTypesMap();
    res.json(tileTypes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch map tiles' });
  }
});

// Mirrors the entity_types_attack_element_check CHECK constraint (migration
// 1714440081000) so a bad value is a readable 400 rather than a raw 500 from
// the constraint -- render_mode on these same two routes has no such check
// (SOMET-254 leaves that pre-existing gap as-is; it is a free-form column
// with no CHECK constraint to mirror). behavior_id is a real integer FK into
// creature_behaviors from that same migration: a non-numeric value (e.g. a
// string) reaches Postgres as a cast error before it ever reaches the FK
// check, so this catches that class of input; whether the id actually names
// a row is left to the FK constraint itself; the resulting 500 there is a
// pre-existing, out-of-scope gap noted in the DELETE /api/creature-behaviors
// handler below.
function entityTypeFieldError(body) {
  if (body.attack_element != null && !ELEMENTS.includes(body.attack_element)) {
    return `attack_element must be one of ${ELEMENTS.join(', ')}`;
  }
  if (body.behavior_id != null
      && (typeof body.behavior_id !== 'number' || !Number.isInteger(body.behavior_id))) {
    return 'behavior_id must be an integer';
  }
  return null;
}

// Entity Types CRUD
app.get('/api/entity-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM entity_types ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch entity types' });
  }
});

app.post('/api/entity-types', adminGuard, async (req, res) => {
  try {
    const {
      name, color, walkable, spawn_tiles, chance,
      strength, dexterity, constitution, intelligence, wisdom, charisma,
      hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image,
      display_width, display_height, render_mode, is_creature, prompt, place_order,
      behavior_id, attack_element
    } = req.body;
    if (!name || !color) return res.status(400).json({ error: 'Name and color are required' });
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }
    const fieldErr = entityTypeFieldError(req.body);
    if (fieldErr) return res.status(400).json({ error: fieldErr });

    const result = await pool.query(
      `INSERT INTO entity_types (
        name, color, walkable, spawn_tiles, chance,
        strength, dexterity, constitution, intelligence, wisdom, charisma,
        hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image,
        display_width, display_height, render_mode, is_creature, prompt, place_order,
        behavior_id, attack_element
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26) RETURNING *`,
      [
        name, color, walkable ?? false, JSON.stringify(spawn_tiles || []), chance ?? 0.1,
        strength ?? 0, dexterity ?? 0, constitution ?? 0, intelligence ?? 0, wisdom ?? 0, charisma ?? 0,
        hp ?? 0, max_hp ?? 0, hp_regen_rate ?? 0, mana ?? 0, max_mana ?? 0, mana_regen_rate ?? 0, image,
        display_width, display_height, render_mode ?? 'rect', is_creature ?? false, prompt ?? '', Number(place_order) || 0,
        behavior_id ?? null, attack_element || 'physical'
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create entity type' });
  }
});

app.put('/api/entity-types/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, color, walkable, spawn_tiles, chance,
      strength, dexterity, constitution, intelligence, wisdom, charisma,
      hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image,
      display_width, display_height, render_mode, is_creature, prompt, place_order,
      behavior_id, attack_element
    } = req.body;
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }
    const fieldErr = entityTypeFieldError(req.body);
    if (fieldErr) return res.status(400).json({ error: fieldErr });

    // SOMET-254 follow-up: `behavior_id ?? null` alone can't tell "field
    // omitted from the request" (must COALESCE against the existing row,
    // per the fix below) apart from "field explicitly sent as null" (must
    // actually clear it) -- both normalize to the same JS value. But
    // EntityTypesAdmin.jsx's "-- none (default Line behavior) --" option
    // (line ~1258) legitimately submits behavior_id: null to clear an
    // override back to none, and a `?? null` COALESCE silently discards
    // that clear (200 OK, DB keeps the old value). `'in'` on the parsed
    // JSON body is the reliable way to see a present-but-null key --
    // JSON.parse never yields `undefined` for one, so this can't be
    // spoofed by an absent key. attack_element does NOT get the same
    // treatment: the column is NOT NULL with a CHECK constraint (migration
    // 1714440081000) and the admin UI's Attack Element <select> has no
    // "none" option -- it only ever submits one of ATTACK_ELEMENTS, so
    // there is no legitimate clear-to-null action to preserve here, and an
    // explicit null would just fail the NOT NULL constraint anyway.
    const behaviorIdProvided = 'behavior_id' in req.body;

    // SOMET-185: worlds.allowed_creature_types and world_creatures.type
    // reference entity_types by NAME (no FK), so a free rename here silently
    // orphans them — a creature re-roll on an affected world then matches
    // zero rows and reports {"placed": 0} with no error, and the GUARD_TYPE =
    // 'Village Guard' guard-sparing clause (index.js's insertVillageGuards
    // callers) stops matching, so a re-roll wipes every village guard.
    // Block a rename that would break an outstanding reference rather than
    // silently orphaning it.
    if (name != null) {
      const cur = await pool.query('SELECT name FROM entity_types WHERE id = $1', [id]);
      if (cur.rows.length === 0) return res.status(404).json({ error: 'Entity type not found' });
      const oldName = cur.rows[0].name;
      if (oldName !== name) {
        const [worldsRef, creaturesRef, biomesRef] = await Promise.all([
          pool.query('SELECT id, name FROM worlds WHERE allowed_creature_types @> $1::jsonb', [JSON.stringify([oldName])]),
          pool.query('SELECT 1 FROM world_creatures WHERE type = $1 LIMIT 1', [oldName]),
          // biomes.flora_types / creature_types reference entity_types by name
          // with no FK, exactly like allowed_creature_types above. A rename
          // that orphans them silently strips that biome's flora or fauna.
          pool.query(
            'SELECT id, name FROM biomes WHERE flora_types @> $1::jsonb OR creature_types @> $1::jsonb',
            [JSON.stringify([oldName])],
          ),
        ]);
        if (worldsRef.rows.length > 0 || creaturesRef.rows.length > 0 || biomesRef.rows.length > 0) {
          return res.status(409).json({
            error: `Cannot rename '${oldName}': still referenced by allowed_creature_types, placed creatures, or a biome`,
            referencing_worlds: worldsRef.rows.map((w) => ({ id: w.id, name: w.name })),
            referencing_biomes: biomesRef.rows.map((b) => ({ id: b.id, name: b.name })),
            has_placed_creatures: creaturesRef.rows.length > 0,
          });
        }
      }
    }

    const result = await pool.query(
      `UPDATE entity_types SET
        name = $1, color = $2, walkable = $3, spawn_tiles = $4, chance = $5,
        strength = $6, dexterity = $7, constitution = $8, intelligence = $9, wisdom = $10, charisma = $11,
        hp = $12, max_hp = $13, hp_regen_rate = $14, mana = $15, max_mana = $16, mana_regen_rate = $17,
        image = $18, display_width = $19, display_height = $20, render_mode = $21, is_creature = $22,
        prompt = COALESCE($23, prompt), place_order = $24,
        behavior_id = CASE WHEN $27::boolean THEN $25 ELSE entity_types.behavior_id END,
        attack_element = COALESCE($26, entity_types.attack_element),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $28 RETURNING *`,
      [
        name, color, walkable, JSON.stringify(spawn_tiles), chance,
        strength, dexterity, constitution, intelligence, wisdom, charisma,
        hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image,
        display_width, display_height, render_mode ?? 'rect', is_creature ?? false,
        // behavior_id/attack_element: SOMET-254 -- a PUT that omits either
        // field must leave the existing value alone (COALESCE against the
        // current row above), same posture prompt already has on this same
        // line and for the same reason: `?? null`/`?? null` here, not
        // `?? null`/`|| 'physical'`, so an omitted field passes NULL and
        // never reaches the fallback-to-default branch that used to silently
        // demote the creature's profile or reset its element on a partial
        // write. behavior_id additionally needs $27 (behaviorIdProvided) in
        // the CASE above so an *explicit* null (the "clear to none" action)
        // isn't swallowed by the same COALESCE that protects an omitted one
        // -- see the comment above entityTypeFieldError's call site.
        // behaviorIdProvided sits before id, not after, so `id` stays the
        // last element of this array -- entityTypes.test.js asserts
        // `params[params.length - 1]` is the id on this exact route.
        prompt ?? null, Number(place_order) || 0, behavior_id ?? null, attack_element ?? null,
        behaviorIdProvided, id
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entity type not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update entity type' });
  }
});

app.delete('/api/entity-types/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM entity_types WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entity type not found' });
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete entity type' });
  }
});


// Item Types CRUD + admin item grant
const ITEM_ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const ITEM_SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

// Mirror the DB CHECKs so the API returns 400 instead of a constraint error.
function validateItemType(b) {
  if (!b.name) return 'Name is required';
  if (catalogNameTooLong(b.name)) return `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer`;
  if (!['weapon', 'armor', 'ammo'].includes(b.category)) return "category must be 'weapon', 'armor' or 'ammo'";
  if (b.element != null && !ITEM_ELEMENTS.includes(b.element)) return `element must be one of ${ITEM_ELEMENTS.join(', ')}`;
  if (b.slot != null && !ITEM_SLOTS.includes(b.slot)) return `slot must be one of ${ITEM_SLOTS.join(', ')}`;
  if (b.resistances) {
    for (const [k, v] of Object.entries(b.resistances)) {
      if (!ITEM_ELEMENTS.includes(k)) return `resistances key '${k}' is not a known element`;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        return `resistances.${k} must be a finite number between 0 and 1`;
      }
    }
  }
  if (b.kind != null && !['melee', 'projectile'].includes(b.kind)) {
    return "kind must be 'melee' or 'projectile' (or unset)";
  }
  if (b.category === 'weapon') {
    if (!['melee', 'projectile'].includes(b.kind)) return "weapon kind must be 'melee' or 'projectile'";
    if (b.kind === 'melee' && (b.reach == null || b.arc_width == null)) return 'melee weapons need reach and arc_width';
    if (b.kind === 'projectile' && (b.range == null || b.projectile_speed == null || b.projectile_radius == null)) {
      return 'projectile weapons need range, projectile_speed and projectile_radius';
    }
  } else if (b.category === 'ammo') {
    if (b.stackable !== true) return 'ammo must be stackable';
    if (b.kind != null) return 'ammo must not have a kind';
  } else {
    if (b.slot == null || b.defense == null) return 'armor needs slot and defense';
  }
  if (b.stamina_cost != null) {
    if (typeof b.stamina_cost !== 'number' || !Number.isFinite(b.stamina_cost) || b.stamina_cost < 0) {
      return 'stamina_cost must be a non-negative finite number';
    }
  }
  if (b.aoe_radius != null) {
    if (typeof b.aoe_radius !== 'number' || !Number.isFinite(b.aoe_radius) || b.aoe_radius < 0) {
      return 'aoe_radius must be a non-negative finite number';
    }
  }
  if (b.ammo_type_id != null) {
    if (typeof b.ammo_type_id !== 'number' || !Number.isFinite(b.ammo_type_id) || b.ammo_type_id < 0) {
      return 'ammo_type_id must be a non-negative finite number';
    }
  }
  if (b.value != null) {
    if (typeof b.value !== 'number' || !Number.isInteger(b.value) || b.value < 0) {
      return 'value must be a non-negative integer';
    }
  }
  // Mirrors item_types_knockback_check (SOMET-253 Task 9). Not gated to
  // category === 'weapon': the column itself carries no such gate (it stays
  // at its default 0 on armor/ammo, exactly like damage/cooldown already do).
  if (b.knockback != null) {
    if (typeof b.knockback !== 'number' || !Number.isFinite(b.knockback) || b.knockback < 0) {
      return 'knockback must be a non-negative finite number';
    }
  }
  // Mirror the DB CHECKs: a detonating projectile can't also pierce, and only
  // a projectile weapon can consume ammo.
  if (b.aoe_radius != null && b.pierce > 1) {
    return 'aoe_radius and pierce > 1 are mutually exclusive';
  }
  if (b.ammo_type_id != null && b.kind !== 'projectile') {
    return 'ammo_type_id is only valid on a projectile weapon';
  }
  return null;
}

app.get('/api/item-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM item_types ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch item types' });
  }
});

app.post('/api/item-types', adminGuard, async (req, res) => {
  try {
    const b = req.body;
    const bad = validateItemType(b);
    if (bad) return res.status(400).json({ error: bad });
    const result = await pool.query(
      `INSERT INTO item_types
        (name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
         range, projectile_speed, projectile_radius, pierce, mana_cost, stamina_cost, element, defense, resistances, icon,
         stackable, ammo_type_id, aoe_radius, value, knockback)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
      [b.name, b.category, b.slot ?? null, b.two_handed ?? false, b.kind ?? null,
       b.damage ?? 0, b.cooldown ?? 0, b.reach ?? null, b.arc_width ?? null,
       b.range ?? null, b.projectile_speed ?? null, b.projectile_radius ?? null, b.pierce ?? null,
       b.mana_cost ?? 0, b.stamina_cost ?? 0, b.element ?? null, b.defense ?? null,
       JSON.stringify(b.resistances ?? {}), b.icon ?? null,
       b.stackable ?? false, b.ammo_type_id ?? null, b.aoe_radius ?? null, b.value ?? 0, b.knockback ?? 0],
    );
    const row = result.rows[0];
    // SOMET-186 / F-006: without this, a weapon/armor type created after a
    // village exists never reaches that village's shop -- seedBaseCatalog
    // only ever ran once, at village creation. Backfill it into every
    // existing village now instead of leaving that permanently missing.
    await seedItemAcrossVillages(pool, row.id);
    res.status(201).json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create item type' });
  }
});

app.put('/api/item-types/:id', adminGuard, async (req, res) => {
  try {
    const b = req.body;
    const bad = validateItemType(b);
    if (bad) return res.status(400).json({ error: bad });
    const result = await pool.query(
      `UPDATE item_types SET
        name=$1, category=$2, slot=$3, two_handed=$4, kind=$5, damage=$6, cooldown=$7,
        reach=$8, arc_width=$9, range=$10, projectile_speed=$11, projectile_radius=$12,
        pierce=$13, mana_cost=$14, stamina_cost=$15, element=$16, defense=$17, resistances=$18, icon=$19,
        stackable=$20, ammo_type_id=$21, aoe_radius=$22, value=$23, knockback=$24,
        updated_at=now()
       WHERE id=$25 RETURNING *`,
      [b.name, b.category, b.slot ?? null, b.two_handed ?? false, b.kind ?? null,
       b.damage ?? 0, b.cooldown ?? 0, b.reach ?? null, b.arc_width ?? null,
       b.range ?? null, b.projectile_speed ?? null, b.projectile_radius ?? null, b.pierce ?? null,
       b.mana_cost ?? 0, b.stamina_cost ?? 0, b.element ?? null, b.defense ?? null,
       JSON.stringify(b.resistances ?? {}), b.icon ?? null,
       b.stackable ?? false, b.ammo_type_id ?? null, b.aoe_radius ?? null, b.value ?? 0, b.knockback ?? 0,
       req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item type not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update item type' });
  }
});

app.delete('/api/item-types/:id', adminGuard, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM item_types WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item type not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete item type' });
  }
});

// Admin grant: give a user an instance of an item type.
app.post('/api/players/:userId/items', adminGuard, async (req, res) => {
  try {
    const { item_type_id } = req.body;
    if (item_type_id == null) return res.status(400).json({ error: 'item_type_id is required' });
    const result = await pool.query(
      'INSERT INTO player_items (user_id, item_type_id) VALUES ($1,$2) RETURNING *',
      [req.params.userId, item_type_id],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to grant item' });
  }
});

// VFX effect library. Read-only and unauthenticated: every client needs it to
// draw an attack. Admin CRUD lands in slice E.
app.get('/api/vfx-effects', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vfx_effects ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vfx effects' });
  }
});

// Tile Types CRUD
app.get('/api/tile-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tile_types ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tile types' });
  }
});

app.post('/api/tile-types', adminGuard, async (req, res) => {
  try {
    const { name, color, walkable, speed, image, valid_neighbors, prompt, wall_height, place_order } = req.body;

    // Simple validation
    if (!name || !color) {
      return res.status(400).json({ error: 'Name and color are required' });
    }
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }

    const result = await pool.query(
      'INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors, prompt, wall_height, place_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [name, color, walkable ?? true, speed ?? 1.0, image || '', JSON.stringify(valid_neighbors || []), prompt || '', Number(wall_height) || 0, Number(place_order) || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create tile type' });
  }
});

app.put('/api/tile-types/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color, walkable, speed, image, valid_neighbors, prompt, wall_height, place_order } = req.body;
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }

    // tile_types.name is referenced by entity_types.spawn_tiles and
    // biomes.terrain_tiles, both jsonb name arrays with no FK (F-027 /
    // SOMET-207). A free rename orphans them silently: the entity stops
    // spawning and the biome quietly loses that terrain.
    if (name != null) {
      const cur = await pool.query('SELECT name FROM tile_types WHERE id = $1', [id]);
      if (cur.rows.length === 0) return res.status(404).json({ error: 'Tile type not found' });
      const oldName = cur.rows[0].name;
      if (oldName !== name) {
        const [entityRef, biomeRef] = await Promise.all([
          pool.query('SELECT id, name FROM entity_types WHERE spawn_tiles @> $1::jsonb', [JSON.stringify([oldName])]),
          pool.query('SELECT id, name FROM biomes WHERE terrain_tiles @> $1::jsonb', [JSON.stringify([oldName])]),
        ]);
        if (entityRef.rows.length > 0 || biomeRef.rows.length > 0) {
          return res.status(409).json({
            error: `Cannot rename '${oldName}': still referenced by an entity type's spawn tiles or a biome`,
            referencing_entity_types: entityRef.rows.map((e) => ({ id: e.id, name: e.name })),
            referencing_biomes: biomeRef.rows.map((b) => ({ id: b.id, name: b.name })),
          });
        }
      }
    }

    // image/render_mode/sprite are owned by the generate+approve flow, NOT this
    // property-edit form. The form captures `image` at modal-open (often empty,
    // before the user approves a texture), so writing it verbatim would clobber a
    // just-approved texture back to ''. COALESCE(NULLIF(...)) preserves the stored
    // image when the form sends '' or nothing; an explicit key still updates it.
    const result = await pool.query(
      "UPDATE tile_types SET name = $1, color = $2, walkable = $3, speed = $4, image = COALESCE(NULLIF($5, ''), image), valid_neighbors = $6, prompt = $7, wall_height = $8, place_order = $9, updated_at = CURRENT_TIMESTAMP WHERE id = $10 RETURNING *",
      [name, color, walkable, speed, image, JSON.stringify(valid_neighbors), prompt || '', Number(wall_height) || 0, Number(place_order) || 0, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tile type not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update tile type' });
  }
});

app.delete('/api/tile-types/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM tile_types WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tile type not found' });
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete tile type' });
  }
});

// --- Creature Behaviors -----------------------------------------------------
// The behaviour catalog that drives CreatureSim's chase style, aggro/leash,
// and (via the nested `abilities` array, SOMET-253) its attacks.
// services/creatureBehaviors.js resolves both tables into one object the sim
// consumes. Read is unauthenticated for the same reason /api/vfx-effects is:
// it is catalog data with nothing private in it. Writes are admin-guarded.
//
// As of SOMET-253 Task 3, an ability is managed NESTED under its behaviour
// rather than as its own CRUD resource: two validation rules span both
// tables (see behaviorAbilitiesError below), and a nested write is what lets
// them be checked atomically instead of in a race between two requests. The
// parent row's own attack_kind/attack_range/attack_cooldown/
// projectile_speed/projectile_radius columns are gone (migration
// 1714440084000) -- the attack lives entirely in creature_abilities now.
//
// Mirrors the DB CHECKs so a bad value is a readable 400 rather than a raw
// 500 from the constraint. See migrations 1714440080000 and 1714440083000
// for the CHECK constraints these mirror.
function behaviorFieldError(body) {
  if (!body.name) return 'name is required';
  if (catalogNameTooLong(body.name)) return `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer`;
  if (!CHASE_STYLES.includes(body.chase_style)) return `chase_style must be one of ${CHASE_STYLES.join(', ')}`;
  if (typeof body.aggro_radius !== 'number' || !Number.isFinite(body.aggro_radius)) {
    return 'aggro_radius must be a number';
  }
  if (typeof body.leash_radius !== 'number' || !Number.isFinite(body.leash_radius)) {
    return 'leash_radius must be a number';
  }
  // SOMET-249 fix-wave I4: these MUST be strictly positive, not merely
  // finite. A saved 0 here is not a valid edge case the way damage_override's
  // 0 is ("hits for nothing") -- it is a creature that never moves
  // (move_speed_mult), never notices a player (aggro_radius), or never
  // chases one past its own feet (leash_radius).
  const POSITIVE_FIELDS = ['aggro_radius', 'leash_radius', 'move_speed_mult'];
  for (const field of POSITIVE_FIELDS) {
    if (!(Number(body[field]) > 0)) return `${field} must be greater than 0`;
  }
  // preferred_range is legitimately 0 (no standoff distance for a melee
  // profile) -- only negative/non-finite is rejected.
  if (body.preferred_range != null && !(Number(body.preferred_range) >= 0)) {
    return 'preferred_range must be 0 or greater';
  }
  // SOMET-254: damage_override has no DB CHECK constraint (it is nullable
  // with no bound, unlike preferred_range/the aura fields below), so nothing
  // else in this function was rejecting a non-numeric value here -- it used
  // to reach Postgres as a real-column cast error (raw 500) instead of a
  // 400. Any finite number is valid, including negative (a creature that
  // heals its target is a deliberately supported, if unusual, profile) and
  // 0 ("hits for nothing", already covered by the test suite below).
  if (body.damage_override != null && !Number.isFinite(Number(body.damage_override))) {
    return 'damage_override must be a number';
  }
  // SOMET-253 Task 8: pack-leader aura + per-rung gold. Mirrors migration
  // 1714440085000's two CHECK constraints exactly. All six fields are
  // optional in the body -- most seeded profiles carry no aura fields at all
  // and fall back to the column defaults (0/1/1/1/0/0), same convention
  // preferred_range/damage_override already use -- so each rule only fires
  // when the field is actually present.
  //
  // aura_radius 0 means "not a leader" and is the correct value for eleven of
  // the twelve seeded profiles, so it is >= 0 like preferred_range. The three
  // multipliers are a different kind of 0: an aura_damage_mult/
  // aura_defense_mult/aura_speed_mult of 0 would make every creature the aura
  // touches deal, take, or move at NOTHING the instant a leader stands near
  // them -- silently. Strictly > 0, same class of rule as move_speed_mult.
  if (body.aura_radius != null && !(Number(body.aura_radius) >= 0)) {
    return 'aura_radius must be 0 or greater';
  }
  for (const field of ['aura_damage_mult', 'aura_defense_mult', 'aura_speed_mult']) {
    if (body[field] != null && !(Number(body[field]) > 0)) return `${field} must be greater than 0`;
  }
  if (body.gold_min != null && !(Number(body.gold_min) >= 0)) {
    return 'gold_min must be 0 or greater';
  }
  if (body.gold_max != null && !(Number(body.gold_max) >= Number(body.gold_min ?? 0))) {
    return 'gold_max must be greater than or equal to gold_min';
  }
  return null;
}

// One ability. Carries P2a's hard-won attack validations, unchanged in
// meaning, moved here from behaviorFieldError now that the attack lives on
// creature_abilities instead of the parent row.
function abilityFieldError(a) {
  if (!a || typeof a !== 'object') return 'ability must be an object';
  if (!a.name) return 'ability name is required';
  if (!ATTACK_KINDS.includes(a.attack_kind)) return `ability attack_kind must be one of ${ATTACK_KINDS.join(', ')}`;
  if (a.element != null && !ELEMENTS.includes(a.element)) return `ability element must be one of ${ELEMENTS.join(', ')}`;
  // Strictly positive, not merely finite: a 0 here is a creature that never
  // attacks (attack_range) or one with unbounded rate of fire
  // (attack_cooldown). Carried from SOMET-249's fix wave.
  for (const f of ['attack_range', 'attack_cooldown']) {
    if (!(Number(a[f]) > 0)) return `ability ${f} must be greater than 0`;
  }
  // A ranged/cast ability needs a projectile that actually moves. Number(undefined)
  // is NaN, so an omitted speed is caught here too.
  if ((a.attack_kind === 'ranged' || a.attack_kind === 'cast') && !(Number(a.projectile_speed) > 0)) {
    return "ability attack_kind 'ranged'/'cast' requires projectile_speed greater than 0";
  }
  // damage_mult 0 is legitimate (a pure status-rider), so this is >= 0, not > 0.
  for (const f of ['projectile_radius', 'damage_mult', 'knockback']) {
    if (a[f] != null && !(Number(a[f]) >= 0)) return `ability ${f} must be 0 or greater`;
  }
  return null;
}

// The two rules that span both tables. Checked on every write of either side,
// which is why abilities are nested under the behaviour rather than being
// their own resource -- two separate endpoints would let a valid behaviour and
// a valid ability combine into an invalid pair.
function behaviorAbilitiesError(body) {
  const list = body.abilities;
  if (!Array.isArray(list) || list.length === 0) {
    return 'at least one ability is required';   // zero abilities = a creature that cannot attack
  }
  for (const a of list) {
    const bad = abilityFieldError(a);
    if (bad) return bad;
  }
  if (body.chase_style === 'guard' && list.some((a) => a.attack_kind !== 'melee')) {
    return "chase_style 'guard' requires every ability to be melee";
  }
  if (body.chase_style === 'kite') {
    const longest = Math.max(...list.map((a) => Number(a.attack_range) || 0));
    if (Number(body.preferred_range) > longest) {
      return "chase_style 'kite' requires preferred_range <= the longest ability range";
    }
  }
  return null;
}

// Replaces a behaviour's whole ability set inside an open transaction: DELETE
// every existing row, then reinsert `abilities` with slot renumbered 1..n BY
// POSITION. Slot is never read from the client -- the admin editor implies it
// by array position (drag to reorder), so honouring a client-supplied slot
// would let the UI and the stored order silently diverge.
async function replaceAbilities(client, behaviorId, abilities) {
  await client.query('DELETE FROM creature_abilities WHERE behavior_id = $1', [behaviorId]);
  for (let i = 0; i < abilities.length; i += 1) {
    const a = abilities[i];
    await client.query(
      `INSERT INTO creature_abilities
        (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown,
         projectile_speed, projectile_radius, element, damage_mult, knockback)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [behaviorId, i + 1, a.name, a.attack_kind, a.attack_range, a.attack_cooldown,
       a.projectile_speed ?? 0, a.projectile_radius ?? 0, a.element ?? null,
       a.damage_mult ?? 1, a.knockback ?? 0],
    );
  }
}

// One row + its nested abilities, in the shape GET/POST/PUT all return.
// `client` so POST/PUT can read back their own writes inside the same
// transaction before COMMIT.
async function loadBehaviorWithAbilities(db, id) {
  const r = await db.query(
    `SELECT b.*, ab.abilities FROM creature_behaviors b${ABILITIES_LATERAL} WHERE b.id = $1`,
    [id],
  );
  return r.rows[0];
}

app.get('/api/creature-behaviors', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, ab.abilities FROM creature_behaviors b${ABILITIES_LATERAL} ORDER BY b.id ASC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch creature behaviors' });
  }
});

app.post('/api/creature-behaviors', adminGuard, async (req, res) => {
  const b = req.body;
  const bad = behaviorFieldError(b) || behaviorAbilitiesError(b);
  if (bad) return res.status(400).json({ error: bad });
  // Acquired inside the try: pool.connect() can reject (DB restart, pool
  // exhaustion) and Express 4.x does not catch async handler rejections, so
  // an unguarded await here would escape as an unhandledRejection and kill
  // the process. Same hardening as /api/maps/:id/entities.
  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO creature_behaviors
        (name, aggro_radius, leash_radius, chase_style,
         preferred_range, move_speed_mult, damage_override,
         aura_radius, aura_damage_mult, aura_defense_mult, aura_speed_mult,
         gold_min, gold_max)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [b.name, b.aggro_radius, b.leash_radius, b.chase_style,
       b.preferred_range ?? 0, b.move_speed_mult ?? 1,
       // damage_override is nullable and 0 is a real value ("hits for
       // nothing"), so this must be ?? not || -- 0 must survive.
       b.damage_override ?? null,
       // SOMET-253 Task 8: same ?? convention as above -- aura_radius 0 and
       // gold_min 0 are real values ("not a leader" / "no loot"), not absent
       // ones, so a genuine 0 must survive rather than being coerced by ||.
       b.aura_radius ?? 0, b.aura_damage_mult ?? 1, b.aura_defense_mult ?? 1,
       b.aura_speed_mult ?? 1, b.gold_min ?? 0, b.gold_max ?? 0],
    );
    const id = result.rows[0].id;
    await replaceAbilities(client, id, b.abilities);
    const row = await loadBehaviorWithAbilities(client, id);
    await client.query('COMMIT');
    res.status(201).json(row);
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    // SOMET-254: creature_behaviors.name is unique (migration 1714440080000)
    // -- a duplicate name used to fall through to the generic 500 below
    // instead of the 409 biomes/worlds already give the same class of error
    // via this same isUniqueViolation helper.
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'a creature behavior with that name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create creature behavior' });
  } finally {
    client?.release();
  }
});

app.put('/api/creature-behaviors/:id', adminGuard, async (req, res) => {
  const { id } = req.params;
  if (invalidId(id)) return res.status(400).json({ error: 'id must be an integer' });
  const b = req.body;
  const bad = behaviorFieldError(b) || behaviorAbilitiesError(b);
  if (bad) return res.status(400).json({ error: bad });
  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE creature_behaviors SET
         name = $1, aggro_radius = $2, leash_radius = $3, chase_style = $4,
         preferred_range = $5, move_speed_mult = $6, damage_override = $7,
         aura_radius = $8, aura_damage_mult = $9, aura_defense_mult = $10,
         aura_speed_mult = $11, gold_min = $12, gold_max = $13,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $14 RETURNING id`,
      [b.name, b.aggro_radius, b.leash_radius, b.chase_style,
       b.preferred_range ?? 0, b.move_speed_mult ?? 1,
       b.damage_override ?? null,
       b.aura_radius ?? 0, b.aura_damage_mult ?? 1, b.aura_defense_mult ?? 1,
       b.aura_speed_mult ?? 1, b.gold_min ?? 0, b.gold_max ?? 0, id],
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Behavior not found' });
    }
    // DELETE FROM creature_abilities WHERE behavior_id = $1 (inside
    // replaceAbilities) is scoped to this one behaviour's children and is the
    // intended way to replace its ability set -- it is not the destructive
    // catalog write the project's DB-safety rules forbid in a test or script,
    // which is about wiping real catalog rows outright.
    await replaceAbilities(client, id, b.abilities);
    const row = await loadBehaviorWithAbilities(client, id);
    await client.query('COMMIT');
    res.json(row);
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'a creature behavior with that name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update creature behavior' });
  } finally {
    client?.release();
  }
});

app.delete('/api/creature-behaviors/:id', adminGuard, async (req, res) => {
  const { id } = req.params;
  if (invalidId(id)) return res.status(400).json({ error: 'id must be an integer' });
  // SOMET-254: the reference-count SELECT and the DELETE used to be two
  // separate pool.query calls with a race window between them -- a
  // concurrent entity-types write that assigned this behavior_id in that
  // window turned the intended 409 into an unhandled foreign-key-violation
  // 500. Both now run against one client inside one transaction.
  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // FOR UPDATE locks this row before the reference check: entity_types'
    // FK constraint takes a FOR KEY SHARE lock on the creature_behaviors row
    // it references as part of enforcing itself (on both INSERT and an
    // UPDATE that assigns this id), and FOR KEY SHARE conflicts with FOR
    // UPDATE -- so any concurrent write that would newly reference this row
    // blocks until this transaction commits or rolls back. That closes the
    // window: the SELECT below is guaranteed to still be accurate at DELETE
    // time.
    const found = await client.query(
      'SELECT id FROM creature_behaviors WHERE id = $1 FOR UPDATE', [id]);
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Behavior not found' });
    }
    // entity_types.behavior_id is a real FK, so the database would refuse
    // this anyway -- with an unreadable 500. Checking first turns it into a
    // 409 that names what is in the way. SOMET-238 records that
    // /api/tile-types and /api/entity-types still lack guards like this one;
    // that gap is not fixed here, but it is not repeated in new code either.
    const refs = await client.query(
      'SELECT id, name FROM entity_types WHERE behavior_id = $1', [id]);
    if (refs.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Cannot delete: still referenced by a creature type',
        referencing_entity_types: refs.rows,
      });
    }
    await client.query('DELETE FROM creature_behaviors WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to delete creature behavior' });
  } finally {
    client?.release();
  }
});

// --- Biomes ---------------------------------------------------------------
// A biome owns a terrain palette, its flora and fauna, and its art context.
// Read is public (the admin UI and the maps editor both need it); writes are
// admin-only, matching the tile-types routes above.

// jsonb name arrays, normalized the same way everywhere: strings only.
function nameArray(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];
}

// Worlds that still list `name` in their biome set. worlds.biomes is a jsonb
// array of names with no FK (same as allowed_creature_types), so a rename or
// delete here would silently orphan the reference and quietly revert those
// worlds to global terrain banding on their next chunk generation.
async function worldsReferencingBiome(name) {
  const { rows } = await pool.query(
    'SELECT id, name FROM worlds WHERE biomes @> $1::jsonb', [JSON.stringify([name])],
  );
  return rows;
}

app.get('/api/biomes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM biomes ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch biomes' });
  }
});

app.post('/api/biomes', adminGuard, async (req, res) => {
  try {
    const { name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }
    const result = await pool.query(
      `INSERT INTO biomes (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8) RETURNING *`,
      [
        name.trim(),
        JSON.stringify(nameArray(terrain_tiles)), JSON.stringify(nameArray(flora_types)),
        JSON.stringify(nameArray(creature_types)), JSON.stringify(nameArray(palette)),
        art_style || '', exclusions || '', color || '#888888',
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'a biome with that name already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create biome' });
  }
});

app.put('/api/biomes/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }
    const cur = await pool.query(
      'SELECT name, terrain_tiles, flora_types, creature_types FROM biomes WHERE id = $1', [id],
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Biome not found' });
    const oldName = cur.rows[0].name;
    if (oldName !== name.trim()) {
      const refs = await worldsReferencingBiome(oldName);
      if (refs.length > 0) {
        return res.status(409).json({
          error: `Cannot rename '${oldName}': still listed by one or more worlds`,
          referencing_worlds: refs.map((w) => ({ id: w.id, name: w.name })),
        });
      }
    }
    const nextTerrainTiles = nameArray(terrain_tiles);
    const nextFlora = nameArray(flora_types);
    const nextCreatures = nameArray(creature_types);
    // terrain_tiles is the one biome column baked into a WORLD's persisted
    // world_chunks.data (services/mapService.js generateChunk picks each
    // cell's tile from it), so it's the only column whose change can leave a
    // stale PERSISTED grid behind -- palette/art_style/exclusions/color are
    // prompt-and-display only and never touch generation at all.
    const terrainChanged = JSON.stringify(nameArray(cur.rows[0].terrain_tiles)) !== JSON.stringify(nextTerrainTiles);
    // flora_types/creature_types are never persisted, so they don't need a
    // world_chunks wipe -- but they are NOT harmlessly re-resolved on every
    // request like the (now-corrected) comment above used to claim. An idle
    // world does re-resolve them on its next load, but a LIVE one does not:
    // authority/server.js's loadWorld() resolves loadBiomes() exactly once,
    // inside its memoized load promise, and bakes the result into that
    // world's ServerMap config for the rest of the session; collision.js's
    // blockedDecorationsFor() memoizes per chunk key off that same frozen
    // config, not off a re-resolution, so every chunk it computes for the
    // rest of the session -- including ones first visited long after this
    // edit -- still uses activation-era flora_types. Meanwhile a fresh
    // /chunk request re-resolves biomes every time. So removing a blocking
    // flora entry here can leave a connected player's client rendering an
    // open tile the live authority's isWalkable still refuses: a server
    // correction / rubber-band, same failure class as the terrain case
    // above, just reached through decorations instead of world_chunks. No DB
    // row is stale, so this only needs evictOrWarn (idle world: nothing to
    // do, it re-resolves on its next load; live world: warn, matching
    // terrainChanged's warning).
    const decorationChanged =
      JSON.stringify(nameArray(cur.rows[0].flora_types)) !== JSON.stringify(nextFlora)
      || JSON.stringify(nameArray(cur.rows[0].creature_types)) !== JSON.stringify(nextCreatures);
    const result = await pool.query(
      `UPDATE biomes SET name = $1, terrain_tiles = $2::jsonb, flora_types = $3::jsonb,
         creature_types = $4::jsonb, palette = $5::jsonb, art_style = $6, exclusions = $7,
         color = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 RETURNING *`,
      [
        name.trim(),
        JSON.stringify(nextTerrainTiles), JSON.stringify(nextFlora),
        JSON.stringify(nextCreatures), JSON.stringify(nameArray(palette)),
        art_style || '', exclusions || '', color || '#888888', id,
      ],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Biome not found' });
    // Same divergence this file's world-PUT boundsChanged/biomesChanged branch
    // exists to prevent, reached through the other door: a world doesn't need
    // to be edited for its terrain to go stale, its biome definition can
    // change out from under it. Reuse invalidateWorld() rather than a second
    // ad hoc cache-clearing mechanism -- including surfacing its liveWarning,
    // same as every other invalidateWorld() caller (F-017/SOMET-197, see the
    // comment above evictOrWarn): a player connected to an affected world
    // means the DB write happened but the live simulation is still serving
    // pre-edit terrain, and the admin response must say so instead of a bare
    // 200 that implies the edit fully landed.
    let liveWarning;
    if (terrainChanged) {
      const affected = await worldsReferencingBiome(name.trim());
      const warnings = await Promise.all(affected.map((w) => invalidateWorld(w.id)));
      liveWarning = warnings.find(Boolean);
    } else if (decorationChanged) {
      const affected = await worldsReferencingBiome(name.trim());
      const warnings = affected.map((w) => evictOrWarn(w.id));
      liveWarning = warnings.find(Boolean);
    }
    res.json(liveWarning ? { ...result.rows[0], liveWarning } : result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'a biome with that name already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to update biome' });
  }
});

app.delete('/api/biomes/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const cur = await pool.query('SELECT name FROM biomes WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Biome not found' });
    const refs = await worldsReferencingBiome(cur.rows[0].name);
    if (refs.length > 0) {
      return res.status(409).json({
        error: `Cannot delete '${cur.rows[0].name}': still listed by one or more worlds`,
        referencing_worlds: refs.map((w) => ({ id: w.id, name: w.name })),
      });
    }
    const result = await pool.query('DELETE FROM biomes WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Biome not found' });
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete biome' });
  }
});

// Get a specific map
app.get('/api/maps/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM maps WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Map not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch map' });
  }
});

// Generate a new map
app.post('/api/maps/generate', adminGuard, async (req, res) => {
  try {
    const { name, description, rows = 100, cols = 100, seed } = req.body;
    const r = Number.isFinite(rows) ? Math.floor(rows) : NaN;
    const c = Number.isFinite(cols) ? Math.floor(cols) : NaN;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 1 || r > MAX_MAP_DIM || c < 1 || c > MAX_MAP_DIM) {
      return res.status(400).json({ error: `rows and cols must be integers between 1 and ${MAX_MAP_DIM}` });
    }

    console.log(`Generating map: ${name} (${r}x${c})`);

    // Fetch tile types from DB for generation
    const tileTypes = await getTileTypesMap();
    const worldSeed = Number.isFinite(seed) ? seed : Date.now();
    const mapData = generateWorld(r, c, tileTypes, { seed: worldSeed });
    
    const result = await pool.query(
      'INSERT INTO maps (name, data, description) VALUES ($1, $2, $3) RETURNING id, name, created_at',
      [name || `Map ${new Date().toLocaleString()}`, JSON.stringify(mapData), description || 'Procedurally generated map']
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate map' });
  }
});


// Delete a map
app.delete('/api/maps/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM maps WHERE id = $1 RETURNING id', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Map not found' });
    }
    
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete map' });
  }
});

// Save map entities. Frontend payload: [{ type: "Tree"|"Stone"|..., row, col, name }, ...].
// Persisted as row-per-entity in map_entities (type='obstacle', entity_type_id resolved by name,
// x = col + 0.5, y = row + 0.5 in tile coords).
app.post('/api/maps/:id/entities', adminGuard, async (req, res) => {
  // Acquired inside the try: pool.connect() can reject (DB restart, pool
  // exhaustion) and Express 4.x does not catch async handler rejections, so
  // an unguarded await here would escape as an unhandledRejection and kill
  // the process (and every WS player co-hosted on it). Same hardening as
  // auth/middleware.js.
  let client = null;
  try {
    client = await pool.connect();
    const { id } = req.params;
    const { entities } = req.body;

    const mapResult = await client.query('SELECT id FROM maps WHERE id = $1', [id]);
    if (mapResult.rows.length === 0) return res.status(404).json({ error: 'Map not found' });

    const typeResult = await client.query('SELECT id, name FROM entity_types');
    const idByName = new Map(typeResult.rows.map((t) => [t.name, t.id]));

    await client.query('BEGIN');
    await client.query(`DELETE FROM map_entities WHERE map_id = $1 AND type = 'obstacle'`, [id]);

    if (entities && entities.length > 0) {
      for (const e of entities) {
        const name = e.type || e.name;
        const etId = idByName.get(name);
        if (!etId) {
          console.warn(`save-entities: skipping unknown entity_type "${name}"`);
          continue;
        }
        const r = e.row ?? 0;
        const c = e.col ?? 0;
        await client.query(
          `INSERT INTO map_entities (map_id, type, entity_type_id, x, y)
           VALUES ($1, 'obstacle', $2, $3, $4)`,
          [id, etId, c + 0.5, r + 0.5]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to save entities' });
  } finally {
    client?.release();
  }
});

// Load map entities. Returns the legacy frontend shape derived from row-per-entity rows:
// { type: <entity_type.name>, name: <entity_type.name>, row, col, id }.
app.get('/api/maps/:id/entities', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT me.id, et.name, me.x, me.y
       FROM map_entities me
       JOIN entity_types et ON et.id = me.entity_type_id
       WHERE me.map_id = $1 AND me.type = 'obstacle'
       ORDER BY me.id`,
      [id]
    );
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        type: r.name,
        name: r.name,
        row: Math.floor(r.y),
        col: Math.floor(r.x),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch entities' });
  }
});

// Generate static obstacles (type='obstacle') from entity_types.spawn_tiles + chance.
app.post('/api/maps/:id/generate-entities', adminGuard, async (req, res) => {
  const { id } = req.params;
  // Acquired inside the try: see the /entities route above for why.
  let client = null;
  try {
    client = await pool.connect();
    const mapResult = await client.query('SELECT data FROM maps WHERE id = $1', [id]);
    if (mapResult.rows.length === 0) return res.status(404).json({ error: 'Map not found' });
    const tiles = mapResult.rows[0].data;

    const typeResult = await client.query('SELECT * FROM entity_types');
    const entityTypes = typeResult.rows.filter((t) => t.walkable === false);

    // Density-driven clustered placement: objects clump (forest stands), while
    // carved paths and clearings stay open. Deterministic per optional seed.
    const pathTile = detectPathTile(uniqueTileNames(tiles));
    const placeSeed = Number.isFinite(req.body?.seed) ? req.body.seed : Date.now();
    const { placed } = placeEntities(tiles, entityTypes, {
      seed: placeSeed,
      pathTiles: pathTile ? [pathTile] : [],
    });
    const generated = placed.map((p) => ({
      entity_type_id: p.def.id,
      name: p.def.name,
      row: p.row,
      col: p.col,
    }));

    await client.query('BEGIN');
    await client.query(`DELETE FROM map_entities WHERE map_id = $1 AND type = 'obstacle'`, [id]);
    for (const g of generated) {
      await client.query(
        `INSERT INTO map_entities (map_id, type, entity_type_id, x, y)
         VALUES ($1, 'obstacle', $2, $3, $4)`,
        [id, g.entity_type_id, g.col + 0.5, g.row + 0.5]
      );
    }
    await client.query('COMMIT');
    await client.query('UPDATE maps SET updated_at = NOW() WHERE id = $1', [id]);

    res.json({
      success: true,
      count: generated.length,
      entities: generated.map((g) => ({ type: g.name, name: g.name, row: g.row, col: g.col })),
    });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Generation failed: ' + err.message });
  } finally {
    client?.release();
  }
});

// Report the sprite-gen service's detected hardware capability so the entity
// editor can show the tier and pick the right generation options.
app.get('/api/sprite-capability', async (req, res) => {
  try {
    res.json(await spriteGen.getCapability());
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Sprite-gen service unavailable' });
  }
});

// Shared by /api/sprite-jobs, /api/entity-jobs and /api/tile-jobs (F-011 /
// SOMET-191): each kicks off a generation job with the sprite-gen service
// and records it as a queued sprite_sets row, differing only in `kind`, the
// default frame count, and which request-body field names the subject.
// When the caller doesn't pin a backend/tier we auto-select the tier from
// detected hardware; the sprite-gen recipe then fills backend/frames/steps
// for that tier.
async function startGenerationJob(req, res, { subject, kind, defaultFrames, failureMessage }) {
  try {
    const { base_prompt, biome, backend, frames, seed = 0, tier } = req.body;
    // Biome art context (palette / style / exclusions) is composed into the
    // base prompt HERE so all three job kinds get it and sprite-gen's
    // prompts.py stays untouched. An unknown biome name degrades to the plain
    // base prompt rather than failing the job.
    const [biomeRow] = biome ? await loadBiomes(pool, [biome]) : [];
    const prompt = composeBiomePrompt(base_prompt, biomeRow || null);
    let effectiveTier = tier;
    if (!effectiveTier && !backend) {
      // Best-effort: if capability lookup fails, let sprite-gen use its own default.
      try { effectiveTier = (await spriteGen.getCapability()).tier; } catch (_) { /* ignore */ }
    }
    const gen = await spriteGen.postGenerate({
      creature: subject, base_prompt: prompt, kind, backend, frames, seed, tier: effectiveTier,
    });
    // Record the actually-chosen backend/frames (from the recipe when not pinned).
    const chosenBackend = backend || (gen.recipe && gen.recipe.backend) || 'stub';
    const chosenFrames = frames || (gen.recipe && gen.recipe.frames) || defaultFrames;
    const row = await pool.query(
      `INSERT INTO sprite_sets (creature, backend, seed, frames, job_id, status)
       VALUES ($1, $2, $3, $4, $5, 'queued') RETURNING *`,
      [subject, chosenBackend, seed, chosenFrames, gen.job_id]
    );
    res.status(201).json({ ...row.rows[0], job_id: gen.job_id, recipe: gen.recipe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: failureMessage });
  }
}

app.post('/api/sprite-jobs', adminGuard, (req, res) => startGenerationJob(req, res, {
  subject: req.body.entity_type, kind: undefined, defaultFrames: 4,
  failureMessage: 'Failed to start sprite job',
}));

// Proxy job status from the sprite-gen service.
app.get('/api/sprite-jobs/:jobId', async (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return res.status(400).json({ error: 'invalid job id' });
  try {
    const job = await spriteGen.getJob(req.params.jobId);
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// Stream a generated asset (sprite/tile texture, atlas, manifest) from MinIO to
// the browser. Read-only; the object key is the path after /api/assets/.
app.get('/api/assets/*', async (req, res) => {
  const key = req.params[0];
  if (!key) return res.status(400).json({ error: 'asset key required' });
  try {
    const stream = await assetStore.getObjectStream(key);
    if (/\.png$/i.test(key)) res.type('image/png');
    else if (/\.json$/i.test(key)) res.type('application/json');
    res.set('Cache-Control', 'public, max-age=300');
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'asset not found' }); });
    stream.pipe(res);
  } catch (err) {
    res.status(404).json({ error: 'asset not found' });
  }
});

// Approve a generated sprite set and link it to an entity type.
// :id is entity_types.id (integer); pg casts the string param automatically.
app.post('/api/entity-types/:id/sprite', adminGuard, async (req, res) => {
  try {
    const { atlas_key, manifest_key, job_id, static_frame, animated, frames } = req.body;
    const result = await pool.query(
      `UPDATE sprite_sets SET atlas_key = $1, manifest_key = $2, status = 'approved', entity_type_id = $3
       WHERE job_id = $4 RETURNING *`,
      [atlas_key, manifest_key, req.params.id, job_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Sprite set not found' });

    // Two atlas shapes land here:
    //  - directional (from /api/sprite-jobs): frame keys "DIR/idx", shown as one
    //    representative frame in 'static' mode.
    //  - flat (from /api/entity-jobs, the tile pipeline): frame keys "0","1",…,
    //    cycled in 'animated' mode. Flat atlases have no 'S/0', so don't claim one.
    const sprite = animated
      ? { atlas_key, manifest_key, frames: frames || 1 }
      : { atlas_key, manifest_key, static_frame: static_frame || 'S/0' };
    await pool.query(
      `UPDATE entity_types SET sprite = $1, render_mode = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [JSON.stringify(sprite), animated ? 'animated' : 'static', req.params.id]
    );

    res.json({ ...result.rows[0], sprite });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save sprite' });
  }
});

// Entity object-image bridge: mirror /api/tile-jobs but with kind:'object', so
// sprite-gen produces ONE framed object image (+ optional loop) instead of a
// full directional walk set. This is the cheap path for props and for creatures
// that don't need per-facing frames; /api/sprite-jobs stays the directional one.
app.post('/api/entity-jobs', adminGuard, (req, res) => startGenerationJob(req, res, {
  subject: req.body.entity_type, kind: 'object', defaultFrames: 1,
  failureMessage: 'Failed to start entity job',
}));

// Proxy entity job status (job ids are global to the sprite-gen job manager).
app.get('/api/entity-jobs/:jobId', async (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return res.status(400).json({ error: 'invalid job id' });
  try {
    res.json(await spriteGen.getJob(req.params.jobId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// Shared by entity-types/:id/image, tile-types/:id/image and
// tile-types/:id/sprite (F-011 / SOMET-191): job_id is optional for all
// three -- if present, mark the sprite_sets row approved (and, for entity
// types only, link it via entity_type_id; sprite_sets has no tile_type_id
// column) -- then persist the asset onto the catalog row and return it.
// entity-types/:id/sprite is deliberately NOT folded in here: unlike these
// three, it requires job_id (its sprite_sets UPDATE has no `if (job_id)`
// guard and 404s when the row isn't found), it branches into two different
// response shapes (animated vs static/directional), and it returns the
// sprite_sets row rather than the catalog row -- forcing it into this same
// shape would risk quietly weakening that route's contract, which is worse
// than leaving one route hand-written.
async function approveGeneratedAsset(req, res, {
  jobId, spriteSetsUpdate, catalogUpdate, notFoundMessage, failureMessage,
}) {
  try {
    if (jobId && spriteSetsUpdate) {
      await pool.query(spriteSetsUpdate.sql, spriteSetsUpdate.params);
    }
    const result = await pool.query(catalogUpdate.sql, catalogUpdate.params);
    if (!result.rows[0]) return res.status(404).json({ error: notFoundMessage });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: failureMessage });
  }
}

// Approve a generated static image and link it to an entity type. Mirrors
// /api/tile-types/:id/image; 'static' is the entity-side name for what tiles
// call 'image' render mode.
app.post('/api/entity-types/:id/image', adminGuard, (req, res) => {
  const { image_key, job_id } = req.body;
  return approveGeneratedAsset(req, res, {
    jobId: job_id,
    spriteSetsUpdate: {
      sql: `UPDATE sprite_sets SET status = 'approved', entity_type_id = $1 WHERE job_id = $2`,
      params: [req.params.id, job_id],
    },
    // Clear `sprite` so the atlas path doesn't keep winning over the new image:
    // RenderSystem.resolveSprite() is tried before the plain-image fallback.
    catalogUpdate: {
      sql: `UPDATE entity_types SET image = $1, sprite = NULL, render_mode = 'static', updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 RETURNING *`,
      params: [image_key, req.params.id],
    },
    notFoundMessage: 'Entity type not found',
    failureMessage: 'Failed to save entity image',
  });
});

// Tile generation bridge: mirror /api/sprite-jobs but with kind:'tile' so
// sprite-gen produces a seamless texture (+ optional loop), not a directional set.
app.post('/api/tile-jobs', adminGuard, (req, res) => startGenerationJob(req, res, {
  subject: req.body.tile_type, kind: 'tile', defaultFrames: 1,
  failureMessage: 'Failed to start tile job',
}));

// Proxy tile job status (job ids are global to the sprite-gen job manager).
app.get('/api/tile-jobs/:jobId', async (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return res.status(400).json({ error: 'invalid job id' });
  try {
    res.json(await spriteGen.getJob(req.params.jobId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// Approve a generated static texture and link it to a tile type.
app.post('/api/tile-types/:id/image', adminGuard, (req, res) => {
  const { image_key, job_id } = req.body;
  return approveGeneratedAsset(req, res, {
    jobId: job_id,
    spriteSetsUpdate: {
      sql: `UPDATE sprite_sets SET status = 'approved' WHERE job_id = $1`,
      params: [job_id],
    },
    // F-011 / SOMET-191: now clears `sprite` the same way entity-types/:id/image
    // does. Previously it didn't -- harmless only because resolveTileVisual
    // gates on render_mode === 'animated' rather than sprite presence, but a
    // trap waiting for the tile renderer to adopt the same sprite-presence
    // precedence entity rendering already uses.
    catalogUpdate: {
      sql: `UPDATE tile_types SET image = $1, sprite = NULL, render_mode = 'image', updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      params: [image_key, req.params.id],
    },
    notFoundMessage: 'Tile type not found',
    failureMessage: 'Failed to save tile image',
  });
});

// Approve a generated animation atlas and link it to a tile type.
app.post('/api/tile-types/:id/sprite', adminGuard, (req, res) => {
  const { atlas_key, manifest_key, frames, job_id } = req.body;
  const sprite = { atlas_key, manifest_key, frames: frames || 1 };
  return approveGeneratedAsset(req, res, {
    jobId: job_id,
    spriteSetsUpdate: {
      sql: `UPDATE sprite_sets SET atlas_key = $1, manifest_key = $2, status = 'approved' WHERE job_id = $3`,
      params: [atlas_key, manifest_key, job_id],
    },
    catalogUpdate: {
      sql: `UPDATE tile_types SET sprite = $1, render_mode = 'animated', updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      params: [JSON.stringify(sprite), req.params.id],
    },
    notFoundMessage: 'Tile type not found',
    failureMessage: 'Failed to save tile sprite',
  });
});

// --- Worlds (chunked overworld) -------------------------------------------

app.post('/api/worlds', adminGuard, async (req, res) => {
  try {
    const { name, seed, chunk_size, width, height } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }
    const worldSeed = Number.isFinite(seed) ? Math.floor(seed) : Math.floor(Math.random() * 2 ** 31);
    const chunkSize = Number.isFinite(chunk_size) ? Math.floor(chunk_size) : 64;
    if (chunkSize < 1 || chunkSize > 256) {
      return res.status(400).json({ error: 'chunk_size must be an integer between 1 and 256' });
    }
    const w = Number.isFinite(width) ? Math.floor(width) : null;
    const h = Number.isFinite(height) ? Math.floor(height) : null;
    // Both required, not merely paired. Creature population only ever runs
    // for bounded worlds, and the per-chunk fallback that used to cover
    // unbounded ones is gone (SOMET-246) -- so an unbounded world would sit
    // empty forever with nothing to notice. seeds/mapSpec.js already requires
    // both, so map specs are unaffected by this narrowing.
    if (w === null || h === null) {
      return res.status(400).json({ error: 'width and height are required' });
    }
    if (w < 8 || w > 4096 || h < 8 || h > 4096) {
      return res.status(400).json({ error: 'width and height must be between 8 and 4096 tiles' });
    }
    const result = await pool.query(
      'INSERT INTO worlds (name, seed, chunk_size, width, height) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name.trim(), worldSeed, chunkSize, w, h],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'a world with that name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create world' });
  }
});

app.get('/api/worlds', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM worlds ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list worlds' });
  }
});

app.delete('/api/worlds/:id', adminGuard, async (req, res) => {
  try {
    // FK dependents (chunks, world_creatures, world_items, world_players) are
    // all declared ON DELETE CASCADE, so a single delete removes the world tree.
    const result = await pool.query('DELETE FROM worlds WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'world not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete world' });
  }
});

app.get('/api/worlds/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM worlds WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'world not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch world' });
  }
});

app.put('/api/worlds/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, width, height, creature_count, allowed_creature_types, is_entry, entry_spawn, biomes, biome_cell } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }
    const w = Number.isFinite(width) ? Math.floor(width) : null;
    const h = Number.isFinite(height) ? Math.floor(height) : null;
    if ((w === null) !== (h === null)) {
      return res.status(400).json({ error: 'width and height must be provided together' });
    }
    if (w !== null && (w < 8 || w > 4096 || h < 8 || h > 4096)) {
      return res.status(400).json({ error: 'width and height must be between 8 and 4096 tiles' });
    }
    // creature_count is DERIVED since SOMET-246: populateWorld resolves how
    // many creatures to place from the world's `density` tier and overwrites
    // this column with what it actually scattered. Nothing reads the value
    // written here for placement, and MapsAdmin now renders the field
    // read-only, echoing back whatever it was sent. The bound that does the
    // real work moved to resolveDensity (MAX_WORLD_CREATURES, same 2000);
    // this check remains so the column can never be poked past what a
    // population pass could legitimately write, and so the API keeps
    // rejecting nonsense with a clear message rather than storing it.
    const countRaw = Number.isFinite(creature_count) ? Math.floor(creature_count) : 0;
    if (countRaw > MAX_CREATURE_COUNT) {
      return res.status(400).json({ error: `creature_count must be between 0 and ${MAX_CREATURE_COUNT}` });
    }
    const count = Math.max(0, countRaw);
    const allowed = Array.isArray(allowed_creature_types)
      ? allowed_creature_types.filter((t) => typeof t === 'string')
      : [];
    const entry = is_entry === true;
    const spawn = entry_spawn && typeof entry_spawn === 'object' ? entry_spawn : null;

    const cur = await pool.query('SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    const before = cur.rows[0];
    // Bounds are omitted entirely on updates that only touch other fields (e.g.
    // toggling is_entry) — default to the existing bounds rather than nulling
    // them out, so an unrelated PUT can't accidentally make a bounded world
    // infinite and re-trigger a chunk wipe.
    const boundsProvided = width !== undefined || height !== undefined;
    const nextW = boundsProvided ? w : (before.width ?? null);
    const nextH = boundsProvided ? h : (before.height ?? null);
    const boundsChanged = (before.width ?? null) !== nextW || (before.height ?? null) !== nextH;
    // Same trap as width/height above: an unrelated PUT (e.g. toggling
    // is_entry) omits these entirely, and defaulting them to empty/null would
    // silently strip a world's biome set and regenerate its terrain.
    const biomesProvided = biomes !== undefined;
    const nextBiomes = biomesProvided
      ? (Array.isArray(biomes) ? biomes.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim()) : [])
      : (before.biomes || []);
    const cellProvided = biome_cell !== undefined;
    const nextCell = cellProvided
      ? (Number.isFinite(biome_cell) && biome_cell > 0 ? Math.floor(biome_cell) : null)
      : (before.biome_cell ?? null);
    // Both inputs decide which tile each cell gets, so a change to either
    // invalidates every materialized chunk of this world -- otherwise the
    // cached grid the client renders and the terrain the authority regenerates
    // disagree, which is client/server divergence and rubber-banding.
    const biomesChanged =
      JSON.stringify(before.biomes || []) !== JSON.stringify(nextBiomes)
      || (before.biome_cell ?? null) !== nextCell;

    // A bounded world's outer ring is always solid wall (stampBounds(), map
    // Service.js), so an entry_spawn must land strictly inside it or the first
    // joiner materialises inside impassable terrain with no way out (SOMET-184,
    // confirmed live: entry_spawn {x:99999,y:99999} on a 24x24 world spawned a
    // fresh player who then couldn't move across 50 state frames). Only bounded
    // worlds have a wall ring to fall inside; unbounded worlds have none.
    if (spawn && nextW != null && nextH != null) {
      const minPx = CREATURE_TILE_PX;
      const maxX = (nextW - 1) * CREATURE_TILE_PX;
      const maxY = (nextH - 1) * CREATURE_TILE_PX;
      const inBounds = Number.isFinite(spawn.x) && Number.isFinite(spawn.y) &&
        spawn.x >= minPx && spawn.x < maxX && spawn.y >= minPx && spawn.y < maxY;
      if (!inBounds) {
        return res.status(400).json({ error: 'entry_spawn must land inside the world bounds, clear of the wall ring' });
      }
    }

    // Enforce a single entry world.
    if (entry) {
      await pool.query('UPDATE worlds SET is_entry = false WHERE is_entry = true AND id <> $1', [id]);
    }
    // A bounds change reshapes the wall ring, and a biome-set/biome_cell change
    // reshapes the terrain those bounds contain: either invalidates persisted +
    // preview terrain the same way.
    if (boundsChanged || biomesChanged) {
      await pool.query('DELETE FROM world_chunks WHERE world_id = $1', [id]);
      worldPreviewCache.delete(id);
      clearOverviewCache(id);
    }
    // Same symptom class as the entry_spawn check above (SOMET-184 / F-004),
    // but for players who already joined and persisted a position: a shrink
    // (or an unbounded->bounded transition) can leave a world_players row
    // outside the new wall ring, and chooseSpawn() hands that stored position
    // straight to the client with no bounds check of its own (SOMET-229 /
    // F-049). Clamp every persisted position into the new interior here, in
    // the same non-transactional sequence the rest of this route already
    // uses for the chunk wipe. LEAST/GREATEST is a no-op for players already
    // inside the new bounds (including every case where bounds only grew),
    // so this is safe to run unconditionally whenever the world remains (or
    // becomes) bounded.
    if (boundsChanged && nextW != null && nextH != null) {
      const minPx = CREATURE_TILE_PX;
      const maxX = (nextW - 1) * CREATURE_TILE_PX - 1;
      const maxY = (nextH - 1) * CREATURE_TILE_PX - 1;
      await pool.query(
        `UPDATE world_players SET x = LEAST(GREATEST(x, $2), $3), y = LEAST(GREATEST(y, $2), $4)
         WHERE world_id = $1`,
        [id, minPx, maxX, maxY],
      );
    }

    const result = await pool.query(
      `UPDATE worlds SET name = $1, width = $2, height = $3, creature_count = $4,
         allowed_creature_types = $5::jsonb, is_entry = $6, entry_spawn = $7::jsonb,
         biomes = $8::jsonb, biome_cell = $9,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $10 RETURNING *`,
      [
        name.trim(), nextW, nextH, count, JSON.stringify(allowed), entry, spawn ? JSON.stringify(spawn) : null,
        JSON.stringify(nextBiomes), nextCell, id,
      ],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    const liveWarning = (boundsChanged || biomesChanged) ? evictOrWarn(id) : undefined;
    res.json(liveWarning ? { ...result.rows[0], liveWarning } : result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'a world with that name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update world' });
  }
});

// Node position for the World Map tab. Deliberately its OWN route rather than
// a field on PUT /api/worlds/:id: that route deletes world_chunks, clears the
// preview/overview caches and evicts or warns connected players when bounds or
// biomes change. A cosmetic node drag must not be able to reach any of that, so
// this issues one UPDATE of two columns and nothing else.
app.put('/api/worlds/:id/graph-position', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { x, y } = req.body;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: 'x and y must be finite numbers' });
    }
    const result = await pool.query(
      `UPDATE worlds SET graph_x = $1, graph_y = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING id, graph_x, graph_y`,
      [x, y, id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save graph position' });
  }
});

// One snapshot for the World Map tab. Composes GET /api/worlds and the
// per-world GET /api/worlds/:id/links (both already public) into a single
// request — 17 worlds would otherwise be 1 + N round trips. The two queries
// below run under Promise.all with no transaction, so this is one round trip
// instead of 1+N, not a torn-read guarantee — a world can still be deleted
// between the worlds query and the links query.
//
// `links` deliberately returns BOTH directions of every link, uncollapsed.
// setLink writes a row and its mirror, so the client can pair them itself;
// serving pre-collapsed pairs would destroy the evidence its missing-mirror
// lint check depends on. Both queries are ORDER BY'd so the payload is stable
// between requests — and the links ORDER BY has to reach past (from_world_id,
// edge) to be a real guarantee: those two columns are unique for compass
// edges, but a world may hold MANY 'PORTAL' rows, which then tie completely
// and come back in whatever order Postgres feels like. That would let
// placePortalClusters (which assigns sibling branch columns in receipt order)
// swap which dungeon branch renders in which column on every refetch. Adding
// from_x, from_y fully disambiguates: a partial unique index already makes
// (from_world_id, from_x, from_y) unique for PORTAL rows.
app.get('/api/world-graph', async (req, res) => {
  try {
    const [worldsRes, linksRes] = await Promise.all([
      pool.query(
        `SELECT id, name, width, height, is_entry, biomes, graph_x, graph_y
           FROM worlds ORDER BY created_at DESC`),
      pool.query(
        `SELECT from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y
           FROM map_links ORDER BY from_world_id, edge, from_x, from_y`),
    ]);
    res.json({ worlds: worldsRes.rows, links: linksRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load world graph' });
  }
});

app.post('/api/worlds/:id/regenerate', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const cur = await pool.query('SELECT id FROM worlds WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    const newSeed = Math.floor(Math.random() * 2 ** 31);
    await pool.query('DELETE FROM world_chunks WHERE world_id = $1', [id]);
    await pool.query('DELETE FROM world_creatures WHERE world_id = $1', [id]);
    // Villages live in a separate table and survive a regenerate — without
    // this, a regenerated world keeps its gated villages but loses their
    // guards, since the wipe above has no village_id to spare them by.
    await insertVillageGuards(pool, id, await fetchVillages(pool, id));
    worldPreviewCache.delete(id);
    clearOverviewCache(id);
    const result = await pool.query(
      'UPDATE worlds SET seed = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [newSeed, id],
    );
    const liveWarning = evictOrWarn(id);
    res.json(liveWarning ? { ...result.rows[0], liveWarning } : result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to regenerate world' });
  }
});

app.post('/api/worlds/:id/creatures', adminGuard, async (req, res) => {
  // client acquired inside the try: pool.connect() can reject (DB restart,
  // pool exhaustion) and Express 4.x does not catch an async handler's
  // rejection, so an unguarded await here would escape as an
  // unhandledRejection and kill the process (same hardening as
  // POST /api/maps/:id/entities).
  let client = null;
  try {
    const { id } = req.params;
    const wr = await pool.query('SELECT * FROM worlds WHERE id = $1', [id]);
    if (wr.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    const world = wr.rows[0];
    if (!isBoundedWorld(world)) {
      return res.status(400).json({ error: 'creature control is only available for bounded maps' });
    }

    // F-007 / SOMET-187: wipe-then-re-derive is two dependent writes around
    // the guard set (like village create/delete below). Without a
    // transaction, a failure between the wipe and the re-roll's own guard
    // re-insert leaves the world with zero guards and no endpoint that
    // re-derives them except another re-roll.
    client = await pool.connect();
    await client.query('BEGIN');
    let placed = 0;
    try {
      // Delegates to the SAME function seeding uses, so re-rolling can never
      // produce a world the spec would not. It owns the non-guard delete, the
      // density resolution, both placement passes and the creature_count
      // write-back; this route owns only the guard re-derivation below.
      const n = await populateWorld(client, world, {
        rngSeed: Math.floor(Math.random() * 2 ** 31),
      });
      placed = n.total;

      await client.query(`DELETE FROM world_creatures WHERE world_id = $1 AND type = $2`,
        [id, GUARD_TYPE]);
      await insertVillageGuards(client, id, await fetchVillages(client, world.id));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    const liveWarning = evictOrWarn(id);
    res.json(liveWarning ? { placed, liveWarning } : { placed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to re-roll creatures' });
  } finally {
    client?.release();
  }
});

const EDGES = new Set(['N', 'E', 'S', 'W']);

app.get('/api/worlds/:id/links', async (req, res) => {
  try {
    const rows = await fetchLinks(pool, req.params.id);
    res.json(rows.map((r) => ({ edge: r.edge, to_world_id: r.to_world_id })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list links' });
  }
});

// A link change flips an edge between a doorway gap and a solid wall, reshaping
// the wall ring exactly like a bounds change: invalidate persisted + preview
// terrain and evict the idle authority copy for the given world. Returns the
// evictOrWarn() warning string (or undefined) so callers with a JSON body can
// surface it (F-017 / SOMET-197) instead of discarding it like every caller
// used to.
async function invalidateWorld(worldId) {
  await pool.query('DELETE FROM world_chunks WHERE world_id = $1', [worldId]);
  worldPreviewCache.delete(worldId);
  clearOverviewCache(worldId);
  return evictOrWarn(worldId);
}

function validateVillageBody(body, worldRow, existing) {
  const { min_row, min_col, width, height, gate_edge, spawn_x, spawn_y } = body || {};
  const ints = [min_row, min_col, width, height].every((n) => Number.isInteger(n));
  if (!ints) return 'min_row, min_col, width, height must be integers';
  if (width < VILLAGE_LIMITS.minW || width > VILLAGE_LIMITS.maxW) return 'width must be between 3 and 8 tiles';
  if (height < VILLAGE_LIMITS.minH || height > VILLAGE_LIMITS.maxH) return 'height must be between 3 and 6 tiles';
  if (!['N', 'E', 'S', 'W'].includes(gate_edge)) return 'gate_edge must be one of N,E,S,W';
  if (!Number.isFinite(spawn_x) || !Number.isFinite(spawn_y)) return 'spawn_x and spawn_y are required';
  if (min_row < 0 || min_col < 0) return 'min_row and min_col must be >= 0';
  if (worldRow.width && (min_col + width > worldRow.width || min_row + height > worldRow.height)) {
    return 'village box must fit inside the world bounds';
  }
  // spawn must land on an interior tile of the box
  const sCol = Math.floor(spawn_x / 100), sRow = Math.floor(spawn_y / 100);
  const inInterior = sRow > min_row && sRow < min_row + height - 1 && sCol > min_col && sCol < min_col + width - 1;
  if (!inInterior) return 'spawn point must be inside the village interior';
  // no overlap with an existing village box
  for (const v of existing) {
    const overlap = min_col <= v.min_col + v.width - 1 && min_col + width - 1 >= v.min_col &&
                    min_row <= v.min_row + v.height - 1 && min_row + height - 1 >= v.min_row;
    if (overlap) return 'village overlaps an existing village';
  }
  return null;
}

app.get('/api/worlds/:id/villages', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y, merchant_x, merchant_y
         FROM villages WHERE world_id = $1 ORDER BY created_at ASC`,
      [req.params.id],
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list villages' });
  }
});

app.post('/api/worlds/:id/villages', adminGuard, async (req, res) => {
  // client acquired inside the try: same pool.connect()-rejection hardening
  // as POST /api/maps/:id/entities.
  let client = null;
  try {
    const { id } = req.params;
    const wr = await pool.query('SELECT id, width, height FROM worlds WHERE id = $1', [id]);
    if (wr.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    if (!isBoundedWorld(wr.rows[0])) {
      return res.status(400).json({ error: 'villages require a bounded world' });
    }
    const existing = (await pool.query(
      'SELECT min_row, min_col, width, height FROM villages WHERE world_id = $1', [id],
    )).rows;
    const err = validateVillageBody(req.body, wr.rows[0], existing);
    if (err) return res.status(400).json({ error: err });

    // F-007 / SOMET-187: village row, guards and base catalog are three
    // dependent writes. Without a transaction, a failure partway through
    // (e.g. seedBaseCatalog throwing) leaves a committed village with no
    // shop and no way for the admin to see or fix it -- a retry then 400s
    // with "village overlaps an existing village" against the phantom row
    // they were never told exists.
    client = await pool.connect();
    await client.query('BEGIN');
    let row;
    try {
      row = await createVillage(client, id, req.body);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    const liveWarning = await invalidateWorld(id);
    res.json(liveWarning ? { ...row, liveWarning } : row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create village' });
  } finally {
    client?.release();
  }
});

app.delete('/api/worlds/:id/villages/:villageId', adminGuard, async (req, res) => {
  let client = null;
  try {
    const { id, villageId } = req.params;
    // F-007 / SOMET-187: the guard wipe + re-derive around the village
    // delete is the same "two dependent writes, no transaction" shape as the
    // re-roll route below. A failure between them leaves the world with zero
    // guards and no endpoint that re-derives them except another re-roll.
    client = await pool.connect();
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM villages WHERE id = $1 AND world_id = $2', [villageId, id]);
      // Guards have no FK cascade to their village (world_creatures rows carry
      // no village_id) — re-derive the whole guard set from the villages that
      // survive the delete, the same pattern the re-roll route uses. This
      // deletes every guard for the world, then re-inserts exactly two per
      // surviving village, so a village deleted alongside others leaves the
      // rest's guards intact, and deleting the last village leaves zero.
      await client.query(`DELETE FROM world_creatures WHERE world_id = $1 AND type = $2`, [id, GUARD_TYPE]);
      await insertVillageGuards(client, id, await fetchVillages(client, id));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    const liveWarning = await invalidateWorld(id);
    // 204 carries no body — a header is the only way this still-live-blocked
    // signal (F-017 / SOMET-197) can reach a caller without changing the
    // response contract every existing client/test relies on.
    if (liveWarning) res.set('X-Live-World-Pending', 'true');
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete village' });
  } finally {
    client?.release();
  }
});

app.post('/api/worlds/:id/links', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { edge, to_world_id } = req.body;
    if (!EDGES.has(edge)) return res.status(400).json({ error: 'edge must be one of N,E,S,W' });
    if (!to_world_id || to_world_id === id) return res.status(400).json({ error: 'to_world_id must be a different world' });
    const fromRes = await pool.query('SELECT id, width, height FROM worlds WHERE id = $1', [id]);
    const toRes = await pool.query('SELECT id, width, height FROM worlds WHERE id = $1', [to_world_id]);
    const from = fromRes.rows[0];
    const to = toRes.rows[0];
    if (!from || !to) return res.status(404).json({ error: 'world not found' });
    if (!isBoundedWorld(from) || !isBoundedWorld(to)) {
      return res.status(400).json({ error: 'both worlds must be bounded maps' });
    }
    await setLink(pool, id, edge, to_world_id);
    const w1 = await invalidateWorld(id);
    const w2 = await invalidateWorld(to_world_id);
    const liveWarning = w1 || w2;
    res.json(liveWarning ? { ok: true, liveWarning } : { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set link' });
  }
});

app.delete('/api/worlds/:id/links/:edge', adminGuard, async (req, res) => {
  try {
    const { id, edge } = req.params;
    if (!EDGES.has(edge)) return res.status(400).json({ error: 'edge must be one of N,E,S,W' });
    const cur = await pool.query('SELECT to_world_id FROM map_links WHERE from_world_id = $1 AND edge = $2', [id, edge]);
    await clearLink(pool, id, edge);
    const w1 = await invalidateWorld(id);
    const w2 = cur.rows[0] ? await invalidateWorld(cur.rows[0].to_world_id) : undefined;
    // See the villages DELETE route above: 204 carries no body.
    if (w1 || w2) res.set('X-Live-World-Pending', 'true');
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear link' });
  }
});

app.get('/api/worlds/:id/chunk', async (req, res) => {
  try {
    const cx = Number(req.query.cx);
    const cy = Number(req.query.cy);
    if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
      return res.status(400).json({ error: 'cx and cy must be integers' });
    }
    const worldId = req.params.id;

    // Loaded on BOTH the cache-hit and cache-miss paths below: decorations are
    // derived from the tile grid regardless of whether that grid came from the
    // world_chunks cache or was just generated, so the world config + defs are
    // needed either way. worldCfg is built by services/worldGenConfig.js, the
    // same builder authority/server.js's loadWorld uses for its ServerMap, so
    // this endpoint's generateChunkDecorations call agrees with the
    // authority's field-for-field -- including which cells are excluded
    // around entry_spawn -- by construction instead of by convention.
    const worldRes = await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
    const world = worldRes.rows[0];
    if (!world) return res.status(404).json({ error: 'world not found' });

    // These five only depend on world.id/world.biomes (already resolved
    // above), not on each other -- run them concurrently instead of one
    // round-trip at a time.
    const [tileTypes, decorationDefs, linkRows, villages, biomes] = await Promise.all([
      getTileTypesMap(),
      loadDecorationDefs(pool),
      fetchLinks(pool, world.id),
      fetchVillages(pool, world.id),
      loadBiomes(pool, world.biomes),
    ]);
    const worldCfg = buildWorldGenConfig({
      row: world, tileTypes, doorways: linkRows.map((l) => l.edge), villages, biomes,
    });

    // Cache hit?
    const cached = await pool.query(
      'SELECT data FROM world_chunks WHERE world_id = $1 AND cx = $2 AND cy = $3',
      [worldId, cx, cy],
    );
    if (cached.rows[0]) {
      const data = cached.rows[0].data;
      const decorations = generateChunkDecorations(worldCfg, cx, cy, data, decorationDefs);
      return res.json({ world_id: worldId, cx, cy, data, decorations });
    }

    // Miss: generate terrain and return it WITHOUT persisting. The authority is
    // the sole writer of world_chunks (it materializes + spawns creatures on
    // chunk activation); terrain is deterministic so this unpersisted view
    // equals the row the authority later writes.
    const data = generateChunk(worldCfg, cx, cy);
    const decorations = generateChunkDecorations(worldCfg, cx, cy, data, decorationDefs);

    res.json({ world_id: worldId, cx, cy, data, decorations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chunk' });
  }
});

app.get('/api/worlds/:id/preview', async (req, res) => {
  try {
    const worldId = req.params.id;
    if (worldPreviewCache.has(worldId)) {
      return res.json({ world_id: worldId, data: worldPreviewCache.get(worldId) });
    }
    const worldRes = await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
    const world = worldRes.rows[0];
    if (!world) return res.status(404).json({ error: 'world not found' });

    const tileTypes = await getTileTypesMap();
    const doorways = (await fetchLinks(pool, world.id)).map((l) => l.edge);
    const villages = await fetchVillages(pool, world.id);
    const biomes = await loadBiomes(pool, world.biomes);
    const data = generateWorldPreview(
      buildWorldGenConfig({ row: world, tileTypes, doorways, villages, biomes }),
      PREVIEW_DIM,
    );
    worldPreviewCache.set(worldId, data);
    res.json({ world_id: worldId, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate world preview' });
  }
});

app.get('/api/worlds/:id/overview', async (req, res) => {
  try {
    const worldId = req.params.id;
    const centerCol = Number(req.query.cx), centerRow = Number(req.query.cy);
    if (!Number.isFinite(centerCol) || !Number.isFinite(centerRow)) {
      return res.status(400).json({ error: 'cx and cy (tile coords) are required' });
    }
    const { snappedCol, snappedRow } = overviewOrigin(centerCol, centerRow, OVERVIEW_SPAN);
    const cacheKey = `${worldId}:${snappedCol}:${snappedRow}`;
    if (worldOverviewCache.has(cacheKey)) return res.json(worldOverviewCache.get(cacheKey));

    const worldRes = await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
    const world = worldRes.rows[0];
    if (!world) return res.status(404).json({ error: 'world not found' });

    const tileTypes = await getTileTypesMap();
    const doorways = (await fetchLinks(pool, world.id)).map((l) => l.edge);
    const villages = await fetchVillages(pool, world.id);
    const biomes = await loadBiomes(pool, world.biomes);
    const data = generateWorldOverview(
      buildWorldGenConfig({ row: world, tileTypes, doorways, villages, biomes }),
      centerCol, centerRow, OVERVIEW_SPAN, OVERVIEW_STEP,
    );
    const payload = { world_id: worldId, ...data };
    boundedCacheSet(worldOverviewCache, cacheKey, payload, OVERVIEW_CACHE_MAX);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate world overview' });
  }
});

if (require.main === module) {
  // Last-resort backstop: log and keep running instead of letting Node's
  // default behavior (exit 1) tear down the process on a rejection that
  // slipped past every route/handler guard. This is a safety net, not a
  // license to skip guarding individual async paths — F-001 and F-012 were
  // both fixed at the source; this only catches whatever the next one is.
  // Installed only inside the require.main guard (not at module-load time)
  // so it stays scoped to the actually-running server: `index.js` and
  // `authority/server.js` are also `require()`d by the test suite, and a
  // process-wide listener installed at import time would attach once per
  // test file, swallow rejections tests want to observe/assert on, and
  // leak across the whole `node --test` run instead of just protecting the
  // live service.
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection (backstopped, process kept alive):', reason);
  });

  const server = app.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
  });
  authorityHandle = attachAuthority(server, pool, { jwtSecret: process.env.JWT_SECRET });
  console.log('Authority WS attached at /authority');
}

module.exports = {
  app, __setSpriteGen, __setPool, __setAuthorityHandle, validateItemType, boundedCacheSet,
  apiRateLimiter, behaviorFieldError, abilityFieldError, behaviorAbilitiesError,
};
