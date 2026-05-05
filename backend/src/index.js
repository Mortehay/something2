const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { generateWFC } = require('./services/mapService');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3101;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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

runMigrations();

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
      image: row.image
    };
  });
  return entityTypes;
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
      hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image
    } = req.body;
    if (!name || !color) return res.status(400).json({ error: 'Name and color are required' });

    const result = await pool.query(
      `INSERT INTO entity_types (
        name, color, walkable, spawn_tiles, chance, 
        strength, dexterity, constitution, intelligence, wisdom, charisma,
        hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
      [
        name, color, walkable ?? false, JSON.stringify(spawn_tiles || []), chance ?? 0.1,
        strength ?? 0, dexterity ?? 0, constitution ?? 0, intelligence ?? 0, wisdom ?? 0, charisma ?? 0,
        hp ?? 0, max_hp ?? 0, hp_regen_rate ?? 0, mana ?? 0, max_mana ?? 0, mana_regen_rate ?? 0, image
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
      hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image
    } = req.body;
    const result = await pool.query(
      `UPDATE entity_types SET 
        name = $1, color = $2, walkable = $3, spawn_tiles = $4, chance = $5,
        strength = $6, dexterity = $7, constitution = $8, intelligence = $9, wisdom = $10, charisma = $11,
        hp = $12, max_hp = $13, hp_regen_rate = $14, mana = $15, max_mana = $16, mana_regen_rate = $17, 
        image = $18, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $19 RETURNING *`,
      [
        name, color, walkable, JSON.stringify(spawn_tiles), chance,
        strength, dexterity, constitution, intelligence, wisdom, charisma,
        hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate, image, id
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
    const { name, description, rows = 100, cols = 100 } = req.body;
    
    console.log(`Generating map: ${name} (${rows}x${cols})`);
    
    // Fetch tile types from DB for generation
    const tileTypes = await getTileTypesMap();
    const mapData = generateWFC(rows, cols, tileTypes);
    
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

// Save map entities
app.post('/api/maps/:id/entities', async (req, res) => {
  console.log("api/maps/:id/entities called with params:", req.params);
  console.log("and body:", req.body);
  try {
    const { id } = req.params;
    const { entities } = req.body;
    
    const mapResult = await pool.query('SELECT id FROM maps WHERE id = $1', [id]);
    if (mapResult.rows.length === 0) return res.status(404).json({ error: 'Map not found' });
    
    await pool.query('DELETE FROM map_entities WHERE map_id = $1', [id]);
    if (entities && entities.length > 0) {
      await pool.query(
        'INSERT INTO map_entities (map_id, data) VALUES ($1, $2)',
        [id, JSON.stringify(entities)]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save entities' });
  }
});

// Load map entities
app.get('/api/maps/:id/entities', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT data FROM map_entities WHERE map_id = $1', [id]);
    if (result.rows.length === 0) {
      return res.json([]);
    }
    res.json(result.rows[0].data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch entities' });
  }
});

// Generate and save entities for a map
app.post('/api/maps/:id/generate-entities', async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Get Map data (tiles)
    const mapResult = await pool.query('SELECT data FROM maps WHERE id = $1', [id]);
    if (mapResult.rows.length === 0) return res.status(404).json({ error: 'Map not found' });
    const tiles = mapResult.rows[0].data;

    // 2. Get all Entity Types rules
    const typeResult = await pool.query('SELECT * FROM entity_types');
    const entityTypes = typeResult.rows;

    // 3. Generation logic
    const generatedEntities = [];
    const rows = tiles.length;
    const cols = tiles[0].length;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tileType = tiles[r][c];
        // Find entity types that can spawn on this tile
        const possible = entityTypes.filter(t => t.spawn_tiles && t.spawn_tiles.includes(tileType));
        
        for (const def of possible) {
          if (Math.random() < def.chance) {
            generatedEntities.push({
              type: def.name,
              row: r,
              col: c,
              name: def.name
            });
            // Stop at first successful spawn for this tile to avoid overcrowding
            break; 
          }
        }
      }
    }

    // 4. Save to map_entities table (Overwrite existing)
    await pool.query('DELETE FROM map_entities WHERE map_id = $1', [id]);
    if (generatedEntities.length > 0) {
      await pool.query(
        'INSERT INTO map_entities (map_id, data) VALUES ($1, $2)',
        [id, JSON.stringify(generatedEntities)]
      );
    }

    // 5. Update timestamp
    await pool.query('UPDATE maps SET updated_at = NOW() WHERE id = $1', [id]);

    res.json({ 
      success: true, 
      count: generatedEntities.length, 
      entities: generatedEntities 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});


app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
});
