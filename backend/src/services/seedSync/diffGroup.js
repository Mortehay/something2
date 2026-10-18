const { getGroup, liveColumns } = require('./registry.js');
const { canonicalRow, rowHash, stableStringify } = require('./canonical.js');
const { readExport } = require('./exportGroup.js');
const { SyncFileError } = require('./errors.js');

// Three-way diff of one group: git file (G) vs local DB (L) vs the baseline
// hash written at the last export/seed (B). Decides what a seed may overwrite.
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

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function zeroCounts() {
  const out = {};
  for (const k of KINDS) out[k] = 0;
  return out;
}

// Token presence only: the secret values are never read into JS.
async function countTokensMissing(db, group) {
  const secrets = group.secretColumns || [];
  if (!secrets.length) return 0;
  const cond = secrets.map((c) => `${quoteIdent(c)} IS NULL OR ${quoteIdent(c)} = ''`).join(' OR ');
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${quoteIdent(group.table)} WHERE ${cond}`);
  return rows[0].n;
}

function validateDoc(doc, group, groupId) {
  const file = `${groupId}.json`;
  if (doc.header.group !== groupId) {
    throw new SyncFileError(`${file}: header names group ${JSON.stringify(doc.header.group)}, expected ${groupId}`, file);
  }
  const seen = new Set();
  doc.rows.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new SyncFileError(`${file}: row ${i} is not an object`, file);
    if (typeof r.sync_uuid !== 'string' || !r.sync_uuid) throw new SyncFileError(`${file}: row ${i} has no sync_uuid`, file);
    if (seen.has(r.sync_uuid)) throw new SyncFileError(`${file}: duplicate sync_uuid ${r.sync_uuid}`, file);
    seen.add(r.sync_uuid);
    if (r[group.naturalKey] === undefined || r[group.naturalKey] === null) {
      throw new SyncFileError(`${file}: row ${i} has no ${group.naturalKey}`, file);
    }
  });
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

async function loadLocal(pool, group, groupId) {
  const client = await pool.connect();
  try {
    // One consistent snapshot for columns, rows, baselines and token count.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const columns = await liveColumns(client, group);
    const select = [...columns.map((c) => quoteIdent(c.name)), 'sync_uuid'].join(', ');
    const { rows } = await client.query(`SELECT ${select} FROM ${quoteIdent(group.table)}`);
    const { rows: base } = await client.query(
      'SELECT sync_uuid, hash FROM seed_row_hashes WHERE group_id = $1', [groupId]);
    const tokensMissing = await countTokensMissing(client, group);
    await client.query('COMMIT');
    return { columns, rows, base, tokensMissing };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function diffGroup(pool, groupId) {
  const group = getGroup(groupId);
  const doc = await readExport(groupId); // SyncFileError propagates
  if (doc) validateDoc(doc, group, groupId);
  const { columns, rows: localRaw, base, tokensMissing } = await loadLocal(pool, group, groupId);
  const counts = zeroCounts();

  if (!doc) {
    return {
      groupId, header: null, status: 'never_exported', counts,
      localEdits: 0, gitChanges: 0, tokensMissing, rows: [],
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
  const out = [];
  const add = (kind, syncUuid, key, fields) => {
    out.push({ syncUuid, key, kind, defaultDecision: DEFAULTS[kind], fields, blockedReason: null });
  };

  for (const g of git) {
    const uuid = g.row.sync_uuid;
    const l = localByUuid.get(uuid);
    if (l) {
      if (l.hash === g.hash) continue;
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
      add('adopt_identity', uuid, g.row[keyCol], diffFields(cand.row, g.row, columns));
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
  const localEdits = LOCAL_EDIT_KINDS.reduce((n, k) => n + counts[k], 0);
  const gitChanges = GIT_CHANGE_KINDS.reduce((n, k) => n + counts[k], 0);
  let status = 'in_sync';
  if (localEdits > 0) status = 'local_edits';
  else if (gitChanges > 0) status = 'git_newer';
  else if (tokensMissing > 0) status = 'tokens_missing';

  return {
    groupId, header: doc.header, status, counts, localEdits, gitChanges, tokensMissing, rows: out,
  };
}

module.exports = { diffGroup, KINDS, DEFAULTS };
