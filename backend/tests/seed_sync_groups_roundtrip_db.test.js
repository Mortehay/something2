const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

// The real plan-2 groups this file exports/seeds (their baselines are dropped
// afterwards: they describe this test's temp files, not a real export).
const PLAN2 = ['items', 'attack_effects', 'aura_effects', 'creature_behaviors', 'entities', 'biomes', 'skill_tree', 'progression'];

let runWatermark = null;

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
    const dropState = async () => {
      await pool.query('DELETE FROM seed_row_hashes WHERE group_id = ANY($1::text[])', [PLAN2]);
      if (runWatermark !== null) {
        await pool.query('DELETE FROM seed_export_runs WHERE id > $1 AND group_id = ANY($2::text[])', [runWatermark, PLAN2]);
      }
    };
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      runWatermark = (await pool.query('SELECT coalesce(max(id), 0)::int AS m FROM seed_export_runs')).rows[0].m;
      try { await body(t, pool, dir); } finally {
        await dropState().catch(() => {});
        await cleanupSx(pool).catch(() => {});
      }
    });
  });
}

const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const { SyncRefused } = require('../src/services/seedSync/errors.js');
const { stableStringify } = require('../src/services/seedSync/canonical.js');

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
      // No numeric local id ever reaches a file: every FK travels as a uuid/key.
      assert.ok(!/"(id|a_id|b_id|behavior_id|item_type_id|entity_type_id|skill_id|ammo_type_id|socket_into_item_type_id)": \d/.test(first),
        'no raw local id in the file');

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
