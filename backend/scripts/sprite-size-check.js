#!/usr/bin/env node
// SOMET-697 backfill: flag size-jump (close-up) frames on sheets already stored.
//
//   node scripts/sprite-size-check.js                 dry run, every sheet
//   node scripts/sprite-size-check.js --id <uuid>     dry run, one sprite_sets row
//   node scripts/sprite-size-check.js --apply         write the merged manifests
//
// The database is only ever SELECTed; --apply writes the manifest object back
// to the same manifest_key in the object store.

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');
const { sizeJumpFlags, mergeQuality } = require('../src/services/spriteSizeCheck.js');
const { decodeRGBA } = require('../src/services/pngAlpha.js');

function parseArgs(argv) {
  const args = { apply: false, id: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--id') { args.id = argv[i + 1]; i += 1; }
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (argv.includes('--id') && !args.id) throw new Error('--id needs a value');
  return args;
}

async function readObject(store, key) {
  const chunks = [];
  for await (const c of await store.getObjectStream(key)) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function run({ db, store, apply, id, out = console.log }) {
  const { rows } = id
    ? await db.query('SELECT id, creature, atlas_key, manifest_key FROM sprite_sets WHERE manifest_key IS NOT NULL AND id = $1', [id])
    : await db.query('SELECT id, creature, atlas_key, manifest_key FROM sprite_sets WHERE manifest_key IS NOT NULL ORDER BY created_at');
  let flagged = 0;
  for (const row of rows) {
    try {
      const manifest = JSON.parse((await readObject(store, row.manifest_key)).toString('utf8'));
      const sheetKey = row.atlas_key || row.manifest_key.replace(/sheet\.json$/, 'sheet.png');
      const sheet = await readObject(store, sheetKey);
      if (!decodeRGBA(sheet)) throw new Error('sheet is not a readable RGBA PNG');
      const flags = sizeJumpFlags(sheet, manifest);
      const merged = mergeQuality(manifest.quality, flags);
      const changed = JSON.stringify(merged) !== JSON.stringify(manifest.quality || []);
      if (flags.length) flagged += 1;
      out(`${row.id} ${row.creature}: ${flags.length} flagged${changed ? '' : ' (no change)'}`);
      for (const f of flags) out(`    ${f.action}/${f.direction}/${f.frame}  ${f.reason}`);
      if (apply && changed) {
        await store.putObject(row.manifest_key, Buffer.from(JSON.stringify({ ...manifest, quality: merged })), 'application/json');
        out('    written');
      }
    } catch (err) {
      out(`${row.id} ${row.creature}: skipped (${err.message})`);
    }
  }
  out(`${rows.length} sheets checked, ${flagged} with flags${apply ? '' : ' (dry run)'}`);
}

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  run({ db: pool, store: assetStore, ...args })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { run, parseArgs };
