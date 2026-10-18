// Seed-sync apply of a rename (Review Focus 1): an entity / aura renamed on
// PC A and applied by uuid on PC B leaves every name-based reference on B
// exactly as the admin PUT would (the same extracted renameCascade.js
// functions run in the seed's transaction). Plus the extracted functions
// themselves, and the in-group rule (no cascade into a table the same seed
// writes from git).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const { previewSeed, applySeed, renameCascadesFor } = require('../src/services/seedSync/applySeed.js');
const { cascadeEntityRename, cascadeAuraRename } = require('../src/services/seedSync/renameCascade.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const { stableStringify } = require('../src/services/seedSync/canonical.js');
const { _withTestGroups, fkProblems } = require('../src/services/seedSync/registry.js');

const LOCAL = { id: 'local', created_at: 'local', updated_at: 'local', sync_uuid: 'identity' };
const ELEMENT_REF = { table: 'elements', by: 'key', keyCol: 'name' };
const entSpec = {
  table: 'entity_types', naturalKey: ['name'],
  omit: { ...LOCAL, ai_provider_id: 'test group', point_kind: 'test group', behavior_id: 'test group' },
  secretColumns: [], refs: { element: ELEMENT_REF },
  nameRefs: { auras: { table: 'aura_effects', keyCol: 'name', shape: 'array' } },
};
const auraSpec = { table: 'aura_effects', naturalKey: ['name'], omit: LOCAL, secretColumns: [], refs: { dot_element: ELEMENT_REF } };
const GROUPS = [
  { id: 'sx_ren_ent', label: 'SX entities', tables: [entSpec] },
  { id: 'sx_ren_aura', label: 'SX auras', tables: [auraSpec] },
  { id: 'sx_ren_both', label: 'SX auras+entities', tables: [auraSpec, entSpec] },
];

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync rename)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const prev = process.env.SEED_SYNC_DIR;
    process.env.SEED_SYNC_DIR = dir;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      if (prev === undefined) delete process.env.SEED_SYNC_DIR; else process.env.SEED_SYNC_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
      await pool.end().catch(() => {});
    });
    const cleanup = async () => {
      await pool.query("DELETE FROM world_creatures WHERE type LIKE 'sx\\_%'");
      await pool.query("DELETE FROM worlds WHERE name LIKE 'sx\\_%'");
      await pool.query("DELETE FROM biomes WHERE name LIKE 'sx\\_%'");
      await cleanupSx(pool);
    };
    await withSeedSyncLock(pool, async () => {
      await cleanup();
      try {
        await _withTestGroups(GROUPS, () => body(t, pool, dir));
      } finally {
        await cleanup().catch(() => {});
      }
    });
  });
}

const q1 = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const addEnt = (pool, name, auras = []) => q1(pool,
  "INSERT INTO entity_types (name, color, auras) VALUES ($1, '#010203', $2::jsonb) RETURNING id, sync_uuid",
  [name, JSON.stringify(auras)]);
const addAura = (pool, name) => q1(pool,
  'INSERT INTO aura_effects (name, radius) VALUES ($1, 10) RETURNING id, sync_uuid', [name]);
const readDoc = (groupId) => JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
function writeDoc(groupId, doc) {
  for (const [tbl, rows] of Object.entries(doc.tables)) doc.header.row_counts[tbl] = rows.length;
  fs.writeFileSync(fileFor(groupId), `${stableStringify(doc)}\n`);
}
async function applyDefaults(pool, groupId, decisions = {}) {
  const p = await previewSeed(pool, groupId);
  assert.deepStrictEqual(p.rows.filter((r) => !String(r.key).startsWith('sx_')), [], 'fixture lists only sx_ rows');
  return applySeed(pool, groupId, decisions, { signature: p.signature });
}
// Every client the pool hands out fails its first query matching `re`
// (restored afterwards, so cleanup runs on clean clients).
function failQueries(t, pool, re) {
  const orig = pool.connect.bind(pool);
  const patched = [];
  // pool.query() connects with a callback: leave that path alone.
  t.mock.method(pool, 'connect', (cb) => (typeof cb === 'function' ? orig(cb) : orig().then((c) => {
    const q = c.query;
    patched.push([c, q]);
    c.query = (...a) => (re.test(String(a[0])) ? Promise.reject(new Error('sx injected failure')) : q.apply(c, a));
    return c;
  })));
  return () => { t.mock.restoreAll(); for (const [c, q] of patched) c.query = q; };
}

dbTest('rename test groups cover every FK column (fixture sanity)', async (t, pool) => {
  for (const s of [entSpec, auraSpec]) assert.deepStrictEqual(await fkProblems(pool, s), [], s.table);
});

// Review Focus 1
dbTest('an entity renamed in git cascades into worlds, world_creatures, biomes and dungeon bosses like the admin PUT', async (t, pool) => {
  const ent = await addEnt(pool, 'sx_beast');
  const world = await q1(pool,
    `INSERT INTO worlds (name, seed, allowed_creature_types, dungeon_boss) VALUES ('sx_w', 1, $1::jsonb, $2::jsonb) RETURNING id`,
    [JSON.stringify(['sx_other', 'sx_beast', 'sx_beast_two']), JSON.stringify({ entity: 'sx_beast', x: 3, y: 4, respawn_s: 60 })]);
  await pool.query("INSERT INTO world_creatures (world_id, type, x, y) VALUES ($1, 'sx_beast', 1, 1)", [world.id]);
  await pool.query(
    "INSERT INTO biomes (name, flora_types, creature_types) VALUES ('sx_bio', $1::jsonb, $2::jsonb)",
    [JSON.stringify(['sx_beast']), JSON.stringify(['sx_slime', 'sx_beast'])]);
  await exportGroup(pool, 'sx_ren_ent');
  const doc = readDoc('sx_ren_ent');
  doc.tables.entity_types.find((r) => r.sync_uuid === ent.sync_uuid).name = 'sx_beast_new';
  writeDoc('sx_ren_ent', doc);

  const res = await applyDefaults(pool, 'sx_ren_ent');
  assert.strictEqual(res.summary.updated, 1);
  const e = await q1(pool, 'SELECT id, name FROM entity_types WHERE sync_uuid = $1', [ent.sync_uuid]);
  assert.deepStrictEqual(e, { id: ent.id, name: 'sx_beast_new' });
  const w = await q1(pool, 'SELECT allowed_creature_types, dungeon_boss FROM worlds WHERE id = $1', [world.id]);
  assert.deepStrictEqual(w.allowed_creature_types, ['sx_other', 'sx_beast_new', 'sx_beast_two'], 'one element, order kept');
  assert.deepStrictEqual(w.dungeon_boss, { entity: 'sx_beast_new', x: 3, y: 4, respawn_s: 60 });
  const wc = await pool.query('SELECT type FROM world_creatures WHERE world_id = $1', [world.id]);
  assert.deepStrictEqual(wc.rows, [{ type: 'sx_beast_new' }]);
  const b = await q1(pool, "SELECT flora_types, creature_types FROM biomes WHERE name = 'sx_bio'");
  assert.deepStrictEqual(b, { flora_types: ['sx_beast_new'], creature_types: ['sx_slime', 'sx_beast_new'] });
  assert.deepStrictEqual((await previewSeed(pool, 'sx_ren_ent')).rows, []);
});

dbTest('a seed that fails after the rename rolls the cascade back too', async (t, pool) => {
  const ent = await addEnt(pool, 'sx_beast');
  const world = await q1(pool,
    "INSERT INTO worlds (name, seed, allowed_creature_types) VALUES ('sx_w', 1, $1::jsonb) RETURNING id",
    [JSON.stringify(['sx_beast'])]);
  await exportGroup(pool, 'sx_ren_ent');
  const doc = readDoc('sx_ren_ent');
  doc.tables.entity_types.find((r) => r.sync_uuid === ent.sync_uuid).name = 'sx_beast_new';
  writeDoc('sx_ren_ent', doc);
  const p = await previewSeed(pool, 'sx_ren_ent');
  // Rows and cascade written; the first baseline write (after them) fails.
  const restore = failQueries(t, pool, /INSERT INTO seed_row_hashes/);
  try {
    await assert.rejects(applySeed(pool, 'sx_ren_ent', {}, { signature: p.signature }), /sx injected failure/);
  } finally { restore(); }
  const w = await q1(pool, 'SELECT allowed_creature_types FROM worlds WHERE id = $1', [world.id]);
  assert.deepStrictEqual(w.allowed_creature_types, ['sx_beast']);
  assert.strictEqual((await q1(pool, 'SELECT name FROM entity_types WHERE id = $1', [ent.id])).name, 'sx_beast');
});

dbTest('an aura renamed in git cascades into entity_types.auras (another group), one element, order kept', async (t, pool) => {
  const aura = await addAura(pool, 'sx_aura');
  const e = await addEnt(pool, 'sx_e', ['sx_x', 'sx_aura', 'sx_y']);
  await exportGroup(pool, 'sx_ren_aura');
  const doc = readDoc('sx_ren_aura');
  doc.tables.aura_effects.find((r) => r.sync_uuid === aura.sync_uuid).name = 'sx_aura_new';
  writeDoc('sx_ren_aura', doc);
  await applyDefaults(pool, 'sx_ren_aura');
  assert.strictEqual((await q1(pool, 'SELECT name FROM aura_effects WHERE id = $1', [aura.id])).name, 'sx_aura_new');
  assert.deepStrictEqual((await q1(pool, 'SELECT auras FROM entity_types WHERE id = $1', [e.id])).auras,
    ['sx_x', 'sx_aura_new', 'sx_y']);
});

dbTest('in-group: no cascade into a table of the same group: its rows stay exactly as git has them', async (t, pool) => {
  const aura = await addAura(pool, 'sx_aura');
  const e1 = await addEnt(pool, 'sx_e1', ['sx_aura']);
  const e3 = await addEnt(pool, 'sx_e3', ['sx_aura', 'sx_x']);
  await exportGroup(pool, 'sx_ren_both');
  const doc = readDoc('sx_ren_both');
  doc.tables.aura_effects.find((r) => r.sync_uuid === aura.sync_uuid).name = 'sx_aura_new';
  // Git carries the new name in the row it changed; sx_e3 is in sync (git
  // left it alone), so a cascade would rewrite a row git did not change.
  doc.tables.entity_types.find((r) => r.sync_uuid === e1.sync_uuid).auras = ['sx_x', 'sx_aura_new'];
  writeDoc('sx_ren_both', doc);
  await applyDefaults(pool, 'sx_ren_both');
  assert.strictEqual((await q1(pool, 'SELECT name FROM aura_effects WHERE id = $1', [aura.id])).name, 'sx_aura_new');
  assert.deepStrictEqual((await q1(pool, 'SELECT auras FROM entity_types WHERE id = $1', [e1.id])).auras, ['sx_x', 'sx_aura_new'],
    'git value exactly (no second rewrite)');
  assert.deepStrictEqual((await q1(pool, 'SELECT auras FROM entity_types WHERE id = $1', [e3.id])).auras, ['sx_aura', 'sx_x'],
    'an in-group row this seed did not write is not rewritten');
  const after = await previewSeed(pool, 'sx_ren_both');
  assert.deepStrictEqual(after.rows, [], 'everything still matches git');
  assert.deepStrictEqual(after.warnings.filter((w) => w.code === 'dangling_name' && w.name.startsWith('sx_aura'))
    .map((w) => [w.key, w.name]), [['sx_e3', 'sx_aura']], 'the stale name is warned (once: local and git agree)');
});

dbTest('in-group: a kept local row still naming the old aura is warned (dangling_name), not silently rewritten', async (t, pool) => {
  const aura = await addAura(pool, 'sx_aura');
  await addEnt(pool, 'sx_e1', ['sx_aura']);
  await exportGroup(pool, 'sx_ren_both');
  const e2 = await addEnt(pool, 'sx_e2', ['sx_aura']);
  const doc = readDoc('sx_ren_both');
  doc.tables.aura_effects.find((r) => r.sync_uuid === aura.sync_uuid).name = 'sx_aura_new';
  doc.tables.entity_types.find((r) => r.name === 'sx_e1').auras = ['sx_aura_new'];
  writeDoc('sx_ren_both', doc);
  await applyDefaults(pool, 'sx_ren_both');
  assert.deepStrictEqual((await q1(pool, 'SELECT auras FROM entity_types WHERE id = $1', [e2.id])).auras, ['sx_aura']);
  const after = await previewSeed(pool, 'sx_ren_both');
  assert.deepStrictEqual(after.warnings.filter((w) => w.code === 'dangling_name').map((w) => [w.key, w.column, w.name]),
    [['sx_e2', 'auras', 'sx_aura']]);
});

dbTest('renameCascadesFor: cascades whose targets are all in the group are skipped; a partial overlap is a config error', () => {
  const tbl = (table) => ({ table });
  assert.deepStrictEqual(Object.keys(renameCascadesFor([tbl('entity_types')])).sort(), ['entity_types']);
  assert.deepStrictEqual(Object.keys(renameCascadesFor([tbl('aura_effects')])).sort(), ['aura_effects']);
  assert.deepStrictEqual(Object.keys(renameCascadesFor([tbl('aura_effects'), tbl('entity_types')])).sort(), ['entity_types']);
  assert.throws(() => renameCascadesFor([tbl('entity_types'), tbl('biomes')]), /entity_types.*biomes/);
});

dbTest('cascadeEntityRename returns null when nothing names the entity; cascadeAuraRename counts rewritten rows', async (t, pool) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    assert.strictEqual(await cascadeEntityRename(client, 'sx_nobody', 'sx_nobody2'), null);
    await client.query("INSERT INTO entity_types (name, color, auras) VALUES ('sx_e', '#010203', '[\"sx_a\"]'::jsonb)");
    assert.strictEqual(await cascadeAuraRename(client, 'sx_a', 'sx_b'), 1);
    assert.deepStrictEqual((await client.query("SELECT auras FROM entity_types WHERE name = 'sx_e'")).rows[0].auras, ['sx_b']);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
