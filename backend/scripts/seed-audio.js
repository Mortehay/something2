#!/usr/bin/env node
// Replay committed audio clips into the object store and re-link their
// bindings. Run via `make audio-seed`; the export/seed logic lives in
// src/services/audioSeed.js.
//
//   node scripts/seed-audio.js                       every kind
//   node scripts/seed-audio.js --kind=music          some kinds
//   node scripts/seed-audio.js --only=Vale --force   overwrite one subject's clips

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');
const { seedAudio, parseArgs } = require('../src/services/audioSeed.js');

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  seedAudio({
    db: pool, store: assetStore, kinds: args.kinds, only: args.only, force: args.force,
  })
    .then((results) => {
      console.log(`clips: ${results.clips.linked} linked, ${results.clips.skipped} already present, `
        + `${results.clips.missingFile} missing files`);
      console.log(`bindings: ${results.bindings.bound} bound, ${results.bindings.skipped} already present, `
        + `${results.bindings.missingSubject.length} unknown subjects`);
      if (results.bindings.missingSubject.length) console.log(`  ${results.bindings.missingSubject.join(', ')}`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
