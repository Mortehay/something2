// The "Fix" button of a bad_file group: repairs only what has one right answer
// and never touches row data -- header row counts (a hand-added or removed
// row), a sync_uuid in upper case or with whitespace, and a row without a
// sync_uuid (a hand-added row gets a fresh one). Anything else (duplicate
// sync_uuid / natural key, a missing key, a missing or unknown table, invalid
// JSON) needs a person to choose, so the file is left alone and the
// validator's message is thrown as a SyncFileError.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getGroup, tableSpecs } = require('./registry.js');
const { stableStringify } = require('./canonical.js');
const { SyncFileError } = require('./errors.js');
const { fileFor, readExport } = require('./exportGroup.js');

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Repairs `doc` in place against its group. -> fixes: one line per kind of
// repair made ([] when there was nothing to repair). Throws SyncFileError
// when the doc is still invalid afterwards.
function repairDoc(doc, group) {
  // Lazy: diffGroup.js requires exportGroup.js, which this module loads too.
  const { validateDoc, UUID_RE } = require('./diffGroup.js');
  const file = `${group.id}.json`;
  if (doc.header.group !== group.id) {
    // Possibly another group's file under this name: never rewrite it.
    validateDoc(doc, group);
  }
  const specs = tableSpecs(group);
  const v1 = Array.isArray(doc.rows);
  const tableRows = v1
    ? [[specs[0].table, doc.rows]]
    : specs.map((s) => [s.table, doc.tables[s.table]]).filter(([, rows]) => Array.isArray(rows));

  const fixes = [];
  for (const [table, rows] of tableRows) {
    let lowered = 0;
    let added = 0;
    for (const r of rows) {
      if (!isPlainObject(r)) continue;
      if (r.sync_uuid === undefined || r.sync_uuid === null || r.sync_uuid === '') {
        r.sync_uuid = crypto.randomUUID();
        added += 1;
      } else if (typeof r.sync_uuid === 'string' && !UUID_RE.test(r.sync_uuid)) {
        const norm = r.sync_uuid.trim().toLowerCase();
        if (UUID_RE.test(norm)) { r.sync_uuid = norm; lowered += 1; }
      }
    }
    if (added) fixes.push(`${table}: gave ${added} row${added === 1 ? '' : 's'} a new sync_uuid`);
    if (lowered) fixes.push(`${table}: normalised ${lowered} sync_uuid${lowered === 1 ? '' : 's'}`);
  }

  if (v1) {
    if (doc.header.row_count !== doc.rows.length) {
      fixes.push(`header row_count ${JSON.stringify(doc.header.row_count)} -> ${doc.rows.length}`);
      doc.header.row_count = doc.rows.length;
    }
  } else if (specs.every((s) => Array.isArray(doc.tables[s.table]))) {
    // Only with every table present: a missing table is not a count problem.
    const old = isPlainObject(doc.header.row_counts) ? doc.header.row_counts : {};
    const counts = {};
    for (const s of specs) {
      const n = doc.tables[s.table].length;
      counts[s.table] = n;
      if (old[s.table] !== n) fixes.push(`header row_counts.${s.table} ${JSON.stringify(old[s.table])} -> ${n}`);
    }
    for (const t of Object.keys(old)) {
      if (!(t in counts)) fixes.push(`header row_counts: dropped unknown table ${t}`);
    }
    doc.header.row_counts = counts;
  }

  try {
    validateDoc(doc, group);
  } catch (err) {
    if (!(err instanceof SyncFileError)) throw err;
    throw new SyncFileError(`Can't fix automatically: ${err.message}`, err.file || file);
  }
  return fixes;
}

// Reads, repairs and (when anything changed) atomically rewrites one group's
// export file. -> { fixes }. Adapter groups (maps) have their own file layout
// and are refused.
async function repairGroup(groupId) {
  const group = getGroup(groupId);
  const file = `${groupId}.json`;
  if (group.adapter) throw new SyncFileError(`Can't fix automatically: ${group.label} files must be fixed by hand`, file);
  const doc = await readExport(groupId); // invalid JSON etc. -> SyncFileError
  if (!doc) throw new SyncFileError(`Can't fix automatically: ${file} is missing`, file);
  const fixes = repairDoc(doc, group);
  if (fixes.length) {
    const target = fileFor(groupId);
    const tmp = `${target}.${process.pid}.repair.tmp`;
    await fs.promises.writeFile(tmp, `${stableStringify(doc)}\n`);
    try {
      await fs.promises.rename(tmp, target);
    } catch (err) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw err;
    }
  }
  return { fixes, file: path.basename(fileFor(groupId)) };
}

module.exports = { repairDoc, repairGroup };
