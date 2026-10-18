const fs = require('node:fs');
const path = require('node:path');
const { getGroup, liveColumns } = require('./registry.js');
const { canonicalRow, rowHash, stableStringify } = require('./canonical.js');
const { pcLabel, schemaVersion, startRun, finishRun } = require('./runs.js');

class SyncFileError extends Error {
  constructor(message, file) {
    super(message);
    this.name = 'SyncFileError';
    this.code = 'bad_file';
    this.file = file;
  }
}

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
  const runId = await startRun(pool, groupId, 'export');
  try {
    const columns = await liveColumns(pool, group);
    const { rows: dbRows } = await pool.query(`SELECT * FROM ${group.table}`);
    const key = group.naturalKey;
    const rows = dbRows
      .map((r) => canonicalRow(r, columns))
      .sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
    const doc = {
      header: {
        group: groupId,
        exported_at: new Date().toISOString(),
        exported_by: pcLabel(),
        schema_version: await schemaVersion(pool),
        row_count: rows.length,
      },
      rows,
    };
    const file = fileFor(groupId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, `${stableStringify(doc)}\n`);
    await fs.promises.rename(tmp, file);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM seed_row_hashes WHERE group_id = $1', [groupId]);
      for (const r of rows) {
        await client.query(
          'INSERT INTO seed_row_hashes (group_id, sync_uuid, hash) VALUES ($1, $2, $3)',
          [groupId, r.sync_uuid, rowHash(r)],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await finishRun(pool, runId, { status: 'ok', summary: { rowCount: rows.length } });
    return { runId, rowCount: rows.length };
  } catch (e) {
    await finishRun(pool, runId, { status: 'failed', error: e.message }).catch(() => {});
    throw e;
  }
}

module.exports = { SyncFileError, syncDir, fileFor, readExport, exportGroup };
