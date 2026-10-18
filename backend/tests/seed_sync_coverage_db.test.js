const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { EXCLUDED, PENDING, groupTables, coverageProblems } = require('../src/services/seedSync/coverage.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function baseTables(pool) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`);
  return rows.map((r) => r.table_name);
}

test('PENDING values name a known plan', () => {
  for (const [t, p] of Object.entries(PENDING)) {
    assert.ok(/^plan [34] \(/.test(p), `${t}: ${p}`);
  }
});

test('the checker flags unclassified, duplicate and stale entries (injected lists)', () => {
  const base = { groupTables: ['a'], excluded: { b: 'why' }, pending: { c: 'plan 4 (maps)' } };
  assert.deepStrictEqual(coverageProblems(['a', 'b', 'c'], base), []);
  assert.deepStrictEqual(coverageProblems(['a', 'b', 'c', 'sx_cov_probe'], base), ['unclassified table: sx_cov_probe']);
  assert.match(coverageProblems(['a', 'b'], base)[0], /does not exist: c/);
  assert.match(coverageProblems(['a', 'b', 'c'], { ...base, pending: { a: 'plan 4 (maps)', c: 'x' } })[0], /several lists: group, PENDING/);
  assert.match(coverageProblems(['a', 'b', 'c'], { ...base, excluded: { b: '' } })[0], /no reason/);
});

test('every public table is in a group, excluded with a reason, or pending a named plan', async (t) => {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = 'TEST_DATABASE_URL not set -- skipping (reads schema of a real database)';
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const pool = new Pool({ connectionString: DB_URL, max: 1, connectionTimeoutMillis: 3000 });
  t.after(async () => { await pool.end().catch(() => {}); });
  const tables = await baseTables(pool);
  assert.ok(tables.length > 20 && groupTables().length > 0);
  assert.deepStrictEqual(coverageProblems(tables), []);
});

test('a real unclassified table is detected (probe table rolled back)', async (t) => {
  if (!process.env.TEST_DATABASE_URL) { t.skip('TEST_DATABASE_URL not set'); return; }
  const pool = new Pool({ connectionString: DB_URL, max: 1, connectionTimeoutMillis: 3000 });
  t.after(async () => { await pool.end().catch(() => {}); });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE sx_cov_probe (id int)');
    const tables = await baseTables(client);
    assert.deepStrictEqual(coverageProblems(tables), ['unclassified table: sx_cov_probe']);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  assert.ok(!(await baseTables(pool)).includes('sx_cov_probe'));
});

test('EXCLUDED and PENDING are disjoint', () => {
  for (const k of Object.keys(PENDING)) assert.ok(!(k in EXCLUDED), k);
});
