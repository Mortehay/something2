// backend/tests/boss_attack_kits_db.test.js
// Pins 1714440873000_world_boss_attack_kits against a real, freshly migrated database
// (read-only apart from one rolled-back transaction): the widened skill kinds, the new
// columns and their defaults, each world boss's kit as the sim will load it, and the
// sprite columns on vfx_effects.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { SKILLS, EFFECTS } = require('../migrations/1714440873000_world_boss_attack_kits.js');
const { ENTITY_CATALOG_SELECT } = require('../src/authority/creatures.js');
const { resolveBehavior } = require('../src/services/creatureBehaviors.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to read a real database' : false;

const BOSSES = [
  'Ignis, the Magma Colossus', 'Glacius, the Frost Leviathan', 'Abyssor, the Voidreaver', 'Gorgon, the Thunder Titan',
];

test('every new skill and effect row exists, with its own deterministic sync_uuid', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const s = await pool.query('SELECT name, kind, params, sync_uuid FROM creature_skills WHERE name = ANY($1::text[])', [SKILLS.map((x) => x[0])]);
    assert.equal(s.rowCount, SKILLS.length);
    const e = await pool.query('SELECT name FROM vfx_effects WHERE name = ANY($1::text[])', [EFFECTS.map((x) => x[0])]);
    assert.equal(e.rowCount, EFFECTS.length);
    const u = await pool.query("SELECT md5('s2sync:creature_skills:' || 'Lava Ring')::uuid AS id");
    assert.equal(s.rows.find((r) => r.name === 'Lava Ring').sync_uuid, u.rows[0].id, 'the same uuid on every machine');
  } finally { await pool.end(); }
});

test('the kind check admits the boss kinds and still refuses nonsense', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const kind of ['charge', 'blink', 'rain', 'chain']) {
      await client.query('SAVEPOINT s');
      await client.query('INSERT INTO creature_skills (name, kind, cooldown_ms) VALUES ($1, $2, 1000)', [`__t_${kind}`, kind]);
      await client.query('RELEASE SAVEPOINT s');
    }
    await client.query('SAVEPOINT bad');
    await assert.rejects(client.query("INSERT INTO creature_skills (name, kind, cooldown_ms) VALUES ('__t_bad', 'teleport', 1000)"), /creature_skills_kind_check/);
    await client.query('ROLLBACK TO SAVEPOINT bad');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

test('each world boss loads its kit through the real catalog query, gated and ordered', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(`${ENTITY_CATALOG_SELECT} WHERE et.boss_tier = 'world' ORDER BY et.id`);
    assert.equal(r.rowCount, 4);
    for (const row of r.rows) {
      assert.ok(BOSSES.includes(row.name));
      const bh = resolveBehavior(row);
      const skills = bh.skills;
      assert.ok(skills.length >= 7, `${row.name}: ${skills.length} skills`);
      assert.deepEqual(skills.map((x) => x.slot), [...skills.map((x) => x.slot)].sort((a, b) => a - b), 'in slot order');
      const cat = skills.find((x) => /Cataclysm$/.test(x.name));
      assert.ok(cat, `${row.name}: an ultimate`);
      assert.equal(cat.ultimate, true);
      assert.equal(cat.minPhase, 3);
      assert.ok(skills.some((x) => x.requiresEnrage), `${row.name}: an enrage-only binding`);
      // The two original skills stay first and ungated.
      assert.deepEqual(skills.slice(0, 2).map((x) => [x.minPhase, x.requiresEnrage]), [[1, false], [1, false]]);
    }
    const ignis = resolveBehavior(r.rows.find((x) => x.name === BOSSES[0])).skills;
    assert.equal(ignis.find((x) => x.name === 'Lava Ring').innerRadius, 110);
    assert.equal(ignis.find((x) => x.name === 'Meteor Shower').zones.length, 6);
    assert.equal(ignis.find((x) => x.name === 'Blazing Charge').dashDistance, 520);
    const gorgon = resolveBehavior(r.rows.find((x) => x.name === BOSSES[3])).skills;
    assert.equal(gorgon.find((x) => x.name === 'Chain Lightning').hits, 4);
    const abyssor = resolveBehavior(r.rows.find((x) => x.name === BOSSES[2])).skills;
    assert.equal(abyssor.find((x) => x.name === 'Gravity Well').pull, 160);
    assert.equal(abyssor.find((x) => x.name === 'Void Orbs').projectileCount, 5);
  } finally { await pool.end(); }
});

test('every new skill names effect rows that exist (the telegraph and cast are its own)', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT s.name, s.vfx FROM creature_skills s WHERE s.name = ANY($1::text[])`, [SKILLS.map((x) => x[0])]);
    const known = new Set((await pool.query('SELECT name FROM vfx_effects')).rows.map((x) => x.name));
    for (const row of r.rows) {
      for (const moment of ['telegraph', 'cast', 'impact']) {
        assert.ok(known.has(row.vfx[moment]), `${row.name}: ${moment} -> ${row.vfx[moment]}`);
      }
    }
  } finally { await pool.end(); }
});

test('vfx_effects sprite columns default to "no sprite" and are range-checked', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const old = await pool.query("SELECT sprite_image, sprite_frames, sprite_size, sprite_additive FROM vfx_effects WHERE name = 'sweep_arc'");
    assert.deepEqual(old.rows[0], { sprite_image: null, sprite_frames: 1, sprite_size: 0, sprite_additive: false });
    await client.query('BEGIN');
    await client.query('SAVEPOINT a');
    await assert.rejects(client.query("INSERT INTO vfx_effects (name, shape, sprite_frames) VALUES ('__t', 'burst', 0)"), /vfx_effects_sprite_frames_check/);
    await client.query('ROLLBACK TO SAVEPOINT a');
    await assert.rejects(client.query("INSERT INTO vfx_effects (name, shape, sprite_size) VALUES ('__t', 'burst', 5000)"), /vfx_effects_sprite_size_check/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

test('creature_behavior_skills gates default to the old behaviour', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM creature_behavior_skills cbs
         JOIN creature_behaviors b ON b.id = cbs.behavior_id
        WHERE b.name NOT IN (${BOSSES.map((_, i) => `$${i + 1}`).join(',')}) AND (cbs.min_phase <> 1 OR cbs.requires_enrage)`,
      BOSSES);
    assert.equal(r.rows[0].n, 0, 'no other creature is gated');
  } finally { await pool.end(); }
});
