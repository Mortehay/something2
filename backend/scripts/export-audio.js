#!/usr/bin/env node
// Copy bound audio clips out of MinIO into the repo so they can be committed
// and replayed on a machine with no live object store. Run via
// `make audio-export`; the export/seed logic lives in src/services/audioSeed.js.
//
//   node scripts/export-audio.js                        every kind
//   node scripts/export-audio.js --kind=music,ambience  some kinds
//   node scripts/export-audio.js --only=Vale,Forest     some subjects' bound clips (manifest merged, not truncated)

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');
const { exportAudio, parseArgs } = require('../src/services/audioSeed.js');

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  exportAudio({
    db: pool, store: assetStore, kinds: args.kinds, only: args.only,
  })
    .then((results) => {
      for (const [kind, s] of Object.entries(results)) {
        console.log(`exported ${s.exported} ${kind} clips (${(s.bytes / 1048576).toFixed(1)} MB) to seeds/audio/${kind}/`);
        if (s.missing.length) console.log(`  missing in the object store: ${s.missing.join(', ')}`);
      }
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
