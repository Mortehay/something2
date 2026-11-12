// Where a test that TRUNCATEs or bulk-deletes may write: only a throwaway test database.
// Same rule as scripts/testdb.js (which creates game_test / game_test_sync and sets BOTH
// DATABASE_URL and TEST_DATABASE_URL to it): TEST_DATABASE_URL must be set and its database
// name must contain "test". There is no fallback to DATABASE_URL or the shared dev database
// (localhost:15432/game_db). A TEST_DATABASE_URL that names a non-test database -- the same
// one DATABASE_URL points at in a hand-run, say -- is refused.
// -> { url } when safe, { skip: reason } otherwise (no connection is made).
const { databaseName } = require('../../scripts/testdb.js');

function privateTestDb(env = process.env) {
  const url = env.TEST_DATABASE_URL;
  if (!url) return { skip: 'no TEST_DATABASE_URL -- refusing to write to a real database (run via scripts/testdb.js)' };
  let name;
  try { name = databaseName(url); } catch { return { skip: 'TEST_DATABASE_URL is not a valid URL' }; }
  if (!/test/i.test(name)) {
    const same = env.DATABASE_URL && (() => { try { return databaseName(env.DATABASE_URL) === name; } catch { return false; } })();
    return { skip: `refusing TEST_DATABASE_URL database "${name}": a test database's name must contain "test"${same ? ' (it is the one DATABASE_URL points at)' : ''}` };
  }
  return { url };
}

module.exports = { privateTestDb };
