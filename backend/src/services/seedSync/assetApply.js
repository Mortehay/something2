// Seed side of asset columns (assets.js): which git rows need asset files,
// whether those files are usable (preview / plan blocking), staging their
// upload before the locked transaction, and the DB values the locked writes
// put in their asset columns.
const { tableOf, gitOf, localByKeyOf } = require('./diffGroup.js');
const { stableStringify } = require('./canonical.js');
const { rollback } = require('./txn.js');
const {
  isEmpty, assetsRoot, hasAssets, checkGitAssets, fileReader, uploadGitAssets,
} = require('./assets.js');

const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// The local row a git write of r lands on (adopt: the same-key local row).
function localRowOf(cd, r) {
  return r.kind === 'adopt_identity' ? localByKeyOf(cd, r) : tableOf(cd, r).local.get(r.syncUuid);
}

// Is git's value of asset column `col` what this row already holds here
// (same file + hash through the cache)? Then nothing is read or uploaded and
// the local key stays.
function assetUnchanged(cd, r, col) {
  const l = localRowOf(cd, r);
  return !!l && stableStringify(l.row[col]) === stableStringify(gitOf(cd, r).row[col]);
}

// r's git row with every unchanged asset column blanked (null), or null when
// no asset file needs reading: what checkGitAssets / uploadGitAssets get.
function assetNeeds(cd, r) {
  const { spec } = tableOf(cd, r);
  const g = gitOf(cd, r);
  if (!g) return null;
  const out = { ...g.row };
  let any = false;
  for (const col of Object.keys(spec.assets)) {
    if (isEmpty(out[col]) || assetUnchanged(cd, r, col)) out[col] = null;
    else any = true;
  }
  return any ? out : null;
}

// Map(syncUuid -> asset_file_missing | asset_file_mismatch) for every row
// that needs asset files and could take git (`gitAllowed(r)`: its kind
// allows it), whatever its default or decision -- so the preview, the
// signature, planOnSnapshot and the locked path all see the same reasons, and
// a red row whose file is unusable never offers 'git'. Hashes each file once
// per call (and once per process while it is unchanged: hashRepoFile).
async function assetInfoFor(cd, gitAllowed) {
  const out = new Map();
  if (!cd.diff.header) return out;
  const root = assetsRoot();
  const read = fileReader(root);
  for (const spec of cd.specs) {
    if (!hasAssets(spec)) continue;
    const rows = cd.diff.rows
      .filter((r) => r.table === spec.table && gitAllowed(r))
      .map((r) => assetNeeds(cd, r)).filter(Boolean);
    for (const [uuid, reason] of await checkGitAssets(root, rows, spec, read)) out.set(uuid, reason);
  }
  return out;
}

const noUploads = () => ({ values: new Map(), cacheEntries: [] });

// Before the locked transaction: `planOnSnapshot(client)` (applySeed) plans the
// seed on a REPEATABLE READ READ ONLY snapshot -- same refusals as the locked
// path, so a stale or refused seed uploads nothing -- and returns { cd,
// assetInfo, steps }, or null when the locked path will refuse anyway (no
// file, newer schema). Then, with the connection released, the asset files of
// the rows that take git are uploaded. Returns { assetInfo, uploads: { values,
// cacheEntries } }. The locked path re-checks the signature, so these uploads
// match the rows it writes.
async function stageUploads(pool, planOnSnapshot, { store, onProgress, signal }) {
  const client = await pool.connect();
  let releaseErr;
  let planned;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    planned = await planOnSnapshot(client);
    await client.query('COMMIT');
  } catch (e) {
    releaseErr = await rollback(client);
    throw e;
  } finally {
    client.release(releaseErr);
  }
  if (!planned) return { assetInfo: new Map(), uploads: noUploads() };
  const { cd, assetInfo, steps } = planned;
  const uploads = noUploads();
  for (const spec of cd.specs) {
    if (!hasAssets(spec)) continue;
    const rows = steps.filter((s) => s.decision === 'git' && s.row.table === spec.table)
      .map((s) => assetNeeds(cd, s.row)).filter(Boolean);
    const up = await uploadGitAssets(store, rows, spec, { onProgress, signal });
    for (const [uuid, vals] of up.values) uploads.values.set(uuid, vals);
    uploads.cacheEntries.push(...up.cacheEntries);
  }
  return { assetInfo, uploads };
}

// `resolved` (a git row about to be written) with each asset column as the
// local DB value: the uploaded key, the local key when unchanged, '' / NULL
// as they are.
function withLocalAssets(cd, r, spec, resolved, uploads) {
  if (!hasAssets(spec)) return resolved;
  const t = tableOf(cd, r);
  const up = (uploads && uploads.values.get(r.syncUuid)) || {};
  const l = localRowOf(cd, r);
  const raw = l && t.rawAssets ? t.rawAssets.get(l.row.sync_uuid) : null;
  const out = { ...resolved };
  for (const col of Object.keys(spec.assets)) {
    if (own(up, col)) out[col] = up[col];
    else if (isEmpty(resolved[col])) continue;
    else if (raw && assetUnchanged(cd, r, col)) out[col] = raw[col];
    else throw new Error(`seed-sync: ${spec.table}.${col} of ${r.syncUuid} has no uploaded object`);
  }
  return out;
}

module.exports = { assetNeeds, assetInfoFor, stageUploads, withLocalAssets };
