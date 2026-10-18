const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { GROUPS, getGroup, tableSpecs, soleSpec, liveColumns, fkProblems, nameRefProblems, _withTestGroups } = require('../src/services/seedSync/registry.js');
const { deterministicUuid } = require('../src/services/seedSync/canonical.js');
const { renameCascadesFor } = require('../src/services/seedSync/applySeed.js');
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
  assert.deepStrictEqual(GROUPS.map((g) => g.id), [
    'tile_types', 'items', 'attack_effects', 'aura_effects', 'creature_behaviors', 'entities',
    'biomes', 'skill_tree', 'progression', 'quests', 'ai_providers',
  ]);
  assert.throws(() => getGroup('nope'), /unknown group/);
});

// Global constraints: each group's tables, in the order the group writes them.
test('plan-2 groups write exactly their tables, in order', () => {
  const expected = {
    items: ['item_types', 'affix_types'],
    attack_effects: ['vfx_effects', 'creature_skills'],
    aura_effects: ['aura_effects'],
    creature_behaviors: ['creature_behaviors', 'creature_abilities', 'creature_behavior_skills', 'behavior_drops', 'chest_loot'],
    entities: ['entity_types', 'creature_drops', 'class_loadouts'],
    biomes: ['biomes'],
    skill_tree: ['passive_nodes', 'passive_edges'],
    progression: ['game_settings'],
  };
  for (const [id, tables] of Object.entries(expected)) {
    assert.deepStrictEqual(tableSpecs(getGroup(id)).map((s) => s.table), tables, id);
  }
  const all = GROUPS.flatMap((g) => tableSpecs(g).map((s) => s.table));
  assert.strictEqual(new Set(all).size, all.length, 'a table belongs to one group only');
  for (const lookup of ['elements', 'attack_origins', 'impact_behaviors', 'projectile_shapes', 'world_point_kinds', 'merchant_stock']) {
    assert.ok(!all.includes(lookup), `${lookup} is never exported`);
  }
});

const specOf = (table) => GROUPS.flatMap((g) => tableSpecs(g)).find((s) => s.table === table);

test('plan-2 fixed decisions (brief) are registered as decided', () => {
  const et = specOf('entity_types');
  for (const c of ['image', 'sprite', 'render_mode', 'display_width', 'display_height', 'prompt']) {
    assert.strictEqual(et.omit[c], 'art group (plan 3)', `entity_types.${c}`);
  }
  assert.strictEqual(et.omit.ai_provider_mode, 'per-PC');
  assert.deepStrictEqual(et.refs, {
    behavior_id: { table: 'creature_behaviors', by: 'uuid' },
    ai_provider_id: { table: 'ai_providers', by: 'uuid' },
    element: { table: 'elements', by: 'key', keyCol: 'name' },
    point_kind: { table: 'world_point_kinds', by: 'key', keyCol: 'kind' },
  });
  assert.deepStrictEqual(et.nameRefs, {
    auras: { table: 'aura_effects', keyCol: 'name', shape: 'array' },
    vfx: { table: 'vfx_effects', keyCol: 'name', shape: 'object-values' },
    spawn_tiles: { table: 'tile_types', keyCol: 'name', shape: 'array' },
  });
  const it = specOf('item_types');
  assert.strictEqual(it.omit.icon, 'art group (plan 3)');
  assert.deepStrictEqual(it.refs, {
    ammo_type_id: { table: 'item_types', by: 'uuid' },
    attack_origin: { table: 'attack_origins', by: 'key', keyCol: 'name' },
    element: { table: 'elements', by: 'key', keyCol: 'name' },
    impact_behavior_id: { table: 'impact_behaviors', by: 'key', keyCol: 'name' },
    projectile_shape_id: { table: 'projectile_shapes', by: 'key', keyCol: 'name' },
  });
  assert.deepStrictEqual(it.nameRefs, { vfx: { table: 'vfx_effects', keyCol: 'name', shape: 'object-values' } });
  assert.deepStrictEqual(specOf('biomes').nameRefs, {
    terrain_tiles: { table: 'tile_types', keyCol: 'name', shape: 'array' },
    path_tile: { table: 'tile_types', keyCol: 'name', shape: 'text' },
    creature_types: { table: 'entity_types', keyCol: 'name', shape: 'array' },
    flora_types: { table: 'entity_types', keyCol: 'name', shape: 'array' },
  });
  assert.deepStrictEqual(specOf('creature_skills').nameRefs, {
    summon_entity: { table: 'entity_types', keyCol: 'name', shape: 'text' },
    vfx: { table: 'vfx_effects', keyCol: 'name', shape: 'object-values' },
  });
  // passive_nodes: every column travels (only the local id and identity are not data).
  assert.deepStrictEqual(Object.keys(specOf('passive_nodes').omit).sort(), ['id', 'sync_uuid']);
  const pe = specOf('passive_edges');
  assert.deepStrictEqual(pe.naturalKey, ['a_id', 'b_id']);
  assert.deepStrictEqual(pe.refs, { a_id: { table: 'passive_nodes', by: 'uuid' }, b_id: { table: 'passive_nodes', by: 'uuid' } });
  const gs = specOf('game_settings');
  assert.deepStrictEqual(gs.naturalKey, ['key']);
  assert.deepStrictEqual(Object.keys(gs.omit).sort(), ['sync_uuid', 'updated_at']);
  assert.strictEqual(gs.validate, 'game_settings');
  assert.deepStrictEqual(specOf('tile_types').refs, { ai_provider_id: { table: 'ai_providers', by: 'uuid' } });
});

// Natural keys must equal the plan-2 migration's deterministic backfill keys,
// so two PCs that never synced agree on identity (composite: '|'-joined).
test('natural keys match the sync_uuid backfill keys of the plan-2 migration', () => {
  const keys = {
    item_types: ['name'], affix_types: ['key'], vfx_effects: ['name'], creature_skills: ['name'], aura_effects: ['name'],
    creature_behaviors: ['name'], creature_abilities: ['behavior_id', 'slot'], creature_behavior_skills: ['behavior_id', 'slot'],
    behavior_drops: ['behavior_id', 'item_type_id'], chest_loot: ['level_min', 'level_max', 'item_type_id'],
    entity_types: ['name'], creature_drops: ['entity_type_id', 'item_type_id'], class_loadouts: ['entity_type_id', 'item_type_id'],
    biomes: ['name'], passive_nodes: ['key'], passive_edges: ['a_id', 'b_id'], game_settings: ['key'],
  };
  for (const [table, k] of Object.entries(keys)) assert.deepStrictEqual(specOf(table).naturalKey, k, table);
});

// Every real group's rename cascades are a supported configuration (a
// partial overlap of a cascade's target tables with the group throws).
test('renameCascadesFor accepts every registered group', () => {
  const ran = {};
  for (const g of GROUPS) ran[g.id] = Object.keys(renameCascadesFor(tableSpecs(g))).sort();
  assert.deepStrictEqual(ran.entities, ['entity_types']);
  assert.deepStrictEqual(ran.aura_effects, ['aura_effects']);
  for (const [id, c] of Object.entries(ran)) if (!['entities', 'aura_effects'].includes(id)) assert.deepStrictEqual(c, [], id);
});

// FKs that point at a group seeding LATER: allowed only here. ai_providers is
// fixed last in the global order; the column is nullable (ON DELETE SET NULL)
// and an unresolved provider is a missing_ref refusal, never a 23503.
const LATER_GROUP_FK_ALLOWED = new Set(['tile_types.ai_provider_id', 'entity_types.ai_provider_id']);

// Deletes run children first (reverse table order) and a ref to a row not yet
// written is deferred as NULL: both rely on every in-group FK pointing at an
// EARLIER table (or the same one). Across groups, seeding in GROUPS order must
// find every FK target already seeded. fks: [{ tbl, col, target }].
function fkOrderProblems(fks, groups) {
  const groupOf = new Map();
  groups.forEach((g, gi) => tableSpecs(g).forEach((s, ti) => groupOf.set(s.table, { gi, ti, id: g.id })));
  const problems = [];
  let checked = 0;
  for (const r of fks) {
    const from = groupOf.get(r.tbl);
    const to = groupOf.get(r.target);
    if (!from || !to || r.tbl === r.target) continue;
    checked += 1;
    const name = `${r.tbl}.${r.col}`;
    if (from.gi === to.gi) {
      if (to.ti > from.ti) problems.push(`${name} -> ${r.target}: points forward inside ${from.id}`);
    } else if (to.gi > from.gi && !LATER_GROUP_FK_ALLOWED.has(name)) {
      problems.push(`${name} -> ${r.target}: group ${to.id} seeds after ${from.id}`);
    }
  }
  return { problems, checked };
}

async function allFks(pool) {
  const { rows } = await pool.query(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col, t.relname::text AS target
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       JOIN pg_class t ON t.oid = c.confrelid
      WHERE c.contype = 'f'`);
  return rows;
}

dbTest('FK order: in-group FKs point backward, cross-group FKs at earlier groups', async (t, pool) => {
  const fks = await allFks(pool);
  const { problems, checked } = fkOrderProblems(fks, GROUPS);
  assert.ok(checked > 10, `checked ${checked} FKs`);
  assert.deepStrictEqual(problems, []);
  for (const name of LATER_GROUP_FK_ALLOWED) {
    const [tbl, col] = name.split('.');
    assert.ok(fks.some((r) => r.tbl === tbl && r.col === col), `${name} is still a real FK`);
  }
});

// The guard can fail: a child listed before its parent, and groups swapped.
dbTest('FK order guard flags a forward in-group FK and a later-group FK', async (t, pool) => {
  const fks = await allFks(pool);
  const cb = getGroup('creature_behaviors');
  const reordered = GROUPS.map((g) => (g === cb ? { ...g, tables: [...g.tables].reverse() } : g));
  assert.ok(fkOrderProblems(fks, reordered).problems
    .includes('creature_abilities.behavior_id -> creature_behaviors: points forward inside creature_behaviors'));
  const items = getGroup('items');
  const swapped = [...GROUPS.filter((g) => g !== items), items];
  assert.ok(fkOrderProblems(fks, swapped).problems
    .includes('creature_drops.item_type_id -> item_types: group items seeds after entities'));
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
  // Plan-1 groups stay single-table.
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
  const omitRest = tt.omit;
  assert.ok(!('ai_provider_id' in omitRest), 'ai_provider_id is a ref since plan 2, not omitted');
  assert.deepStrictEqual(await fkProblems(pool, { ...tt, refs: {} }),
    [{ column: 'ai_provider_id', problem: 'uncovered', target: 'ai_providers' }]);
  assert.deepStrictEqual(
    await fkProblems(pool, { ...tt, omit: omitRest, refs: { ai_provider_id: { table: 'quests', by: 'uuid' } } }),
    [{ column: 'ai_provider_id', problem: 'wrong_target', target: 'ai_providers', declared: 'quests' }]);
  assert.deepStrictEqual(
    await fkProblems(pool, { ...tt, omit: omitRest, refs: { ai_provider_id: { table: 'ai_providers', by: 'uuid' } } }), []);
  assert.deepStrictEqual(
    await fkProblems(pool, { ...tt, refs: { ...tt.refs, name: { table: 'ai_providers', by: 'uuid' } } }),
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
// Plan 1 exported, except tile_types.ai_provider_id, which plan 2 (Task 6,
// ruling R1) exports as a ref (the provider's sync_uuid).
const PLAN1 = {
  tile_types: { omit: ['id', 'created_at', 'updated_at', 'image', 'render_mode', 'sprite', 'sync_uuid'], secret: [] },
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
    assert.deepStrictEqual(await liveColumns(pool, tableSpecs(getGroup(id))[0]), expected, id);
  }
  assert.strictEqual(soleSpec(getGroup('ai_providers')).secretNeededIf, 'auth_header_name');
  assert.deepStrictEqual(tableSpecs(getGroup('tile_types'))[0].naturalKey, ['name']);
  assert.ok((await liveColumns(pool, tableSpecs(getGroup('tile_types'))[0])).some((c) => c.name === 'ai_provider_id'));
  assert.deepStrictEqual(soleSpec(getGroup('quests')).naturalKey, ['key']);
  assert.deepStrictEqual(soleSpec(getGroup('ai_providers')).naturalKey, ['name']);
});

dbTest('liveColumns is sorted and carries information_schema data_type', async (t, pool) => {
  const cols = await liveColumns(pool, tableSpecs(getGroup('tile_types'))[0]);
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
  const tt = tableSpecs(getGroup('tile_types'))[0];
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
