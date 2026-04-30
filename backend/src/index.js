const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { generateWFC, TILE_TYPES } = require('./services/mapService');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

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
        EXISTS(SELECT 1 FROM map_environments me WHERE me.map_id = m.id) as has_environments
      FROM maps m 
      ORDER BY m.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch maps' });
  }
});

// List all map tiles
app.get('/api/map/tiles', async (req, res) => {
  try {
    res.json(TILE_TYPES);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch map tiles' });
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
    const mapData = generateWFC(rows, cols);
    
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

// Save map environments
app.post('/api/maps/:id/environments', async (req, res) => {
  try {
    const { id } = req.params;
    const { environments } = req.body;
    
    const mapResult = await pool.query('SELECT id FROM maps WHERE id = $1', [id]);
    if (mapResult.rows.length === 0) return res.status(404).json({ error: 'Map not found' });
    
    await pool.query('DELETE FROM map_environments WHERE map_id = $1', [id]);
    if (environments && environments.length > 0) {
      await pool.query(
        'INSERT INTO map_environments (map_id, data) VALUES ($1, $2)',
        [id, JSON.stringify(environments)]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save environments' });
  }
});

// Load map environments
app.get('/api/maps/:id/environments', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT data FROM map_environments WHERE map_id = $1', [id]);
    if (result.rows.length === 0) {
      return res.json([]);
    }
    res.json(result.rows[0].data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch environments' });
  }
});

app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
});
