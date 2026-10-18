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

// lock_timeout expired (55P03) -> a refusal the route can show, not a 500.
function mapLockError(e) {
  if (e && e.code === '55P03') {
    return new SyncRefused('busy', 'another seed/export is running', { pgCode: e.code });
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

module.exports = { SEED_SYNC_LOCK_SQL, lockTimeoutMs, beginLocked, mapLockError, rollback };
