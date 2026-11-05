// SOMET-734. Animation sheets for the board: `seed-art.js --kind=sprites`.
//
// WHY A SEPARATE PATH. seedArt (artSeed.js) replays the STILL images and cannot carry a sheet: a sprite is two
// objects (atlas PNG + manifest JSON) plus a jsonb descriptor on the row. The Seed/Export `art` group already
// knows how to put exactly that back -- it is just not one of the groups "Seed from git" runs on the board,
// because it also writes prompts, notes and every catalog image and would replace art the board already has.
// So this does the one slice of it the board lacks, with the same pieces:
//   * the descriptor comes from the committed seeds/sync/art.json (atlas/manifest files with their sha256 and
//     the extra fields such as static_frame), the files from seeds/textures/sprites/{entity_types,
//     character_appearances}/;
//   * uploadGitAssets (seedSync/assets.js) checks every file against its hash and uploads it content-addressed
//     under `<bucket>/seedsync/<sha256>/<file>`, the keys the art group would have written;
//   * the cache the art group reads (seed_asset_hashes) is filled, so its status does not read these rows as
//     local edits later.
// Sheets are NOT trimmed: a trim would move the cells off the manifest's grid.
//
// WHAT IT TOUCHES. Only `sprite` (and updated_at) of entity_types and character_appearances rows that the file
// has a sheet for. Never image, render_mode, characters, users or any other table. A character_appearances
// row is a catalog slot; the choice a player made lives on `characters` and is never written here.
// A row that already has a sheet whose objects are in the store is left alone (--force replaces it); a row whose
// objects are gone is uploaded again. A second run therefore changes nothing.

const fs = require('node:fs');
const path = require('node:path');
const { getGroup, tableSpecs } = require('./seedSync/registry.js');
const { uploadGitAssets, recordCache } = require('./seedSync/assets.js');
const { SyncRefused } = require('./seedSync/errors.js');

const TABLES = ['entity_types', 'character_appearances'];

function defaultSyncFile() {
  return path.join(process.env.SEED_SYNC_DIR || path.join(__dirname, '../../seeds/sync'), 'art.json');
}

// The art group's own spec for the table, cut down to its sprite column.
function spriteSpec(table) {
  const spec = tableSpecs(getGroup('art')).find((s) => s.table === table);
  if (!spec || !spec.assets || !spec.assets.sprite) throw new Error(`the art group has no sprite column on ${table}`);
  return { ...spec, assets: { sprite: spec.assets.sprite } };
}

function readArt(syncFile) {
  const doc = JSON.parse(fs.readFileSync(syncFile, 'utf8'));
  const t = doc && doc.tables;
  if (!t || typeof t !== 'object') throw new Error(`${syncFile}: not a seed-sync art file`);
  return t;
}

const LOCATE = {
  entity_types: async (db, row) => {
    const { rows } = await db.query('SELECT id, sprite FROM entity_types WHERE name = $1', [row.name]);
    return rows[0] ? { ...rows[0], label: row.name } : null;
  },
  character_appearances: async (db, row, ctx) => {
    const name = ctx.entityName.get(row.entity_type_id);
    if (!name) return null;
    const { rows } = await db.query(
      `SELECT ca.entity_type_id AS id, ca.sprite FROM character_appearances ca
         JOIN entity_types e ON e.id = ca.entity_type_id WHERE e.name = $1 AND ca.variant = $2`, [name, row.variant]);
    return rows[0] ? { ...rows[0], label: `${name}:${row.variant}`, entityName: name, variant: row.variant } : null;
  },
};

const LINK = {
  entity_types: (db, loc, sprite, old) => db.query(
    `UPDATE entity_types SET sprite = $1::jsonb, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND sprite IS NOT DISTINCT FROM $3::jsonb`, [JSON.stringify(sprite), loc.id, old]),
  character_appearances: (db, loc, sprite, old) => db.query(
    `UPDATE character_appearances SET sprite = $1::jsonb, updated_at = now()
      WHERE entity_type_id = $2 AND variant = $3 AND sprite IS NOT DISTINCT FROM $4::jsonb`, [JSON.stringify(sprite), loc.id, loc.variant, old]),
};

// Does the row's current sheet have both of its objects in the store?
async function sheetIsHere(store, sprite) {
  const keys = [sprite && sprite.atlas_key, sprite && sprite.manifest_key];
  if (!keys.every((k) => typeof k === 'string' && k)) return false;
  for (const k of keys) if (!(await store.objectExists(k))) return false;
  return true;
}

async function seedSprites({
  db, store, root, syncFile = defaultSyncFile(), only = null, force = false, log = console.log,
}) {
  const art = readArt(syncFile);
  const entityName = new Map((art.entity_types || []).map((r) => [r.sync_uuid, r.name]));
  const results = {};
  await store.ensureBucket();
  for (const table of TABLES) {
    const spec = spriteSpec(table);
    const stats = { linked: 0, skipped: 0, dangling: 0, missingFile: 0, missingRow: 0 };
    results[table] = stats;
    for (const row of art[table] || []) {
      if (!row.sprite || typeof row.sprite !== 'object') continue;
      const loc = await LOCATE[table](db, row, { entityName });
      const label = loc ? loc.label : (row.name || `${entityName.get(row.entity_type_id) || row.entity_type_id}:${row.variant}`);
      if (only && !only.some((o) => o === label || o === (loc && loc.entityName) || o === row.name)) continue;
      if (!loc) {
        log(`  ${label}: SKIP (no such ${table === 'entity_types' ? 'creature' : 'appearance'} -- seed the catalogue first)`);
        stats.missingRow += 1;
        continue;
      }
      if (loc.sprite && !force) {
        if (await sheetIsHere(store, loc.sprite)) { stats.skipped += 1; continue; }
        log(`  ${label}: sheet objects are not in the store -- re-seeding`);
        stats.dangling += 1;
      }
      let up;
      try {
        up = await uploadGitAssets(store, [row], spec, { root });
      } catch (e) {
        if (!(e instanceof SyncRefused)) throw e;
        log(`  ${label}: FAILED a sheet file is missing or does not match art.json (${(e.details && e.details.file) || e.message})`);
        stats.missingFile += 1;
        continue;
      }
      const sprite = up.values.get(row.sync_uuid).sprite;
      const res = await LINK[table](db, loc, sprite, loc.sprite ? JSON.stringify(loc.sprite) : null);
      if (res.rowCount === 0) {
        log(`  ${label}: SKIP (the row changed while seeding)`);
        stats.skipped += 1;
        continue;
      }
      await recordCache(db, up.cacheEntries);
      stats.linked += 1;
      log(`  ${label}: seeded`);
    }
  }
  return results;
}

module.exports = { seedSprites, TABLES };
