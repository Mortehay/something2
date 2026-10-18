const fs = require('node:fs');
const path = require('node:path');
const { getGroup, liveColumns } = require('./registry.js');
const { canonicalRow, rowHash, stableStringify } = require('./canonical.js');
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
  if (!data || typeof data !== 'object' || !data.header || typeof data.header !== 'object' || !Array.isArray(data.rows)) {
    throw new SyncFileError(`${path.basename(file)}: missing header or rows`, path.basename(file));
  }
  return data;
}

async function exportGroup(pool, groupId) {
  const group = getGroup(groupId);
  // Lazy require: diffGroup.js needs readExport from this module.
  const { diffGroup } = require('./diffGroup.js');
  const client = await pool.connect();
  let runId = null;
  let tmp = null;
  let releaseErr;
  let result;
  try {
    await beginLocked(client);
    // Never export over changes that came from git: they would be lost. A
    // corrupt file (SyncFileError) propagates too; the user must fix or delete
    // it first. Checked under the lock, so no seed can slip in before the write.
    const diff = await diffGroup(client, groupId);
    if (diff.gitChanges > 0) {
      throw new SyncRefused('git_newer', 'seed (preview) first', { gitChanges: diff.gitChanges });
    }
    // Run rows live on the pool, outside the transaction, so a failed run is
    // still recorded after the rollback.
    runId = await startRun(pool, groupId, 'export');
    const columns = await liveColumns(client, group);
    const { rows: dbRows } = await client.query(`SELECT * FROM ${group.table}`);
    const key = group.naturalKey;
    const rows = dbRows
      .map((r) => canonicalRow(r, columns))
      .sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
    const doc = {
      header: {
        group: groupId,
        exported_at: new Date().toISOString(),
        exported_by: pcLabel(),
        schema_version: await schemaVersion(client),
        row_count: rows.length,
      },
      rows,
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
    for (const r of rows) {
      await client.query(
        'INSERT INTO seed_row_hashes (group_id, sync_uuid, hash) VALUES ($1, $2, $3)',
        [groupId, r.sync_uuid, rowHash(r)],
      );
    }
    await client.query('COMMIT');
    result = { runId, rowCount: rows.length };
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
