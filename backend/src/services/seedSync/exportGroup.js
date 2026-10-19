const fs = require('node:fs');
const path = require('node:path');
const {
  getGroup, tableSpecs, specOfTable, liveColumns, pairKeyCol, orderPair, scopeSql, quoteIdent,
} = require('./registry.js');
const { canonicalRow, rowHash, stableStringify, compareNaturalKey } = require('./canonical.js');
const { buildRefMaps, exportRow, exportColumns } = require('./refs.js');
const { pcLabel, schemaVersion, startRun, finishRun } = require('./runs.js');
const { SyncFileError, SyncRefused } = require('./errors.js');
const { SEED_SYNC_LOCK_SQL, beginLocked, mapLockError, rollback, lockShare } = require('./txn.js');
const {
  hasAssets, translateRow, rowCacheKeys, hasUnhashed, loadCache, prepareExportAssets,
} = require('./assets.js');

let tmpCounter = 0;

function syncDir() {
  return process.env.SEED_SYNC_DIR || path.join(__dirname, '../../../seeds/sync');
}

function fileFor(groupId) {
  return path.join(syncDir(), `${groupId}.json`);
}

async function readExport(groupId) {
  const file = fileFor(groupId);
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new SyncFileError(`${path.basename(file)}: invalid JSON`, path.basename(file));
  }
  const name = path.basename(file);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.header || typeof data.header !== 'object') {
    throw new SyncFileError(`${name}: missing header or rows`, name);
  }
  // v1 (Plan 1): rows[]; v2: tables{}. Per-table checks are validateDoc's.
  const v1 = Array.isArray(data.rows);
  const v2 = !!data.tables && typeof data.tables === 'object' && !Array.isArray(data.tables);
  if (data.rows !== undefined && data.tables !== undefined) {
    throw new SyncFileError(`${name}: has both rows (v1) and tables (v2)`, name);
  }
  if (!v1 && !v2) throw new SyncFileError(`${name}: missing header or rows`, name);
  return data;
}

// Exported (canonical, refs translated) rows of one table, in file order.
async function exportTable(client, spec) {
  const canonCols = exportColumns(await liveColumns(client, spec), spec);
  const maps = await buildRefMaps(client, spec);
  // rowFilter / versioned: only the rows that sync (scopeSql).
  const { rows: dbRows } = await client.query(`SELECT * FROM ${quoteIdent(spec.table)} WHERE true${scopeSql(spec)}`);
  // An unordered pair travels ordered by its targets' natural keys, never by
  // local id order (diffGroup normalises the same way).
  let keyOf = null;
  if (spec.unorderedPair) {
    const { table, keyCol } = pairKeyCol(spec);
    const { rows } = await client.query(
      `SELECT sync_uuid, ${quoteIdent(keyCol)} AS k FROM ${quoteIdent(table)} WHERE true${scopeSql(specOfTable(table))}`);
    const keys = new Map(rows.map((r) => [r.sync_uuid, r.k]));
    keyOf = (u) => (keys.has(u) ? keys.get(u) : null);
  }
  let rows = dbRows.map((r) => exportRow(r, spec, maps));
  if (hasAssets(spec)) {
    // Asset keys -> { file, sha256 } through the cache prepareExportAssets
    // filled before the lock. A key it did not see was set meanwhile.
    const cache = await loadCache(client, rowCacheKeys(spec, rows));
    rows = rows.map((r) => translateRow(spec, r, cache));
    if (rows.some((r) => Object.keys(spec.assets).some((c) => hasUnhashed(r[c])))) {
      throw new SyncRefused('assets_changed', 'art changed during export, run it again');
    }
  }
  return rows
    .map((r) => canonicalRow(orderPair(spec, r, keyOf), canonCols))
    .sort((a, b) => compareNaturalKey(a, b, spec.naturalKey));
}

// Git changes whatever this PC's asset cache holds (an uncached key only ever
// makes local differ from B and git): changed / new / deleted_in_git, and an
// edited_here that HAS a baseline -- B differs from git's hash too (else it
// would read not_exported), a real both-sides conflict.
const DEFINITE_GIT_KINDS = new Set(['changed', 'new', 'deleted_in_git']);
function definiteGitChange(r, baselines) {
  return DEFINITE_GIT_KINDS.has(r.kind) || (r.kind === 'edited_here' && baselines.has(r.syncUuid));
}

// opts: { store (default assetStore), onProgress, signal } -- used only by a
// group with asset columns: their objects are downloaded into the repo and
// hashed (prepareExportAssets) BEFORE the locked transaction (long and
// cancellable; the lock is never held across downloads). The summary then
// carries { downloaded, reused, orphanFiles }.
async function exportGroup(pool, groupId, opts = {}) {
  const group = getGroup(groupId);
  const specs = tableSpecs(group);
  // Lazy require: diffGroup.js needs readExport from this module.
  const { diffGroup } = require('./diffGroup.js');
  let assetSummary = null;
  if (specs.some(hasAssets)) {
    // Refuse a definite git_newer before writing any asset file: the files
    // would land over the ones git's rows reference. (Re-checked under the lock.)
    const pre = await diffGroup(pool, groupId);
    if (pre.status === 'schema_newer') {
      throw new SyncRefused('schema_newer', 'run migrations first', {
        fileVersion: pre.header.schema_version, dbVersion: await schemaVersion(pool),
      });
    }
    const { rows: base } = await pool.query('SELECT sync_uuid FROM seed_row_hashes WHERE group_id = $1', [groupId]);
    const baselines = new Set(base.map((b) => b.sync_uuid));
    if (pre.rows.some((r) => definiteGitChange(r, baselines))) {
      throw new SyncRefused('git_newer', 'seed (preview) first', { gitChanges: pre.gitChanges });
    }
    const store = opts.store || require('../assetStore.js');
    // A file that would replace different bytes on disk goes in place only
    // if, with every key now hashed, git has changed nothing (the locked
    // check below, early): a refused export overwrites no repo file.
    const verify = async (client) => {
      const d = await diffGroup(client, groupId);
      if (d.gitChanges > 0) throw new SyncRefused('git_newer', 'seed (preview) first', { gitChanges: d.gitChanges });
    };
    const prep = await prepareExportAssets(pool, store, group, { onProgress: opts.onProgress, signal: opts.signal, verify });
    if (prep.sha1Missing.length) {
      throw new SyncRefused('audio_sha1_missing',
        'these clips have no sha1; regenerate or re-upload them first', { rows: prep.sha1Missing });
    }
    if (prep.missing.length) {
      throw new SyncRefused('assets_missing', 'regenerate or clear these images first', { rows: prep.missing });
    }
    assetSummary = { downloaded: prep.downloaded, reused: prep.reused, orphanFiles: prep.orphanFiles };
  }
  const client = await pool.connect();
  let runId = null;
  let tmp = null;
  let releaseErr;
  let result;
  try {
    await beginLocked(client);
    // The tables and ref maps are read in separate READ COMMITTED statements:
    // an admin edit committing between them could leave a ref dangling inside
    // the file (or make exportRow throw). SHARE blocks writers until COMMIT and
    // waits for open ones; readers go on. Bounded by lock_timeout -> 'busy'.
    // (Not REPEATABLE READ: its snapshot is taken by the first statement, the
    // advisory-lock wait, so a seed committing while we waited would be
    // invisible -- the same trap applySeed avoids with LOCK TABLE.)
    await lockShare(client, specs);
    // Never export over changes that came from git: they would be lost. A
    // corrupt file (SyncFileError) propagates too; the user must fix or delete
    // it first. Checked under the lock, so no seed can slip in before the write.
    const diff = await diffGroup(client, groupId);
    // A newer-schema file was written by a DB with columns this one lacks:
    // overwriting it would drop them from git.
    if (diff.status === 'schema_newer') {
      throw new SyncRefused('schema_newer', 'run migrations first', {
        fileVersion: diff.header.schema_version, dbVersion: await schemaVersion(client),
      });
    }
    if (diff.gitChanges > 0) {
      throw new SyncRefused('git_newer', 'seed (preview) first', { gitChanges: diff.gitChanges });
    }
    // Run rows live on the pool, outside the transaction, so a failed run is
    // still recorded after the rollback.
    runId = await startRun(pool, groupId, 'export');
    const tables = {};
    const rowCounts = {};
    for (const spec of specs) {
      tables[spec.table] = await exportTable(client, spec);
      rowCounts[spec.table] = tables[spec.table].length;
    }
    const allRows = specs.flatMap((spec) => tables[spec.table]);
    const doc = {
      header: {
        group: groupId,
        exported_at: new Date().toISOString(),
        exported_by: pcLabel(),
        schema_version: await schemaVersion(client),
        row_counts: rowCounts,
      },
      tables,
    };
    const file = fileFor(groupId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
    await fs.promises.writeFile(tmp, `${stableStringify(doc)}\n`);
    // File first, baselines second: if the baseline write or COMMIT then fails,
    // the result is "git changed" (safe), never baselines claiming a sync that
    // was not exported.
    await fs.promises.rename(tmp, file);
    tmp = null;

    await client.query('DELETE FROM seed_row_hashes WHERE group_id = $1', [groupId]);
    for (const r of allRows) {
      await client.query(
        'INSERT INTO seed_row_hashes (group_id, sync_uuid, hash) VALUES ($1, $2, $3)',
        [groupId, r.sync_uuid, rowHash(r)],
      );
    }
    await client.query('COMMIT');
    result = { runId, rowCount: allRows.length, rowCounts, ...assetSummary };
  } catch (err) {
    const e = mapLockError(err);
    releaseErr = await rollback(client);
    if (tmp) await fs.promises.unlink(tmp).catch(() => {});
    if (runId !== null) await finishRun(pool, runId, { status: 'failed', error: e.message }).catch(() => {});
    throw e;
  } finally {
    client.release(releaseErr);
  }
  // Committed: the run is ok whatever happens now; never report it failed.
  await finishRun(pool, runId, { status: 'ok', summary: { rowCount: result.rowCount, ...assetSummary } })
    .catch((e) => console.error(`seed-sync: export run ${runId} committed but not marked ok:`, e.message));
  return result;
}

module.exports = { SyncFileError, SEED_SYNC_LOCK_SQL, syncDir, fileFor, readExport, exportGroup };
