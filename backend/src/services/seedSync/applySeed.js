const crypto = require('node:crypto');
const { getGroup, tableSpecs, scopeSql, quoteIdent } = require('./registry.js');
const { computeDiff, tableOf, gitOf, localByKeyOf, OWNER_MISSING } = require('./diffGroup.js');
const { EXCLUDED } = require('./coverage.js');
const { beginLocked, lockForApply, mapLockError, rollback } = require('./txn.js');
const { buildRefMaps, resolveRow } = require('./refs.js');
const { schemaVersion, startRun, finishRun } = require('./runs.js');
const { SyncRefused } = require('./errors.js');
const { cascadeEntityRename, cascadeAuraRename } = require('./renameCascade.js');
const { assertValid, isKnownKey } = require('../gameSettings.js');
const { ASSET_REASONS, BLOCKED_MESSAGES, hasAssets, recordCache } = require('./assets.js');
const { assetInfoFor, stageUploads, withLocalAssets } = require('./assetApply.js');
const { adapterOf } = require('./adapters.js');

// Seeding writes game data from the git export into this DB. Rules that keep it
// safe: every red row needs an explicit decision, the diff is recomputed under
// the seed_sync lock (never trusted from an earlier preview), deletes of rows
// that other tables reference are refused (never cascaded -- the only
// exception is a row of the same group that this seed deletes too), a git row
// never takes a natural key a kept local row holds, every ref of a row written
// from git resolves before anything is written (missing_ref), secret columns
// are never written, and everything happens in one transaction.
// Plan 3 spec fields (registry.js header): every statement on a group table is
// scoped by scopeSql (rowFilter / versioned `active`); a versioned delete
// deactivates; a slice only UPDATEs its columns of rows that exist here.
// Asset columns (assets.js): a row that would take git whose asset file is
// missing or does not match its hash is blocked (asset_file_missing /
// asset_file_mismatch: 'git' unavailable); the files of the rows that take git
// are uploaded before the locked transaction (cancellable), which then writes
// their object keys and records them in the per-PC cache.

// Allowed decisions per kind; anything else is refused.
const ALLOWED = {
  changed: ['git', 'local'],
  not_exported: ['git', 'local'],
  edited_here: ['git', 'local'],
  adopt_identity: ['git', 'local'],
  new: ['git', 'local'],
  deleted_here: ['git', 'local'],
  deleted_in_git: ['delete', 'local'],
  only_here: ['delete', 'local'],
};
// Kinds whose local row can be deleted, so FK references can block them.
const DELETABLE = new Set(['deleted_in_git', 'only_here']);
// Git-only rows that 'git' inserts, so a kept local row can hold their key.
const INSERTABLE = new Set(['new', 'deleted_here']);
const UPDATE_KINDS = new Set(['changed', 'edited_here', 'not_exported']);
const KEY_CLASH_REASON = 'key already used by a local row';

// Decisions a row's kind allows (invalid_decision otherwise): a slice row is
// never deleted.
const kindAllowed = (cd, r) => (tableOf(cd, r).spec.slice ? ALLOWED[r.kind].filter((d) => d !== 'delete') : ALLOWED[r.kind]);
// Rows whose kind allows 'git': the ones assetInfoFor checks files for.
const gitAllowedIn = (cd) => (r) => kindAllowed(cd, r).includes('git');
// A row that this seed may delete (FK references can block it).
const deletableRow = (cd, r) => DELETABLE.has(r.kind) && !tableOf(cd, r).spec.slice;
// Decisions apply accepts for an ANNOTATED row: kindAllowed minus what its
// blockedReason forbids ('delete' of a referenced row; 'git' of a git-only row
// whose key a local row holds, or whose slice owner row is missing). The one
// source of truth for plan()'s refusals and preview's allowedDecisions.
function allowedDecisions(cd, r) {
  const a = kindAllowed(cd, r);
  if (!r.blockedReason) return a;
  if (ASSET_REASONS.has(r.blockedReason)) return a.filter((d) => d !== 'git');
  if (deletableRow(cd, r)) return a.filter((d) => d !== 'delete');
  if (INSERTABLE.has(r.kind)) return a.filter((d) => d !== 'git');
  return a;
}

const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// Every FK pointing at the group's table, with its column pairs in key order
// and its ON DELETE action (pg_constraint.confdeltype: 'n' = SET NULL).
async function referencingFks(db, spec) {
  const { rows } = await db.query(
    `SELECT c.oid, c.conrelid::regclass::text AS ref_table, c.confdeltype::text AS on_delete,
            (SELECT relname::text FROM pg_class WHERE oid = c.conrelid) AS ref_name,
            array_agg(a.attname::text ORDER BY k.ord) AS ref_cols,
            array_agg(fa.attname::text ORDER BY k.ord) AS target_cols
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(conkey, confkey, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.conkey
       JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.confkey
      WHERE c.contype = 'f' AND c.confrelid = $1::text::regclass
      GROUP BY c.oid, c.conrelid
      ORDER BY 2, c.oid`,
    [quoteIdent(spec.table)],
  );
  return rows;
}

// Who references each deletable local row (kinds deleted_in_git / only_here):
// Map(syncUuid -> { external: Map(table -> n), inGroup: [{ table, uuid }] }).
// `external` counts rows of tables outside the group (other groups, player
// data, maps): they always block. `inGroup` lists the referencing rows of the
// group's own tables by sync_uuid: they block unless this seed deletes them
// too (annotate). Includes self-references (item_types.ammo_type_id).
// Never blocks: an FK from an EXCLUDED (machine-local) table that is ON DELETE
// SET NULL (audio_jobs.clip_id): the delete only forgets a job's link.
const relaxedFk = (fk) => fk.on_delete === 'n' && Object.prototype.hasOwnProperty.call(EXCLUDED, fk.ref_name);

async function referenceInfo(db, cd) {
  const out = new Map();
  const groupTables = new Set(cd.specs.map((s) => s.table));
  const entry = (uuid) => {
    if (!out.has(uuid)) out.set(uuid, { external: new Map(), inGroup: [] });
    return out.get(uuid);
  };
  for (const spec of cd.specs) {
    const uuids = cd.diff.rows.filter((r) => r.table === spec.table && deletableRow(cd, r)).map((r) => r.syncUuid);
    if (!uuids.length) continue;
    for (const fk of await referencingFks(db, spec)) {
      if (relaxedFk(fk)) continue;
      const on = fk.ref_cols.map((c, i) => `r.${quoteIdent(c)} = t.${quoteIdent(fk.target_cols[i])}`).join(' AND ');
      // ref_table is regclass output: already quoted/qualified as needed.
      if (groupTables.has(fk.ref_name)) {
        const { rows } = await db.query(
          `SELECT t.sync_uuid::text AS uuid, r.sync_uuid::text AS ref_uuid
             FROM ${quoteIdent(spec.table)} t JOIN ${fk.ref_table} r ON ${on}
            WHERE t.sync_uuid = ANY($1::uuid[])${scopeSql(spec, 't')}`,
          [uuids],
        );
        for (const r of rows) entry(r.uuid).inGroup.push({ table: fk.ref_name, uuid: r.ref_uuid });
        continue;
      }
      const { rows } = await db.query(
        `SELECT t.sync_uuid::text AS uuid, count(*)::int AS n
           FROM ${quoteIdent(spec.table)} t JOIN ${fk.ref_table} r ON ${on}
          WHERE t.sync_uuid = ANY($1::uuid[])${scopeSql(spec, 't')}
          GROUP BY t.sync_uuid`,
        [uuids],
      );
      for (const r of rows) {
        const m = entry(r.uuid).external;
        m.set(fk.ref_table, (m.get(fk.ref_table) || 0) + r.n);
      }
    }
  }
  return out;
}

// "<n> rows in <table> reference this" (tables sorted, joined by "; ") for
// the references that still block when `deleting` is deleted; null if none.
function blockReason(info, deleting) {
  if (!info) return null;
  const counts = new Map(info.external);
  for (const { table, uuid } of info.inGroup) {
    if (!deleting.has(uuid)) counts.set(table, (counts.get(table) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([table, n]) => `${n} rows in ${table} reference this`).join('; ');
}

// Sets blockedReason and the blocking-aware defaultDecision on every diff row,
// and returns each row's effective decision under `decisions` (rows left out
// take their default). Pure: validation happens in the caller.
//  - A deletable row is blocked while anything references it, except rows of
//    the same group that this seed deletes as well (a behavior deleted in git
//    with its abilities, skills and drops). A kept in-group child blocks: ON
//    DELETE CASCADE would silently delete it. A blocked deleted_in_git
//    defaults to 'local' (keep), which can block its own parent in turn --
//    iterated to a fixpoint (the deleting set only shrinks).
//  - A new/deleted_here git row whose natural key is held by a local row that
//    this seed does NOT delete is blocked and red (defaultDecision null): an
//    explicit decision is required -- 'local' sets B = hG, so the next export
//    drops the other PC's row, which must be a deliberate choice. (Adopt
//    consumes the same-key local row, so a new/deleted_here row's key holder
//    is never adopted in the same seed.)
//  - A row that could take git and whose asset files are missing or altered
//    (assetInfo: Map(syncUuid -> reason), assetInfoFor) is blocked with that
//    reason and a blockedMessage whatever its decision ('git' is not offered);
//    a default of 'git' turns red (null): 'local' acknowledges git's version,
//    which must be deliberate.
function annotate(cd, refInfo, decisions, assetInfo = new Map()) {
  const { diff } = cd;
  const decisionOf = (r) => (own(decisions, r.syncUuid) ? decisions[r.syncUuid] : r.defaultDecision);
  const deletable = diff.rows.filter((r) => deletableRow(cd, r));
  const deletingNow = () => new Set(deletable
    .filter((r) => !r.blockedReason && decisionOf(r) === 'delete').map((r) => r.syncUuid));
  for (let changed = true; changed;) {
    changed = false;
    const deleting = deletingNow();
    for (const r of deletable) {
      if (r.blockedReason) continue;
      const reason = blockReason(refInfo.get(r.syncUuid), deleting);
      if (!reason) continue;
      r.blockedReason = reason;
      if (r.kind === 'deleted_in_git') r.defaultDecision = 'local';
      changed = true;
    }
  }
  // Final reasons against the final deleting set (stable, order-independent).
  const finalDeleting = deletingNow();
  for (const r of deletable) {
    if (r.blockedReason) r.blockedReason = blockReason(refInfo.get(r.syncUuid), finalDeleting);
  }
  const deleting = new Set(deletable.filter((r) => decisionOf(r) === 'delete').map((r) => r.syncUuid));
  for (const r of diff.rows) {
    // A slice never inserts (its git-only rows are owner_missing).
    if (!INSERTABLE.has(r.kind) || tableOf(cd, r).spec.slice) continue;
    const holder = localByKeyOf(cd, r);
    if (holder && !deleting.has(holder.row.sync_uuid)) {
      r.blockedReason = KEY_CLASH_REASON;
      r.defaultDecision = null;
    }
  }
  for (const r of diff.rows) {
    if (r.blockedReason || !assetInfo.has(r.syncUuid)) continue;
    r.blockedReason = assetInfo.get(r.syncUuid);
    r.blockedMessage = BLOCKED_MESSAGES[r.blockedReason];
    if (r.defaultDecision === 'git') r.defaultDecision = null;
  }
  return diff.rows.map((row) => ({ row, decision: decisionOf(row) }));
}

function warningsFor(fileVersion, dbVersion) {
  return fileVersion < dbVersion ? [{ code: 'schema_older' }] : [];
}

const versionOf = (header) => (header && header.schema_version != null ? String(header.schema_version) : '');

// The local row a diff row is about: by uuid, or for adopt_identity the
// same-key local row it would take git's identity onto.
function localHashOf(cd, r) {
  const l = r.kind === 'adopt_identity' ? localByKeyOf(cd, r) : tableOf(cd, r).local.get(r.syncUuid);
  return l ? l.hash : '';
}

// Identity of what a preview showed: the file's exported_at plus every row's
// table, uuid, kind, blocking-aware default, blocked reason (annotated with NO
// decisions) and its current local and git hashes. applySeed recomputes it
// under the lock and refuses a mismatch, so a decision map is never applied to
// a diff the admin did not see (a row edited here since -- even again, with
// the same kind --, a git pull that added/removed/changed rows, a new
// reference).
function previewSignatureOf(cd, refInfo, assetInfo) {
  // annotate() mutates rows; sign a copy so the caller's rows stay untouched.
  const copy = { ...cd, diff: { ...cd.diff, rows: cd.diff.rows.map((r) => ({ ...r })) } };
  annotate(copy, refInfo, {}, assetInfo);
  const parts = copy.diff.rows
    .map((r) => {
      const g = gitOf(cd, r);
      return `${r.table}:${r.syncUuid}:${r.kind}:${r.defaultDecision}:${r.blockedReason}:${localHashOf(cd, r)}:${g ? g.hash : ''}`;
    })
    .sort();
  const head = cd.diff.header ? String(cd.diff.header.exported_at) : '';
  return crypto.createHash('sha256').update(`${head}\n${parts.join('\n')}`).digest('hex');
}

// diffGroup plus blockedReason (FK references, natural-key clashes), the
// blocking-aware defaults, and `warnings` ({ code: 'schema_older' } when the file
// predates this DB's migrations; dangling_name; missing_ref / invalid_value
// that applying every row's default decision would refuse). One REPEATABLE READ READ ONLY snapshot (what
// computeDiff's Pool path takes), opened here so the reference counts and the
// schema version come from the same snapshot as the diff; no table locks, so
// an open admin edit never blocks a preview.
// opts ({ store, onProgress, signal }) are accepted for symmetry with
// export/apply; a preview reads asset files from the repo only.
async function previewSeed(pool, groupId, opts = {}) {
  getGroup(groupId); // unknown group -> throws before a connection is taken
  const adapter = adapterOf(groupId);
  if (adapter) return adapter.preview(pool, opts);
  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const cd = await computeDiff(client, groupId);
    const refInfo = await referenceInfo(client, cd);
    const assetInfo = await assetInfoFor(cd, gitAllowedIn(cd));
    const signature = previewSignatureOf(cd, refInfo, assetInfo);
    const steps = annotate(cd, refInfo, {}, assetInfo);
    // schema_older first, then the diff's dangling_name entries, then what
    // applying the defaults would refuse (all { code, ... }).
    const schemaWarnings = cd.diff.header ? warningsFor(versionOf(cd.diff.header), await schemaVersion(client)) : [];
    const refusalWarnings = cd.diff.header ? await writeWarnings(client, cd, steps) : [];
    const warnings = [...schemaWarnings, ...cd.diff.warnings, ...refusalWarnings];
    await client.query('COMMIT');
    // allowedDecisions: what apply accepts per row (the client offers only those).
    const rows = steps.map(({ row }) => ({ ...row, allowedDecisions: allowedDecisions(cd, row) }));
    return { ...cd.diff, rows, warnings, signature };
  } catch (e) {
    releaseErr = await rollback(client);
    throw e;
  } finally {
    client.release(releaseErr);
  }
}

// A refusal that names rows by sync_uuid also names them by display key
// (details.rows: [{ table, key }], at most MAX_ERROR_ROWS): a failed
// background job shows those (the tab's jobErrorRowsText), not the uuids.
const MAX_ERROR_ROWS = 50;
function withRowKeys(cd, e) {
  if (!cd || !(e instanceof SyncRefused) || !e.details || e.details.rows !== undefined) return e;
  const { uuids } = e.details;
  if (!Array.isArray(uuids) || !uuids.length) return e;
  const byUuid = new Map(cd.diff.rows.map((r) => [r.syncUuid, r]));
  const rows = uuids.map((u) => byUuid.get(u)).filter(Boolean).slice(0, MAX_ERROR_ROWS)
    .map((r) => ({ table: r.table, key: r.key }));
  if (rows.length) e.details = { ...e.details, rows };
  return e;
}

// Refusals before any write; returns [{ row, decision }] for every listed row.
function plan(cd, refInfo, decisions, assetInfo) {
  try {
    return planSteps(cd, refInfo, decisions, assetInfo);
  } catch (e) {
    throw withRowKeys(cd, e);
  }
}

function planSteps(cd, refInfo, decisions, assetInfo) {
  if (decisions === null || decisions === undefined) decisions = {};
  if (typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw new SyncRefused('invalid_decision', 'decisions must be an object keyed by sync_uuid', { uuids: [] });
  }
  const byUuid = new Map(cd.diff.rows.map((r) => [r.syncUuid, r]));
  const stale = Object.keys(decisions).filter((u) => !byUuid.has(u));
  if (stale.length) {
    throw new SyncRefused('stale_preview', 'the diff changed since the preview; preview again', { uuids: stale });
  }
  const invalid = Object.keys(decisions).filter((u) => !kindAllowed(cd, byUuid.get(u)).includes(decisions[u]));
  if (invalid.length) {
    throw new SyncRefused('invalid_decision', 'decision not allowed for this row', { uuids: invalid });
  }
  const steps = annotate(cd, refInfo, decisions, assetInfo);
  const undecided = steps.filter((s) => s.decision === null).map((s) => s.row.syncUuid);
  if (undecided.length) {
    throw new SyncRefused('undecided', 'rows edited on this PC need a decision', { uuids: undecided });
  }
  // Every decision outside allowedDecisions is refused, by why it is not
  // allowed (owner_missing, blocked, conflict).
  const rejected = steps.filter((s) => !allowedDecisions(cd, s.row).includes(s.decision));
  const orphans = rejected.filter((s) => s.row.blockedReason === OWNER_MISSING);
  if (orphans.length) {
    throw new SyncRefused(OWNER_MISSING, orphans[0].row.blockedMessage, { uuids: orphans.map((s) => s.row.syncUuid) });
  }
  const noFile = rejected.filter((s) => ASSET_REASONS.has(s.row.blockedReason));
  if (noFile.length) {
    throw new SyncRefused(noFile[0].row.blockedReason, noFile[0].row.blockedMessage, { uuids: noFile.map((s) => s.row.syncUuid) });
  }
  const blocked = rejected.filter((s) => s.decision === 'delete');
  if (blocked.length) {
    throw new SyncRefused('blocked', 'rows referenced elsewhere cannot be deleted', {
      uuids: blocked.map((s) => s.row.syncUuid),
      reasons: Object.fromEntries(blocked.map((s) => [s.row.syncUuid, s.row.blockedReason])),
    });
  }
  const conflicts = rejected.filter((s) => s.row.blockedReason === KEY_CLASH_REASON);
  if (conflicts.length) {
    throw new SyncRefused('conflict', `${KEY_CLASH_REASON}; keep it local or delete the local row`, {
      uuids: conflicts.map((s) => s.row.syncUuid),
    });
  }
  if (rejected.length) {
    throw new SyncRefused('invalid_decision', 'decision not allowed for this row', { uuids: rejected.map((s) => s.row.syncUuid) });
  }
  return steps;
}

// Live-column values of a resolved git row as query params. Ref columns
// already hold local values (resolveRow); json/jsonb travel as text.
function paramsFor(columns, row) {
  return columns.map((c) => {
    const v = row[c.name];
    if (v === null || v === undefined) return null;
    if (c.dataType === 'asset') return v && typeof v === 'object' ? JSON.stringify(v) : v; // key text or sprite jsonb
    return c.dataType === 'json' || c.dataType === 'jsonb' ? JSON.stringify(v) : v;
  });
}

// Not scoped by rowFilter (a git row that exists here but is filtered out is
// overwritten); a versioned table conflicts on its active version only. When
// its sync_uuid is UNIQUE outright (art_prompt_notes: one row per note, a
// delete deactivates it), the conflict can hit the deactivated row: it is
// reactivated, else git's row would be written yet stay invisible.
async function upsertFromGit(db, spec, columns, row) {
  const names = columns.map((c) => quoteIdent(c.name));
  const vals = paramsFor(columns, row);
  const ph = vals.map((_, i) => `$${i + 2}`).join(', ');
  const set = names.map((n) => `${n} = EXCLUDED.${n}`).join(', ') + (spec.versioned ? ', active = true' : '');
  const target = spec.versioned ? '(sync_uuid) WHERE active' : '(sync_uuid)';
  const res = await db.query(
    `INSERT INTO ${quoteIdent(spec.table)} (sync_uuid, ${names.join(', ')}) VALUES ($1, ${ph})
     ON CONFLICT ${target} DO UPDATE SET ${set} RETURNING *`,
    [row.sync_uuid, ...vals],
  );
  return res.rows[0];
}

// A slice's write: its own columns of the (scoped) row that exists here.
async function updateSlice(db, spec, columns, row) {
  const cols = columns.filter((c) => spec.columns.includes(c.name));
  const set = cols.map((c, i) => `${quoteIdent(c.name)} = $${i + 2}`).join(', ');
  const res = await db.query(
    `UPDATE ${quoteIdent(spec.table)} SET ${set} WHERE sync_uuid = $1${scopeSql(spec)} RETURNING *`,
    [row.sync_uuid, ...paramsFor(cols, row)],
  );
  if (res.rowCount !== 1) throw new Error(`seed-sync: slice update ${spec.table} ${row.sync_uuid}: expected 1 row, got ${res.rowCount}`);
  return res.rows[0];
}

// Take git's identity for the local row; with `columns`, git's (resolved)
// values too. Returns the written row.
async function adopt(db, spec, columns, row, localUuid) {
  const vals = columns ? paramsFor(columns, row) : [];
  const set = columns ? columns.map((c, i) => `, ${quoteIdent(c.name)} = $${i + 3}`).join('') : '';
  const res = await db.query(
    `UPDATE ${quoteIdent(spec.table)} SET sync_uuid = $1${set} WHERE sync_uuid = $2${scopeSql(spec)} RETURNING *`,
    [row.sync_uuid, localUuid, ...vals],
  );
  if (res.rowCount !== 1) throw new Error(`adopt_identity: local row ${localUuid} not found`);
  return res.rows[0];
}

async function setBaseline(db, groupId, uuid, hash) {
  await db.query(
    `INSERT INTO seed_row_hashes (group_id, sync_uuid, hash) VALUES ($1, $2, $3)
     ON CONFLICT (group_id, sync_uuid) DO UPDATE SET hash = EXCLUDED.hash`,
    [groupId, uuid, hash],
  );
}

async function dropBaselines(db, groupId, uuids) {
  if (!uuids.length) return;
  await db.query('DELETE FROM seed_row_hashes WHERE group_id = $1 AND sync_uuid = ANY($2::uuid[])', [groupId, uuids]);
}

// A unique violation while writing (e.g. a git row renamed onto a natural key
// a kept local row holds) is a refusal, not a 500. Constraint name only: the
// pg detail carries the clashing values.
function mapWriteError(e) {
  // 23514 (check violation, e.g. passive_edges a_id < b_id) is a backstop:
  // apply orders unordered pairs, so it should never fire -- but a refusal
  // with the constraint name beats a 500.
  if (e && e.code === '23514') {
    const constraint = e.constraint || null;
    return new SyncRefused('conflict',
      `a git row would break a check constraint${constraint ? ` (${constraint})` : ''}; keep it local or fix the row`,
      { constraint });
  }
  if (e && e.code === '23505') {
    const constraint = e.constraint || null;
    return new SyncRefused('conflict',
      `a git row would duplicate a unique value${constraint ? ` (${constraint})` : ''}; keep it local or fix the clash`,
      { constraint });
  }
  return e;
}

// ---- renames ----------------------------------------------------------------

// Name-based references (no FK) that follow a rename of a table's `name`,
// exactly as the admin PUT routes rewrite them (renameCascade.js), with the
// tables each cascade writes.
const RENAME_CASCADES = {
  entity_types: { targets: ['worlds', 'world_creatures', 'biomes'], run: cascadeEntityRename },
  aura_effects: { targets: ['entity_types'], run: cascadeAuraRename },
};

// The cascades a seed of `specs` runs: { [renamedTable]: fn(client, old, new) }.
// A cascade whose target tables are ALL in the group is skipped: those tables
// are written from git in this same seed and the file already carries the new
// names (the other PC's admin rename cascaded before its export) -- rewriting
// them again could turn a git reference to a NEW row that took the old name
// into the renamed one. A kept local row there keeps its old name and shows
// as dangling_name in the next preview: warned, never silently rewritten. A
// partial overlap cannot be honoured by the shared cascade functions: a
// registry configuration error. (No real group does either: every target is
// in another group.)
function renameCascadesFor(specs) {
  // A slice never writes the name (its natural key): no cascade.
  const mine = new Set(specs.filter((s) => !s.slice).map((s) => s.table));
  const out = {};
  for (const [table, c] of Object.entries(RENAME_CASCADES)) {
    if (!mine.has(table)) continue;
    const inGroup = c.targets.filter((t) => mine.has(t));
    if (inGroup.length === c.targets.length) continue;
    if (inGroup.length) {
      throw new Error(`seed-sync: the rename cascade of ${table} writes ${c.targets.join(', ')}, `
        + `but only ${inGroup.join(', ')} is in the same group; unsupported`);
    }
    out[table] = c.run;
  }
  return out;
}

// Chains first: A->B after B->C, so A's references do not end up as C.
// (A cycle -- a swap -- already fails on the unique name while writing.)
function orderRenames(renames) {
  const left = [...renames];
  const out = [];
  while (left.length) {
    let i = left.findIndex((r) => !left.some((o) => o !== r && o.table === r.table && o.from === r.to));
    if (i < 0) i = 0;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}

// ---- refs -------------------------------------------------------------------

// Everything a seed writes from git, checked before the first write:
//  - missing_ref: every non-null ref of a row written from git ('git' on any
//    kind, adopts included) resolves -- by key to an existing lookup row; by
//    uuid to a local row this seed does not delete, or (target in the group)
//    to a git row this seed inserts or adopts. Never a 23503/500.
//  - invalid_value: a game_settings row fails assertValid, or names a key this
//    code does not know (setSetting refuses those too).
// Read-only: returns { maps, missing: [{ table, key, column, target, value }],
// invalid: [{ key, error }] } (maps = the ref maps per table).
async function writeProblems(db, cd, steps) {
  const inGroup = new Set(cd.specs.map((s) => s.table));
  const maps = new Map();
  for (const spec of cd.specs) maps.set(spec.table, await buildRefMaps(db, spec));
  const deleted = new Map(cd.specs.map((s) => [s.table, new Set()]));
  const created = new Map(cd.specs.map((s) => [s.table, new Set()]));
  for (const { row, decision } of steps) {
    if (decision === 'delete') deleted.get(row.table).add(row.syncUuid);
    // An adopt gives the local row git's uuid whatever the decision.
    if (row.kind === 'adopt_identity' || (decision === 'git' && INSERTABLE.has(row.kind))) {
      created.get(row.table).add(row.syncUuid);
    }
  }
  const writes = steps.filter((s) => s.decision === 'git');
  const missing = [];
  for (const { row } of writes) {
    const { spec } = tableOf(cd, row);
    const g = gitOf(cd, row).row;
    const { fromRef } = maps.get(spec.table);
    for (const [column, ref] of Object.entries(spec.refs || {})) {
      const v = g[column];
      if (v === null || v === undefined) continue;
      const local = !!fromRef[column] && fromRef[column].has(v);
      const ok = ref.by === 'uuid' && inGroup.has(ref.table)
        ? (local && !deleted.get(ref.table).has(v)) || created.get(ref.table).has(v)
        : local;
      if (!ok) missing.push({ table: spec.table, key: row.key, column, target: ref.table, value: v });
    }
  }
  const invalid = [];
  for (const { row } of writes) {
    if (tableOf(cd, row).spec.validate !== 'game_settings') continue;
    const g = gitOf(cd, row).row;
    let error = null;
    if (!isKnownKey(g.key)) error = `unknown setting: ${g.key}`;
    else {
      try { assertValid(g.key, g.value); } catch (e) { error = e.message; }
    }
    if (error) invalid.push({ key: g.key, error });
  }
  return { maps, missing, invalid };
}

// writeProblems as refusals (missing_ref first, then the first invalid_value);
// returns the ref maps per table, read under the apply locks.
async function checkWrites(db, cd, steps) {
  const { maps, missing, invalid } = await writeProblems(db, cd, steps);
  if (missing.length) {
    throw new SyncRefused('missing_ref',
      'rows from git reference rows that exist neither here nor in this seed; seed their group first or keep the rows local',
      { refs: missing });
  }
  if (invalid.length) {
    const { key, error } = invalid[0];
    throw new SyncRefused('invalid_value', `${key}: ${error}`, { key, error });
  }
  return maps;
}

// The refusals applySeed would raise with every row on its default decision,
// as preview warnings: { code: 'missing_ref', table, key, column, target } and
// { code: 'invalid_value', key, error }. Read-only.
async function writeWarnings(db, cd, steps) {
  const { missing, invalid } = await writeProblems(db, cd, steps);
  return [
    ...missing.map(({ table, key, column, target }) => ({ code: 'missing_ref', table, key, column, target })),
    ...invalid.map(({ key, error }) => ({ code: 'invalid_value', key, error })),
  ];
}

// resolveRow's `pending` for `spec`: git uuid -> the written row's referenced
// column, for rows this seed already wrote (inserted, adopted or updated).
function pendingFor(spec, maps, written) {
  const out = {};
  for (const [col, ref] of Object.entries(spec.refs || {})) {
    if (ref.by !== 'uuid' || !written.has(ref.table)) continue;
    const refCol = maps.refCols[col];
    if (out[ref.table] && out[ref.table].refCol !== refCol) {
      throw new Error(`seed-sync: ${spec.table} references ${ref.table} through different columns`);
    }
    const rows = written.get(ref.table);
    out[ref.table] = { refCol, has: (u) => rows.has(u), get: (u) => rows.get(u)[refCol] };
  }
  return out;
}

// A git row with its refs as local values. A by-uuid ref to a row of this
// table or a later table of the group that is not written yet (a
// self-reference such as item_types.ammo_type_id) is written NULL now and
// queued in `deferred` for the second pass. checkWrites already proved every
// ref resolvable, so anything else unresolved is a bug.
// An unorderedPair spec (passive_edges) is written with the two resolved
// local ids LEAST/GREATEST: its CHECK (a_id < b_id) is on local ids, whose
// order differs between PCs.
async function resolveForWrite(spec, gitRow, maps, written, order, deferred) {
  const { row, missing } = await resolveRow(gitRow, spec, maps, pendingFor(spec, maps, written));
  for (const m of missing) {
    if (!(order.has(m.target) && order.get(m.target) >= order.get(spec.table))) {
      throw new Error(`seed-sync: ${spec.table}.${m.column} = ${m.value} did not resolve`);
    }
    if (spec.unorderedPair && spec.unorderedPair.includes(m.column)) {
      throw new Error(`seed-sync: ${spec.table}.${m.column} is half of an unordered pair; it cannot be deferred`);
    }
    row[m.column] = null;
    deferred.push({ spec, uuid: gitRow.sync_uuid, column: m.column, value: m.value });
  }
  if (spec.unorderedPair) {
    const [a, b] = spec.unorderedPair;
    if (row[a] != null && row[b] != null && Number(row[a]) > Number(row[b])) [row[a], row[b]] = [row[b], row[a]];
  }
  return row;
}

// decisions: { [syncUuid]: 'git' | 'local' | 'delete' }; rows left out use
// their (blocking-aware) defaultDecision. `signature` is the one previewSeed
// returned; required -- a missing or different one refuses stale_preview.
// Refusals (busy, no_export, schema_newer, stale_preview, invalid_decision,
// undecided, owner_missing, blocked, conflict, missing_ref, invalid_value) happen before a
// run is started, so they record no run -- like export's git_newer. A failure
// after that (including a write conflict, 23505 -> SyncRefused('conflict'))
// rolls everything back and finishes the run as failed; a committed seed
// always finishes ok.
// opts.store (default assetStore), opts.onProgress, opts.signal: a group
// with asset columns uploads the files of its git rows first (stageUploads,
// outside the lock and cancellable -> SyncRefused('cancelled')).
async function applySeed(pool, groupId, decisions, opts = {}) {
  const adapter = adapterOf(groupId);
  if (adapter) return adapter.apply(pool, decisions, opts);
  const { signature } = opts;
  const specs = tableSpecs(getGroup(groupId));
  const cascades = renameCascadesFor(specs);
  const order = new Map(specs.map((s, i) => [s.table, i]));
  let assetInfo = new Map();
  let uploads = null;
  if (specs.some(hasAssets)) {
    let snapCd = null;
    const planOnSnapshot = async (client) => {
      const cd = await computeDiff(client, groupId);
      snapCd = cd;
      // No file / newer schema: the locked path refuses it.
      if (!cd.diff.header || versionOf(cd.diff.header) > await schemaVersion(client)) return null;
      const refInfo = await referenceInfo(client, cd);
      const info = await assetInfoFor(cd, gitAllowedIn(cd));
      if (typeof signature !== 'string' || signature !== previewSignatureOf(cd, refInfo, info)) {
        throw new SyncRefused('stale_preview', 'the diff changed since the preview; preview again', { uuids: [] });
      }
      return { cd, assetInfo: info, steps: plan(cd, refInfo, decisions, info) };
    };
    try {
      ({ assetInfo, uploads } = await stageUploads(pool, planOnSnapshot, {
        store: opts.store || require('../assetStore.js'), onProgress: opts.onProgress, signal: opts.signal,
      }));
    } catch (e) {
      throw withRowKeys(snapCd, e); // an upload's asset_file_mismatch
    }
  }
  const client = await pool.connect();
  let runId = null;
  let releaseErr;
  let result;
  try {
    await beginLocked(client);
    // No concurrent INSERT/UPDATE/DELETE on the group's tables, nor on any
    // by-uuid ref target outside it, until COMMIT (reads go on): the diff and
    // the ref maps below stay true while we write, so an edit made meanwhile
    // on this PC can never be silently overwritten. One sorted order shared
    // with export. (Not REPEATABLE READ: its snapshot would be taken before
    // the lock wait.)
    await lockForApply(client, specs);
    const cd = await computeDiff(client, groupId);
    const { diff } = cd;
    if (!diff.header) throw new SyncRefused('no_export', `no export file for ${groupId}`);
    const fileVersion = versionOf(diff.header);
    const dbVersion = await schemaVersion(client);
    if (fileVersion > dbVersion) {
      throw new SyncRefused('schema_newer', 'run migrations first', { fileVersion, dbVersion });
    }
    // Lock every deletable row before counting its references: a new
    // referencing row (FK KEY SHARE) from outside the group now waits for us,
    // and the count sees everything committed before it.
    for (const spec of specs) {
      const uuids = diff.rows.filter((r) => r.table === spec.table && deletableRow(cd, r)).map((r) => r.syncUuid);
      if (!uuids.length) continue;
      await client.query(
        `SELECT 1 FROM ${quoteIdent(spec.table)} WHERE sync_uuid = ANY($1::uuid[])${scopeSql(spec)} FOR UPDATE`, [uuids]);
    }
    const refInfo = await referenceInfo(client, cd);
    // assetInfo is stageUploads': the files are not under the DB lock anyway,
    // and an equal signature means the same rows need the same files.
    if (typeof signature !== 'string' || signature !== previewSignatureOf(cd, refInfo, assetInfo)) {
      throw new SyncRefused('stale_preview', 'the diff changed since the preview; preview again', { uuids: [] });
    }
    const steps = plan(cd, refInfo, decisions, assetInfo);
    const maps = await checkWrites(client, cd, steps);

    runId = await startRun(pool, groupId, 'seed');
    const summary = { updated: 0, created: 0, deleted: 0, kept: 0, adopted: 0 };
    const by = (decision, pred = () => true) => steps.filter((s) => s.decision === decision && pred(s.row));

    // 1. Deletes, children first (reverse table order), before any write: a
    // git row may take the natural key of a local row deleted in this seed.
    // The rows were picked by the (scoped) diff and locked FOR UPDATE above,
    // so only `active` is re-applied here (a versioned table shares one
    // sync_uuid across versions), never the rowFilter: it may read the
    // group's own children (audio_clips: EXISTS a binding), which the
    // children-first deletes just removed.
    const deleteScope = (spec) => (spec.versioned ? ' AND active' : '');
    for (const spec of [...specs].reverse()) {
      const uuids = by('delete', (r) => r.table === spec.table).map((s) => s.row.syncUuid);
      if (!uuids.length) continue;
      // Self-references among rows deleted together (ON DELETE RESTRICT).
      // A versioned table only deactivates: its rows stay, so do their refs.
      for (const [col, ref] of Object.entries(spec.refs || {})) {
        if (ref.table !== spec.table || spec.versioned) continue;
        await client.query(
          `UPDATE ${quoteIdent(spec.table)} SET ${quoteIdent(col)} = NULL
            WHERE sync_uuid = ANY($1::uuid[]) AND ${quoteIdent(col)} IS NOT NULL${deleteScope(spec)}`, [uuids]);
      }
      const res = await client.query(spec.versioned
        ? `UPDATE ${quoteIdent(spec.table)} SET active = false WHERE sync_uuid = ANY($1::uuid[])${deleteScope(spec)}`
        : `DELETE FROM ${quoteIdent(spec.table)} WHERE sync_uuid = ANY($1::uuid[])${deleteScope(spec)}`, [uuids]);
      if (res.rowCount !== uuids.length) {
        throw new Error(`delete ${spec.table}: expected ${uuids.length} rows, got ${res.rowCount}`);
      }
      await dropBaselines(client, groupId, uuids);
      summary.deleted += uuids.length;
    }

    // 2. Per table, parents first: adopts, then upserts. Every written row is
    // recorded (git uuid -> row) so a later row's ref to it resolves.
    const written = new Map(specs.map((s) => [s.table, new Map()]));
    const deferred = [];
    const renames = [];
    for (const spec of specs) {
      const t = cd.tables.get(spec.table);
      const m = maps.get(spec.table);
      const mine = (r) => r.table === spec.table;
      for (const { row, decision } of steps.filter((s) => mine(s.row) && s.row.kind === 'adopt_identity')) {
        const g = gitOf(cd, row).row;
        const localUuid = localByKeyOf(cd, row).row.sync_uuid;
        const out = decision === 'git'
          ? await adopt(client, spec, t.columns,
            withLocalAssets(cd, row, spec, await resolveForWrite(spec, g, m, written, order, deferred), uploads), localUuid)
          // Identity only: values and local refs stay (a ref's target keeps
          // its local id even when it is adopted too).
          : await adopt(client, spec, null, g, localUuid);
        written.get(spec.table).set(g.sync_uuid, out);
        if (decision === 'git') summary.adopted += 1;
      }
      for (const { row } of by('git', (r) => mine(r) && r.kind !== 'adopt_identity')) {
        const g = gitOf(cd, row).row;
        const resolved = withLocalAssets(cd, row, spec, await resolveForWrite(spec, g, m, written, order, deferred), uploads);
        if (spec.slice && !UPDATE_KINDS.has(row.kind)) throw new Error(`seed-sync: slice ${spec.table} cannot write kind ${row.kind}`);
        const out = spec.slice
          ? await updateSlice(client, spec, t.columns, resolved)
          : await upsertFromGit(client, spec, t.columns, resolved);
        written.get(spec.table).set(g.sync_uuid, out);
        if (UPDATE_KINDS.has(row.kind)) {
          summary.updated += 1;
          const before = t.local.get(row.syncUuid).row.name;
          if (cascades[spec.table] && before !== g.name) renames.push({ table: spec.table, from: before, to: g.name });
        } else if (INSERTABLE.has(row.kind)) summary.created += 1;
        else throw new Error(`no git write for kind ${row.kind}`);
      }
    }
    // 3. Second pass: refs that pointed at rows written after them.
    for (const d of deferred) {
      const m = maps.get(d.spec.table);
      const one = { ...d.spec, refs: { [d.column]: d.spec.refs[d.column] } };
      const { row, missing } = await resolveRow({ [d.column]: d.value }, one, m, pendingFor(one, m, written));
      if (missing.length) throw new Error(`seed-sync: ${d.spec.table}.${d.column} = ${d.value} did not resolve`);
      const res = await client.query(
        `UPDATE ${quoteIdent(d.spec.table)} SET ${quoteIdent(d.column)} = $1 WHERE sync_uuid = $2${scopeSql(d.spec)}`,
        [row[d.column], d.uuid]);
      if (res.rowCount !== 1) {
        throw new Error(`seed-sync: second pass ${d.spec.table}.${d.column} of ${d.uuid}: expected 1 row, got ${res.rowCount}`);
      }
    }
    // 4. Renames: the admin PUT's name cascades, in this transaction.
    for (const r of orderRenames(renames)) await cascades[r.table](client, r.from, r.to);
    summary.kept = by('local').length;

    // Baselines. Written from git -> B = hG. A 'local' decision acknowledges
    // git's version so export is not stuck behind git_newer:
    // changed/edited_here/adopt_identity/new -> B = hG (next diff:
    // not_exported / deleted_here); deleted_in_git -> drop B (next: only_here);
    // deleted_here/not_exported/only_here -> untouched. Rows already identical
    // with a missing or stale B -> B = hL (first sync, or a B written by an
    // older export form).
    const ACK = new Set(['changed', 'edited_here', 'adopt_identity', 'new']);
    for (const { row } of [...by('git'), ...by('local', (r) => ACK.has(r.kind))]) {
      await setBaseline(client, groupId, row.syncUuid, gitOf(cd, row).hash);
    }
    await dropBaselines(client, groupId, by('local', (r) => r.kind === 'deleted_in_git').map((s) => s.row.syncUuid));
    for (const s of cd.inSync) if (!s.hasBaseline) await setBaseline(client, groupId, s.syncUuid, s.hash);
    // The uploaded keys translate to git's files from now on (next diff: in sync).
    if (uploads) await recordCache(client, uploads.cacheEntries);

    await client.query('COMMIT');
    result = { runId, summary };
  } catch (err) {
    const e = mapWriteError(mapLockError(err));
    releaseErr = await rollback(client);
    if (runId !== null) await finishRun(pool, runId, { status: 'failed', error: e.message }).catch(() => {});
    throw e;
  } finally {
    client.release(releaseErr);
  }
  // Committed: the run is ok whatever happens now; never report it failed.
  await finishRun(pool, runId, { status: 'ok', summary: result.summary })
    .catch((e) => console.error(`seed-sync: seed run ${runId} committed but not marked ok:`, e.message));
  return result;
}

module.exports = {
  previewSeed, applySeed, ALLOWED, KEY_CLASH_REASON, allowedDecisions, annotate, renameCascadesFor, _mapWriteError: mapWriteError,
};
