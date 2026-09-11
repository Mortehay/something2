#!/usr/bin/env node
// Trim the entity art ALREADY in the object store. SOMET-564.
//
// SOMET-563 trims art on the way in, so everything generated from now on is
// tight. This is the other half: hundreds of images were stored before that
// existed, and they are what the world is rendering today. Measured across the
// eleven newest remote-generated objects, the subject spans a mean 30.4% of its
// canvas width -- and because RenderSystem stretches the whole image into the
// entity's display box, that is what it renders at.
//
// DRY RUN BY DEFAULT. Pass --apply to write. The default prints exactly what it
// would do and touches nothing, because this rewrites art in a store that is
// shared with whatever else is running against it.
//
// IDEMPOTENT, and that is a correctness requirement rather than a nicety:
// pngTrim returns the original buffer untouched when an image is already as
// tight as it would make it, so a second run reports ratio 1.00 for everything
// and writes nothing. Without that property a repair pass would shave another
// margin off every image each time somebody ran it.
//
// The exclusions are NOT re-implemented here. trimForStorage owns them -- tiles
// by kind, unreadable images by the null return -- and importing it is what
// stops this script and the live path drifting into two different rules.

const path = require('path');
const dotenv = require('dotenv');
const assetStore = require('../src/services/assetStore.js');
const { trimForStorage } = require('../src/services/remoteImageProvider.js');

// Keys under these prefixes are ground textures, not props. `sprites/tiles/` is
// where remoteImageProvider.storageKey puts them.
const TILE_PREFIX = 'tiles/';

// An atlas is a sheet of frames whose layout a manifest describes; trimming it
// as one image would desync the two and crop every frame wrongly. Sheets are
// stored as atlas.png beside an atlas.json.
const ATLAS_FILE = 'atlas.png';

function classify(key) {
  const rest = key.split('/').slice(1).join('/');   // drop the bucket segment
  if (rest.startsWith(TILE_PREFIX)) return 'tile';
  if (key.endsWith(ATLAS_FILE)) return 'atlas';
  if (!key.endsWith('.png')) return 'not-an-image';
  return 'object';
}

async function readObject(store, key) {
  const stream = await store.getObjectStream(key);
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function trimStoredTextures(store, { apply = false, limit = 0, log = console.log } = {}) {
  const keys = await store.listObjectKeys();
  const stats = {
    scanned: 0, trimmed: 0, alreadyTight: 0, skippedTile: 0, skippedAtlas: 0,
    unreadable: 0, failed: 0, bytesBefore: 0, bytesAfter: 0,
  };

  for (const key of keys) {
    const kind = classify(key);
    if (kind === 'not-an-image') continue;
    if (kind === 'tile') { stats.skippedTile += 1; continue; }
    if (kind === 'atlas') { stats.skippedAtlas += 1; continue; }
    if (limit && stats.scanned >= limit) break;
    stats.scanned += 1;

    let buf;
    try {
      // eslint-disable-next-line no-await-in-loop
      buf = await readObject(store, key);
    } catch (err) {
      log(`  FAILED read ${key}: ${err.message}`);
      stats.failed += 1;
      continue;
    }

    const out = trimForStorage(buf, 'object');
    if (out.skipped === 'unreadable') {
      stats.unreadable += 1;
      log(`  skip  ${key} (not 8-bit RGBA)`);
      continue;
    }
    if (out.ratio >= 1) {
      stats.alreadyTight += 1;
      continue;
    }

    stats.trimmed += 1;
    stats.bytesBefore += buf.length;
    stats.bytesAfter += out.buffer.length;
    log(`  ${apply ? 'trim ' : 'would'} ${key}  ratio ${out.ratio.toFixed(3)}  `
      + `${buf.length} -> ${out.buffer.length} bytes`);

    if (apply) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await store.putObject(key, out.buffer, 'image/png');
      } catch (err) {
        log(`  FAILED write ${key}: ${err.message}`);
        stats.failed += 1;
      }
    }
  }
  return stats;
}

// --- the checked-in seed art ------------------------------------------------
//
// The other place entity art lives. seed-art.js trims on upload, so
// the object store ends up correct either way; this exists so the committed
// PNGs are correct on their own terms, for anyone reading or using them outside
// the seeder.
//
// The manifest records a `bytes` field per entry, so it has to be rewritten in
// the same pass or it starts lying about files it describes.
async function trimSeedFiles({ apply = false, log = console.log } = {}) {
  // Required lazily: this half touches no object store, and importing the
  // manifest paths at module load would make the store-side entry point depend
  // on the seed directory existing.
  // eslint-disable-next-line global-require
  const fs = require('fs');
  // eslint-disable-next-line global-require
  const { SEED_POLICY, SEEDS_ROOT } = require('../src/services/artSeed.js');
  const IN_DIR = path.join(SEEDS_ROOT, SEED_POLICY.entity.dir);
  const MANIFEST = path.join(SEEDS_ROOT, SEED_POLICY.entity.manifest);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const stats = { scanned: 0, trimmed: 0, alreadyTight: 0, unreadable: 0, missing: 0 };

  for (const entry of manifest) {
    const file = path.join(IN_DIR, entry.file);
    if (!fs.existsSync(file)) { stats.missing += 1; continue; }
    stats.scanned += 1;

    const buf = fs.readFileSync(file);
    const out = trimForStorage(buf, 'object');
    if (out.skipped === 'unreadable') { stats.unreadable += 1; continue; }
    if (out.ratio >= 1) { stats.alreadyTight += 1; continue; }

    stats.trimmed += 1;
    log(`  ${apply ? 'trim ' : 'would'} ${entry.file}  ratio ${out.ratio.toFixed(3)}  `
      + `${buf.length} -> ${out.buffer.length} bytes`);
    if (apply) {
      fs.writeFileSync(file, out.buffer);
      entry.bytes = out.buffer.length;
    }
  }

  if (apply && stats.trimmed) {
    // Trailing newline: the file is committed, and a missing one makes every
    // future regeneration show a spurious last-line diff.
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return stats;
}

module.exports = { trimStoredTextures, trimSeedFiles, classify };

function main() {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;

  if (!apply) {
    console.log('DRY RUN -- nothing will be written. Pass --apply to write.\n');
  }

  // --files trims the committed seed PNGs instead of the object store. They are
  // two separate populations and conflating them in one run would make the
  // summary meaningless, so it is one mode or the other.
  if (process.argv.includes('--files')) {
    trimSeedFiles({ apply })
      .then((s) => {
        console.log(`\n${apply ? 'trimmed' : 'would trim'} ${s.trimmed} of ${s.scanned} seed files`
          + ` (${s.alreadyTight} already tight, ${s.unreadable} unreadable, ${s.missing} missing)`);
      })
      .catch((e) => { console.error(e.message); process.exitCode = 1; });
    return;
  }

  trimStoredTextures(assetStore, { apply, limit })
    .then((s) => {
      const saved = s.bytesBefore - s.bytesAfter;
      console.log(`\n${apply ? 'trimmed' : 'would trim'} ${s.trimmed} of ${s.scanned} object images`
        + ` (${s.alreadyTight} already tight, ${s.unreadable} unreadable, ${s.failed} failed)`);
      console.log(`skipped ${s.skippedTile} tiles and ${s.skippedAtlas} atlases by rule`);
      if (s.trimmed) {
        console.log(`bytes: ${s.bytesBefore} -> ${s.bytesAfter} (${saved} saved)`);
      }
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; });
}

if (require.main === module) main();
