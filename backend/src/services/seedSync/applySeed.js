const crypto = require('node:crypto');
const { getGroup, soleSpec } = require('./registry.js');
const { computeDiff, tableOf, gitOf, localByKeyOf } = require('./diffGroup.js');
const { beginLocked, mapLockError, rollback } = require('./txn.js');
const { schemaVersion, startRun, finishRun } = require('./runs.js');
const { SyncRefused } = require('./errors.js');

// Seeding writes game data from the git export into this DB. Rules that keep it
// safe: every red row needs an explicit decision, the diff is recomputed under
// the seed_sync lock (never trusted from an earlier preview), deletes of rows
// that other tables reference are refused (never cascaded), a git row never
// takes a natural key a kept local row holds, secret columns are never
// written, and everything happens in one transaction.

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

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// Every FK pointing at the group's table, with its column pairs in key order.
async function referencingFks(db, spec) {
  const { rows } = await db.query(
    `SELECT c.oid, c.conrelid::regclass::text AS ref_table,
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

// syncUuid -> "<n> rows in <table> reference this" (several tables joined by
// "; "), for the given local rows that are referenced at all.
async function referenceReasons(db, spec, uuids) {
  const out = new Map();
  if (!uuids.length) return out;
  const perUuid = new Map(); // uuid -> Map(table -> n)
  for (const fk of await referencingFks(db, spec)) {
    const on = fk.ref_cols.map((c, i) => `r.${quoteIdent(c)} = t.${quoteIdent(fk.target_cols[i])}`).join(' AND ');
    // ref_table is regclass output: already quoted/qualified as needed.
    const { rows } = await db.query(
      `SELECT t.sync_uuid::text AS uuid, count(*)::int AS n
         FROM ${quoteIdent(spec.table)} t JOIN ${fk.ref_table} r ON ${on}
        WHERE t.sync_uuid = ANY($1::uuid[])
        GROUP BY t.sync_uuid`,
      [uuids],
    );
    for (const r of rows) {
      if (!perUuid.has(r.uuid)) perUuid.set(r.uuid, new Map());
      const m = perUuid.get(r.uuid);
      m.set(fk.ref_table, (m.get(fk.ref_table) || 0) + r.n);
    }
  }
  for (const [uuid, m] of perUuid) {
    out.set(uuid, [...m].map(([table, n]) => `${n} rows in ${table} reference this`).join('; '));
  }
  return out;
}

const deletableUuids = (diff) => diff.rows.filter((r) => DELETABLE.has(r.kind)).map((r) => r.syncUuid);

// Sets blockedReason and the blocking-aware defaultDecision on every diff row,
// and returns each row's effective decision under `decisions` (rows left out
// take their default). Pure: validation happens in the caller.
//  - A referenced deletable row is blocked; a blocked deleted_in_git defaults
//    to 'local' (keep) instead of 'delete'.
//  - A new/deleted_here git row whose natural key is held by a local row that
//    this seed does NOT delete is blocked and red (defaultDecision null): an
//    explicit decision is required -- 'local' sets B = hG, so the next export
//    drops the other PC's row, which must be a deliberate choice. (Adopt
//    consumes the same-key local row, so a new/deleted_here row's key holder
//    is never adopted in the same seed.)
function annotate(cd, refReasons, decisions) {
  const { diff } = cd;
  const decisionOf = (r) => (own(decisions, r.syncUuid) ? decisions[r.syncUuid] : r.defaultDecision);
  for (const r of diff.rows) {
    if (!DELETABLE.has(r.kind) || !refReasons.has(r.syncUuid)) continue;
    r.blockedReason = refReasons.get(r.syncUuid);
    if (r.kind === 'deleted_in_git') r.defaultDecision = 'local';
  }
  const deleting = new Set(diff.rows
    .filter((r) => DELETABLE.has(r.kind) && decisionOf(r) === 'delete').map((r) => r.syncUuid));
  for (const r of diff.rows) {
    if (!INSERTABLE.has(r.kind)) continue;
    const holder = localByKeyOf(cd, r);
    if (holder && !deleting.has(holder.row.sync_uuid)) {
      r.blockedReason = KEY_CLASH_REASON;
      r.defaultDecision = null;
    }
  }
  return diff.rows.map((row) => ({ row, decision: decisionOf(row) }));
}

function warningsFor(fileVersion, dbVersion) {
  return fileVersion < dbVersion ? ['schema_older'] : [];
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
function previewSignatureOf(cd, refReasons) {
  // annotate() mutates rows; sign a copy so the caller's rows stay untouched.
  const copy = { ...cd, diff: { ...cd.diff, rows: cd.diff.rows.map((r) => ({ ...r })) } };
  annotate(copy, refReasons, {});
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
// blocking-aware defaults, and `warnings` (['schema_older'] when the file
// predates this DB's migrations). One read-only snapshot.
async function previewSeed(pool, groupId) {
  const spec = soleSpec(getGroup(groupId));
  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const cd = await computeDiff(client, groupId);
    const refReasons = await referenceReasons(client, spec, deletableUuids(cd.diff));
    const signature = previewSignatureOf(cd, refReasons);
    annotate(cd, refReasons, {});
    // schema_older (a string) first, then the diff's dangling_name objects.
    const schemaWarnings = cd.diff.header ? warningsFor(versionOf(cd.diff.header), await schemaVersion(client)) : [];
    const warnings = [...schemaWarnings, ...cd.diff.warnings];
    await client.query('COMMIT');
    return { ...cd.diff, warnings, signature };
  } catch (e) {
    releaseErr = await rollback(client);
    throw e;
  } finally {
    client.release(releaseErr);
  }
}

// Refusals before any write; returns [{ row, decision }] for every listed row.
function plan(cd, refReasons, decisions) {
  if (decisions === null || decisions === undefined) decisions = {};
  if (typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw new SyncRefused('invalid_decision', 'decisions must be an object keyed by sync_uuid', { uuids: [] });
  }
  const byUuid = new Map(cd.diff.rows.map((r) => [r.syncUuid, r]));
  const stale = Object.keys(decisions).filter((u) => !byUuid.has(u));
  if (stale.length) {
    throw new SyncRefused('stale_preview', 'the diff changed since the preview; preview again', { uuids: stale });
  }
  const invalid = Object.keys(decisions).filter((u) => !ALLOWED[byUuid.get(u).kind].includes(decisions[u]));
  if (invalid.length) {
    throw new SyncRefused('invalid_decision', 'decision not allowed for this row', { uuids: invalid });
  }
  const steps = annotate(cd, refReasons, decisions);
  const undecided = steps.filter((s) => s.decision === null).map((s) => s.row.syncUuid);
  if (undecided.length) {
    throw new SyncRefused('undecided', 'rows edited on this PC need a decision', { uuids: undecided });
  }
  const blocked = steps.filter((s) => s.decision === 'delete' && s.row.blockedReason);
  if (blocked.length) {
    throw new SyncRefused('blocked', 'rows referenced elsewhere cannot be deleted', {
      uuids: blocked.map((s) => s.row.syncUuid),
      reasons: Object.fromEntries(blocked.map((s) => [s.row.syncUuid, s.row.blockedReason])),
    });
  }
  const conflicts = steps.filter((s) => s.decision === 'git' && s.row.blockedReason === KEY_CLASH_REASON);
  if (conflicts.length) {
    throw new SyncRefused('conflict', `${KEY_CLASH_REASON}; keep it local or delete the local row`, {
      uuids: conflicts.map((s) => s.row.syncUuid),
    });
  }
  return steps;
}

// Live-column values of a canonical git row as query params.
function paramsFor(columns, gitRow) {
  return columns.map((c) => {
    const v = gitRow[c.name];
    if (v === null || v === undefined) return null;
    return c.dataType === 'json' || c.dataType === 'jsonb' ? JSON.stringify(v) : v;
  });
}

async function upsertFromGit(db, spec, columns, gitRow) {
  const names = columns.map((c) => quoteIdent(c.name));
  const vals = paramsFor(columns, gitRow);
  const ph = vals.map((_, i) => `$${i + 2}`).join(', ');
  const set = names.map((n) => `${n} = EXCLUDED.${n}`).join(', ');
  await db.query(
    `INSERT INTO ${quoteIdent(spec.table)} (sync_uuid, ${names.join(', ')}) VALUES ($1, ${ph})
     ON CONFLICT (sync_uuid) DO UPDATE SET ${set}`,
    [gitRow.sync_uuid, ...vals],
  );
}

// Take git's identity for the local row; with `columns`, git's values too.
async function adopt(db, spec, columns, gitRow, localUuid) {
  const vals = columns ? paramsFor(columns, gitRow) : [];
  const set = columns ? columns.map((c, i) => `, ${quoteIdent(c.name)} = $${i + 3}`).join('') : '';
  const res = await db.query(
    `UPDATE ${quoteIdent(spec.table)} SET sync_uuid = $1${set} WHERE sync_uuid = $2`,
    [gitRow.sync_uuid, localUuid, ...vals],
  );
  if (res.rowCount !== 1) throw new Error(`adopt_identity: local row ${localUuid} not found`);
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
  if (e && e.code === '23505') {
    const constraint = e.constraint || null;
    return new SyncRefused('conflict',
      `a git row would duplicate a unique value${constraint ? ` (${constraint})` : ''}; keep it local or fix the clash`,
      { constraint });
  }
  return e;
}

// decisions: { [syncUuid]: 'git' | 'local' | 'delete' }; rows left out use
// their (blocking-aware) defaultDecision. `signature` is the one previewSeed
// returned; required -- a missing or different one refuses stale_preview.
// Refusals (busy, no_export, schema_newer, stale_preview, invalid_decision,
// undecided, blocked, conflict) happen before a run is started, so they record
// no run -- like export's git_newer. A failure after that (including a write
// conflict, 23505 -> SyncRefused('conflict')) rolls everything back and
// finishes the run as failed; a committed seed always finishes ok.
async function applySeed(pool, groupId, decisions, { signature } = {}) {
  // Single-table groups only until plan 2 Task 5 (soleSpec throws otherwise).
  const spec = soleSpec(getGroup(groupId));
  const client = await pool.connect();
  let runId = null;
  let releaseErr;
  let result;
  try {
    await beginLocked(client);
    // No concurrent INSERT/UPDATE/DELETE on the group's table until COMMIT
    // (reads go on): the diff below stays true while we write, so an edit made
    // meanwhile on this PC can never be silently overwritten. (Not REPEATABLE
    // READ: its snapshot would be taken before the lock wait.)
    await client.query(`LOCK TABLE ${quoteIdent(spec.table)} IN SHARE ROW EXCLUSIVE MODE`);
    const cd = await computeDiff(client, groupId);
    const { diff } = cd;
    const { columns } = cd.tables.get(spec.table);
    if (!diff.header) throw new SyncRefused('no_export', `no export file for ${groupId}`);
    const fileVersion = versionOf(diff.header);
    const dbVersion = await schemaVersion(client);
    if (fileVersion > dbVersion) {
      throw new SyncRefused('schema_newer', 'run migrations first', { fileVersion, dbVersion });
    }
    // Lock every deletable row before counting its references: a new
    // referencing row (FK KEY SHARE) now waits for us, and the count sees
    // everything committed before it.
    const deletable = deletableUuids(diff);
    if (deletable.length) {
      await client.query(
        `SELECT 1 FROM ${quoteIdent(spec.table)} WHERE sync_uuid = ANY($1::uuid[]) FOR UPDATE`, [deletable]);
    }
    const refReasons = await referenceReasons(client, spec, deletable);
    if (typeof signature !== 'string' || signature !== previewSignatureOf(cd, refReasons)) {
      throw new SyncRefused('stale_preview', 'the diff changed since the preview; preview again', { uuids: [] });
    }
    const steps = plan(cd, refReasons, decisions);

    runId = await startRun(pool, groupId, 'seed');
    const summary = { updated: 0, created: 0, deleted: 0, kept: 0, adopted: 0 };
    const by = (decision, pred = () => true) => steps.filter((s) => s.decision === decision && pred(s.row));

    // Deletes, then adopts, then upserts: a git row may take the natural key
    // of a local row deleted in the same seed.
    const deletes = by('delete').map((s) => s.row.syncUuid);
    if (deletes.length) {
      const res = await client.query(
        `DELETE FROM ${quoteIdent(spec.table)} WHERE sync_uuid = ANY($1::uuid[])`, [deletes]);
      if (res.rowCount !== deletes.length) throw new Error(`delete: expected ${deletes.length} rows, got ${res.rowCount}`);
      await dropBaselines(client, groupId, deletes);
      summary.deleted = deletes.length;
    }
    const localOf = (row) => localByKeyOf(cd, row).row.sync_uuid;
    for (const { row } of by('git', (r) => r.kind === 'adopt_identity')) {
      await adopt(client, spec, columns, gitOf(cd, row).row, localOf(row));
      summary.adopted += 1;
    }
    for (const { row } of by('local', (r) => r.kind === 'adopt_identity')) {
      await adopt(client, spec, null, gitOf(cd, row).row, localOf(row)); // identity only, values stay
    }
    for (const { row } of by('git', (r) => r.kind !== 'adopt_identity')) {
      await upsertFromGit(client, spec, columns, gitOf(cd, row).row);
      if (UPDATE_KINDS.has(row.kind)) summary.updated += 1;
      else if (INSERTABLE.has(row.kind)) summary.created += 1;
      else throw new Error(`no git write for kind ${row.kind}`);
    }
    summary.kept = by('local').length;

    // Baselines. Written from git -> B = hG. A 'local' decision acknowledges
    // git's version so export is not stuck behind git_newer:
    // changed/edited_here/adopt_identity/new -> B = hG (next diff:
    // not_exported / deleted_here); deleted_in_git -> drop B (next: only_here);
    // deleted_here/not_exported/only_here -> untouched. Rows already identical
    // with no B -> B = hL (first sync).
    const ACK = new Set(['changed', 'edited_here', 'adopt_identity', 'new']);
    for (const { row } of [...by('git'), ...by('local', (r) => ACK.has(r.kind))]) {
      await setBaseline(client, groupId, row.syncUuid, gitOf(cd, row).hash);
    }
    await dropBaselines(client, groupId, by('local', (r) => r.kind === 'deleted_in_git').map((s) => s.row.syncUuid));
    for (const s of cd.inSync) if (!s.hasBaseline) await setBaseline(client, groupId, s.syncUuid, s.hash);

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

module.exports = { previewSeed, applySeed, ALLOWED, KEY_CLASH_REASON };
