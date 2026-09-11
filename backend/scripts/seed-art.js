#!/usr/bin/env node
// Replay the committed catalog art into the object store and point every
// catalog row at it. Run via `make art-seed`; the per-kind rules and the
// export half live in src/services/artSeed.js.
//
//   node scripts/seed-art.js                        every kind
//   node scripts/seed-art.js --kind=tile,entity     some kinds
//   node scripts/seed-art.js --only=Wolf --force    overwrite one subject's local art
//
// Trimming happens here, on the way up, with the same trimForStorage the live
// generation path uses -- so seeded art and freshly generated art cannot
// disagree, and the PNGs on disk stay as the generator drew them (SOMET-564).

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');
const { trimForStorage } = require('../src/services/remoteImageProvider.js');
const { seedArt, parseArgs } = require('../src/services/artSeed.js');

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  seedArt({
    db: pool, store: assetStore, kinds: args.kinds, only: args.only, force: args.force, trimForStorage,
  })
    .then((results) => {
      for (const [kind, s] of Object.entries(results)) {
        console.log(`seeded ${s.linked} ${kind} images (${s.trimmed} trimmed), `
          + `${s.skipped} already had art, ${s.needsRegen} awaiting a redraw, `
          + `${s.missingFile} missing files, ${s.missingRow} unknown subjects`);
      }
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
