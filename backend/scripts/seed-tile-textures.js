#!/usr/bin/env node
// Replay the committed tile textures into the object store and point the
// catalog at them. Run via `make tiles-seed`.
//
// This is the other half of export-tile-textures.js: clone the repo on a
// machine with no GPU and no AI provider, run this, and the world renders with
// the textures somebody else generated.
//
// A FIXED KEY, NOT THE ORIGINAL JOB KEY. Generated assets are stored under the
// job id that produced them (SOMET-235 made keys job-scoped so a regeneration
// can never be served from a stale cache). Replaying the original key would
// resurrect one machine's job ids on another and make the two disagree about
// which job a texture came from. Seeded textures get their own honest
// namespace instead:
//
//   <bucket>/tiles/<name>/seeded/static.png
//
// It is stable, so re-running overwrites in place rather than accumulating,
// and `seeded` says where the pixels came from.
//
// UPSERT, NEVER CLOBBER BY DEFAULT. A tile that already has a texture is left
// alone: on a machine that HAS generated its own art, seeding must not throw it
// away. --force overwrites, which is what you want when the committed set is
// the newer one.

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');

const IN_DIR = path.resolve(__dirname, '../seeds/textures/tiles');
const MANIFEST = path.resolve(__dirname, '../seeds/textures/tiles.json');

function seededKey(bucket, name) {
  const safe = String(name).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${bucket}/tiles/${safe}/seeded/static.png`;
}

async function seedTileTextures(pool, { force = false, only = null } = {}) {
  if (!fs.existsSync(MANIFEST)) {
    throw new Error(`no texture manifest at ${MANIFEST} -- run \`make tiles-export\` first`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const wanted = only ? manifest.filter((m) => only.includes(m.name)) : manifest;

  await assetStore.ensureBucket();
  const bucket = assetStore.BUCKET();
  const stats = { uploaded: 0, linked: 0, skipped: 0, missingFile: 0, missingTile: 0 };

  for (const entry of wanted) {
    const file = path.join(IN_DIR, entry.file);
    if (!fs.existsSync(file)) {
      console.log(`  ${entry.name}: FAILED ${entry.file} listed in the manifest but not on disk`);
      stats.missingFile += 1;
      continue;
    }
    const row = await pool.query(
      'SELECT id, render_mode FROM tile_types WHERE name = $1', [entry.name],
    );
    if (!row.rows[0]) {
      // The catalog is seeded separately and may legitimately not have this
      // tile yet. Say so rather than inventing a row here.
      console.log(`  ${entry.name}: SKIP (no such tile -- run \`make seed-catalogs\` first)`);
      stats.missingTile += 1;
      continue;
    }
    if (row.rows[0].render_mode !== 'color' && !force) {
      stats.skipped += 1;
      continue;
    }

    const key = seededKey(bucket, entry.name);
    await assetStore.putObject(key, fs.readFileSync(file), 'image/png');
    stats.uploaded += 1;
    await pool.query(
      `UPDATE tile_types SET image = $1, sprite = NULL, render_mode = 'image',
        art_biome = CASE WHEN art_biome = '' THEN $2 ELSE art_biome END,
        updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [key, entry.art_biome || '', row.rows[0].id],
    );
    stats.linked += 1;
    console.log(`  ${entry.name}: seeded`);
  }
  return stats;
}

module.exports = { seedTileTextures, seededKey, IN_DIR, MANIFEST };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const force = process.argv.includes('--force');
  const pool = new Pool({ connectionString: url });
  seedTileTextures(pool, { force })
    .then((s) => {
      console.log(`seeded ${s.linked} tile textures (${s.uploaded} uploaded), `
        + `${s.skipped} already textured, ${s.missingFile} missing files, ${s.missingTile} unknown tiles`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
