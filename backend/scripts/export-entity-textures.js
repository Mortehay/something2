#!/usr/bin/env node
// Copy generated entity art out of MinIO into the repo. Run via
// `make entities-export`. Tile-side sibling: export-tile-textures.js.
//
// Same bargain as tiles: the pixels live in an object store and the catalog
// holds a job-scoped key, neither of which survives a clone. Committing the
// PNGs is what lets a machine with no GPU show props and creatures instead of
// coloured rectangles.
//
// ONLY `static` ROWS ARE EXPORTED. An entity whose render_mode is 'directional'
// or 'animated' carries an atlas plus a manifest rather than one still, and
// pretending a single PNG represents it would quietly downgrade it on the next
// seed. Those remain sprite-gen's business.

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');

const OUT_DIR = path.resolve(__dirname, '../seeds/textures/entities');
const MANIFEST = path.resolve(__dirname, '../seeds/textures/entities.json');

// See the note in export-tile-textures.js: this runs as root inside the
// container onto a bind mount, and without it the host user cannot touch the
// files the cutout pass has to rewrite.
function matchOwner(target, referenceDir) {
  try {
    const ref = fs.statSync(referenceDir);
    fs.chownSync(target, ref.uid, ref.gid);
  } catch (_) { /* not fatal */ }
}

async function readObject(key) {
  const stream = await assetStore.getObjectStream(key);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function exportEntityTextures(pool, { only = null } = {}) {
  const r = await pool.query(
    `SELECT name, image, prompt, is_creature FROM entity_types
      WHERE render_mode = 'static' AND image IS NOT NULL AND image <> '' ORDER BY name`,
  );
  const rows = only ? r.rows.filter((e) => only.includes(e.name)) : r.rows;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = [];
  let bytes = 0;
  const failed = [];
  for (const entity of rows) {
    try {
      const buf = await readObject(entity.image);
      const file = `${entity.name.replace(/[^A-Za-z0-9_-]/g, '_')}.png`;
      const dest = path.join(OUT_DIR, file);
      fs.writeFileSync(dest, buf);
      matchOwner(dest, path.resolve(__dirname, '../seeds'));
      bytes += buf.length;
      manifest.push({
        name: entity.name, file, bytes: buf.length,
        prompt: entity.prompt, is_creature: entity.is_creature,
      });
    } catch (err) {
      console.log(`  ${entity.name}: FAILED ${err.message}`);
      failed.push(entity.name);
    }
  }
  manifest.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  matchOwner(MANIFEST, path.resolve(__dirname, '../seeds'));
  matchOwner(OUT_DIR, path.resolve(__dirname, '../seeds'));
  return { exported: manifest.length, bytes, failed };
}

module.exports = { exportEntityTextures, OUT_DIR, MANIFEST };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  exportEntityTextures(pool)
    .then((s) => {
      console.log(`exported ${s.exported} entity images (${(s.bytes / 1048576).toFixed(1)} MB) `
        + 'to seeds/textures/entities/');
      if (s.failed.length) console.log(`missing in the object store: ${s.failed.join(', ')}`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
