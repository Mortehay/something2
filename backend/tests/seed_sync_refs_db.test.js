const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const { _withTestGroups, fkProblems, getGroup } = require('../src/services/seedSync/registry.js');
const { exportGroup, fileFor, readExport } = require('../src/services/seedSync/exportGroup.js');
const { diffGroup, validateDoc } = require('../src/services/seedSync/diffGroup.js');
const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { buildRefMaps, exportRow, resolveRow } = require('../src/services/seedSync/refs.js');
const { SyncFileError } = require('../src/services/seedSync/errors.js');
const { compareNaturalKey } = require('../src/services/seedSync/canonical.js');

// TEST-ONLY groups built from real tables (Task 6 adds the real groups). Every
// FK column is a ref or omitted, so fkProblems passes (asserted below).
const LOCAL = { id: 'local', created_at: 'local', updated_at: 'local', sync_uuid: 'identity' };
const behaviorsSpec = { table: 'creature_behaviors', naturalKey: ['name'], omit: LOCAL, secretColumns: [], refs: {} };
const entitiesSpec = {
  table: 'entity_types',
  naturalKey: ['name'],
  omit: { ...LOCAL, ai_provider_id: 'test group', point_kind: 'test group' },
  secretColumns: [],
  refs: {
    behavior_id: { table: 'creature_behaviors', by: 'uuid' },
    element: { table: 'elements', by: 'key', keyCol: 'name' },
  },
};
const itemsSpec = {
  table: 'item_types',
  naturalKey: ['name'],
  omit: LOCAL,
  secretColumns: [],
  refs: {
    ammo_type_id: { table: 'item_types', by: 'uuid' },
    element: { table: 'elements', by: 'key', keyCol: 'name' },
    attack_origin: { table: 'attack_origins', by: 'key', keyCol: 'name' },
    projectile_shape_id: { table: 'projectile_shapes', by: 'key', keyCol: 'name' },
    impact_behavior_id: { table: 'impact_behaviors', by: 'key', keyCol: 'name' },
  },
};
const SX_TEST = { id: 'sx_test', label: 'SX test', tables: [behaviorsSpec, entitiesSpec] };
const SX_ITEMS = { id: 'sx_items', label: 'SX items', tables: [itemsSpec] };

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync refs)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const prev = process.env.SEED_SYNC_DIR;
    process.env.SEED_SYNC_DIR = dir;
    const pool = new Pool({ connectionString: DB_URL, max: 6, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      if (prev === undefined) delete process.env.SEED_SYNC_DIR; else process.env.SEED_SYNC_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
      await pool.end().catch(() => {});
    });
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      try {
        await _withTestGroups([SX_TEST, SX_ITEMS], () => body(t, pool, dir));
      } finally { await cleanupSx(pool).catch(() => {}); }
    });
  });
}

const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const addBehavior = (pool, name) => one(pool,
  `INSERT INTO creature_behaviors (name, aggro_radius, leash_radius, chase_style)
   VALUES ($1, 5, 10, 'charge') RETURNING id, sync_uuid`, [name]);
const addEntity = (pool, name, behaviorId, element) => one(pool,
  `INSERT INTO entity_types (name, color, behavior_id, element) VALUES ($1, '#010203', $2, $3)
   RETURNING id, sync_uuid`, [name, behaviorId, element]);
const docOf = (groupId) => JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
const rawNoStamp = (groupId) => fs.readFileSync(fileFor(groupId), 'utf8')
  .split('\n').filter((l) => !/^\s*"exported_at":/.test(l)).join('\n');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Every ref column of every row of every table: null, a uuid (by uuid) or a
// string key (by key) -- never a local numeric id.
function assertNoLocalIds(doc, group) {
  let checked = 0;
  for (const spec of group.tables) {
    for (const r of doc.tables[spec.table]) {
      for (const [col, ref] of Object.entries(spec.refs)) {
        const v = r[col];
        if (v === null) continue;
        assert.strictEqual(typeof v, 'string', `${spec.table} ${r.sync_uuid}.${col} = ${JSON.stringify(v)}`);
        if (ref.by === 'uuid') assert.match(v, UUID_RE, `${spec.table}.${col}`);
        checked += 1;
      }
    }
  }
  return checked;
}

dbTest('test groups cover every FK column (fixture sanity)', async (t, pool) => {
  for (const s of [behaviorsSpec, entitiesSpec, itemsSpec]) {
    assert.deepStrictEqual(await fkProblems(pool, s), [], s.table);
  }
});

dbTest('export writes uuid refs and key refs; no local id of a ref column reaches the file', async (t, pool) => {
  const beh = await addBehavior(pool, 'sx_beh');
  await addEntity(pool, 'sx_ent', beh.id, 'fire');
  await addEntity(pool, 'sx_plain', null, null);
  const { rowCount } = await exportGroup(pool, 'sx_test');
  const doc = docOf('sx_test');
  assert.deepStrictEqual(Object.keys(doc).sort(), ['header', 'tables']);
  assert.deepStrictEqual(Object.keys(doc.tables).sort(), ['creature_behaviors', 'entity_types']);
  const ent = doc.tables.entity_types.find((r) => r.name === 'sx_ent');
  assert.strictEqual(ent.behavior_id, beh.sync_uuid);
  assert.strictEqual(ent.element, 'fire');
  const plain = doc.tables.entity_types.find((r) => r.name === 'sx_plain');
  assert.strictEqual(plain.behavior_id, null, 'null stays null');
  assert.strictEqual(plain.element, null);
  // Every row: behavior_id is a uuid of an exported behavior, never a number.
  const behUuids = new Set(doc.tables.creature_behaviors.map((r) => r.sync_uuid));
  for (const r of doc.tables.entity_types) {
    assert.ok(r.behavior_id === null || (UUID_RE.test(r.behavior_id) && behUuids.has(r.behavior_id)), `${r.name}: ${r.behavior_id}`);
    assert.ok(!('id' in r) && !('ai_provider_id' in r));
  }
  assert.ok(assertNoLocalIds(doc, SX_TEST) >= 2);
  assert.ok(!/"behavior_id": \d/.test(fs.readFileSync(fileFor('sx_test'), 'utf8')));
  assert.ok(!JSON.stringify(doc).includes(`"behavior_id":${beh.id}`));
  const n = async (tbl) => Number((await one(pool, `SELECT count(*) AS n FROM ${tbl}`)).n);
  assert.deepStrictEqual(doc.header.row_counts, {
    creature_behaviors: await n('creature_behaviors'), entity_types: await n('entity_types'),
  });
  assert.strictEqual(rowCount, doc.header.row_counts.creature_behaviors + doc.header.row_counts.entity_types);
  assert.deepStrictEqual(Object.keys(doc.header).sort(),
    ['exported_at', 'exported_by', 'group', 'row_counts', 'schema_version']);
  // Baselines are the hashes of the exported (translated) rows.
  const h = await one(pool, 'SELECT hash FROM seed_row_hashes WHERE group_id = $1 AND sync_uuid = $2', ['sx_test', ent.sync_uuid]);
  const { rowHash } = require('../src/services/seedSync/canonical.js');
  assert.strictEqual(h.hash, rowHash(ent));
  assert.deepStrictEqual(await readExport('sx_test'), doc);
});

dbTest('key refs translate lookup ids to names; a self-ref travels as uuid', async (t, pool) => {
  const ammo = await one(pool,
    `INSERT INTO item_types (name, category, damage, cooldown, stackable)
     VALUES ('sx_ammo', 'ammo', 0, 0, true) RETURNING id, sync_uuid`);
  const shape = await one(pool, "SELECT id, name FROM projectile_shapes WHERE name = 'bolt'");
  const impact = await one(pool, "SELECT id, name FROM impact_behaviors WHERE name = 'pierce'");
  assert.notStrictEqual(String(shape.id), shape.name);
  await pool.query(
    `INSERT INTO item_types (name, category, kind, damage, cooldown, range, projectile_speed, projectile_radius,
                             ammo_type_id, element, attack_origin, projectile_shape_id, impact_behavior_id)
     VALUES ('sx_bow', 'weapon', 'projectile', 1, 1, 10, 10, 2, $1, 'fire', 'head', $2, $3)`,
    [ammo.id, shape.id, impact.id]);
  await exportGroup(pool, 'sx_items');
  const bow = docOf('sx_items').tables.item_types.find((r) => r.name === 'sx_bow');
  assert.strictEqual(bow.ammo_type_id, ammo.sync_uuid);
  assert.strictEqual(bow.projectile_shape_id, 'bolt');
  assert.strictEqual(bow.impact_behavior_id, 'pierce');
  assert.strictEqual(bow.element, 'fire');
  assert.strictEqual(bow.attack_origin, 'head');
  assert.ok(assertNoLocalIds(docOf('sx_items'), SX_ITEMS) >= 5);
});

dbTest('multi-table export: rows sorted per table, second export byte-identical', async (t, pool) => {
  const b = await addBehavior(pool, 'sx_b2');
  await addBehavior(pool, 'sx_b1');
  await addEntity(pool, 'sx_e2', b.id, 'ice');
  await addEntity(pool, 'sx_e1', null, 'fire');
  await exportGroup(pool, 'sx_test');
  const first = rawNoStamp('sx_test');
  const doc = docOf('sx_test');
  for (const [tbl, rows] of Object.entries(doc.tables)) {
    const sorted = [...rows].sort((x, y) => compareNaturalKey(x, y, ['name']));
    assert.deepStrictEqual(rows.map((r) => r.name), sorted.map((r) => r.name), tbl);
  }
  await exportGroup(pool, 'sx_test'); // over the existing file: in sync, allowed
  assert.strictEqual(rawNoStamp('sx_test'), first);
});

dbTest('re-export of a multi-table or ref group: in sync is allowed, git_newer refused, bad file propagates', async (t, pool) => {
  const beh = await addBehavior(pool, 'sx_rx_beh');
  await addEntity(pool, 'sx_rx_ent', beh.id, 'fire');
  await exportGroup(pool, 'sx_test');
  await exportGroup(pool, 'sx_test');
  assert.strictEqual((await diffGroup(pool, 'sx_test')).status, 'in_sync');
  // A child row changed in git (its ref now points at no behavior): refused.
  const doc = docOf('sx_test');
  doc.tables.entity_types.find((r) => r.name === 'sx_rx_ent').behavior_id = null;
  const { stableStringify } = require('../src/services/seedSync/canonical.js');
  const edited = `${stableStringify(doc)}\n`;
  fs.writeFileSync(fileFor('sx_test'), edited);
  await assert.rejects(exportGroup(pool, 'sx_test'),
    (e) => e.name === 'SyncRefused' && e.code === 'git_newer' && e.details.gitChanges === 1);
  assert.strictEqual(fs.readFileSync(fileFor('sx_test'), 'utf8'), edited, 'file untouched');
  // Single-table group with refs: same rules.
  await exportGroup(pool, 'sx_items');
  await exportGroup(pool, 'sx_items');
  // A corrupt file is never overwritten.
  fs.writeFileSync(fileFor('sx_items'), '{ nope');
  await assert.rejects(exportGroup(pool, 'sx_items'), (e) => e instanceof SyncFileError);
  assert.strictEqual(fs.readFileSync(fileFor('sx_items'), 'utf8'), '{ nope');
});

dbTest('diff, preview and apply handle multi-table and ref groups (no single-table guard left)', async (t, pool) => {
  for (const id of ['sx_test', 'sx_items']) {
    await exportGroup(pool, id);
    const d = await diffGroup(pool, id);
    assert.strictEqual(d.status, 'in_sync', id);
    assert.deepStrictEqual(d.tables.map((x) => x.table), getGroup(id).tables.map((s) => s.table));
    const p = await previewSeed(pool, id);
    assert.deepStrictEqual(p.rows, [], `previewSeed ${id}`);
    const res = await applySeed(pool, id, {}, { signature: p.signature });
    assert.deepStrictEqual(res.summary, { updated: 0, created: 0, deleted: 0, kept: 0, adopted: 0 }, `applySeed ${id}`);
  }
});

dbTest('buildRefMaps / exportRow / resolveRow round trip, missing and pending refs', async (t, pool) => {
  const beh = await addBehavior(pool, 'sx_rt');
  const maps = await buildRefMaps(pool, entitiesSpec);
  assert.strictEqual(maps.toRef.behavior_id.get(beh.id), beh.sync_uuid);
  assert.strictEqual(maps.fromRef.behavior_id.get(beh.sync_uuid), beh.id);
  assert.strictEqual(maps.toRef.element.get('fire'), 'fire');
  const local = { name: 'sx_x', behavior_id: beh.id, element: 'ice', color: '#000' };
  const out = exportRow(local, entitiesSpec, maps);
  assert.deepStrictEqual(out, { name: 'sx_x', behavior_id: beh.sync_uuid, element: 'ice', color: '#000' });
  assert.strictEqual(local.behavior_id, beh.id, 'input not mutated');
  assert.deepStrictEqual(exportRow({ behavior_id: null, element: null }, entitiesSpec, maps), { behavior_id: null, element: null });
  assert.throws(() => exportRow({ behavior_id: -1, element: null }, entitiesSpec, maps), /behavior_id.*-1/);
  // A target whose uuid/key is null fails closed too (never a silent null ref).
  const holey = { toRef: { behavior_id: new Map([[7, null]]), element: new Map([['fire', undefined]]) }, fromRef: {} };
  assert.throws(() => exportRow({ behavior_id: 7, element: null }, entitiesSpec, holey), /behavior_id = 7.*no sync_uuid/);
  assert.throws(() => exportRow({ behavior_id: null, element: 'fire' }, entitiesSpec, holey), /element = "fire".*no name/);

  const back = await resolveRow(out, entitiesSpec, maps);
  assert.deepStrictEqual(back, { row: local, missing: [] });
  const ghost = '00000000-0000-4000-8000-0000000000aa';
  const miss = await resolveRow({ name: 'sx_x', behavior_id: ghost, element: 'nope' }, entitiesSpec, maps);
  assert.deepStrictEqual(miss.missing, [
    { column: 'behavior_id', target: 'creature_behaviors', value: ghost },
    { column: 'element', target: 'elements', value: 'nope' },
  ]);
  const pending = { creature_behaviors: new Map([[ghost, 424242]]) };
  const ok = await resolveRow({ name: 'sx_x', behavior_id: ghost, element: null }, entitiesSpec, maps, pending);
  assert.deepStrictEqual(ok, { row: { name: 'sx_x', behavior_id: 424242, element: null }, missing: [] });
});

dbTest('validateDoc: unknown table, v1 for a multi-table group, missing table, row_counts mismatch', async (t, pool) => {
  const g = getGroup('sx_test');
  const header = { group: 'sx_test', exported_at: 'x', exported_by: 'sx', schema_version: '', row_counts: { creature_behaviors: 0, entity_types: 0 } };
  const good = { header, tables: { creature_behaviors: [], entity_types: [] } };
  validateDoc(good, g);
  const bad = (doc, re) => assert.throws(() => validateDoc(doc, g), (e) => e instanceof SyncFileError && re.test(e.message));
  bad({ header: { ...header, row_counts: { ...header.row_counts, quests: 0 } }, tables: { ...good.tables, quests: [] } },
    /unknown table quests/);
  bad({ header: { group: 'sx_test', row_count: 0 }, rows: [] }, /v1.*single-table/);
  bad({ header: { ...header, row_counts: { creature_behaviors: 0 } }, tables: { creature_behaviors: [] } },
    /missing table entity_types/);
  bad({ header: { ...header, row_counts: { creature_behaviors: 1, entity_types: 0 } }, tables: good.tables },
    /row_counts.*creature_behaviors/);
  const u = '00000000-0000-4000-8000-0000000000b1';
  const dupUuid = { header: { ...header, row_counts: { creature_behaviors: 1, entity_types: 1 } },
    tables: { creature_behaviors: [{ name: 'sx_a', sync_uuid: u }], entity_types: [{ name: 'sx_e', sync_uuid: u }] } };
  validateDoc(dupUuid, g); // uuids are unique per table
  bad({ header: { ...header, row_counts: { creature_behaviors: 2, entity_types: 0 } },
    tables: { creature_behaviors: [{ name: 'sx_a', sync_uuid: u }, { name: 'sx_b', sync_uuid: u }], entity_types: [] } },
  /creature_behaviors.*duplicate sync_uuid/);
  bad({ header: { ...header, row_counts: { creature_behaviors: 2, entity_types: 0 } },
    tables: { creature_behaviors: [{ name: 'sx_a', sync_uuid: u }, { name: 'sx_a', sync_uuid: '00000000-0000-4000-8000-0000000000b2' }], entity_types: [] } },
  /creature_behaviors.*duplicate name/);
  bad({ header: { ...header, row_counts: { creature_behaviors: 1, entity_types: 0 } },
    tables: { creature_behaviors: [{ name: 'sx_a', sync_uuid: 'NOT-A-UUID' }], entity_types: [] } },
  /creature_behaviors.*lowercase uuid/);
  bad({ header, tables: { creature_behaviors: {}, entity_types: [] } }, /creature_behaviors.*not an array/);
});

dbTest('buildRefMaps refuses a ref whose FK targets another table', async (t, pool) => {
  const wrong = { ...entitiesSpec, refs: { behavior_id: { table: 'quests', by: 'uuid' } } };
  await assert.rejects(buildRefMaps(pool, wrong), /entity_types\.behavior_id references creature_behaviors, but the ref declares quests/);
  const notFk = { ...entitiesSpec, refs: { name: { table: 'quests', by: 'uuid' } } };
  await assert.rejects(buildRefMaps(pool, notFk), /entity_types\.name .*not a single-column FK/);
});

test('buildRefMaps refuses a column with two single-column FKs', async () => {
  // No such column exists in the schema; a stub catalog reply stands in.
  const db = { query: async () => ({ rows: [
    { col: 'behavior_id', ref_col: 'id', target: 'creature_behaviors' },
    { col: 'behavior_id', ref_col: 'id', target: 'creature_behaviors' },
  ] }) };
  const spec = { table: 'entity_types', refs: { behavior_id: { table: 'creature_behaviors', by: 'uuid' } } };
  await assert.rejects(buildRefMaps(db, spec), /behavior_id has 2 single-column FKs/);
});

// Without a table lock, export reads behaviors and entities in separate READ
// COMMITTED statements: a writer committing in between would produce an
// entity whose behavior uuid is not in the file.
dbTest('export waits for an open writer and exports a self-consistent file', async (t, pool) => {
  const writer = await pool.connect();
  let open = true;
  try {
    await writer.query('BEGIN');
    const wpid = (await writer.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const beh = (await writer.query(
      `INSERT INTO creature_behaviors (name, aggro_radius, leash_radius, chase_style)
       VALUES ('sx_cw_beh', 5, 10, 'charge') RETURNING id, sync_uuid`)).rows[0];
    await writer.query(
      "INSERT INTO entity_types (name, color, behavior_id) VALUES ('sx_cw_ent', '#010203', $1)", [beh.id]);

    let done = false;
    const p = exportGroup(pool, 'sx_test').then((r) => { done = true; return r; });
    p.catch(() => {});
    // Deterministic: wait until some backend is blocked by the writer.
    let blocked = false;
    for (let i = 0; i < 100 && !blocked && !done; i += 1) {
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [wpid]);
      blocked = rows[0].n > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(blocked, 'export blocks on the open writer');
    assert.strictEqual(done, false, 'export has not finished while the writer is open');
    await writer.query('COMMIT');
    open = false;
    await p;
    const doc = docOf('sx_test');
    const b = doc.tables.creature_behaviors.find((r) => r.name === 'sx_cw_beh');
    const e = doc.tables.entity_types.find((r) => r.name === 'sx_cw_ent');
    assert.ok(b && e, 'both rows exported');
    assert.strictEqual(b.sync_uuid, beh.sync_uuid);
    assert.strictEqual(e.behavior_id, b.sync_uuid, "the entity's ref resolves inside the file");
    const inFile = new Set(doc.tables.creature_behaviors.map((r) => r.sync_uuid));
    for (const r of doc.tables.entity_types) assert.ok(r.behavior_id === null || inFile.has(r.behavior_id), r.name);
  } finally {
    if (open) await writer.query('ROLLBACK').catch(() => {});
    writer.release();
  }
});
