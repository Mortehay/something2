// backend/tests/seed_dungeon_bosses_db.test.js
// SOMET-609 (S9). An admin who deletes a dungeon boss gets it back from
// `make seed-catalogs` -- tiered, behaved, aura-bound and with its drop rule --
// not as an untiered plain creature (what seedOneCreatureType would restore).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { seedOneDungeonBoss } = require('../scripts/seed-catalogs.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

const ZZ = {
  name: 'zzS9 Restored Warden', boss_tier: 'dungeon_elite', element: 'physical', color: '#b8b09a',
  hp: 850, defense: 15, base_damage: 14, size: 72, xp_reward: 120, gold_min: 8, gold_max: 15,
  behavior_name: 'Champion', auras: ['ossuary_dread'], resistances: { ice: 0.4 },
  drop_item: 'short sword', prompt: 'test',
};

test('seedOneDungeonBoss inserts a complete boss once and never overwrites it', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    assert.equal(await seedOneDungeonBoss(c, ZZ), 1, 'first run inserts');
    const r = await c.query(
      `SELECT e.boss_tier, e.element, e.attack_element, e.hp, e.max_hp, e.hitbox_size, e.display_height,
              e.base_damage, e.auras, e.resistances, b.name AS behavior,
              (SELECT count(*)::int FROM creature_drops cd JOIN item_types it ON it.id = cd.item_type_id
                WHERE cd.entity_type_id = e.id AND it.name = 'short sword') AS drops
         FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id WHERE e.name = $1`, [ZZ.name]);
    assert.deepEqual(r.rows[0], {
      boss_tier: 'dungeon_elite', element: 'physical', attack_element: 'physical', hp: 850, max_hp: 850,
      hitbox_size: 72, display_height: 72, base_damage: 14, auras: ['ossuary_dread'],
      resistances: { ice: 0.4 }, behavior: 'Champion', drops: 1,
    });

    await c.query('UPDATE entity_types SET hp = 1 WHERE name = $1', [ZZ.name]);
    assert.equal(await seedOneDungeonBoss(c, ZZ), 0, 'second run is a no-op');
    const again = await c.query(
      `SELECT e.hp, (SELECT count(*)::int FROM creature_drops cd WHERE cd.entity_type_id = e.id) AS drops
         FROM entity_types e WHERE e.name = $1`, [ZZ.name]);
    assert.deepEqual(again.rows[0], { hp: 1, drops: 1 }, 'admin edit kept, no duplicate drop rule');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    await pool.end();
  }
});

const { DUNGEON_BOSSES } = require('../seeds/data/dungeonBosses.js');

const bossRows = (c) => c.query(
  `SELECT e.name, e.boss_tier, e.behavior_id,
          (SELECT count(*)::int FROM creature_drops cd WHERE cd.entity_type_id = e.id) AS drops
     FROM entity_types e WHERE e.name = ANY($1) ORDER BY e.name`, [DUNGEON_BOSSES.map((b) => b.name)]);

test('every real dungeon boss restores tiered, with a resolved behaviour and exactly one drop', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const names = DUNGEON_BOSSES.map((b) => b.name);
    await c.query('DELETE FROM creature_drops WHERE entity_type_id IN (SELECT id FROM entity_types WHERE name = ANY($1))', [names]);
    await c.query('DELETE FROM entity_types WHERE name = ANY($1)', [names]);
    let inserted = 0;
    for (const b of DUNGEON_BOSSES) inserted += await seedOneDungeonBoss(c, b);
    assert.equal(inserted, DUNGEON_BOSSES.length);
    const rows = (await bossRows(c)).rows;
    assert.equal(rows.length, DUNGEON_BOSSES.length);
    for (const r of rows) {
      const want = DUNGEON_BOSSES.find((b) => b.name === r.name);
      assert.equal(r.boss_tier, want.boss_tier, `${r.name} tier`);
      assert.notEqual(r.behavior_id, null, `${r.name} behavior_id resolved`);
      assert.equal(r.drops, 1, `${r.name} drop rule (${want.drop_item}) resolved`);
    }
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    await pool.end();
  }
});

test('P7: an existing boss keeps its admin-edited drops across a reseed', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const b = DUNGEON_BOSSES[0];
    await seedOneDungeonBoss(c, b); // present (real row or restored)
    await c.query('DELETE FROM creature_drops WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = $1)', [b.name]);
    assert.equal(await seedOneDungeonBoss(c, b), 0);
    const r = await c.query('SELECT count(*)::int AS n FROM creature_drops WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = $1)', [b.name]);
    assert.equal(r.rows[0].n, 0, 'admin-deleted drop rule must not be re-added');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    await pool.end();
  }
});
