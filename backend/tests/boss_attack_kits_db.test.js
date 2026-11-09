// backend/tests/boss_attack_kits_db.test.js
// Pins the world bosses' kits as they stand after every migration (1714440873000 built the
// schema, 1714440874000 gave each boss its own distinct kit) against a real, freshly migrated
// database (read-only apart from rolled-back transactions): the widened skill kinds, the new
// columns and their defaults, each boss's kit as the sim will load it, and the sprite columns.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { SKILLS, EFFECTS, OBSOLETE } = require('../migrations/1714440874000_world_boss_distinct_kits.js');
const { ENTITY_CATALOG_SELECT } = require('../src/authority/creatures.js');
const { resolveBehavior } = require('../src/services/creatureBehaviors.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to read a real database' : false;

const IGNIS = 'Ignis, the Magma Colossus';
const GLACIUS = 'Glacius, the Frost Leviathan';
const ABYSSOR = 'Abyssor, the Voidreaver';
const GORGON = 'Gorgon, the Thunder Titan';
const BOSSES = [IGNIS, GLACIUS, ABYSSOR, GORGON];

test('every new skill and effect row exists, with its own deterministic sync_uuid', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const s = await pool.query('SELECT name, kind, params, sync_uuid FROM creature_skills WHERE name = ANY($1::text[])', [SKILLS.map((x) => x[0])]);
    assert.equal(s.rowCount, SKILLS.length);
    const e = await pool.query('SELECT name FROM vfx_effects WHERE name = ANY($1::text[])', [EFFECTS.map((x) => x[0])]);
    assert.equal(e.rowCount, EFFECTS.length);
    const u = await pool.query("SELECT md5('s2sync:creature_skills:' || 'Lava Pools')::uuid AS id");
    assert.equal(s.rows.find((r) => r.name === 'Lava Pools').sync_uuid, u.rows[0].id, 'the same uuid on every machine');
  } finally { await pool.end(); }
});

test('the skills the bosses no longer use are gone', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query('SELECT name FROM creature_skills WHERE name = ANY($1::text[])', [OBSOLETE]);
    assert.deepEqual(r.rows, []);
  } finally { await pool.end(); }
});

test('the kind check admits every boss kind and still refuses nonsense', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const kind of ['charge', 'blink', 'rain', 'chain', 'zone', 'mark', 'shelter']) {
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

async function loadKits(pool) {
  const r = await pool.query(`${ENTITY_CATALOG_SELECT} WHERE et.boss_tier = 'world' ORDER BY et.id`);
  assert.equal(r.rowCount, 4);
  return Object.fromEntries(r.rows.map((row) => [row.name, resolveBehavior(row).skills]));
}

test('each world boss loads five or six attacks through the real catalog query, ultimate first', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const kits = await loadKits(pool);
    for (const boss of BOSSES) {
      const skills = kits[boss];
      assert.ok(skills.length >= 5 && skills.length <= 6, `${boss}: ${skills.length} skills`);
      assert.deepEqual(skills.map((x) => x.slot), skills.map((_, i) => i + 1), 'slots 1..n in priority order');
      assert.equal(skills[0].ultimate, true, `${boss}: the ultimate comes first`);
      assert.equal(skills[0].minPhase, 4);
      assert.equal(skills[skills.length - 1].minPhase, 1, 'plain filler last');
      assert.ok(!skills.some((x) => x.requiresEnrage), 'no enrage-only duplicates');
      assert.equal(new Set(skills.map((x) => x.name)).size, skills.length, 'no skill twice');
    }
  } finally { await pool.end(); }
});

test('the mechanics survive the round trip through the database', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const kits = await loadKits(pool);
    const by = (boss, name) => kits[boss].find((x) => x.name === name);
    // Ignis: ground that stays
    assert.equal(by(IGNIS, 'Lava Pools').hazard.pattern, 'targets');
    assert.equal(by(IGNIS, 'Lava Pools').hazard.count, 4);
    assert.equal(by(IGNIS, 'Scorched Earth').hazard.pattern, 'ring');
    assert.equal(by(IGNIS, 'Scorched Earth').hazard.inner, 430);
    assert.equal(by(IGNIS, 'Ember Mark').mark.targets, 1);
    assert.equal(by(IGNIS, 'Meltdown').shelter.safeRadius, 150);
    // Glacius: control
    assert.equal(by(GLACIUS, 'Flash Freeze').status.rootS, 2.2);
    assert.equal(by(GLACIUS, 'Frost Field').hazard.slowPct, 65);
    assert.equal(by(GLACIUS, 'Frost Field').damageMult, 0);
    assert.equal(by(GLACIUS, 'Absolute Zero').status.rootS, 2.5);
    assert.equal(by(GLACIUS, 'Permafrost Nova').status.slowPct, 40, 'the original nova gained its slow');
    assert.equal(by(GLACIUS, 'Ice Spikes').zones.length, 6);
    // Gorgon: speed and chains
    assert.equal(by(GORGON, 'Static Charge').mark.all, true);
    assert.equal(by(GORGON, 'Thunderstorm').waves, 4);
    assert.equal(by(GORGON, 'Chain Lightning').hits, 4);
    assert.equal(by(GORGON, 'Storm Dash').dashDistance, 520);
    // Abyssor: space and mind
    assert.equal(by(ABYSSOR, 'Mind Rend').status.silenceS, 4);
    assert.equal(by(ABYSSOR, 'Reality Tear').status.silenceS, 3);
    assert.equal(by(ABYSSOR, 'Gravity Well').pull, 160);
    assert.equal(by(ABYSSOR, 'Void Orbs').projectileCount, 5);
  } finally { await pool.end(); }
});

test('every new skill names effect rows that exist', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query('SELECT s.name, s.vfx FROM creature_skills s WHERE s.name = ANY($1::text[])', [SKILLS.map((x) => x[0])]);
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

test('creature_behavior_skills gates default to the old behaviour for everyone else', { skip }, async () => {
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
