const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

// The real plan-2 groups this file exports/seeds. Exports rewrite their
// baselines and add runs: both are snapshotted before each test and restored
// exactly afterwards (baselines) / deleted by watermark (runs).
const PLAN2 = ['items', 'attack_effects', 'aura_effects', 'creature_behaviors', 'entities', 'biomes', 'skill_tree', 'progression'];

const baselinesOf = async (pool) => (await pool.query(
  `SELECT group_id, sync_uuid::text AS sync_uuid, hash FROM seed_row_hashes
    WHERE group_id = ANY($1::text[]) ORDER BY group_id, sync_uuid`, [PLAN2])).rows;

async function restoreBaselines(pool, snapshot) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM seed_row_hashes WHERE group_id = ANY($1::text[])', [PLAN2]);
    if (snapshot.length) {
      await client.query(
        `INSERT INTO seed_row_hashes (group_id, sync_uuid, hash)
         SELECT * FROM unnest($1::text[], $2::uuid[], $3::text[])`,
        [snapshot.map((r) => r.group_id), snapshot.map((r) => r.sync_uuid), snapshot.map((r) => r.hash)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync groups)';
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
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      const snapshot = await baselinesOf(pool);
      const watermark = (await pool.query('SELECT coalesce(max(id), 0)::int AS m FROM seed_export_runs')).rows[0].m;
      let failure = null;
      try { await body(t, pool, dir); } catch (e) { failure = e; } finally {
        await cleanupSx(pool).catch(() => {});
        await pool.query('DELETE FROM seed_export_runs WHERE id > $1 AND group_id = ANY($2::text[])', [watermark, PLAN2])
          .catch(() => {});
        await restoreBaselines(pool, snapshot);
      }
      if (failure) throw failure;
      assert.deepStrictEqual(await baselinesOf(pool), snapshot, 'real baselines restored exactly');
    });
  });
}

const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const { SyncRefused } = require('../src/services/seedSync/errors.js');
const { stableStringify } = require('../src/services/seedSync/canonical.js');
const { getGroup, tableSpecs } = require('../src/services/seedSync/registry.js');

const q1 = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const idOf = async (pool, table, col, val) => (await q1(pool, `SELECT id FROM ${table} WHERE ${col} = $1`, [val])).id;
const uuidOf = async (pool, table, col, val) => (await q1(pool, `SELECT sync_uuid FROM ${table} WHERE ${col} = $1`, [val])).sync_uuid;

// The file without its export timestamp (the only value that differs between
// two exports of the same data).
const fileNoStamp = (groupId) => fs.readFileSync(fileFor(groupId), 'utf8')
  .split('\n').filter((l) => !/^\s*"exported_at":/.test(l)).join('\n');

// ---- fixtures: sx_ rows per table, plus the one row each test modifies ----

async function sxItems(pool) {
  const origin = (await q1(pool, 'SELECT name FROM attack_origins ORDER BY name LIMIT 1')).name;
  const impact = await q1(pool, 'SELECT id FROM impact_behaviors ORDER BY name LIMIT 1');
  const shape = await q1(pool, 'SELECT id FROM projectile_shapes ORDER BY name LIMIT 1');
  const vfx = await q1(pool, 'SELECT name FROM vfx_effects ORDER BY name LIMIT 1');
  await pool.query(`INSERT INTO item_types (name, category, stackable, damage, cooldown)
    VALUES ('sx_rt_ammo', 'ammo', true, 0, 0)`);
  const ammo = await idOf(pool, 'item_types', 'name', 'sx_rt_ammo');
  await pool.query(`INSERT INTO item_types (name, category, kind, damage, cooldown, range, projectile_speed, projectile_radius,
      ammo_type_id, element, attack_origin, impact_behavior_id, projectile_shape_id, vfx)
    VALUES ('sx_rt_bow', 'weapon', 'projectile', 3, 1, 100, 200, 4, $1, 'fire', $2, $3, $4, $5::jsonb)`,
  [ammo, origin, impact.id, shape.id, JSON.stringify({ attack: vfx ? vfx.name : 'sx_none' })]);
  await pool.query(`INSERT INTO item_types (name, category, damage, cooldown) VALUES ('sx_rt_gem', 'currency', 0, 0)`);
}

async function sxSkill(pool) {
  await pool.query(`INSERT INTO vfx_effects (name, shape, color, width, duration_ms, ease, fade, follows_weapon)
    VALUES ('sx_rt_vfx', 'arc', '#ffffff', 2, 200, 'linear', true, false)`);
  await pool.query(`INSERT INTO creature_skills (name, kind, cooldown_ms, vfx)
    VALUES ('sx_rt_skill', 'slam', 1000, '{"cast":"sx_rt_vfx"}'::jsonb)`);
}

async function sxBehavior(pool) {
  await pool.query(`INSERT INTO creature_behaviors (name, aggro_radius, leash_radius, chase_style)
    VALUES ('sx_rt_beh', 100, 200, 'charge')`);
}

const FIXTURES = {
  items: {
    async setup(pool) {
      await sxItems(pool);
      await pool.query(`INSERT INTO affix_types (key, label, effect, min_value, max_value)
        VALUES ('sx_rt_affix', 'sx affix', '{"stat":"strength"}'::jsonb, 1, 2)`);
    },
    modify: (pool) => pool.query("UPDATE item_types SET damage = damage + 1 WHERE name = 'sx_rt_bow'"),
    modified: { table: 'item_types', col: 'name', key: 'sx_rt_bow' },
  },
  attack_effects: {
    setup: sxSkill,
    modify: (pool) => pool.query("UPDATE creature_skills SET cooldown_ms = cooldown_ms + 1 WHERE name = 'sx_rt_skill'"),
    modified: { table: 'creature_skills', col: 'name', key: 'sx_rt_skill' },
  },
  aura_effects: {
    setup: (pool) => pool.query("INSERT INTO aura_effects (name, radius, dot_element) VALUES ('sx_rt_aura', 50, 'fire')"),
    modify: (pool) => pool.query("UPDATE aura_effects SET radius = radius + 1 WHERE name = 'sx_rt_aura'"),
    modified: { table: 'aura_effects', col: 'name', key: 'sx_rt_aura' },
  },
  creature_behaviors: {
    async setup(pool) {
      await sxItems(pool);
      await sxSkill(pool);
      await sxBehavior(pool);
      const beh = await idOf(pool, 'creature_behaviors', 'name', 'sx_rt_beh');
      const skill = await idOf(pool, 'creature_skills', 'name', 'sx_rt_skill');
      const gem = await idOf(pool, 'item_types', 'name', 'sx_rt_gem');
      await pool.query(`INSERT INTO creature_abilities (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown)
        VALUES ($1, 1, 'sx_rt_bite', 'melee', 10, 1)`, [beh]);
      await pool.query('INSERT INTO creature_behavior_skills (behavior_id, skill_id, slot) VALUES ($1, $2, 1)', [beh, skill]);
      await pool.query('INSERT INTO behavior_drops (behavior_id, item_type_id, chance) VALUES ($1, $2, 0.5)', [beh, gem]);
      // Level band far above any real chest_loot row.
      await pool.query('INSERT INTO chest_loot (level_min, level_max, item_type_id, chance) VALUES (9001, 9002, $1, 0.5)', [gem]);
    },
    modify: (pool) => pool.query(`UPDATE creature_abilities SET damage_mult = damage_mult + 1
      WHERE name = 'sx_rt_bite'`),
    modified: { table: 'creature_abilities', col: 'name', key: 'sx_rt_bite' },
  },
  entities: {
    async setup(pool) {
      await sxItems(pool);
      await sxBehavior(pool);
      const beh = await idOf(pool, 'creature_behaviors', 'name', 'sx_rt_beh');
      await pool.query(`INSERT INTO entity_types (name, color, behavior_id, element, point_kind, spawn_tiles, auras, is_creature)
        VALUES ('sx_rt_ent', '#123456', $1, 'ice', 'portal', '["grass"]'::jsonb, '[]'::jsonb, true)`, [beh]);
      const ent = await idOf(pool, 'entity_types', 'name', 'sx_rt_ent');
      const gem = await idOf(pool, 'item_types', 'name', 'sx_rt_gem');
      const bow = await idOf(pool, 'item_types', 'name', 'sx_rt_bow');
      await pool.query('INSERT INTO creature_drops (entity_type_id, item_type_id, chance) VALUES ($1, $2, 0.25)', [ent, gem]);
      await pool.query(`INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity, socket_into_item_type_id)
        VALUES ($1, $2, 1, $3)`, [ent, gem, bow]);
    },
    modify: (pool) => pool.query("UPDATE entity_types SET hp = hp + 1 WHERE name = 'sx_rt_ent'"),
    modified: { table: 'entity_types', col: 'name', key: 'sx_rt_ent' },
  },
  biomes: {
    setup: (pool) => pool.query(`INSERT INTO biomes (name, terrain_tiles, path_tile)
      VALUES ('sx_rt_biome', '["grass"]'::jsonb, 'grass')`),
    modify: (pool) => pool.query("UPDATE biomes SET creature_density = creature_density + 1 WHERE name = 'sx_rt_biome'"),
    modified: { table: 'biomes', col: 'name', key: 'sx_rt_biome' },
  },
  // sx_ nodes/edges only: the real tree is never written (other test files
  // read it).
  skill_tree: {
    async setup(pool) {
      await pool.query(`INSERT INTO passive_nodes (key, sector, ring, x, y, kind, label, grants) VALUES
        ('sx_rt_n1', 'core', 4, 9001, 9001, 'minor', 'sx one', '[{"stat":"strength","amount":1}]'::jsonb),
        ('sx_rt_n2', 'core', 4, 9002, 9002, 'notable', 'sx two', '[]'::jsonb)`);
      const a = await idOf(pool, 'passive_nodes', 'key', 'sx_rt_n1');
      const b = await idOf(pool, 'passive_nodes', 'key', 'sx_rt_n2');
      await pool.query('INSERT INTO passive_edges (a_id, b_id) VALUES ($1, $2)', [a, b]);
    },
    modify: (pool) => pool.query("UPDATE passive_nodes SET label = 'sx changed' WHERE key = 'sx_rt_n2'"),
    modified: { table: 'passive_nodes', col: 'key', key: 'sx_rt_n2' },
  },
  // game_settings has only real keys (unknown keys are invalid_value): touch
  // respec_base_gold and restore it exactly (the seed restores it; the
  // finally restores it whatever happens).
  progression: {
    setup: async () => {},
    modify: (pool) => pool.query("UPDATE game_settings SET value = to_jsonb((value)::int + 1) WHERE key = 'respec_base_gold'"),
    modified: { table: 'game_settings', col: 'key', key: 'respec_base_gold' },
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Every row of every table: no `id`; each ref column (registry refs) null, a
// uuid of an existing target row (by uuid) or an existing target key (by key).
async function assertRefsTranslated(pool, groupId, doc) {
  let refValues = 0;
  for (const spec of tableSpecs(getGroup(groupId))) {
    const targets = {};
    for (const [col, ref] of Object.entries(spec.refs)) {
      const valueCol = ref.by === 'uuid' ? 'sync_uuid' : ref.keyCol;
      targets[col] = new Set((await pool.query(`SELECT ${valueCol}::text AS v FROM ${ref.table}`)).rows.map((r) => r.v));
    }
    for (const row of doc.tables[spec.table]) {
      assert.ok(!('id' in row), `${spec.table}: id exported`);
      for (const [col, ref] of Object.entries(spec.refs)) {
        const v = row[col];
        if (v === null) continue;
        refValues += 1;
        assert.strictEqual(typeof v, 'string', `${spec.table}.${col} = ${JSON.stringify(v)} is not translated`);
        if (ref.by === 'uuid') assert.match(v, UUID_RE, `${spec.table}.${col}`);
        assert.ok(targets[col].has(v), `${spec.table}.${col} = ${v} names no ${ref.table} row`);
      }
    }
  }
  if (groupId !== 'progression' && groupId !== 'biomes' && groupId !== 'attack_effects') {
    assert.ok(refValues > 0, `${groupId}: some ref values were checked`);
  }
}

// Exactly the rows a test may list in a diff: its own sx_ rows (or the one
// real setting it touches).
async function onlyModifiedListed(pool, groupId, uuid) {
  const d = await previewSeed(pool, groupId);
  assert.deepStrictEqual(d.rows.map((r) => [r.table, r.syncUuid, r.kind]),
    [[FIXTURES[groupId].modified.table, uuid, 'not_exported']], `${groupId}: only the modified row is listed`);
  return d;
}

for (const groupId of PLAN2) {
  dbTest(`${groupId}: export twice byte-identical; seed back with take-git restores it; diff in_sync`, async (t, pool) => {
    const fx = FIXTURES[groupId];
    const realSetting = await q1(pool, "SELECT value FROM game_settings WHERE key = 'respec_base_gold'");
    try {
      await fx.setup(pool);
      await exportGroup(pool, groupId);
      const first = fileNoStamp(groupId);
      await exportGroup(pool, groupId);
      assert.strictEqual(fileNoStamp(groupId), first, 'second export is byte-identical');
      const doc = JSON.parse(first);
      assert.deepStrictEqual(Object.keys(doc.tables).sort(), Object.keys(doc.header.row_counts).sort());
      // Every table of the group carries a row the test made (or, for
      // progression, the real settings).
      for (const [table, rows] of Object.entries(doc.tables)) assert.ok(rows.length > 0, `${groupId}.${table} exported rows`);
      // No numeric local id ever reaches a file: every ref column (from the
      // registry) holds a uuid or its target's natural key.
      await assertRefsTranslated(pool, groupId, doc);

      const { table, col, key } = fx.modified;
      const uuid = await uuidOf(pool, table, col, key);
      await fx.modify(pool);
      const d = await onlyModifiedListed(pool, groupId, uuid);
      await applySeed(pool, groupId, { [uuid]: 'git' }, { signature: d.signature });

      await exportGroup(pool, groupId);
      assert.strictEqual(fileNoStamp(groupId), first, 'export after the seed equals the first export');
      const after = await diffGroup(pool, groupId);
      assert.strictEqual(after.status, 'in_sync');
      assert.deepStrictEqual(after.rows, []);
      assert.strictEqual(after.gitChanges, 0);
    } finally {
      await pool.query("UPDATE game_settings SET value = $1::jsonb WHERE key = 'respec_base_gold'",
        [JSON.stringify(realSetting.value)]);
    }
    assert.deepStrictEqual((await q1(pool, "SELECT value FROM game_settings WHERE key = 'respec_base_gold'")).value,
      realSetting.value, 'real setting restored');
  });
}

dbTest('items: lookup refs travel as names, the ammo ref as a uuid', async (t, pool) => {
  await sxItems(pool);
  await exportGroup(pool, 'items');
  const doc = JSON.parse(fs.readFileSync(fileFor('items'), 'utf8'));
  const bow = doc.tables.item_types.find((r) => r.name === 'sx_rt_bow');
  const local = await q1(pool, `SELECT i.attack_origin, ib.name AS impact, ps.name AS shape
      FROM item_types i JOIN impact_behaviors ib ON ib.id = i.impact_behavior_id
      JOIN projectile_shapes ps ON ps.id = i.projectile_shape_id WHERE i.name = 'sx_rt_bow'`);
  assert.strictEqual(bow.impact_behavior_id, local.impact);
  assert.strictEqual(bow.projectile_shape_id, local.shape);
  assert.strictEqual(bow.attack_origin, local.attack_origin);
  assert.strictEqual(bow.element, 'fire');
  assert.strictEqual(bow.ammo_type_id, await uuidOf(pool, 'item_types', 'name', 'sx_rt_ammo'));
  assert.ok(!('icon' in bow) && !('id' in bow));
});

// The ref columns travel as the target's uuid / natural key, and resolve back.
dbTest('entities: refs travel as uuid/key and composite keys show the parents\' names', async (t, pool) => {
  await FIXTURES.entities.setup(pool);
  await exportGroup(pool, 'entities');
  const doc = JSON.parse(fs.readFileSync(fileFor('entities'), 'utf8'));
  const ent = doc.tables.entity_types.find((r) => r.name === 'sx_rt_ent');
  assert.strictEqual(ent.behavior_id, await uuidOf(pool, 'creature_behaviors', 'name', 'sx_rt_beh'));
  assert.strictEqual(ent.element, 'ice');
  assert.strictEqual(ent.point_kind, 'portal');
  for (const c of ['image', 'sprite', 'render_mode', 'display_width', 'display_height', 'prompt', 'ai_provider_mode', 'id']) {
    assert.ok(!(c in ent), `entity_types.${c} not exported`);
  }
  const lo = doc.tables.class_loadouts.find((r) => r.entity_type_id === ent.sync_uuid);
  assert.strictEqual(lo.item_type_id, await uuidOf(pool, 'item_types', 'name', 'sx_rt_gem'));
  assert.strictEqual(lo.socket_into_item_type_id, await uuidOf(pool, 'item_types', 'name', 'sx_rt_bow'));
  await pool.query(`UPDATE creature_drops SET chance = 0.75
    WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sx_rt_ent')`);
  const p = await previewSeed(pool, 'entities');
  assert.deepStrictEqual(p.rows.map((r) => [r.table, r.key, r.keyParts, r.kind]),
    [['creature_drops', 'sx_rt_ent → sx_rt_gem', ['sx_rt_ent', 'sx_rt_gem'], 'not_exported']]);
});

// ---- Task 5 carry-over (b): transitive blocking -----------------------------

// sx_rt_bow uses sx_rt_ammo (item_types.ammo_type_id, in-group); a chest_loot
// row (creature_behaviors group: outside items) references sx_rt_bow. Both are
// deleted in git: sx_rt_bow is blocked by chest_loot, defaults to keep, and so
// blocks sx_rt_ammo too (the fixpoint's second iteration).
dbTest('transitive blocking: a child blocked by an outside ref blocks its parent; both intact', async (t, pool) => {
  await sxItems(pool);
  const bow = await idOf(pool, 'item_types', 'name', 'sx_rt_bow');
  await pool.query('INSERT INTO chest_loot (level_min, level_max, item_type_id, chance) VALUES (9001, 9002, $1, 0.5)', [bow]);
  await exportGroup(pool, 'items');
  const file = fileFor('items');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.tables.item_types = doc.tables.item_types.filter((r) => !['sx_rt_bow', 'sx_rt_ammo'].includes(r.name));
  doc.header.row_counts.item_types = doc.tables.item_types.length;
  fs.writeFileSync(file, `${stableStringify(doc)}\n`);

  const ammoUuid = await uuidOf(pool, 'item_types', 'name', 'sx_rt_ammo');
  const bowUuid = await uuidOf(pool, 'item_types', 'name', 'sx_rt_bow');
  const p = await previewSeed(pool, 'items');
  const row = (u) => p.rows.find((r) => r.syncUuid === u);
  assert.deepStrictEqual(p.rows.map((r) => r.syncUuid).sort(), [ammoUuid, bowUuid].sort());
  assert.strictEqual(row(bowUuid).kind, 'deleted_in_git');
  assert.strictEqual(row(bowUuid).blockedReason, '1 rows in chest_loot reference this');
  assert.strictEqual(row(bowUuid).defaultDecision, 'local');
  assert.strictEqual(row(ammoUuid).kind, 'deleted_in_git');
  assert.strictEqual(row(ammoUuid).blockedReason, '1 rows in item_types reference this');
  assert.strictEqual(row(ammoUuid).defaultDecision, 'local');

  for (const decisions of [{ [ammoUuid]: 'delete' }, { [ammoUuid]: 'delete', [bowUuid]: 'delete' }]) {
    await assert.rejects(applySeed(pool, 'items', decisions, { signature: p.signature }), (e) => {
      assert.ok(e instanceof SyncRefused);
      assert.strictEqual(e.code, 'blocked');
      assert.ok(e.details.uuids.includes(ammoUuid));
      return true;
    });
  }
  assert.strictEqual((await pool.query("SELECT 1 FROM item_types WHERE name IN ('sx_rt_ammo', 'sx_rt_bow')")).rowCount, 2);
  assert.strictEqual((await q1(pool, "SELECT ammo_type_id FROM item_types WHERE name = 'sx_rt_bow'")).ammo_type_id,
    await idOf(pool, 'item_types', 'name', 'sx_rt_ammo'));
  assert.strictEqual((await pool.query('SELECT 1 FROM chest_loot WHERE item_type_id = $1', [bow])).rowCount, 1);
});

// ---- Task 5 carry-over (c): preview shows would-be refusals ------------------

dbTest('preview warns missing_ref (default decisions, read-only); apply still refuses', async (t, pool) => {
  await sxItems(pool);
  await sxBehavior(pool);
  const beh = await idOf(pool, 'creature_behaviors', 'name', 'sx_rt_beh');
  await pool.query(`INSERT INTO entity_types (name, color, behavior_id) VALUES ('sx_rt_ent', '#123456', $1)`, [beh]);
  await exportGroup(pool, 'entities');
  const file = fileFor('entities');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  // git: the entity now uses a behavior that exists neither here nor in git.
  const ghost = '00000000-0000-4000-8000-00000000beef';
  doc.tables.entity_types.find((r) => r.name === 'sx_rt_ent').behavior_id = ghost;
  fs.writeFileSync(file, `${stableStringify(doc)}\n`);

  const p = await previewSeed(pool, 'entities');
  assert.deepStrictEqual(p.rows.map((r) => [r.key, r.kind, r.defaultDecision]), [['sx_rt_ent', 'changed', 'git']]);
  assert.deepStrictEqual(p.warnings.filter((w) => w.code === 'missing_ref'), [
    { code: 'missing_ref', table: 'entity_types', key: 'sx_rt_ent', column: 'behavior_id', target: 'creature_behaviors' },
  ]);
  // The preview itself wrote nothing.
  assert.strictEqual((await q1(pool, "SELECT behavior_id FROM entity_types WHERE name = 'sx_rt_ent'")).behavior_id, beh);
  await assert.rejects(applySeed(pool, 'entities', {}, { signature: p.signature }),
    (e) => e instanceof SyncRefused && e.code === 'missing_ref');
  assert.strictEqual((await q1(pool, "SELECT behavior_id FROM entity_types WHERE name = 'sx_rt_ent'")).behavior_id, beh);
});

dbTest('preview warns invalid_value for a game setting git would write; apply still refuses', async (t, pool) => {
  const real = await q1(pool, "SELECT value FROM game_settings WHERE key = 'respec_base_gold'");
  await exportGroup(pool, 'progression');
  const file = fileFor('progression');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.tables.game_settings.find((r) => r.key === 'respec_base_gold').value = -1;
  fs.writeFileSync(file, `${stableStringify(doc)}\n`);

  const p = await previewSeed(pool, 'progression');
  assert.deepStrictEqual(p.rows.map((r) => [r.key, r.kind, r.defaultDecision]), [['respec_base_gold', 'changed', 'git']]);
  assert.deepStrictEqual(p.warnings.filter((w) => w.code === 'invalid_value'), [
    { code: 'invalid_value', key: 'respec_base_gold', error: 'respec_base_gold must be an integer >= 0' },
  ]);
  await assert.rejects(applySeed(pool, 'progression', {}, { signature: p.signature }),
    (e) => e instanceof SyncRefused && e.code === 'invalid_value');
  assert.deepStrictEqual((await q1(pool, "SELECT value FROM game_settings WHERE key = 'respec_base_gold'")).value, real.value);
});

// ---- Final review (1): passive_edges is an unordered pair -------------------
// CHECK (a_id < b_id) is on LOCAL ids, which follow insertion order: the same
// edge is (X,Y) on one PC and (Y,X) on another. Identity, file and hashes must
// follow the node KEYS (code-unit order), never local id order.

const { deterministicUuid } = require('../src/services/seedSync/canonical.js');
const { pairKeyCol, specOfTable } = require('../src/services/seedSync/registry.js');
const plan2Migration = require('../migrations/1714440790000_seed_sync_plan2.js');

const PE_NODE = {
  sx_pe_a: ['core', 4, 9101, 9101, 'minor', 'sx pe a'],
  sx_pe_b: ['core', 4, 9102, 9102, 'minor', 'sx pe b'],
};

// Inserts the sx_pe_ nodes in `order` (ids follow it), with `uuids` when
// given, then the edge between them as LEAST/GREATEST local ids.
async function sxPairEdge(pool, order, { uuids = {}, edgeUuid = null } = {}) {
  for (const key of order) {
    const [sector, ring, x, y, kind, label] = PE_NODE[key];
    await pool.query(`INSERT INTO passive_nodes (key, sector, ring, x, y, kind, label, grants, sync_uuid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, coalesce($8::uuid, gen_random_uuid()))`,
    [key, sector, ring, x, y, kind, label, uuids[key] || null]);
  }
  const a = await idOf(pool, 'passive_nodes', 'key', 'sx_pe_a');
  const b = await idOf(pool, 'passive_nodes', 'key', 'sx_pe_b');
  await pool.query(`INSERT INTO passive_edges (a_id, b_id, sync_uuid)
    VALUES ($1, $2, coalesce($3::uuid, gen_random_uuid()))`, [Math.min(a, b), Math.max(a, b), edgeUuid]);
  return { a, b };
}

const peEdge = async (pool) => q1(pool, `SELECT e.a_id, e.b_id, e.sync_uuid FROM passive_edges e
  JOIN passive_nodes n ON n.id = e.a_id WHERE n.key LIKE 'sx\\_pe\\_%'`);
const sxRows = (d) => d.rows.filter((r) => String(r.key).includes('sx_pe_'));

dbTest('skill_tree: passive_edges unorderedPair targets passive_nodes.key', async () => {
  assert.deepStrictEqual(pairKeyCol(specOfTable('passive_edges')), { table: 'passive_nodes', keyCol: 'key' });
});

dbTest('skill_tree: an edge stored against key order -> LEAST/GREATEST backfill uuid, key-ordered file, take-git writes LEAST/GREATEST ids', async (t, pool) => {
  // b first: id(b) < id(a), so the stored pair is (b, a) -- the reverse of key order.
  const { a, b } = await sxPairEdge(pool, ['sx_pe_b', 'sx_pe_a']);
  assert.ok(b < a, 'local id order is the reverse of key order');
  assert.deepStrictEqual(await peEdge(pool).then((e) => [e.a_id, e.b_id]), [b, a]);

  // The migration's own backfill expression gives the key-ordered uuid.
  const [, keyExpr, joins] = plan2Migration._TABLES.find(([table]) => table === 'passive_edges');
  const sqlUuid = (await q1(pool, `SELECT md5('s2sync:passive_edges:' || ${keyExpr})::uuid::text AS u
    FROM passive_edges t ${joins} WHERE t.a_id = $1 AND t.b_id = $2`, [b, a])).u;
  assert.strictEqual(sqlUuid, deterministicUuid('passive_edges', 'sx_pe_a|sx_pe_b'));

  await exportGroup(pool, 'skill_tree');
  const edgeUuid = (await peEdge(pool)).sync_uuid;
  const doc = JSON.parse(fs.readFileSync(fileFor('skill_tree'), 'utf8'));
  const fileEdge = doc.tables.passive_edges.find((r) => r.sync_uuid === edgeUuid);
  assert.strictEqual(fileEdge.a_id, await uuidOf(pool, 'passive_nodes', 'key', 'sx_pe_a'), 'file pair is key-ordered');
  assert.strictEqual(fileEdge.b_id, await uuidOf(pool, 'passive_nodes', 'key', 'sx_pe_b'));
  assert.strictEqual((await diffGroup(pool, 'skill_tree')).status, 'in_sync', 'export then diff is in sync');

  // Round trip: the edge deleted here, seeded back from git (take git).
  await pool.query('DELETE FROM passive_edges WHERE sync_uuid = $1', [edgeUuid]);
  const p = await previewSeed(pool, 'skill_tree');
  assert.deepStrictEqual(p.rows.map((r) => [r.table, r.syncUuid, r.key, r.kind]),
    [['passive_edges', edgeUuid, 'sx_pe_a → sx_pe_b', 'deleted_here']]);
  await applySeed(pool, 'skill_tree', { [edgeUuid]: 'git' }, { signature: p.signature }); // no 23514
  assert.deepStrictEqual(await peEdge(pool), { a_id: b, b_id: a, sync_uuid: edgeUuid }, 'written LEAST/GREATEST');
  const after = await diffGroup(pool, 'skill_tree');
  assert.strictEqual(after.status, 'in_sync');
  assert.deepStrictEqual(after.rows, []);
});

dbTest('skill_tree: a second PC with the edge stored in swapped local id order diffs in sync / adopt, never new + only_here', async (t, pool) => {
  // PC 1: ids against key order; export.
  await sxPairEdge(pool, ['sx_pe_b', 'sx_pe_a']);
  await exportGroup(pool, 'skill_tree');
  const uuids = {
    sx_pe_a: await uuidOf(pool, 'passive_nodes', 'key', 'sx_pe_a'),
    sx_pe_b: await uuidOf(pool, 'passive_nodes', 'key', 'sx_pe_b'),
  };
  const edgeUuid = (await peEdge(pool)).sync_uuid;

  // PC 2: same nodes (same uuids), inserted in key order, so the stored pair
  // is (a, b): swapped relative to PC 1. Same edge uuid (the deterministic
  // backfill gives it on both PCs).
  await pool.query("DELETE FROM passive_nodes WHERE key LIKE 'sx\\_pe\\_%'"); // edge cascades
  const { a, b } = await sxPairEdge(pool, ['sx_pe_a', 'sx_pe_b'], { uuids, edgeUuid });
  assert.ok(a < b, 'PC 2 local id order follows key order');
  const same = await diffGroup(pool, 'skill_tree');
  assert.deepStrictEqual(sxRows(same), [], 'same edge, swapped local ids: in sync');
  assert.strictEqual(same.status, 'in_sync');

  // PC 2 created the edge itself after the migration: a random uuid. It is
  // the same edge by its (key-ordered) deep key: adopt, nothing to decide.
  await pool.query('DELETE FROM passive_edges WHERE sync_uuid = $1', [edgeUuid]);
  await pool.query('INSERT INTO passive_edges (a_id, b_id) VALUES ($1, $2)', [a, b]);
  const fresh = await diffGroup(pool, 'skill_tree');
  assert.deepStrictEqual(sxRows(fresh).map((r) => [r.table, r.syncUuid, r.key, r.kind, r.fields, r.defaultDecision]),
    [['passive_edges', edgeUuid, 'sx_pe_a → sx_pe_b', 'adopt_identity', [], 'git']]);
});

// ---- Final review (2): a stale baseline of an in-sync row is refreshed -------

dbTest('aura_effects: an in-sync row with a stale baseline gets B = hL on the next seed; a later git-only change is `changed`', async (t, pool) => {
  await pool.query("INSERT INTO aura_effects (name, radius, dot_element) VALUES ('sx_bl_aura', 50, 'fire')");
  await exportGroup(pool, 'aura_effects');
  const uuid = await uuidOf(pool, 'aura_effects', 'name', 'sx_bl_aura');
  const baseOf = async () => (await q1(pool,
    "SELECT hash FROM seed_row_hashes WHERE group_id = 'aura_effects' AND sync_uuid = $1", [uuid])).hash;
  const hL = await baseOf();
  await pool.query("UPDATE seed_row_hashes SET hash = 'stale' WHERE group_id = 'aura_effects' AND sync_uuid = $1", [uuid]);

  const p = await previewSeed(pool, 'aura_effects');
  assert.deepStrictEqual(p.rows, [], 'local == git: nothing listed');
  await applySeed(pool, 'aura_effects', {}, { signature: p.signature });
  assert.strictEqual(await baseOf(), hL, 'baseline refreshed to the local hash');

  const file = fileFor('aura_effects');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.tables.aura_effects.find((r) => r.name === 'sx_bl_aura').radius = 70;
  fs.writeFileSync(file, `${stableStringify(doc)}\n`);
  const d = await diffGroup(pool, 'aura_effects');
  assert.deepStrictEqual(d.rows.map((r) => [r.key, r.kind]), [['sx_bl_aura', 'changed']]);
});

test('mapWriteError: a check violation (23514) is a conflict refusal naming the constraint, never a 500', () => {
  const { _mapWriteError } = require('../src/services/seedSync/applySeed.js');
  const e = _mapWriteError(Object.assign(new Error('violates check'), { code: '23514', constraint: 'passive_edges_ordered' }));
  assert.ok(e instanceof SyncRefused);
  assert.strictEqual(e.code, 'conflict');
  assert.deepStrictEqual(e.details, { constraint: 'passive_edges_ordered' });
});
