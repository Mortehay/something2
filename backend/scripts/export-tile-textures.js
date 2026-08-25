#!/usr/bin/env node
// Copy the generated tile textures out of MinIO and into the repo, so they can
// be committed and replayed on a machine with no GPU. Run via
// `make tiles-export`.
//
// THE PROBLEM THIS SOLVES. A generated texture lives in two places that git
// cannot see: the object store holds the pixels, and tile_types.image holds a
// job-scoped key pointing at them. Clone the repo onto another machine and you
// get neither -- every tile falls back to flat colour, and regenerating means
// owning the GPU box. The textures are expensive, deterministic-ish output;
// they belong in version control the same way generated sprites do.
//
// WHAT IS WRITTEN. One PNG per textured tile under seeds/textures/tiles/, named
// for the tile rather than the job, plus a manifest recording the prompt and
// biome each one was drawn from. The job-scoped source key is deliberately NOT
// what the seeder replays -- see seed-tile-textures.js for why.
//
// SIZE, stated plainly: these are 512px PNGs at roughly 300-500 KB each, so a
// full catalog is ~15-20 MB of binary in git. That is the cost of not needing
// a GPU to see the game as intended. Nothing here downscales them, because the
// backend has no image library and adding one to shrink a seed asset would be
// a poor trade.

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');

const OUT_DIR = path.resolve(__dirname, '../seeds/textures/tiles');
const MANIFEST = path.resolve(__dirname, '../seeds/textures/tiles.json');

async function readObject(key) {
  const stream = await assetStore.getObjectStream(key);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function exportTileTextures(pool, { only = null } = {}) {
  const r = await pool.query(
    `SELECT name, image, prompt, art_biome FROM tile_types
      WHERE render_mode = 'image' AND image <> '' ORDER BY name`,
  );
  const rows = only ? r.rows.filter((t) => only.includes(t.name)) : r.rows;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = [];
  let bytes = 0;
  const failed = [];
  for (const tile of rows) {
    try {
      const buf = await readObject(tile.image);
      const file = `${tile.name}.png`;
      fs.writeFileSync(path.join(OUT_DIR, file), buf);
      bytes += buf.length;
      // The prompt and biome ride along so a future reader can tell what a
      // committed PNG was drawn from without digging through the database it
      // came out of.
      manifest.push({
        name: tile.name, file, bytes: buf.length,
        prompt: tile.prompt, art_biome: tile.art_biome || '',
      });
      console.log(`  ${tile.name}: ${(buf.length / 1024).toFixed(0)} KB`);
    } catch (err) {
      // A row pointing at a key the store no longer has is worth reporting,
      // not crashing on: it means that tile needs regenerating.
      console.log(`  ${tile.name}: FAILED ${err.message}`);
      failed.push(tile.name);
    }
  }
  manifest.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return { exported: manifest.length, bytes, failed };
}

module.exports = { exportTileTextures, OUT_DIR, MANIFEST };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  exportTileTextures(pool)
    .then((s) => {
      console.log(`exported ${s.exported} tile textures (${(s.bytes / 1048576).toFixed(1)} MB) `
        + `to seeds/textures/tiles/`);
      if (s.failed.length) console.log(`missing in the object store: ${s.failed.join(', ')}`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
