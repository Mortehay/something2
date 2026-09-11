#!/usr/bin/env node
// Replay the committed entity art into the object store and point the catalog
// at it. Run via `make entities-seed`. Tile-side sibling:
// seed-tile-textures.js.
//
// Same stable-key rule as tiles, for the same reason -- a seeded asset must not
// claim to be the output of a job id that only ever existed on somebody else's
// machine:
//
//   <bucket>/<name>/seeded/static.png
//
// Note the shape: entity keys have no `tiles/` or `objects/` prefix, matching
// what remoteImageProvider.storageKey writes for the creature path and what
// sprite-gen's storage.py has always used. Getting this wrong would store the
// file somewhere GET /api/assets/* does not look.

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');
const { trimForStorage } = require('../src/services/remoteImageProvider.js');

const IN_DIR = path.resolve(__dirname, '../seeds/textures/entities');
const MANIFEST = path.resolve(__dirname, '../seeds/textures/entities.json');

function seededKey(bucket, name) {
  const safe = String(name).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${bucket}/${safe}/seeded/static.png`;
}

async function seedEntityTextures(pool, { force = false, only = null } = {}) {
  if (!fs.existsSync(MANIFEST)) {
    throw new Error(`no manifest at ${MANIFEST} -- run \`make entities-export\` first`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const wanted = only ? manifest.filter((m) => only.includes(m.name)) : manifest;

  // Refuse to seed art that never had its backdrop removed. Without the cutout
  // every prop ships as a subject inside an opaque square, which looks like a
  // rendering bug rather than a missing pipeline step -- and it would be
  // committed and spread to every other machine.
  if (wanted.length && !wanted.every((m) => m.cutout)) {
    throw new Error('these images have not been cut out -- run `make entities-cutout` first, '
      + 'or they will render as subjects inside opaque rectangles');
  }

  await assetStore.ensureBucket();
  const bucket = assetStore.BUCKET();
  const stats = {
    uploaded: 0, linked: 0, skipped: 0, missingFile: 0, missingEntity: 0,
    needsRegen: 0, trimmed: 0,
  };

  for (const entry of wanted) {
    // Flagged by the cutout pass as still carrying a background or as an
    // erased subject. Seeding one puts a visible box or a blank where a
    // sprite should be, which is worse than the coloured rectangle it would
    // replace -- so it waits for a redraw instead.
    if (entry.needs_regen) {
      stats.needsRegen += 1;
      continue;
    }
    const file = path.join(IN_DIR, entry.file);
    if (!fs.existsSync(file)) {
      console.log(`  ${entry.name}: FAILED ${entry.file} is in the manifest but not on disk`);
      stats.missingFile += 1;
      continue;
    }
    const row = await pool.query('SELECT id, render_mode FROM entity_types WHERE name = $1', [entry.name]);
    if (!row.rows[0]) {
      console.log(`  ${entry.name}: SKIP (no such entity -- run \`make seed-catalogs\` first)`);
      stats.missingEntity += 1;
      continue;
    }
    // 'rect' is "no art". Anything else -- static, directional, animated -- is
    // art this machine already has, and a directional set in particular must
    // not be flattened to one still by a seed run.
    if (row.rows[0].render_mode !== 'rect' && !force) {
      stats.skipped += 1;
      continue;
    }

    // SOMET-564. Trim on the way up, rather than re-trimming the checked-in
    // files and committing 15MB of rewritten binaries.
    //
    // WHY HERE AND NOT IN THE FILES. A repair that only fixes the object store
    // is undone by the next seed run -- the shape recorded in SOMET-335, where
    // two migrations repaired the entry world's spawn and both were silently
    // reverted by re-seeding. Trimming at the seam that does the re-seeding
    // closes that by construction: there is no state to drift back to, because
    // the rule is applied every time the art is uploaded. The PNGs on disk stay
    // as the generator drew them, which is what they are -- source.
    //
    // Same trimForStorage the live generation path uses, so seeded art and
    // freshly generated art cannot disagree.
    const key = seededKey(bucket, entry.name);
    const trimmed = trimForStorage(fs.readFileSync(file), 'object');
    await assetStore.putObject(key, trimmed.buffer, 'image/png');
    stats.uploaded += 1;
    if (trimmed.ratio < 1) stats.trimmed += 1;
    await pool.query(
      `UPDATE entity_types SET image = $1, sprite = NULL, render_mode = 'static',
        updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [key, row.rows[0].id],
    );
    stats.linked += 1;
  }
  return stats;
}

module.exports = { seedEntityTextures, seededKey, IN_DIR, MANIFEST };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const force = process.argv.includes('--force');
  const pool = new Pool({ connectionString: url });
  seedEntityTextures(pool, { force })
    .then((s) => {
      console.log(`seeded ${s.linked} entity images (${s.uploaded} uploaded, `
        + `${s.trimmed} trimmed), `
        + `${s.skipped} already had art, ${s.needsRegen} awaiting a redraw, `
        + `${s.missingFile} missing files, ${s.missingEntity} unknown entities`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
