const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { generateWorld, placeEntities, detectPathTile, uniqueTileNames, generateChunk } = require('./services/mapService');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3101;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Database setup
let pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
// Test seam: lets tests swap in a mock pool so routes don't need a live DB.
const __setPool = (impl) => { pool = impl; };

// Sprite-gen HTTP bridge (mutable holder so tests can mock the outbound calls).
let spriteGen = require('./services/spriteGen');
const __setSpriteGen = (impl) => { spriteGen = impl; };

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
// directly, not when it's required (e.g. by tests importing `app`).
if (require.main === module) {
  runMigrations();
}

// Helper to get tile types in the format expected by the game engine
async function getTileTypesMap() {
  const result = await pool.query('SELECT * FROM tile_types ORDER BY id ASC');
  const tileTypes = {};
  result.rows.forEach(row => {
    tileTypes[row.name] = {
      id: row.id,
      color: row.color,
      walkable: row.walkable,
      speed: row.speed,
      image: row.image,
      validNeighbors: row.valid_neighbors || []
    };
  });
  return tileTypes;
}

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
      displayHeight: row.display_height
    };
  });
  return entityTypes;
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Dev-only: mints a short-lived JWT signed with the engine's shared secret so
// the frontend can connect to the WS engine without a real auth flow yet.
// Replace with a proper login endpoint when auth lands.
app.get('/api/dev-token', (req, res) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'JWT_SECRET not configured' });
  }
  const userId = parseInt(req.query.user_id, 10) || Math.floor(Math.random() * 1e9) + 1;
  const username = req.query.username || `dev-${userId}`;
  const token = jwt.sign(
    { user_id: userId, username, sub: String(userId) },
    secret,
    { algorithm: 'HS256', expiresIn: '24h' }
  );
  res.json({ token, user_id: userId, username });
});

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

app.post('/api/entity-types', async (req, res) => {
  try {
    const {
      name, color, walkable, spawn_tiles, chance,
      strength, dexterity, constitution, intelligence, wisdom, charisma,
      hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image,
      display_width, display_height, render_mode
    } = req.body;
    if (!name || !color) return res.status(400).json({ error: 'Name and color are required' });

    const result = await pool.query(
      `INSERT INTO entity_types (
        name, color, walkable, spawn_tiles, chance,
        strength, dexterity, constitution, intelligence, wisdom, charisma,
        hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image,
        display_width, display_height, render_mode
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
      [
        name, color, walkable ?? false, JSON.stringify(spawn_tiles || []), chance ?? 0.1,
        strength ?? 0, dexterity ?? 0, constitution ?? 0, intelligence ?? 0, wisdom ?? 0, charisma ?? 0,
        hp ?? 0, max_hp ?? 0, hp_regen_rate ?? 0, mana ?? 0, max_mana ?? 0, mana_regen_rate ?? 0, image,
        display_width, display_height, render_mode ?? 'rect'
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create entity type' });
  }
});

app.put('/api/entity-types/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, color, walkable, spawn_tiles, chance,
      strength, dexterity, constitution, intelligence, wisdom, charisma,
      hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image,
      display_width, display_height, render_mode
    } = req.body;
    const result = await pool.query(
      `UPDATE entity_types SET
        name = $1, color = $2, walkable = $3, spawn_tiles = $4, chance = $5,
        strength = $6, dexterity = $7, constitution = $8, intelligence = $9, wisdom = $10, charisma = $11,
        hp = $12, max_hp = $13, hp_regen_rate = $14, mana = $15, max_mana = $16, mana_regen_rate = $17,
        image = $18, display_width = $19, display_height = $20, render_mode = $21, updated_at = CURRENT_TIMESTAMP
      WHERE id = $22 RETURNING *`,
      [
        name, color, walkable, JSON.stringify(spawn_tiles), chance,
        strength, dexterity, constitution, intelligence, wisdom, charisma,
        hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image,
        display_width, display_height, render_mode ?? 'rect', id
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entity type not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update entity type' });
  }
});

app.delete('/api/entity-types/:id', async (req, res) => {
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

app.post('/api/tile-types', async (req, res) => {
  try {
    const { name, color, walkable, speed, image, valid_neighbors } = req.body;
    
    // Simple validation
    if (!name || !color) {
      return res.status(400).json({ error: 'Name and color are required' });
    }

    const result = await pool.query(
      'INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, color, walkable ?? true, speed ?? 1.0, image || '', JSON.stringify(valid_neighbors || [])]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create tile type' });
  }
});

app.put('/api/tile-types/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color, walkable, speed, image, valid_neighbors } = req.body;
    
    const result = await pool.query(
      'UPDATE tile_types SET name = $1, color = $2, walkable = $3, speed = $4, image = $5, valid_neighbors = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *',
      [name, color, walkable, speed, image, JSON.stringify(valid_neighbors), id]
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

app.delete('/api/tile-types/:id', async (req, res) => {
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
app.post('/api/maps/generate', async (req, res) => {
  try {
    const { name, description, rows = 100, cols = 100, seed } = req.body;

    console.log(`Generating map: ${name} (${rows}x${cols})`);

    // Fetch tile types from DB for generation
    const tileTypes = await getTileTypesMap();
    const worldSeed = Number.isFinite(seed) ? seed : Date.now();
    const mapData = generateWorld(rows, cols, tileTypes, { seed: worldSeed });
    
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
app.delete('/api/maps/:id', async (req, res) => {
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
app.post('/api/maps/:id/entities', async (req, res) => {
  const client = await pool.connect();
  try {
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
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to save entities' });
  } finally {
    client.release();
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
app.post('/api/maps/:id/generate-entities', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
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
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Generation failed: ' + err.message });
  } finally {
    client.release();
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

// Sprite-gen admin bridge: kick off a generation job with the sprite-gen
// service and record it as a queued sprite_sets row. When the caller doesn't
// pin a backend/tier we auto-select the tier from detected hardware; the
// sprite-gen recipe then fills backend/frames/steps for that tier.
app.post('/api/sprite-jobs', async (req, res) => {
  try {
    const { entity_type, base_prompt, backend, frames, seed = 0, tier } = req.body;
    let effectiveTier = tier;
    if (!effectiveTier && !backend) {
      // Best-effort: if capability lookup fails, let sprite-gen use its own default.
      try { effectiveTier = (await spriteGen.getCapability()).tier; } catch (_) { /* ignore */ }
    }
    const gen = await spriteGen.postGenerate({
      creature: entity_type, base_prompt, backend, frames, seed, tier: effectiveTier,
    });
    // Record the actually-chosen backend/frames (from the recipe when not pinned).
    const chosenBackend = backend || (gen.recipe && gen.recipe.backend) || 'stub';
    const chosenFrames = frames || (gen.recipe && gen.recipe.frames) || 4;
    const row = await pool.query(
      `INSERT INTO sprite_sets (creature, backend, seed, frames, job_id, status)
       VALUES ($1, $2, $3, $4, $5, 'queued') RETURNING *`,
      [entity_type, chosenBackend, seed, chosenFrames, gen.job_id]
    );
    res.status(201).json({ ...row.rows[0], job_id: gen.job_id, recipe: gen.recipe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start sprite job' });
  }
});

// Proxy job status from the sprite-gen service.
app.get('/api/sprite-jobs/:jobId', async (req, res) => {
  try {
    const job = await spriteGen.getJob(req.params.jobId);
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// Approve a generated sprite set and link it to an entity type.
// :id is entity_types.id (integer); pg casts the string param automatically.
app.post('/api/entity-types/:id/sprite', async (req, res) => {
  try {
    const { atlas_key, manifest_key, job_id, static_frame } = req.body;
    const result = await pool.query(
      `UPDATE sprite_sets SET atlas_key = $1, manifest_key = $2, status = 'approved', entity_type_id = $3
       WHERE job_id = $4 RETURNING *`,
      [atlas_key, manifest_key, req.params.id, job_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Sprite set not found' });

    // Link the atlas to the entity type and flip it to static rendering so the
    // game crops the named frame from the atlas (default: south-facing frame 0).
    const sprite = { atlas_key, manifest_key, static_frame: static_frame || 'S/0' };
    await pool.query(
      `UPDATE entity_types SET sprite = $1, render_mode = 'static', updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(sprite), req.params.id]
    );

    res.json({ ...result.rows[0], sprite });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save sprite' });
  }
});

// --- Worlds (chunked overworld) -------------------------------------------

app.post('/api/worlds', async (req, res) => {
  try {
    const { name, seed, chunk_size } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const worldSeed = Number.isFinite(seed) ? Math.floor(seed) : Math.floor(Math.random() * 2 ** 31);
    const chunkSize = Number.isFinite(chunk_size) ? Math.floor(chunk_size) : 64;
    const result = await pool.query(
      'INSERT INTO worlds (name, seed, chunk_size) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), worldSeed, chunkSize],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
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

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
  });
}

module.exports = { app, __setSpriteGen, __setPool };
