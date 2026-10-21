const {
  GROUPS, getGroup, tableSpecs, liveColumns, liveDefaults, pairKeyCol, orderPair, scopeSql, ownerLabel, quoteIdent,
} = require('./registry.js');
const { canonicalRow, rowHash, stableStringify } = require('./canonical.js');
const { buildRefMaps, exportRow, exportColumns } = require('./refs.js');
const { readExport } = require('./exportGroup.js');
const { SyncFileError } = require('./errors.js');
const { schemaVersion } = require('./runs.js');
const { rollback } = require('./txn.js');
const { hasAssets, translateRow, rowCacheKeys, loadCache } = require('./assets.js');

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
// blockedReason of a slice's git row whose owner row is not here (the row
// also carries blockedMessage "seed <owner label> first").
const OWNER_MISSING = 'owner_missing';
const LOCAL_EDIT_KINDS = ['not_exported', 'edited_here', 'only_here', 'deleted_here'];
const GIT_CHANGE_KINDS = ['changed', 'new', 'deleted_in_git', 'edited_here', 'adopt_identity'];
// v1 (Plan 1): { header{..., row_count}, rows }; v2: { header{..., row_counts}, tables }.
const HEADER_FIELDS_V1 = ['group', 'exported_at', 'exported_by', 'schema_version', 'row_count'];
const HEADER_FIELDS_V2 = ['group', 'exported_at', 'exported_by', 'schema_version', 'row_counts'];

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
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${quoteIdent(spec.table)} WHERE (${cond})${scopeSql(spec)}`);
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

const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj || {}, k);

// The TableSpec that describes `table`: the group's own first, else any
// registered group's full (non-slice) spec. null when no group exports that table.
function specFor(group, table) {
  const mine = tableSpecs(group).find((s) => s.table === table);
  if (mine) return mine;
  for (const g of GROUPS) {
    const s = tableSpecs(g).find((x) => x.table === table && !x.slice);
    if (s) return s;
  }
  return null;
}

const uuidKeyRefs = (spec) => spec.naturalKey.filter((k) => own(spec.refs, k) && spec.refs[k].by === 'uuid');

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
  // table -> Map(sync_uuid -> exported-form row holding at least the natural
  // key): what deep natural keys and display keys are resolved from.
  const keyIndex = new Map();
  for (const spec of specs) {
    const columns = exportColumns(await liveColumns(db, spec), spec);
    const maps = await buildRefMaps(db, spec);
    const select = [...columns.map((c) => quoteIdent(c.name)), 'sync_uuid'].join(', ');
    const { rows } = await db.query(`SELECT ${select} FROM ${quoteIdent(spec.table)} WHERE true${scopeSql(spec)}`);
    // Exactly what export would write (refs translated, asset keys through
    // this PC's cache), so hL == B for an unchanged row. An uncached key
    // reads { unhashed: key }: never equal to git, a local edit.
    let exported = rows.map((r) => exportRow(r, spec, maps));
    // rawAssets: uuid -> { col: local DB value } (apply keeps an unchanged
    // asset's local key instead of uploading git's file again).
    let rawAssets = null;
    if (hasAssets(spec)) {
      const cache = await loadCache(db, rowCacheKeys(spec, exported));
      rawAssets = new Map(exported.map((r) => [r.sync_uuid,
        Object.fromEntries(Object.keys(spec.assets).map((c) => [c, r[c]]))]));
      exported = exported.map((r) => translateRow(spec, r, cache));
    }
    const canon = exported.map((r) => canonicalRow(r, columns));
    // Ref and asset columns travel in a translated form: no default applies.
    const defaults = await liveDefaults(db, spec, columns.filter((c) => c.dataType !== 'ref' && c.dataType !== 'asset'));
    tables.push({ spec, columns, defaults, rows: canon, rawAssets, tokensMissing: await countTokensMissing(db, spec) });
    keyIndex.set(spec.table, new Map(canon.map((r) => [r.sync_uuid, r])));
  }
  // Natural keys of by-uuid ref targets outside the group, transitively (a
  // target's own key may hold uuid refs). A table no group describes stays
  // unresolved (null): its refs fall back to the uuid.
  const todo = specs.flatMap((s) => uuidKeyRefs(s).map((k) => s.refs[k].table));
  while (todo.length) {
    const table = todo.shift();
    if (keyIndex.has(table)) continue;
    const ts = specFor(group, table);
    if (!ts) { keyIndex.set(table, null); continue; }
    const keySpec = {
      table, naturalKey: ts.naturalKey,
      refs: Object.fromEntries(ts.naturalKey.filter((k) => own(ts.refs, k)).map((k) => [k, ts.refs[k]])),
    };
    const maps = await buildRefMaps(db, keySpec);
    const { rows } = await db.query(
      `SELECT sync_uuid, ${ts.naturalKey.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)} WHERE true${scopeSql(ts)}`);
    keyIndex.set(table, new Map(rows.map((r) => [r.sync_uuid, exportRow(r, keySpec, maps)])));
    todo.push(...uuidKeyRefs(keySpec).map((k) => keySpec.refs[k].table));
  }
  // Names that exist locally, per by-name target (table, keyCol).
  const names = new Map();
  for (const spec of specs) {
    for (const nr of Object.values(spec.nameRefs || {})) {
      const id = `${nr.table}\u0000${nr.keyCol}`;
      if (names.has(id)) continue;
      const { rows } = await db.query(
        `SELECT ${quoteIdent(nr.keyCol)} AS n FROM ${quoteIdent(nr.table)} WHERE true${scopeSql(specFor(group, nr.table))}`);
      names.set(id, new Set(rows.map((r) => r.n)));
    }
  }
  const { rows: base } = await db.query(
    'SELECT sync_uuid, hash FROM seed_row_hashes WHERE group_id = $1', [groupId]);
  const dbVersion = await schemaVersion(db);
  return { tables, keyIndex, names, base, dbVersion };
}

// A checked-out client (it has release()) is used as-is: the caller owns the
// transaction and its locks (applySeed / exportGroup under the seed_sync
// lock). A Pool gets one REPEATABLE READ READ ONLY snapshot: every table, ref
// map, key/name lookup and baseline is read from one consistent state, and an
// open admin write never blocks a status/preview read. (No advisory-lock wait
// precedes it, so the snapshot is current.)
const isClient = (db) => typeof db.release === 'function';

async function loadLocal(db, group, specs, groupId) {
  if (isClient(db)) return readLocal(db, group, specs, groupId);
  const client = await db.connect();
  let releaseErr;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = await readLocal(client, group, specs, groupId);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    releaseErr = await rollback(client);
    throw e;
  } finally {
    client.release(releaseErr);
  }
}

// ---- keys ------------------------------------------------------------------

// Resolves natural keys "deeply": every by-uuid ref part becomes the target
// row's own (deep) natural key, so two PCs that created the same parent and
// child under different random uuids still agree on the child's key. A git
// row resolves its targets from the group's git file first, then the local
// DB; a local row from the local DB first. Unresolvable -> the uuid.
//   match(spec, row, side) -> text used for adopt_identity / key clashes
//   display(spec, row, side) -> keyParts for the UI (ref part shown as the
//     target's key joined with ' → ', or the uuid's first 8 chars)
function keyResolver(group, keyIndex, gitIndex) {
  const order = { git: [gitIndex, keyIndex], local: [keyIndex, gitIndex] };
  const memo = { git: new Map(), local: new Map() };
  function partsOf(spec, row, side, seen) {
    return spec.naturalKey.map((k) => {
      const v = row[k] === undefined ? null : row[k];
      const ref = own(spec.refs, k) ? spec.refs[k] : null;
      if (!ref || ref.by !== 'uuid' || typeof v !== 'string') return v;
      return { ref: target(ref.table, v, side, seen), uuid: v };
    });
  }
  // Deep parts of target row (table, uuid), or null when not found.
  function target(table, uuid, side, seen) {
    const id = `${table}\u0000${uuid}`;
    if (memo[side].has(id)) return memo[side].get(id);
    if (seen.has(id)) return null; // a cycle: fall back to the uuid
    const ts = specFor(group, table);
    let row = null;
    for (const idx of order[side]) {
      const m = idx.get(table);
      if (m && m.has(uuid)) { row = m.get(uuid); break; }
    }
    const out = ts && row ? partsOf(ts, row, side, new Set([...seen, id])) : null;
    memo[side].set(id, out);
    return out;
  }
  const matchValue = (parts) => parts.map((p) => (isPlainObject(p) && own(p, 'uuid')
    ? (p.ref ? { k: matchValue(p.ref) } : { u: p.uuid }) : p));
  const displayText = (parts) => (parts.length === 1 ? displayPart(parts[0]) : parts.map((p) => String(displayPart(p))).join(' → '));
  const displayPart = (p) => (isPlainObject(p) && own(p, 'uuid') ? (p.ref ? String(displayText(p.ref)) : p.uuid.slice(0, 8)) : p);
  const refText = (table, uuid, side) => {
    const parts = target(table, uuid, side, new Set());
    return parts ? stableStringify(matchValue(parts)) : `uuid:${uuid}`;
  };
  return {
    match: (spec, row, side) => stableStringify(matchValue(partsOf(spec, row, side, new Set()))),
    // Do a local and a git ref uuid name one row? Equal uuids, or the two
    // sides of one adopt pair: equal deep keys AND the git uuid is no live
    // local row AND the local uuid no live git row. (A parent renamed in git
    // while a new one took its name is two rows: the ref really changed.)
    sameRef: (table, localUuid, gitUuid) => {
      if (localUuid === gitUuid) return true;
      if (typeof localUuid !== 'string' || typeof gitUuid !== 'string') return false;
      const localRows = keyIndex.get(table);
      const gitRows = gitIndex.get(table);
      if (localRows && localRows.has(gitUuid)) return false;
      if (gitRows && gitRows.has(localUuid)) return false;
      return refText(table, localUuid, 'local') === refText(table, gitUuid, 'git');
    },
    display: (spec, row, side) => partsOf(spec, row, side, new Set()).map(displayPart),
  };
}

// keyOf for orderPair: the pair target's natural key, looked up in `indexes`
// (Map(table -> Map(uuid -> row))) in order; null when unknown.
function pairKeyOf(spec, indexes) {
  const { table, keyCol } = pairKeyCol(spec);
  return (uuid) => {
    for (const idx of indexes) {
      const m = idx.get(table);
      if (m && m.has(uuid)) {
        const v = m.get(uuid)[keyCol];
        return typeof v === 'string' ? v : null;
      }
    }
    return null;
  };
}

const joinKey = (parts) => (parts.length === 1 ? parts[0] : parts.map((p) => String(p)).join(' → '));

// ---- diff ------------------------------------------------------------------

// A git row in canonical form. A column the row lacks (the file was exported
// before the column existed) reads as the column's constant default, so a
// local row still at the default is identical; `absent` lists those columns,
// which apply never writes (unchanged on update, the default on insert).
function canonicalGit(r, t) {
  const absent = new Set();
  let filled = r;
  if (isPlainObject(r)) {
    for (const c of t.columns) {
      if (Object.prototype.hasOwnProperty.call(r, c.name)) continue;
      absent.add(c.name);
      if (t.defaults && t.defaults.has(c.name)) {
        if (filled === r) filled = { ...r };
        filled[c.name] = t.defaults.get(c.name);
      }
    }
  }
  return { row: canonicalRow(filled, t.columns), absent };
}

// One table's three-way classification (Plan-1 rules, unchanged). Hashes are
// on the uuid-translated export form; natural-key matching (adopt_identity,
// localByKey for key clashes) on the deep key.
function diffTable(t, gitRaw, baseline, keys) {
  const { spec, columns } = t;
  const local = t.rows.map((row) => ({ row, hash: rowHash(row) }));
  const localByUuid = new Map(local.map((l) => [l.row.sync_uuid, l]));
  const localByKey = new Map(local.map((l) => [keys.match(spec, l.row, 'local'), l]));
  // Re-canonicalize git rows so a hand-edited file (other key order, extra or
  // missing columns) hashes exactly as the exporter would have written it.
  const git = gitRaw.map((r) => {
    const { row, absent } = canonicalGit(r, t);
    return { row, hash: rowHash(row), absent };
  });
  const gitKeyText = new Map(git.map((g) => [g.row.sync_uuid, keys.match(spec, g.row, 'git')]));
  const gitUuids = new Set(git.map((g) => g.row.sync_uuid));
  const consumed = new Set();
  const inSync = []; // identical on both sides
  const out = [];
  const add = (kind, syncUuid, row, side, fields, defaultDecision = DEFAULTS[kind], extra = null) => {
    const keyParts = keys.display(spec, row, side);
    out.push({
      table: spec.table, syncUuid, key: joinKey(keyParts), keyParts, kind, defaultDecision, fields, blockedReason: null,
      ...extra,
    });
  };

  for (const g of git) {
    const uuid = g.row.sync_uuid;
    const l = localByUuid.get(uuid);
    if (l) {
      if (l.hash === g.hash) {
        // hasBaseline: B is present AND current. A missing or stale B (e.g.
        // written before an upgrade changed the export form) is refreshed by
        // the next seed: local == git, so B = hL is always right.
        inSync.push({ table: spec.table, syncUuid: uuid, hash: l.hash, hasBaseline: baseline.get(uuid) === l.hash });
        continue;
      }
      const b = baseline.get(uuid);
      let kind;
      if (b !== undefined && l.hash === b) kind = 'changed';
      else if (b !== undefined && g.hash === b) kind = 'not_exported';
      else kind = 'edited_here';
      add(kind, uuid, l.row, 'local', diffFields(l.row, g.row, columns));
      continue;
    }
    if (spec.slice) {
      // A slice never inserts or adopts: the owner group creates the row.
      // Red (null) like a key clash: 'local' sets B = hG, so the next export
      // drops the row from git -- a deliberate choice.
      add(baseline.has(uuid) ? 'deleted_here' : 'new', uuid, g.row, 'git', [], null, {
        blockedReason: OWNER_MISSING, blockedMessage: `seed ${ownerLabel(spec.table)} first`,
      });
      continue;
    }
    const cand = localByKey.get(gitKeyText.get(uuid));
    if (cand && !consumed.has(cand.row.sync_uuid)
        && !gitUuids.has(cand.row.sync_uuid) && !baseline.has(cand.row.sync_uuid)) {
      consumed.add(cand.row.sync_uuid);
      // A by-uuid ref whose two uuids name the same deep row (e.g. a parent
      // adopted in the same seed) is not a value difference.
      const fields = diffFields(cand.row, g.row, columns).filter((f) => {
        const ref = own(spec.refs, f.name) ? spec.refs[f.name] : null;
        return !(ref && ref.by === 'uuid' && keys.sameRef(ref.table, f.local, f.git));
      });
      add('adopt_identity', uuid, g.row, 'git', fields, fields.length ? null : DEFAULTS.adopt_identity);
      continue;
    }
    add(baseline.has(uuid) ? 'deleted_here' : 'new', uuid, g.row, 'git', []);
  }

  for (const l of local) {
    const uuid = l.row.sync_uuid;
    if (gitUuids.has(uuid) || consumed.has(uuid)) continue;
    const b = baseline.get(uuid);
    const kind = b !== undefined && l.hash === b ? 'deleted_in_git' : 'only_here';
    // A slice never deletes (the owner does): keep is the only choice.
    add(kind, uuid, l.row, 'local', [], spec.slice ? 'local' : DEFAULTS[kind]);
  }

  out.sort((a, b) => cmp(String(a.key), String(b.key)) || cmp(a.syncUuid, b.syncUuid));
  const counts = zeroCounts();
  for (const r of out) counts[r.kind] += 1;
  return {
    detail: {
      spec,
      columns,
      rawAssets: t.rawAssets,
      git: new Map(git.map((g) => [g.row.sync_uuid, g])),
      gitKeyText,
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
function danglingNames(sets, names, gitNames, keys) {
  const out = new Map();
  for (const { spec, rows, side } of sets) {
    for (const [column, nr] of Object.entries(spec.nameRefs || {}).sort(([a], [b]) => cmp(a, b))) {
      const id = `${nr.table}\u0000${nr.keyCol}`;
      const here = names.get(id) || new Set();
      const inGit = gitNames.get(id) || new Set();
      for (const row of rows) {
        for (const name of namesIn(row[column], nr.shape)) {
          if (here.has(name) || inGit.has(name)) continue;
          const w = {
            code: 'dangling_name', table: spec.table, key: joinKey(keys.display(spec, row, side)), column, name,
            target: nr.table, syncUuid: row.sync_uuid,
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
// (`row.table`); `tables` maps each table to its spec, columns, the git /
// local rows by sync_uuid, the local rows by deep natural key (localByKey)
// and each git row's deep key text (gitKeyText).
async function computeDiff(db, groupId) {
  const group = getGroup(groupId);
  const specs = tableSpecs(group);
  const doc = await readExport(groupId); // SyncFileError propagates
  if (doc) validateDoc(doc, group);
  const L = await loadLocal(db, group, specs, groupId);
  // Unordered pairs (registry unorderedPair): local rows ordered by the
  // targets' local natural keys -- exactly what export writes, so hL == B.
  for (const t of L.tables) {
    if (!t.spec.unorderedPair) continue;
    const keyOf = pairKeyOf(t.spec, [L.keyIndex]);
    t.rows = t.rows.map((r) => orderPair(t.spec, r, keyOf));
    L.keyIndex.set(t.spec.table, new Map(t.rows.map((r) => [r.sync_uuid, r])));
  }
  const tokensMissing = L.tables.reduce((n, t) => n + t.tokensMissing, 0);

  // Git-side rows (file form) and names, for targets inside this group's file.
  const gitIndex = new Map();
  const gitNames = new Map();
  if (doc) {
    for (const spec of specs) gitIndex.set(spec.table, new Map(docRows(doc, spec.table).map((r) => [r.sync_uuid, r])));
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
  const keys = keyResolver(group, L.keyIndex, gitIndex);

  const gitCanon = new Map(); // table -> canonical git rows (for name checks)
  if (doc) {
    for (const t of L.tables) gitCanon.set(t.spec.table, docRows(doc, t.spec.table).map((r) => canonicalGit(r, t).row));
  }
  const warnings = danglingNames([
    ...L.tables.map((t) => ({ spec: t.spec, rows: t.rows, side: 'local' })),
    ...L.tables.map((t) => ({ spec: t.spec, rows: gitCanon.get(t.spec.table) || [], side: 'git' })),
  ], L.names, gitNames, keys);

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
    // Git rows of an unordered pair: ordered by the targets' keys in the file
    // first, then here (a hand-edited or differently ordered file still
    // hashes as the exporter would have written it).
    let gitRows = docRows(doc, t.spec.table);
    if (t.spec.unorderedPair) {
      const keyOf = pairKeyOf(t.spec, [gitIndex, L.keyIndex]);
      gitRows = gitRows.map((r) => (isPlainObject(r) ? orderPair(t.spec, r, keyOf) : r));
    }
    const d = diffTable(t, gitRows, baseline, keys);
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
// adopt_identity / key clashes) the local row holding its deep natural key.
const tableOf = (cd, r) => cd.tables.get(r.table);
const gitOf = (cd, r) => tableOf(cd, r).git.get(r.syncUuid);
function localByKeyOf(cd, r) {
  const t = tableOf(cd, r);
  return t.localByKey.get(t.gitKeyText.get(r.syncUuid));
}

// `db` is a Pool (own consistent snapshot, see loadLocal) or a checked-out
// client inside the caller's transaction.
async function diffGroup(db, groupId) {
  const adapter = require('./adapters.js').adapterOf(groupId);
  if (adapter) return adapter.status(db);
  return (await computeDiff(db, groupId)).diff;
}

module.exports = {
  diffGroup, computeDiff, validateDoc, tableOf, gitOf, localByKeyOf, KINDS, DEFAULTS, OWNER_MISSING,
};
