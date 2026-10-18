const fs = require('node:fs');
const path = require('node:path');
const { getGroup, tableSpecs, liveColumns } = require('./registry.js');
const { canonicalRow, rowHash, stableStringify, compareNaturalKey } = require('./canonical.js');
const { buildRefMaps, exportRow } = require('./refs.js');
const { pcLabel, schemaVersion, startRun, finishRun } = require('./runs.js');
const { SyncFileError, SyncRefused } = require('./errors.js');
const { SEED_SYNC_LOCK_SQL, beginLocked, mapLockError, rollback } = require('./txn.js');

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
  const columns = await liveColumns(client, spec);
  const maps = await buildRefMaps(client, spec);
  // Ref columns already hold their exported value (uuid or key text) after
  // exportRow: canonicalize them as-is, never as the FK column's numeric type.
  const refCols = new Set(Object.keys(spec.refs || {}));
  const canonCols = columns.map((c) => (refCols.has(c.name) ? { name: c.name, dataType: 'ref' } : c));
  const { rows: dbRows } = await client.query(`SELECT * FROM ${spec.table}`);
  return dbRows
    .map((r) => canonicalRow(exportRow(r, spec, maps), canonCols))
    .sort((a, b) => compareNaturalKey(a, b, spec.naturalKey));
}

// A group the diff cannot handle yet (several tables, or ref columns).
const needsV2Diff = (specs) => specs.length > 1 || specs.some((s) => Object.keys(s.refs || {}).length > 0);

async function exportGroup(pool, groupId) {
  const group = getGroup(groupId);
  const specs = tableSpecs(group);
  // Lazy require: diffGroup.js needs readExport from this module.
  const { diffGroup } = require('./diffGroup.js');
  const client = await pool.connect();
  let runId = null;
  let tmp = null;
  let releaseErr;
  let result;
  try {
    await beginLocked(client);
    if (needsV2Diff(specs)) {
      // TODO(Task 4): diffGroup is single-table until Task 4, so the git_newer /
      // schema_newer pre-check cannot run for this group. Never overwrite a
      // file unchecked: only a first export (no file at all) is allowed.
      const exists = await fs.promises.access(fileFor(groupId)).then(() => true, (e) => e.code !== 'ENOENT');
      if (exists) {
        throw new SyncRefused('not_supported_yet',
          `re-export of ${groupId} over an existing file needs the multi-table diff (not supported yet)`);
      }
    } else {
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
    result = { runId, rowCount: allRows.length, rowCounts };
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
  await finishRun(pool, runId, { status: 'ok', summary: { rowCount: result.rowCount } })
    .catch((e) => console.error(`seed-sync: export run ${runId} committed but not marked ok:`, e.message));
  return result;
}

module.exports = { SyncFileError, SEED_SYNC_LOCK_SQL, syncDir, fileFor, readExport, exportGroup };
