#!/usr/bin/env node
// Copy generated catalog art out of MinIO into the repo so it can be committed
// and replayed on a machine with no GPU. Run via `make art-export`; the
// per-kind rules and the seed half live in src/services/artSeed.js.
//
//   node scripts/export-art.js                      every kind
//   node scripts/export-art.js --kind=skill,item    some kinds
//   node scripts/export-art.js --only=grass,sand    some subjects (manifest merged, not truncated)
//
// SIZE, stated plainly: tiles are 512px PNGs at ~300-500 KB each and objects
// are 1024px cutouts, so a full catalogue is tens of MB of binary in git. That
// is the cost of not needing a GPU to see the game as intended.

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');
const { exportArt, parseArgs, SEED_POLICY } = require('../src/services/artSeed.js');

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  exportArt({ db: pool, store: assetStore, kinds: args.kinds, only: args.only })
    .then((results) => {
      for (const [kind, s] of Object.entries(results)) {
        console.log(`exported ${s.exported} ${kind} images (${(s.bytes / 1048576).toFixed(1)} MB) `
          + `to seeds/textures/${SEED_POLICY[kind].dir}/`);
        if (s.failed.length) console.log(`  missing in the object store: ${s.failed.join(', ')}`);
      }
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
