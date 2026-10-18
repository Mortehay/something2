const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { GROUPS, getGroup, tableSpecs, soleSpec, liveColumns, fkProblems, nameRefProblems, _withTestGroups } = require('../src/services/seedSync/registry.js');
const { deterministicUuid } = require('../src/services/seedSync/canonical.js');
const { withSeedSyncLock, cleanupSx } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync fixtures)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      try { await body(t, pool); } finally { await cleanupSx(pool).catch(() => {}); }
    });
  });
}

test('getGroup throws on unknown id and GROUPS is in seed order', () => {
  assert.deepStrictEqual(GROUPS.map((g) => g.id), ['tile_types', 'quests', 'ai_providers']);
  assert.throws(() => getGroup('nope'), /unknown group/);
});

test('every group is an ordered list of TableSpecs', () => {
  for (const g of GROUPS) {
    assert.ok(Array.isArray(g.tables) && g.tables.length > 0, `${g.id}: tables`);
    assert.strictEqual(tableSpecs(g), g.tables);
    for (const s of tableSpecs(g)) {
      assert.strictEqual(typeof s.table, 'string');
      assert.ok(Array.isArray(s.naturalKey) && s.naturalKey.length > 0, `${s.table}: naturalKey is a non-empty array`);
      assert.ok(s.omit && typeof s.omit === 'object', `${s.table}: omit`);
      for (const [c, why] of Object.entries(s.omit)) assert.ok(typeof why === 'string' && why, `${s.table}.${c}: omit reason`);
      assert.ok(Array.isArray(s.secretColumns), `${s.table}: secretColumns`);
      assert.ok(s.refs && typeof s.refs === 'object', `${s.table}: refs`);
      for (const [c, r] of Object.entries(s.refs)) {
        assert.ok(r.by === 'uuid' || (r.by === 'key' && typeof r.keyCol === 'string'), `${s.table}.${c}: ref shape`);
      }
    }
  }
  // Plan-1 groups stay single-table until Task 6 adds the multi-table ones.
  for (const id of ['tile_types', 'quests', 'ai_providers']) {
    assert.deepStrictEqual(tableSpecs(getGroup(id)).map((s) => s.table), [id]);
  }
});

test('soleSpec refuses a multi-table group with a clear error', () => {
  assert.strictEqual(soleSpec(getGroup('quests')), getGroup('quests').tables[0]);
  const two = { id: 'sx_two', tables: [getGroup('quests').tables[0], getGroup('tile_types').tables[0]] };
  assert.throws(() => soleSpec(two), /sx_two.*2 tables.*single-table/);
});

dbTest('every live column is exported or explicitly omitted, with no stale omit keys', async (t, pool) => {
  for (const g of GROUPS) {
    for (const s of tableSpecs(g)) {
      const all = (await pool.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [s.table],
      )).rows.map((r) => r.column_name);
      assert.ok(all.length > 0, `${s.table} has columns`);
      const live = (await liveColumns(pool, s)).map((c) => c.name);
      const omit = Object.keys(s.omit);
      const secret = s.secretColumns;
      for (const c of [...omit, ...secret]) assert.ok(all.includes(c), `${s.table}: stale omit/secret key ${c}`);
      for (const c of Object.keys(s.refs)) assert.ok(live.includes(c), `${s.table}: ref ${c} is not a live column`);
      const union = [...live, ...omit, ...secret];
      assert.strictEqual(new Set(union).size, union.length, `${s.table}: a column is listed twice`);
      assert.deepStrictEqual([...union].sort(), [...all].sort(), `${s.table}: columns drifted`);
    }
  }
});

// A FK column holds a local numeric id that means nothing on another PC (or
// worse, points at a different row). It must either be declared a ref (export
// translates it) or omitted with a reason -- never exported raw.
dbTest('every FK column is a declared ref or omitted, and a declared ref matches the real FK target', async (t, pool) => {
  for (const g of GROUPS) {
    for (const s of tableSpecs(g)) {
      assert.deepStrictEqual(await fkProblems(pool, s), [], `${s.table}: FK coverage`);
      assert.deepStrictEqual(await nameRefProblems(pool, s), [], `${s.table}: nameRefs`);
    }
  }
});

dbTest('nameRefProblems flags a bad shape, a missing column/target and an omitted column', async (t, pool) => {
  const spec = (nameRefs, omit = {}) => ({ table: 'entity_types', naturalKey: ['name'], omit, secretColumns: [], refs: {}, nameRefs });
  const aura = { table: 'aura_effects', keyCol: 'name' };
  assert.deepStrictEqual(await nameRefProblems(pool, spec({
    auras: { ...aura, shape: 'array' }, vfx: { ...aura, shape: 'object-values' }, name: { ...aura, shape: 'text' },
  })), []);
  assert.deepStrictEqual(await nameRefProblems(pool, spec({ auras: { ...aura, shape: 'list' } })),
    [{ column: 'auras', target: 'aura_effects.name', problem: 'bad_shape', shape: 'list' }]);
  assert.deepStrictEqual(await nameRefProblems(pool, spec({ sx_nope: { ...aura, shape: 'text' } })),
    [{ column: 'sx_nope', target: 'aura_effects.name', problem: 'not_a_column' }]);
  assert.deepStrictEqual(await nameRefProblems(pool, spec({ auras: { table: 'aura_effects', keyCol: 'sx_nope', shape: 'array' } })),
    [{ column: 'auras', target: 'aura_effects.sx_nope', problem: 'missing_target' }]);
  assert.deepStrictEqual(await nameRefProblems(pool, spec({ auras: { table: 'sx_no_table', keyCol: 'name', shape: 'array' } })),
    [{ column: 'auras', target: 'sx_no_table.name', problem: 'missing_target' }]);
  assert.deepStrictEqual(await nameRefProblems(pool, spec({ auras: { ...aura, shape: 'array' } }, { auras: 'test' })),
    [{ column: 'auras', target: 'aura_effects.name', problem: 'not_exported' }]);
});

// The guard must be able to fail: tile_types.ai_provider_id is a real FK.
dbTest('fkProblems flags an uncovered FK column, a wrong ref target and a ref on a non-FK column', async (t, pool) => {
  const tt = getGroup('tile_types').tables[0];
  const { ai_provider_id: _dropped, ...omitRest } = tt.omit;
  assert.deepStrictEqual(await fkProblems(pool, { ...tt, omit: omitRest }),
    [{ column: 'ai_provider_id', problem: 'uncovered', target: 'ai_providers' }]);
  assert.deepStrictEqual(
    await fkProblems(pool, { ...tt, omit: omitRest, refs: { ai_provider_id: { table: 'quests', by: 'uuid' } } }),
    [{ column: 'ai_provider_id', problem: 'wrong_target', target: 'ai_providers', declared: 'quests' }]);
  assert.deepStrictEqual(
    await fkProblems(pool, { ...tt, omit: omitRest, refs: { ai_provider_id: { table: 'ai_providers', by: 'uuid' } } }), []);
  assert.deepStrictEqual(
    await fkProblems(pool, { ...tt, refs: { name: { table: 'ai_providers', by: 'uuid' } } }),
    [{ column: 'name', problem: 'not_a_fk', target: null, declared: 'ai_providers' }]);
});

// Composite / multi-target: passive_edges has two FK columns (a_id, b_id) into
// the same table, and a composite primary key over both.
dbTest('fkProblems covers each column of a two-column FK pair separately', async (t, pool) => {
  const edges = { table: 'passive_edges', naturalKey: ['a_id', 'b_id'], omit: { sync_uuid: 'identity' }, secretColumns: [], refs: {} };
  assert.deepStrictEqual(await fkProblems(pool, edges), [
    { column: 'a_id', problem: 'uncovered', target: 'passive_nodes' },
    { column: 'b_id', problem: 'uncovered', target: 'passive_nodes' },
  ]);
  const a = { a_id: { table: 'passive_nodes', by: 'uuid' } };
  assert.deepStrictEqual(await fkProblems(pool, { ...edges, refs: a }),
    [{ column: 'b_id', problem: 'uncovered', target: 'passive_nodes' }], 'covering a_id does not cover b_id');
  assert.deepStrictEqual(
    await fkProblems(pool, { ...edges, refs: { ...a, b_id: { table: 'passive_edges', by: 'uuid' } } }),
    [{ column: 'b_id', problem: 'wrong_target', target: 'passive_nodes', declared: 'passive_edges' }]);
  assert.deepStrictEqual(
    await fkProblems(pool, { ...edges, refs: { ...a, b_id: { table: 'passive_nodes', by: 'uuid' } } }), []);
});

test('soleSpec refuses a spec with refs: single-table paths never compare raw local ids', () => {
  const q = getGroup('quests').tables[0];
  const withRef = { id: 'sx_ref', tables: [{ ...q, refs: { x: { table: 'quests', by: 'uuid' } } }] };
  assert.throws(() => soleSpec(withRef), /sx_ref.*quests.*refs/);
});

test('_withTestGroups registers groups for the callback only', async () => {
  const before = GROUPS.map((g) => g.id);
  const g = { id: 'sx_tmp', label: 'Tmp', tables: [getGroup('quests').tables[0]] };
  const seen = await _withTestGroups([g], async () => getGroup('sx_tmp'));
  assert.strictEqual(seen, g);
  assert.deepStrictEqual(GROUPS.map((x) => x.id), before);
  assert.throws(() => getGroup('sx_tmp'), /unknown group/);
  await assert.rejects(_withTestGroups([g], async () => { throw new Error('sx boom'); }), /sx boom/);
  assert.deepStrictEqual(GROUPS.map((x) => x.id), before, 'removed after a throw too');
  await assert.rejects(_withTestGroups([{ ...g, id: 'quests' }], async () => {}), /already/);
});

// Frozen Plan-1 omit/secret lists: the refactor must export exactly what
// Plan 1 exported (R1: tile_types.ai_provider_id stays omitted until Task 6).
const PLAN1 = {
  tile_types: { omit: ['id', 'created_at', 'updated_at', 'image', 'render_mode', 'sprite', 'sync_uuid', 'ai_provider_id'], secret: [] },
  quests: { omit: ['id', 'created_at', 'sync_uuid'], secret: [] },
  ai_providers: {
    omit: ['id', 'created_at', 'updated_at', 'sync_uuid', 'models_cache', 'models_fetched_at', 'is_active'],
    secret: ['auth_token'],
  },
};
dbTest('plan-1 groups unchanged: liveColumns identical to Plan 1', async (t, pool) => {
  for (const [id, p] of Object.entries(PLAN1)) {
    const { rows } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1`, [id]);
    const skip = new Set([...p.omit, ...p.secret]);
    const expected = rows.filter((r) => !skip.has(r.column_name))
      .map((r) => ({ name: r.column_name, dataType: r.data_type }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    assert.ok(expected.length > 0, id);
    assert.deepStrictEqual(await liveColumns(pool, soleSpec(getGroup(id))), expected, id);
  }
  assert.strictEqual(soleSpec(getGroup('ai_providers')).secretNeededIf, 'auth_header_name');
  assert.deepStrictEqual(soleSpec(getGroup('tile_types')).naturalKey, ['name']);
  assert.deepStrictEqual(soleSpec(getGroup('quests')).naturalKey, ['key']);
  assert.deepStrictEqual(soleSpec(getGroup('ai_providers')).naturalKey, ['name']);
});

dbTest('liveColumns is sorted and carries information_schema data_type', async (t, pool) => {
  const cols = await liveColumns(pool, soleSpec(getGroup('tile_types')));
  const names = cols.map((c) => c.name);
  assert.deepStrictEqual(names, [...names].sort());
  assert.strictEqual(cols.find((c) => c.name === 'valid_neighbors').dataType, 'jsonb');
  assert.strictEqual(cols.find((c) => c.name === 'speed').dataType, 'real');
});

dbTest('ai_providers liveColumns never includes auth_token', async (t, pool) => {
  const names = (await liveColumns(pool, soleSpec(getGroup('ai_providers')))).map((c) => c.name);
  assert.ok(!names.includes('auth_token'));
  assert.ok(names.includes('base_url'));
});

// Per-PC choices and art travel separately (final review rulings).
dbTest('per-PC and art columns are omitted, with their reason', async (t, pool) => {
  const ai = soleSpec(getGroup('ai_providers'));
  assert.ok(!(await liveColumns(pool, ai)).some((c) => c.name === 'is_active'));
  assert.strictEqual(ai.omit.is_active, 'per-PC choice: which box this PC can reach');
  const tt = soleSpec(getGroup('tile_types'));
  const ttNames = (await liveColumns(pool, tt)).map((c) => c.name);
  for (const c of ['render_mode', 'sprite']) {
    assert.ok(!ttNames.includes(c), c);
    assert.strictEqual(tt.omit[c], 'art group (plan 3)');
  }
});

dbTest('deterministicUuid matches the SQL backfill formula', async (t, pool) => {
  const sql = (await pool.query("SELECT md5('s2sync:'||'quests'||':'||$1::text)::uuid::text AS u", ['sx_q1'])).rows[0].u;
  assert.strictEqual(deterministicUuid('quests', 'sx_q1'), sql);
});

// 'grass' is seeded by 1714440002000_create_tile_types.js, long before the
// sync_uuid migration, so its uuid can only come from the backfill.
dbTest('migration backfilled pre-existing rows', async (t, pool) => {
  const { rows } = await pool.query("SELECT sync_uuid FROM tile_types WHERE name = 'grass'");
  if (!rows.length) { t.skip("tile 'grass' (seeded by the create_tile_types migration) is absent on this DB"); return; }
  assert.strictEqual(rows[0].sync_uuid, deterministicUuid('tile_types', 'grass'));
});
