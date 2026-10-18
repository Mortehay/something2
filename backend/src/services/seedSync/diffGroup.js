const { GROUPS, getGroup, tableSpecs, liveColumns } = require('./registry.js');
const { canonicalRow, rowHash, stableStringify } = require('./canonical.js');
const { buildRefMaps, exportRow, exportColumns } = require('./refs.js');
const { readExport } = require('./exportGroup.js');
const { SyncFileError } = require('./errors.js');
const { schemaVersion } = require('./runs.js');
const { lockTimeoutMs, lockShare, mapLockError, rollback } = require('./txn.js');

// Three-way diff of one group: git file (G) vs local DB (L) vs the baseline
// hash written at the last export/seed (B). Decides what a seed may overwrite.
// DEFAULTS is the brief's table. One controller override: an adopt_identity
// whose values differ (non-empty fields) defaults to null (red, must be
// decided) and counts as a local edit too -- rows created on both PCs after
// the migration get random uuids, and 'git' would silently overwrite local.
const DEFAULTS = {
  changed: 'git',
  not_exported: 'local',
  edited_here: null,
  adopt_identity: 'git',
  deleted_here: 'local',
  new: 'git',
  deleted_in_git: 'delete',
  only_here: 'local',
};
const KINDS = Object.keys(DEFAULTS);
const LOCAL_EDIT_KINDS = ['not_exported', 'edited_here', 'only_here', 'deleted_here'];
const GIT_CHANGE_KINDS = ['changed', 'new', 'deleted_in_git', 'edited_here', 'adopt_identity'];
// v1 (Plan 1): { header{..., row_count}, rows }; v2: { header{..., row_counts}, tables }.
const HEADER_FIELDS_V1 = ['group', 'exported_at', 'exported_by', 'schema_version', 'row_count'];
const HEADER_FIELDS_V2 = ['group', 'exported_at', 'exported_by', 'schema_version', 'row_counts'];

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Lowercase canonical uuid text, exactly as Postgres prints a uuid: a file
// value in any other form would never match the local row's sync_uuid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function zeroCounts() {
  const out = {};
  for (const k of KINDS) out[k] = 0;
  return out;
}

// Token presence only: the secret values are never read into JS. A row only
// needs its token when `secretNeededIf` (e.g. auth_header_name) is non-blank:
// a provider with no auth header never sends one.
async function countTokensMissing(db, spec) {
  const secrets = spec.secretColumns || [];
  if (!secrets.length) return 0;
  let cond = secrets.map((c) => `${quoteIdent(c)} IS NULL OR ${quoteIdent(c)} = ''`).join(' OR ');
  if (spec.secretNeededIf) cond = `btrim(coalesce(${quoteIdent(spec.secretNeededIf)}, '')) <> '' AND (${cond})`;
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${quoteIdent(spec.table)} WHERE ${cond}`);
  return rows[0].n;
}

const isV1 = (doc) => Array.isArray(doc.rows);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// One table's rows: object rows, lowercase unique sync_uuid, a complete and
// unique natural key. `where` prefixes messages ('' for v1, 'table ' for v2).
function validateRows(rows, spec, file, where) {
  const keyCols = spec.naturalKey;
  const keyName = keyCols.join('+');
  const seen = new Set();
  const seenKeys = new Set();
  rows.forEach((r, i) => {
    if (!isPlainObject(r)) throw new SyncFileError(`${file}: ${where}row ${i} is not an object`, file);
    if (typeof r.sync_uuid !== 'string' || !r.sync_uuid) throw new SyncFileError(`${file}: ${where}row ${i} has no sync_uuid`, file);
    if (!UUID_RE.test(r.sync_uuid)) {
      throw new SyncFileError(`${file}: ${where}row ${i} sync_uuid is not a lowercase uuid`, file);
    }
    if (seen.has(r.sync_uuid)) throw new SyncFileError(`${file}: ${where}duplicate sync_uuid ${r.sync_uuid}`, file);
    seen.add(r.sync_uuid);
    for (const k of keyCols) {
      if (r[k] === undefined || r[k] === null) throw new SyncFileError(`${file}: ${where}row ${i} has no ${k}`, file);
    }
    const nk = stableStringify(keyCols.length === 1 ? r[keyCols[0]] : keyCols.map((k) => r[k]));
    if (seenKeys.has(nk)) throw new SyncFileError(`${file}: ${where}duplicate ${keyName} ${nk}`, file);
    seenKeys.add(nk);
  });
}

// Checks a parsed file (readExport) against its group, per table. v1 is only
// valid for a single-table group. Every group table must be present (a missing
// one would read as "all rows deleted in git"); an unknown table is refused.
function validateDoc(doc, group) {
  const groupId = group.id;
  const file = `${groupId}.json`;
  const specs = tableSpecs(group);
  if (doc.header.group !== groupId) {
    throw new SyncFileError(`${file}: header names group ${JSON.stringify(doc.header.group)}, expected ${groupId}`, file);
  }
  if (isV1(doc)) {
    if (specs.length !== 1) {
      throw new SyncFileError(`${file}: a v1 file (rows) is only valid for a single-table group; ${groupId} has ${specs.length} tables`, file);
    }
    validateRows(doc.rows, specs[0], file, '');
    // A truncated or hand-merged file: rows went missing (or were added) after
    // the header was written. Checked last so a bad row is named first.
    if (doc.header.row_count !== doc.rows.length) {
      throw new SyncFileError(
        `${file}: header row_count ${JSON.stringify(doc.header.row_count)} but ${doc.rows.length} rows`, file);
    }
    return;
  }
  const known = new Set(specs.map((s) => s.table));
  for (const t of Object.keys(doc.tables).sort()) {
    if (!known.has(t)) throw new SyncFileError(`${file}: unknown table ${t} (not in group ${groupId})`, file);
  }
  for (const spec of specs) {
    const rows = doc.tables[spec.table];
    if (rows === undefined) throw new SyncFileError(`${file}: missing table ${spec.table}`, file);
    if (!Array.isArray(rows)) throw new SyncFileError(`${file}: ${spec.table} is not an array`, file);
    validateRows(rows, spec, file, `${spec.table} `);
  }
  const counts = doc.header.row_counts;
  if (!isPlainObject(counts)) {
    throw new SyncFileError(`${file}: header row_counts missing`, file);
  }
  for (const t of Object.keys(counts).sort()) {
    if (!known.has(t)) throw new SyncFileError(`${file}: header row_counts names unknown table ${t}`, file);
  }
  for (const spec of specs) {
    const n = doc.tables[spec.table].length;
    if (counts[spec.table] !== n) {
      throw new SyncFileError(
        `${file}: header row_counts.${spec.table} ${JSON.stringify(counts[spec.table])} but ${n} rows`, file);
    }
  }
}

// The rows of one table of a validated doc (v1: the group's only table).
function docRows(doc, table) {
  return isV1(doc) ? doc.rows : doc.tables[table];
}

// Only the known header fields of the file's format: the file is
// hand-editable, never echo extras.
function pickHeader(h, doc) {
  const out = {};
  for (const k of isV1(doc) ? HEADER_FIELDS_V1 : HEADER_FIELDS_V2) out[k] = h[k] === undefined ? null : h[k];
  return out;
}

// Differing live columns between two canonical rows (sync_uuid excluded).
function diffFields(local, git, columns) {
  const out = [];
  for (const c of columns) {
    if (stableStringify(local[c.name]) !== stableStringify(git[c.name])) {
      out.push({ name: c.name, local: local[c.name], git: git[c.name] });
    }
  }
  return out;
}

// ---- local side ------------------------------------------------------------

// Natural-key identity of a canonical (exported-form) row: ref parts are the
// translated values, so a local and a git row with the same composite key
// compare equal. Internal only (Map keys).
function keyTextOf(spec, row) {
  return stableStringify(spec.naturalKey.map((k) => (row[k] === undefined ? null : row[k])));
}

// The TableSpec that describes `table`: the group's own first, else any
// registered group's. null when no group exports that table.
function specFor(group, table) {
  const own = tableSpecs(group).find((s) => s.table === table);
  if (own) return own;
  for (const g of GROUPS) {
    const s = tableSpecs(g).find((x) => x.table === table);
    if (s) return s;
  }
  return null;
}

// A display key can only be built from a target whose natural key has no ref
// parts (a ref part would need another level of lookup).
const plainKeyed = (spec) => !!spec && spec.naturalKey.every((k) => !Object.prototype.hasOwnProperty.call(spec.refs || {}, k));
const joinKey = (parts) => (parts.length === 1 ? parts[0] : parts.map((p) => String(p)).join(' → '));

// Names a by-name column holds, per its declared shape. Non-string entries
// are not names and are ignored.
function namesIn(value, shape) {
  if (value === null || value === undefined) return [];
  if (shape === 'text') return typeof value === 'string' && value !== '' ? [value] : [];
  if (shape === 'array') return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  if (shape === 'object-values') {
    return isPlainObject(value) ? Object.values(value).filter((v) => typeof v === 'string') : [];
  }
  throw new Error(`seed-sync: unknown nameRefs shape ${JSON.stringify(shape)}`);
}

async function readLocal(db, group, specs, groupId) {
  const tables = [];
  for (const spec of specs) {
    const columns = exportColumns(await liveColumns(db, spec), spec);
    const maps = await buildRefMaps(db, spec);
    const select = [...columns.map((c) => quoteIdent(c.name)), 'sync_uuid'].join(', ');
    const { rows } = await db.query(`SELECT ${select} FROM ${quoteIdent(spec.table)}`);
    // Exactly what export would write (refs translated), so hL == B for an
    // unchanged row.
    const canon = rows.map((r) => canonicalRow(exportRow(r, spec, maps), columns));
    tables.push({ spec, columns, rows: canon, tokensMissing: await countTokensMissing(db, spec) });
  }
  // Display keys of by-uuid ref targets: sync_uuid -> natural key parts.
  const targetKeys = new Map();
  for (const spec of specs) {
    for (const ref of Object.values(spec.refs || {})) {
      if (ref.by !== 'uuid' || targetKeys.has(ref.table)) continue;
      const ts = specFor(group, ref.table);
      if (!plainKeyed(ts)) { targetKeys.set(ref.table, new Map()); continue; }
      const { rows } = await db.query(
        `SELECT sync_uuid, ${ts.naturalKey.map(quoteIdent).join(', ')} FROM ${quoteIdent(ref.table)}`);
      targetKeys.set(ref.table, new Map(rows.map((r) => [r.sync_uuid, ts.naturalKey.map((k) => r[k])])));
    }
  }
  // Names that exist locally, per by-name target (table, keyCol).
  const names = new Map();
  for (const spec of specs) {
    for (const nr of Object.values(spec.nameRefs || {})) {
      const id = `${nr.table}\u0000${nr.keyCol}`;
      if (names.has(id)) continue;
      const { rows } = await db.query(`SELECT ${quoteIdent(nr.keyCol)} AS n FROM ${quoteIdent(nr.table)}`);
      names.set(id, new Set(rows.map((r) => r.n)));
    }
  }
  const { rows: base } = await db.query(
    'SELECT sync_uuid, hash FROM seed_row_hashes WHERE group_id = $1', [groupId]);
  const dbVersion = await schemaVersion(db);
  return { tables, targetKeys, names, base, dbVersion };
}

// A checked-out client (it has release()) is used as-is: the caller owns the
// transaction and its locks (applySeed / exportGroup under the seed_sync
// lock). A Pool gets its own transaction holding the group's tables and
// by-uuid ref targets in SHARE mode (the same set export locks), so every
// table, ref map and baseline is read from one consistent state. (Not
// REPEATABLE READ: see the export lock note in exportGroup.js.)
const isClient = (db) => typeof db.release === 'function';

async function loadLocal(db, group, specs, groupId) {
  if (isClient(db)) return readLocal(db, group, specs, groupId);
  const client = await db.connect();
  let releaseErr;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs()}ms'`);
    await lockShare(client, specs);
    const out = await readLocal(client, group, specs, groupId);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    releaseErr = await rollback(client);
    throw mapLockError(e);
  } finally {
    client.release(releaseErr);
  }
}

// ---- diff ------------------------------------------------------------------

// Display key of a canonical row: natural key parts, a by-uuid ref part shown
// as the target's natural key (local row, else the same group's git file,
// else the uuid's first 8 chars).
function keyPartsOf(spec, row, lookup) {
  return spec.naturalKey.map((k) => {
    const v = row[k] === undefined ? null : row[k];
    const ref = (spec.refs || {})[k];
    if (!ref || ref.by !== 'uuid' || typeof v !== 'string') return v;
    const parts = lookup(ref.table, v);
    return parts ? joinKey(parts) : v.slice(0, 8);
  });
}

// One table's three-way classification (Plan-1 rules, unchanged).
function diffTable(t, gitRaw, baseline, keyOf) {
  const { spec, columns } = t;
  const local = t.rows.map((row) => ({ row, hash: rowHash(row) }));
  const localByUuid = new Map(local.map((l) => [l.row.sync_uuid, l]));
  const localByKey = new Map(local.map((l) => [keyTextOf(spec, l.row), l]));
  // Re-canonicalize git rows so a hand-edited file (other key order, extra or
  // missing columns) hashes exactly as the exporter would have written it.
  const git = gitRaw.map((r) => {
    const row = canonicalRow(r, columns);
    return { row, hash: rowHash(row) };
  });
  const gitUuids = new Set(git.map((g) => g.row.sync_uuid));
  const consumed = new Set();
  const inSync = []; // identical on both sides
  const out = [];
  const add = (kind, syncUuid, row, fields, defaultDecision = DEFAULTS[kind]) => {
    const keyParts = keyOf(row);
    out.push({
      table: spec.table, syncUuid, key: joinKey(keyParts), keyParts, kind, defaultDecision, fields, blockedReason: null,
    });
  };

  for (const g of git) {
    const uuid = g.row.sync_uuid;
    const l = localByUuid.get(uuid);
    if (l) {
      if (l.hash === g.hash) {
        inSync.push({ table: spec.table, syncUuid: uuid, hash: l.hash, hasBaseline: baseline.has(uuid) });
        continue;
      }
      const b = baseline.get(uuid);
      let kind;
      if (b !== undefined && l.hash === b) kind = 'changed';
      else if (b !== undefined && g.hash === b) kind = 'not_exported';
      else kind = 'edited_here';
      add(kind, uuid, l.row, diffFields(l.row, g.row, columns));
      continue;
    }
    const cand = localByKey.get(keyTextOf(spec, g.row));
    if (cand && !consumed.has(cand.row.sync_uuid)
        && !gitUuids.has(cand.row.sync_uuid) && !baseline.has(cand.row.sync_uuid)) {
      consumed.add(cand.row.sync_uuid);
      const fields = diffFields(cand.row, g.row, columns);
      add('adopt_identity', uuid, g.row, fields, fields.length ? null : DEFAULTS.adopt_identity);
      continue;
    }
    add(baseline.has(uuid) ? 'deleted_here' : 'new', uuid, g.row, []);
  }

  for (const l of local) {
    const uuid = l.row.sync_uuid;
    if (gitUuids.has(uuid) || consumed.has(uuid)) continue;
    const b = baseline.get(uuid);
    add(b !== undefined && l.hash === b ? 'deleted_in_git' : 'only_here', uuid, l.row, []);
  }

  out.sort((a, b) => cmp(String(a.key), String(b.key)) || cmp(a.syncUuid, b.syncUuid));
  const counts = zeroCounts();
  for (const r of out) counts[r.kind] += 1;
  return {
    detail: {
      spec,
      columns,
      git: new Map(git.map((g) => [g.row.sync_uuid, g])),
      local: localByUuid,
      localByKey,
    },
    inSync,
    rows: out,
    counts,
  };
}

// dangling_name warnings: a by-name column (spec.nameRefs) naming a row that
// exists neither locally nor in this group's git file. Local and git rows are
// both checked (one warning per table/row/column/name). Never blocks anything.
function danglingNames(perTable, names, gitNames, keyOf) {
  const out = new Map();
  for (const { spec, rows } of perTable) {
    for (const [column, nr] of Object.entries(spec.nameRefs || {}).sort(([a], [b]) => cmp(a, b))) {
      const id = `${nr.table}\u0000${nr.keyCol}`;
      const here = names.get(id) || new Set();
      const inGit = gitNames.get(id) || new Set();
      for (const row of rows) {
        for (const name of namesIn(row[column], nr.shape)) {
          if (here.has(name) || inGit.has(name)) continue;
          const w = {
            code: 'dangling_name', table: spec.table, key: joinKey(keyOf(spec, row)), column, name, target: nr.table,
            syncUuid: row.sync_uuid,
          };
          out.set(stableStringify([w.table, w.syncUuid, w.column, w.name]), w);
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => cmp(a.table, b.table) || cmp(String(a.key), String(b.key))
    || cmp(a.column, b.column) || cmp(a.name, b.name) || cmp(a.syncUuid, b.syncUuid));
}

// Full diff plus the canonical rows behind it (applySeed writes from them).
// Internal: callers outside seedSync use diffGroup. Rows are per table
// (`row.table`); `tables` maps each table to its spec, columns and the git /
// local rows by sync_uuid and by natural key (see keyTextOf).
async function computeDiff(db, groupId) {
  const group = getGroup(groupId);
  const specs = tableSpecs(group);
  const doc = await readExport(groupId); // SyncFileError propagates
  if (doc) validateDoc(doc, group);
  const L = await loadLocal(db, group, specs, groupId);
  const tokensMissing = L.tables.reduce((n, t) => n + t.tokensMissing, 0);

  // Git-side display keys and names, for targets inside this group's file.
  const gitKeys = new Map();
  const gitNames = new Map();
  if (doc) {
    for (const spec of specs) {
      if (plainKeyed(spec)) {
        gitKeys.set(spec.table, new Map(docRows(doc, spec.table).map((r) => [r.sync_uuid, spec.naturalKey.map((k) => r[k])])));
      }
    }
    for (const spec of specs) {
      for (const nr of Object.values(spec.nameRefs || {})) {
        if (!specs.some((s) => s.table === nr.table)) continue;
        const id = `${nr.table}\u0000${nr.keyCol}`;
        const set = gitNames.get(id) || new Set();
        for (const r of docRows(doc, nr.table)) if (r[nr.keyCol] != null) set.add(r[nr.keyCol]);
        gitNames.set(id, set);
      }
    }
  }
  const lookup = (table, uuid) => {
    const l = L.targetKeys.get(table);
    if (l && l.has(uuid)) return l.get(uuid);
    const g = gitKeys.get(table);
    return g && g.has(uuid) ? g.get(uuid) : null;
  };
  const keyOf = (spec, row) => keyPartsOf(spec, row, lookup);

  const gitCanon = new Map(); // table -> canonical git rows (for name checks)
  if (doc) {
    for (const t of L.tables) gitCanon.set(t.spec.table, docRows(doc, t.spec.table).map((r) => canonicalRow(r, t.columns)));
  }
  const warnings = danglingNames(
    [...L.tables, ...L.tables.map((t) => ({ spec: t.spec, rows: gitCanon.get(t.spec.table) || [] }))],
    L.names, gitNames, keyOf);

  if (!doc) {
    // No file, but this PC has exported the group: the file was deleted or
    // never committed/pulled -- not a group that was never exported.
    const { rows: ex } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM seed_export_runs
                       WHERE group_id = $1 AND action = 'export' AND status = 'ok') AS x`,
      [groupId]);
    return {
      specs,
      tables: new Map(L.tables.map((t) => [t.spec.table, { spec: t.spec, columns: t.columns }])),
      inSync: [],
      dbVersion: L.dbVersion,
      diff: {
        groupId,
        header: null,
        status: ex[0].x ? 'file_missing' : 'never_exported',
        counts: zeroCounts(),
        localEdits: 0,
        gitChanges: 0,
        tokensMissing,
        tables: specs.map((s) => ({ table: s.table, counts: zeroCounts() })),
        warnings,
        rows: [],
      },
    };
  }

  const baseline = new Map(L.base.map((b) => [b.sync_uuid, b.hash]));
  const tables = new Map();
  const inSync = [];
  const rows = [];
  const counts = zeroCounts();
  const perTable = [];
  for (const t of L.tables) {
    const d = diffTable(t, docRows(doc, t.spec.table), baseline, (row) => keyOf(t.spec, row));
    tables.set(t.spec.table, d.detail);
    inSync.push(...d.inSync);
    rows.push(...d.rows); // group (seed) order, then key order within a table
    for (const k of KINDS) counts[k] += d.counts[k];
    perTable.push({ table: t.spec.table, counts: d.counts });
  }
  const divergentAdopts = rows.filter((r) => r.kind === 'adopt_identity' && r.fields.length).length;
  const localEdits = LOCAL_EDIT_KINDS.reduce((n, k) => n + counts[k], 0) + divergentAdopts;
  const gitChanges = GIT_CHANGE_KINDS.reduce((n, k) => n + counts[k], 0);
  // A file from a newer schema (header.schema_version > this DB's latest
  // migration): its columns may not exist here yet. Ranks right after
  // never_exported / file_missing; export and seed both refuse it.
  const fileVersion = doc.header.schema_version != null ? String(doc.header.schema_version) : '';
  let status = 'in_sync';
  if (fileVersion > L.dbVersion) status = 'schema_newer';
  else if (localEdits > 0) status = 'local_edits';
  else if (gitChanges > 0) status = 'git_newer';
  else if (tokensMissing > 0) status = 'tokens_missing';

  return {
    specs,
    tables,
    inSync,
    dbVersion: L.dbVersion,
    diff: {
      groupId,
      header: pickHeader(doc.header, doc),
      status,
      counts,
      localEdits,
      gitChanges,
      tokensMissing,
      tables: perTable,
      warnings,
      rows,
    },
  };
}

// The per-table detail a diff row belongs to, its git row and (for
// adopt_identity / key clashes) the local row holding its natural key.
const tableOf = (cd, r) => cd.tables.get(r.table);
const gitOf = (cd, r) => tableOf(cd, r).git.get(r.syncUuid);
function localByKeyOf(cd, r) {
  const t = tableOf(cd, r);
  return t.localByKey.get(keyTextOf(t.spec, gitOf(cd, r).row));
}

// `db` is a Pool (own consistent read, see loadLocal) or a checked-out client
// inside the caller's transaction.
async function diffGroup(db, groupId) {
  return (await computeDiff(db, groupId)).diff;
}

module.exports = {
  diffGroup, computeDiff, validateDoc, keyTextOf, tableOf, gitOf, localByKeyOf, KINDS, DEFAULTS,
};
