const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { EXCLUDED, PENDING, groupTables, sliceProblems, coverageProblems } = require('../src/services/seedSync/coverage.js');
const { GROUPS, tableSpecs } = require('../src/services/seedSync/registry.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function baseTables(pool) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`);
  return rows.map((r) => r.table_name);
}

test('PENDING values name a known plan; plan 3 is no longer pending', () => {
  for (const [t, p] of Object.entries(PENDING)) {
    assert.ok(/^plan 4 \(/.test(p), `${t}: ${p}`);
  }
  assert.strictEqual(EXCLUDED.sprite_sets,
    'machine-local sprite job queue; approved atlases travel in the sprite columns (art group)');
  assert.strictEqual(EXCLUDED.seed_asset_hashes, 'seed sync per-PC asset hash cache');
});

const ART = 'art group (plan 3)';

// A full spec that omits a column as art, with NO slice of its table anywhere,
// is a forgotten slice: the column would travel in no group at all.
test('sliceProblems: an art-omitted column of a table with no slice is reported', () => {
  const specs = [
    { table: 'a', naturalKey: ['name'], omit: { id: 'local', x: ART } },
    { table: 'b', naturalKey: ['name'], omit: { id: 'local', q: ART, r: ART, z: 'per-PC' } },
    { table: 'b', slice: true, columns: ['q'], naturalKey: ['name'] },
  ];
  assert.deepStrictEqual(sliceProblems(specs), [
    'column a.x is omitted as art but in no slice',
    'column b.r is omitted as art but in no slice',
  ]);
  assert.deepStrictEqual(coverageProblems(['a', 'b'], { specs, excluded: {}, pending: {} }), sliceProblems(specs));
});

// The plan's claim: the real slices cover the plan-2 ART omits exactly.
test('registered slices cover every art-omitted column exactly once', () => {
  const specs = GROUPS.flatMap((g) => tableSpecs(g));
  assert.deepStrictEqual(sliceProblems(specs), []);
  const artOmits = specs.filter((s) => !s.slice)
    .flatMap((s) => Object.entries(s.omit || {}).filter(([, why]) => why === ART).map(([c]) => `${s.table}.${c}`)).sort();
  const sliced = specs.filter((s) => s.slice).flatMap((s) => s.columns.map((c) => `${s.table}.${c}`)).sort();
  assert.deepStrictEqual(sliced, artOmits);
  assert.ok(artOmits.length >= 10, artOmits.join(' '));
  // Without the art group's slices the same specs are flagged.
  const noSlices = specs.filter((s) => !s.slice);
  assert.strictEqual(sliceProblems(noSlices).length, artOmits.length);
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
