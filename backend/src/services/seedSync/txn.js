const { SyncRefused } = require('./errors.js');

// Export and seed (any group) share one transaction-scoped advisory lock: both
// hold it for their whole check-then-write, so neither acts on a diff the
// other has invalidated.
const SEED_SYNC_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('seed_sync'))";

function lockTimeoutMs() {
  const n = Number(process.env.SEED_SYNC_LOCK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30000;
}

// BEGIN, bound every lock wait of this transaction, take the seed_sync lock.
async function beginLocked(client) {
  await client.query('BEGIN');
  await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs()}ms'`);
  await client.query(SEED_SYNC_LOCK_SQL);
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Tables an export (or a diff that must be self-consistent) holds still: the
// group's own tables and every target of a by-uuid ref (by-key targets are
// migration-seeded lookups with no admin write route). Sorted, so concurrent
// lockers take them in one order.
function exportLockTables(specs) {
  const out = new Set();
  for (const s of specs) {
    out.add(s.table);
    for (const ref of Object.values(s.refs || {})) if (ref.by === 'uuid') out.add(ref.table);
  }
  return [...out].sort();
}

// LOCK TABLE <exportLockTables> IN SHARE MODE: blocks writers until COMMIT and
// waits for open ones; readers go on. Bounded by the transaction's lock_timeout.
async function lockShare(client, specs) {
  await client.query(`LOCK TABLE ${exportLockTables(specs).map(quoteIdent).join(', ')} IN SHARE MODE`);
}

// Apply's table locks: the export lock set (same sorted order, so concurrent
// lockers never take them in opposite orders), the group's own tables IN SHARE
// ROW EXCLUSIVE MODE (no concurrent writer until COMMIT, and no second
// seed/export SRE/SHARE holder could slip a write in either), every by-uuid ref
// target outside the group IN SHARE MODE (its rows -- and so the ref maps --
// stay put while we resolve and write). [[table, mode]].
function applyLockPlan(specs) {
  const mine = new Set(specs.map((s) => s.table));
  return exportLockTables(specs).map((t) => [t, mine.has(t) ? 'SHARE ROW EXCLUSIVE' : 'SHARE']);
}

// One LOCK TABLE per table, in applyLockPlan order (one statement takes one
// mode, and a mixed order would break the shared sort).
async function lockForApply(client, specs) {
  for (const [table, mode] of applyLockPlan(specs)) {
    await client.query(`LOCK TABLE ${quoteIdent(table)} IN ${mode} MODE`);
  }
}

// lock_timeout expired (55P03), or this transaction lost a deadlock against an
// open admin edit (40P01) -> a refusal the route can show, not a 500.
function mapLockError(e) {
  if (e && (e.code === '55P03' || e.code === '40P01')) {
    return new SyncRefused('busy', 'another seed/export or an open edit of this table is in progress — try again', { pgCode: e.code });
  }
  return e;
}

// ROLLBACK; returns the rollback's own error (pass it to client.release so a
// broken connection is destroyed instead of going back to the pool).
async function rollback(client) {
  try {
    await client.query('ROLLBACK');
    return undefined;
  } catch (re) {
    return re;
  }
}

module.exports = {
  SEED_SYNC_LOCK_SQL, lockTimeoutMs, beginLocked, mapLockError, rollback, exportLockTables, lockShare, applyLockPlan, lockForApply,
};
