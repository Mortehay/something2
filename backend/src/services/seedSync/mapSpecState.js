// SOMET-641 (Plan 4a). Per-PC bookkeeping of map spec files (map_spec_state):
// which version of each spec this PC last applied (seed, `make seed-map`) or
// exported, and the canonical text of that version (base_spec, the three-way
// base of the Maps group, seedSync/mapsGroup.js). Shared by the Maps group and
// scripts/seed-map.js so both hash a spec the same way.
const crypto = require('node:crypto');
const { canonicalSpecJson } = require('../mapSpecExport.js');

// The spec's identity: sha256 of its canonical JSON (what the writer and the
// Maps export write). A hand-formatted file hashes as its canonical form, so
// whitespace alone is never a change.
const specHash = (spec) => crypto.createHash('sha256').update(canonicalSpecJson(spec)).digest('hex');
const textHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

// This PC now holds `spec` as applied: applied hash and base = this version.
async function recordApplied(db, name, spec) {
  const text = canonicalSpecJson(spec);
  await db.query(
    `INSERT INTO map_spec_state (spec_name, applied_sha256, applied_at, base_spec, updated_at)
     VALUES ($1, $2, now(), $3, now())
     ON CONFLICT (spec_name) DO UPDATE
       SET applied_sha256 = EXCLUDED.applied_sha256, applied_at = EXCLUDED.applied_at,
           base_spec = EXCLUDED.base_spec, updated_at = now()`,
    [name, textHash(text), text]);
}

// This PC wrote `spec` into git: exported hash and base = this version.
async function recordExported(db, name, spec) {
  const text = canonicalSpecJson(spec);
  await db.query(
    `INSERT INTO map_spec_state (spec_name, exported_sha256, exported_at, base_spec, updated_at)
     VALUES ($1, $2, now(), $3, now())
     ON CONFLICT (spec_name) DO UPDATE
       SET exported_sha256 = EXCLUDED.exported_sha256, exported_at = EXCLUDED.exported_at,
           base_spec = EXCLUDED.base_spec, updated_at = now()`,
    [name, textHash(text), text]);
}

async function forget(db, name) {
  await db.query('DELETE FROM map_spec_state WHERE spec_name = $1', [name]);
}

// Map(spec name -> state row).
async function readStates(db) {
  const { rows } = await db.query('SELECT * FROM map_spec_state ORDER BY spec_name');
  return new Map(rows.map((r) => [r.spec_name, r]));
}

module.exports = { specHash, textHash, recordApplied, recordExported, forget, readStates };
