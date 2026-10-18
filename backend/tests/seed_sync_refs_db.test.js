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
    const pool = new Pool({ connectionString: DB_URL, max: 3, connectionTimeoutMillis: 3000 });
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
  for (const r of docOf('sx_items').tables.item_types) {
    for (const c of ['ammo_type_id', 'projectile_shape_id', 'impact_behavior_id']) {
      assert.ok(r[c] === null || typeof r[c] === 'string', `${r.name}.${c} = ${r[c]}`);
    }
  }
});

// TODO(Task 4): once diff is multi-table, export over an existing file is
// allowed again; until then the file is removed between the two exports.
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
  fs.unlinkSync(fileFor('sx_test'));
  await exportGroup(pool, 'sx_test');
  assert.strictEqual(rawNoStamp('sx_test'), first);
});

dbTest('export over an existing file of a multi-table or ref group is refused until Task 4', async (t, pool, dir) => {
  await exportGroup(pool, 'sx_test');
  const text = fs.readFileSync(fileFor('sx_test'), 'utf8');
  await assert.rejects(exportGroup(pool, 'sx_test'), (e) => e.name === 'SyncRefused' && e.code === 'not_supported_yet');
  assert.strictEqual(fs.readFileSync(fileFor('sx_test'), 'utf8'), text, 'file untouched');
  // Single-table group with refs: same rule.
  await exportGroup(pool, 'sx_items');
  await assert.rejects(exportGroup(pool, 'sx_items'), (e) => e.code === 'not_supported_yet');
  // Even a corrupt file is never overwritten.
  fs.writeFileSync(fileFor('sx_items'), '{ nope');
  await assert.rejects(exportGroup(pool, 'sx_items'), (e) => e.code === 'not_supported_yet');
  assert.strictEqual(fs.readFileSync(fileFor('sx_items'), 'utf8'), '{ nope');
});

dbTest('single-table diff/preview/apply refuse a multi-table group and a ref group', async (t, pool) => {
  for (const id of ['sx_test', 'sx_items']) {
    const re = id === 'sx_test' ? /sx_test.*2 tables/ : /sx_items.*item_types.*refs/;
    await assert.rejects(diffGroup(pool, id), re, `diffGroup ${id}`);
    await assert.rejects(previewSeed(pool, id), re, `previewSeed ${id}`);
    await assert.rejects(applySeed(pool, id, {}), re, `applySeed ${id}`);
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
