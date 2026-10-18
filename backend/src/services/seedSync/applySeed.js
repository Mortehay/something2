const { getGroup } = require('./registry.js');
const { computeDiff } = require('./diffGroup.js');
const { SEED_SYNC_LOCK_SQL } = require('./exportGroup.js');
const { schemaVersion, startRun, finishRun } = require('./runs.js');
const { SyncRefused } = require('./errors.js');

// Seeding writes game data from the git export into this DB. Rules that keep it
// safe: every red row needs an explicit decision, the diff is recomputed under
// the seed_sync lock (never trusted from an earlier preview), deletes of rows
// that other tables reference are refused (never cascaded), secret columns are
// never written, and everything happens in one transaction.

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
const UPDATE_KINDS = new Set(['changed', 'edited_here', 'not_exported']);
const CREATE_KINDS = new Set(['new', 'deleted_here']);

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Every FK pointing at the group's table, with its column pairs in key order.
async function referencingFks(db, group) {
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
    [quoteIdent(group.table)],
  );
  return rows;
}

// syncUuid -> "<n> rows in <table> reference this" (several tables joined by
// "; "), for the given local rows that are referenced at all.
async function blockedReasons(db, group, uuids) {
  const out = new Map();
  if (!uuids.length) return out;
  const perUuid = new Map(); // uuid -> Map(table -> n)
  for (const fk of await referencingFks(db, group)) {
    const on = fk.ref_cols.map((c, i) => `r.${quoteIdent(c)} = t.${quoteIdent(fk.target_cols[i])}`).join(' AND ');
    // ref_table is regclass output: already quoted/qualified as needed.
    const { rows } = await db.query(
      `SELECT t.sync_uuid::text AS uuid, count(*)::int AS n
         FROM ${quoteIdent(group.table)} t JOIN ${fk.ref_table} r ON ${on}
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

// diffGroup plus blockedReason on every row that could be deleted. One
// read-only snapshot for the diff and the reference counts.
async function previewSeed(pool, groupId) {
  const group = getGroup(groupId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { diff } = await computeDiff(client, groupId);
    const reasons = await blockedReasons(client, group,
      diff.rows.filter((r) => DELETABLE.has(r.kind)).map((r) => r.syncUuid));
    for (const r of diff.rows) if (reasons.has(r.syncUuid)) r.blockedReason = reasons.get(r.syncUuid);
    await client.query('COMMIT');
    return diff;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Validate the caller's decisions against the freshly computed diff and return
// [{ row, decision }] for every listed row.
function resolveDecisions(diff, decisions) {
  if (decisions === null || decisions === undefined) decisions = {};
  if (typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw new SyncRefused('invalid_decision', 'decisions must be an object keyed by sync_uuid', { uuids: [] });
  }
  const own = (k) => Object.prototype.hasOwnProperty.call(decisions, k);
  const byUuid = new Map(diff.rows.map((r) => [r.syncUuid, r]));
  const stale = Object.keys(decisions).filter((u) => !byUuid.has(u));
  if (stale.length) {
    throw new SyncRefused('stale_preview', 'the diff changed since the preview; preview again', { uuids: stale });
  }
  const invalid = Object.keys(decisions).filter((u) => !ALLOWED[byUuid.get(u).kind].includes(decisions[u]));
  if (invalid.length) {
    throw new SyncRefused('invalid_decision', 'decision not allowed for this row', { uuids: invalid });
  }
  const undecided = diff.rows.filter((r) => r.defaultDecision === null && !own(r.syncUuid)).map((r) => r.syncUuid);
  if (undecided.length) {
    throw new SyncRefused('undecided', 'rows edited on this PC need a decision', { uuids: undecided });
  }
  return diff.rows.map((row) => ({ row, decision: own(row.syncUuid) ? decisions[row.syncUuid] : row.defaultDecision }));
}

// Live-column values of a canonical git row as query params.
function paramsFor(columns, gitRow) {
  return columns.map((c) => {
    const v = gitRow[c.name];
    if (v === null || v === undefined) return null;
    return c.dataType === 'json' || c.dataType === 'jsonb' ? JSON.stringify(v) : v;
  });
}

async function upsertFromGit(db, group, columns, gitRow) {
  const names = columns.map((c) => quoteIdent(c.name));
  const vals = paramsFor(columns, gitRow);
  const ph = vals.map((_, i) => `$${i + 2}`).join(', ');
  const set = names.map((n) => `${n} = EXCLUDED.${n}`).join(', ');
  await db.query(
    `INSERT INTO ${quoteIdent(group.table)} (sync_uuid, ${names.join(', ')}) VALUES ($1, ${ph})
     ON CONFLICT (sync_uuid) DO UPDATE SET ${set}`,
    [gitRow.sync_uuid, ...vals],
  );
}

async function adoptFromGit(db, group, columns, gitRow, localUuid) {
  const vals = paramsFor(columns, gitRow);
  const set = columns.map((c, i) => `${quoteIdent(c.name)} = $${i + 3}`).join(', ');
  const res = await db.query(
    `UPDATE ${quoteIdent(group.table)} SET sync_uuid = $1, ${set} WHERE sync_uuid = $2`,
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

// decisions: { [syncUuid]: 'git' | 'local' | 'delete' }; rows left out use
// their defaultDecision. Refusals (no_export, schema_newer, stale_preview,
// invalid_decision, undecided, blocked) happen before a run is started, so
// they record no run -- like export's git_newer. Failures after that roll the
// whole transaction back and finish the run as failed.
async function applySeed(pool, groupId, decisions) {
  const group = getGroup(groupId);
  const client = await pool.connect();
  let runId = null;
  try {
    await client.query('BEGIN');
    await client.query(SEED_SYNC_LOCK_SQL);
    // No concurrent INSERT/UPDATE/DELETE on the group's table until COMMIT
    // (reads go on): the diff below stays true while we write, so an edit made
    // meanwhile on this PC can never be silently overwritten.
    await client.query(`LOCK TABLE ${quoteIdent(group.table)} IN SHARE ROW EXCLUSIVE MODE`);
    const cd = await computeDiff(client, groupId);
    const { diff, columns } = cd;
    if (!diff.header) throw new SyncRefused('no_export', `no export file for ${groupId}`);
    const fileVersion = diff.header.schema_version == null ? '' : String(diff.header.schema_version);
    const dbVersion = await schemaVersion(client);
    if (fileVersion > dbVersion) {
      throw new SyncRefused('schema_newer', 'run migrations first', { fileVersion, dbVersion });
    }
    const plan = resolveDecisions(diff, decisions);

    const deletes = plan.filter((p) => p.decision === 'delete').map((p) => p.row.syncUuid);
    if (deletes.length) {
      // Row locks first: a new referencing row (FK KEY SHARE) now waits for
      // us, and the count below sees everything committed before it.
      await client.query(
        `SELECT 1 FROM ${quoteIdent(group.table)} WHERE sync_uuid = ANY($1::uuid[]) FOR UPDATE`, [deletes]);
      const reasons = await blockedReasons(client, group, deletes);
      if (reasons.size) {
        throw new SyncRefused('blocked', 'rows referenced elsewhere cannot be deleted', {
          uuids: deletes.filter((u) => reasons.has(u)),
          reasons: Object.fromEntries(reasons),
        });
      }
    }

    runId = await startRun(pool, groupId, 'seed');
    const summary = { updated: 0, created: 0, deleted: 0, kept: 0, adopted: 0 };

    // Deletes, then adopts, then upserts: a git row may take the natural key
    // of a local row deleted in the same seed.
    if (deletes.length) {
      const res = await client.query(
        `DELETE FROM ${quoteIdent(group.table)} WHERE sync_uuid = ANY($1::uuid[])`, [deletes]);
      if (res.rowCount !== deletes.length) throw new Error(`delete: expected ${deletes.length} rows, got ${res.rowCount}`);
      await client.query(
        'DELETE FROM seed_row_hashes WHERE group_id = $1 AND sync_uuid = ANY($2::uuid[])', [groupId, deletes]);
      summary.deleted = deletes.length;
    }
    const fromGit = plan.filter((p) => p.decision === 'git');
    for (const { row } of fromGit.filter((p) => p.row.kind === 'adopt_identity')) {
      const g = cd.git.get(row.syncUuid);
      const local = cd.localByKey.get(g.row[group.naturalKey]);
      await adoptFromGit(client, group, columns, g.row, local.row.sync_uuid);
      summary.adopted += 1;
    }
    for (const { row } of fromGit.filter((p) => p.row.kind !== 'adopt_identity')) {
      await upsertFromGit(client, group, columns, cd.git.get(row.syncUuid).row);
      if (UPDATE_KINDS.has(row.kind)) summary.updated += 1;
      else if (CREATE_KINDS.has(row.kind)) summary.created += 1;
      else throw new Error(`no git write for kind ${row.kind}`);
    }
    summary.kept = plan.filter((p) => p.decision === 'local').length;

    // Baselines: written rows -> B = hG; local rows keep theirs; rows already
    // identical with no B yet -> B = hL (first sync).
    for (const { row } of fromGit) await setBaseline(client, groupId, row.syncUuid, cd.git.get(row.syncUuid).hash);
    for (const s of cd.inSync) if (!s.hasBaseline) await setBaseline(client, groupId, s.syncUuid, s.hash);

    await client.query('COMMIT');
    await finishRun(pool, runId, { status: 'ok', summary });
    return { runId, summary };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (runId !== null) await finishRun(pool, runId, { status: 'failed', error: e.message }).catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { previewSeed, applySeed, ALLOWED };
