const { getGroup, liveColumns } = require('./registry.js');
const { canonicalRow, rowHash, stableStringify } = require('./canonical.js');
const { readExport } = require('./exportGroup.js');
const { SyncFileError } = require('./errors.js');
const { schemaVersion } = require('./runs.js');

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
const HEADER_FIELDS = ['group', 'exported_at', 'exported_by', 'schema_version', 'row_count'];

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
async function countTokensMissing(db, group) {
  const secrets = group.secretColumns || [];
  if (!secrets.length) return 0;
  let cond = secrets.map((c) => `${quoteIdent(c)} IS NULL OR ${quoteIdent(c)} = ''`).join(' OR ');
  if (group.secretNeededIf) cond = `btrim(coalesce(${quoteIdent(group.secretNeededIf)}, '')) <> '' AND (${cond})`;
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${quoteIdent(group.table)} WHERE ${cond}`);
  return rows[0].n;
}

function validateDoc(doc, group, groupId) {
  const file = `${groupId}.json`;
  if (doc.header.group !== groupId) {
    throw new SyncFileError(`${file}: header names group ${JSON.stringify(doc.header.group)}, expected ${groupId}`, file);
  }
  const seen = new Set();
  const seenKeys = new Set();
  doc.rows.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new SyncFileError(`${file}: row ${i} is not an object`, file);
    if (typeof r.sync_uuid !== 'string' || !r.sync_uuid) throw new SyncFileError(`${file}: row ${i} has no sync_uuid`, file);
    if (!UUID_RE.test(r.sync_uuid)) {
      throw new SyncFileError(`${file}: row ${i} sync_uuid is not a lowercase uuid`, file);
    }
    if (seen.has(r.sync_uuid)) throw new SyncFileError(`${file}: duplicate sync_uuid ${r.sync_uuid}`, file);
    seen.add(r.sync_uuid);
    if (r[group.naturalKey] === undefined || r[group.naturalKey] === null) {
      throw new SyncFileError(`${file}: row ${i} has no ${group.naturalKey}`, file);
    }
    const nk = stableStringify(r[group.naturalKey]);
    if (seenKeys.has(nk)) throw new SyncFileError(`${file}: duplicate ${group.naturalKey} ${nk}`, file);
    seenKeys.add(nk);
  });
  // A truncated or hand-merged file: rows went missing (or were added) after
  // the header was written. Checked last so a bad row is named first.
  if (doc.header.row_count !== doc.rows.length) {
    throw new SyncFileError(
      `${file}: header row_count ${JSON.stringify(doc.header.row_count)} but ${doc.rows.length} rows`, file);
  }
}

// Only the known header fields: the file is hand-editable, never echo extras.
function pickHeader(h) {
  const out = {};
  for (const k of HEADER_FIELDS) out[k] = h[k] === undefined ? null : h[k];
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

async function readLocal(db, group, groupId) {
  const columns = await liveColumns(db, group);
  const select = [...columns.map((c) => quoteIdent(c.name)), 'sync_uuid'].join(', ');
  const { rows } = await db.query(`SELECT ${select} FROM ${quoteIdent(group.table)}`);
  const { rows: base } = await db.query(
    'SELECT sync_uuid, hash FROM seed_row_hashes WHERE group_id = $1', [groupId]);
  const tokensMissing = await countTokensMissing(db, group);
  const dbVersion = await schemaVersion(db);
  return { columns, rows, base, tokensMissing, dbVersion };
}

// A checked-out client (it has release()) is used as-is: the caller owns the
// transaction (applySeed / exportGroup under the seed_sync lock). A Pool gets
// its own one-snapshot read-only transaction.
const isClient = (db) => typeof db.release === 'function';

async function loadLocal(db, group, groupId) {
  if (isClient(db)) return readLocal(db, group, groupId);
  const client = await db.connect();
  try {
    // One consistent snapshot for columns, rows, baselines and token count.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = await readLocal(client, group, groupId);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Full diff plus the canonical rows behind it (applySeed writes from them).
// Internal: callers outside seedSync use diffGroup.
async function computeDiff(db, groupId) {
  const group = getGroup(groupId);
  const doc = await readExport(groupId); // SyncFileError propagates
  if (doc) validateDoc(doc, group, groupId);
  const { columns, rows: localRaw, base, tokensMissing, dbVersion } = await loadLocal(db, group, groupId);
  const counts = zeroCounts();

  if (!doc) {
    return {
      group,
      columns,
      diff: {
        groupId, header: null, status: 'never_exported', counts,
        localEdits: 0, gitChanges: 0, tokensMissing, rows: [],
      },
    };
  }

  const keyCol = group.naturalKey;
  const baseline = new Map(base.map((b) => [b.sync_uuid, b.hash]));
  const local = localRaw.map((r) => {
    const row = canonicalRow(r, columns);
    return { row, hash: rowHash(row) };
  });
  const localByUuid = new Map(local.map((l) => [l.row.sync_uuid, l]));
  const localByKey = new Map(local.map((l) => [l.row[keyCol], l]));
  // Re-canonicalize git rows so a hand-edited file (other key order, extra or
  // missing columns) hashes exactly as the exporter would have written it.
  const git = doc.rows.map((r) => {
    const row = canonicalRow(r, columns);
    return { row, hash: rowHash(row) };
  });
  const gitUuids = new Set(git.map((g) => g.row.sync_uuid));
  const consumed = new Set();
  const inSync = []; // identical on both sides: { syncUuid, hash, hasBaseline }
  const out = [];
  const add = (kind, syncUuid, key, fields, defaultDecision = DEFAULTS[kind]) => {
    out.push({ syncUuid, key, kind, defaultDecision, fields, blockedReason: null });
  };

  for (const g of git) {
    const uuid = g.row.sync_uuid;
    const l = localByUuid.get(uuid);
    if (l) {
      if (l.hash === g.hash) {
        inSync.push({ syncUuid: uuid, hash: l.hash, hasBaseline: baseline.has(uuid) });
        continue;
      }
      const b = baseline.get(uuid);
      let kind;
      if (b !== undefined && l.hash === b) kind = 'changed';
      else if (b !== undefined && g.hash === b) kind = 'not_exported';
      else kind = 'edited_here';
      add(kind, uuid, l.row[keyCol], diffFields(l.row, g.row, columns));
      continue;
    }
    const cand = localByKey.get(g.row[keyCol]);
    if (cand && !consumed.has(cand.row.sync_uuid)
        && !gitUuids.has(cand.row.sync_uuid) && !baseline.has(cand.row.sync_uuid)) {
      consumed.add(cand.row.sync_uuid);
      const fields = diffFields(cand.row, g.row, columns);
      add('adopt_identity', uuid, g.row[keyCol], fields, fields.length ? null : DEFAULTS.adopt_identity);
      continue;
    }
    add(baseline.has(uuid) ? 'deleted_here' : 'new', uuid, g.row[keyCol], []);
  }

  for (const l of local) {
    const uuid = l.row.sync_uuid;
    if (gitUuids.has(uuid) || consumed.has(uuid)) continue;
    const b = baseline.get(uuid);
    add(b !== undefined && l.hash === b ? 'deleted_in_git' : 'only_here', uuid, l.row[keyCol], []);
  }

  out.sort((a, b) => cmp(String(a.key), String(b.key)) || cmp(a.syncUuid, b.syncUuid));
  for (const r of out) counts[r.kind] += 1;
  const divergentAdopts = out.filter((r) => r.kind === 'adopt_identity' && r.fields.length).length;
  const localEdits = LOCAL_EDIT_KINDS.reduce((n, k) => n + counts[k], 0) + divergentAdopts;
  const gitChanges = GIT_CHANGE_KINDS.reduce((n, k) => n + counts[k], 0);
  // A file from a newer schema (header.schema_version > this DB's latest
  // migration): its columns may not exist here yet. Ranks right after
  // never_exported; export and seed both refuse it.
  const fileVersion = doc.header.schema_version != null ? String(doc.header.schema_version) : '';
  let status = 'in_sync';
  if (fileVersion > dbVersion) status = 'schema_newer';
  else if (localEdits > 0) status = 'local_edits';
  else if (gitChanges > 0) status = 'git_newer';
  else if (tokensMissing > 0) status = 'tokens_missing';

  return {
    group,
    columns,
    git: new Map(git.map((g) => [g.row.sync_uuid, g])),
    local: localByUuid,
    localByKey,
    inSync,
    dbVersion,
    diff: {
      groupId, header: pickHeader(doc.header), status, counts, localEdits, gitChanges, tokensMissing, rows: out,
    },
  };
}

// `db` is a Pool (own read-only snapshot) or a checked-out client inside the
// caller's transaction.
async function diffGroup(db, groupId) {
  return (await computeDiff(db, groupId)).diff;
}

module.exports = { diffGroup, computeDiff, KINDS, DEFAULTS };
