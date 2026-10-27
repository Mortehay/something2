// backend/tests/creature_skills_api_db.test.js
// SOMET-608 (S6). Real-HTTP, real-DB tests for two surfaces:
//   1. /api/creature-skills -- the catalog's own CRUD (modelled on
//      aura_effects_api_db.test.js: real pg Pool via __setPool, disposable
//      users, t.after cleanup, gated on TEST_DATABASE_URL).
//   2. The `skills` array nested under /api/creature-behaviors (modelled on
//      creature_abilities_api_db.test.js), which binds an EXISTING catalog
//      skill by skill_id -- unlike an ability, there is nothing inline to
//      validate without a database, so this is where that half of
//      behaviorSkillsError is actually exercised.
//
// SAFETY: every fixture row is `zz`-prefixed and torn down by name/prefix in
// t.after, unconditionally. Never asserts against a real catalog row.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const tag = `${process.pid}${Date.now()}`;
const SKILL_A = `zzSkill${tag}`;
const SKILL_B = `zzSkillB${tag}`;
const BEHAVIOR = `zzSkillBehavior${tag}`;

const skillBody = (over = {}) => ({
  name: SKILL_A, kind: 'slam', telegraph_ms: 500, cooldown_ms: 4000,
  radius: 80, range: 200, damage_mult: 1, ...over,
});
const behaviorBody = (over = {}) => ({
  name: BEHAVIOR, aggro_radius: 300, leash_radius: 500, chase_style: 'charge', move_speed_mult: 1,
  abilities: [{
    name: 'Attack', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
    projectile_speed: 0, projectile_radius: 0, element: null, damage_mult: 1, knockback: 0,
  }],
  ...over,
});

async function makeUser(pool, role) {
  const r = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, token_version',
    [`creature-skill-${role}-${tag}-${Math.random().toString(36).slice(2)}`, 'x', role]);
  return { id: r.rows[0].id, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: 'x', role: u.role, tokenVersion: u.tokenVersion })}`;

test('creature skills catalog admin API', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const admin = await makeUser(pool, 'admin');
  const player = await makeUser(pool, 'player');
  t.after(async () => {
    await pool.query('DELETE FROM creature_behaviors WHERE name LIKE $1', [`zzSkillBehavior%`]).catch(() => {});
    await pool.query('DELETE FROM creature_skills WHERE name LIKE $1', [`zzSkill%`]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[admin.id, player.id]]).catch(() => {});
    await pool.end();
  });
  const as = (u) => ['Authorization', bearer(u)];
  let id;

  await t.test('GET is open, with no auth required', async () => {
    const r = await request(app).get('/api/creature-skills');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  await t.test('writes are admin-only', async () => {
    assert.strictEqual((await request(app).post('/api/creature-skills').send(skillBody())).status, 401);
    assert.strictEqual((await request(app).post('/api/creature-skills').set(...as(player)).send(skillBody())).status, 403);
  });

  await t.test('validation runs before the DB (400 with a readable message)', async () => {
    for (const [over, re] of [
      [{ name: '' }, /name/],
      [{ kind: 'not-a-kind' }, /kind/],
      [{ cooldown_ms: 0 }, /cooldown_ms/],
      [{ telegraph_ms: 5000 }, /telegraph_ms/],
      [{ telegraph_ms: -1 }, /telegraph_ms/],
      [{ element: 'plasma' }, /element/],
      [{ vfx: 'not-an-object' }, /vfx/],
    ]) {
      const r = await request(app).post('/api/creature-skills').set(...as(admin)).send(skillBody(over));
      assert.strictEqual(r.status, 400, JSON.stringify(over));
      assert.match(r.body.error, re);
    }
  });

  await t.test('create, then duplicate name is 409', async () => {
    const r = await request(app).post('/api/creature-skills').set(...as(admin)).send(skillBody());
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    id = r.body.id;
    assert.strictEqual(r.body.radius, 80);
    assert.deepStrictEqual(r.body.used_by, []);
    assert.strictEqual((await request(app).post('/api/creature-skills').set(...as(admin)).send(skillBody())).status, 409);
  });

  await t.test('delete while bound (via a behavior) is 409, naming the behavior', async () => {
    const b = await request(app).post('/api/creature-behaviors').set(...as(admin))
      .send(behaviorBody({ skills: [{ skill_id: id, power_scale: 1 }] }));
    assert.strictEqual(b.status, 201, JSON.stringify(b.body));

    const r = await request(app).delete(`/api/creature-skills/${id}`).set(...as(admin));
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual(r.body.referencing_behaviors.map((x) => x.name), [BEHAVIOR]);
    const still = await pool.query('SELECT 1 FROM creature_skills WHERE id = $1', [id]);
    assert.strictEqual(still.rowCount, 1, 'a refused delete must not delete');
  });

  await t.test('GET lists the catalog row with its used_by behavior', async () => {
    const r = await request(app).get('/api/creature-skills');
    const row = r.body.find((s) => s.id === id);
    assert.ok(row);
    assert.deepStrictEqual(row.used_by.map((b) => b.name), [BEHAVIOR]);
  });

  await t.test('a retune updates the catalog row', async () => {
    const r = await request(app).put(`/api/creature-skills/${id}`).set(...as(admin)).send(skillBody({ radius: 120 }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.radius, 120);
  });

  await t.test('PUT and DELETE reject non-admins, bad input and bad ids', async () => {
    assert.strictEqual((await request(app).put(`/api/creature-skills/${id}`).set(...as(player)).send(skillBody())).status, 403);
    assert.strictEqual((await request(app).delete(`/api/creature-skills/${id}`).set(...as(player))).status, 403);
    assert.strictEqual((await request(app).put(`/api/creature-skills/${id}`).set(...as(admin)).send(skillBody({ cooldown_ms: 0 }))).status, 400);
    assert.strictEqual((await request(app).put('/api/creature-skills/2147483000').set(...as(admin)).send(skillBody())).status, 404);
    assert.strictEqual((await request(app).put('/api/creature-skills/abc').set(...as(admin)).send(skillBody())).status, 400);
  });

  await t.test('once unbound (behavior deleted), delete succeeds', async () => {
    await pool.query('DELETE FROM creature_behaviors WHERE name = $1', [BEHAVIOR]);
    assert.strictEqual((await request(app).delete(`/api/creature-skills/${id}`).set(...as(admin))).status, 204);
    assert.strictEqual((await request(app).delete(`/api/creature-skills/${id}`).set(...as(admin))).status, 404);
  });
});

test('creature-behaviors: nested `skills` binding', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const admin = await makeUser(pool, 'admin');
  t.after(async () => {
    await pool.query('DELETE FROM creature_behaviors WHERE name LIKE $1', [`zzSkillBehavior%`]).catch(() => {});
    await pool.query('DELETE FROM creature_skills WHERE name LIKE $1', [`zzSkill%`]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]).catch(() => {});
    await pool.end();
  });
  const as = (u) => ['Authorization', bearer(u)];

  const skillOne = (await request(app).post('/api/creature-skills').set(...as(admin)).send(skillBody({ name: SKILL_A }))).body;
  const skillTwo = (await request(app).post('/api/creature-skills').set(...as(admin)).send(skillBody({ name: SKILL_B, kind: 'nova' }))).body;

  await t.test('POST binds skills by skill_id, nested and slot-ordered in the response', async () => {
    const r = await request(app).post('/api/creature-behaviors').set(...as(admin)).send(behaviorBody({
      name: `${BEHAVIOR}Nested`,
      skills: [{ skill_id: skillTwo.id, power_scale: 1.2 }, { skill_id: skillOne.id, power_scale: 0.5 }],
    }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.skills.map((s) => s.slot), [1, 2]);
    assert.strictEqual(r.body.skills[0].name, SKILL_B);
    assert.strictEqual(Number(r.body.skills[0].power_scale), 1.2);
    assert.strictEqual(r.body.skills[1].name, SKILL_A);
    await pool.query('DELETE FROM creature_behaviors WHERE name = $1', [`${BEHAVIOR}Nested`]);
  });

  await t.test('an unknown skill_id is a 400, not a raw FK 500', async () => {
    const r = await request(app).post('/api/creature-behaviors').set(...as(admin)).send(behaviorBody({
      name: `${BEHAVIOR}Unknown`,
      skills: [{ skill_id: 2147483000, power_scale: 1 }],
    }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /skill_id/);
    const row = await pool.query('SELECT 1 FROM creature_behaviors WHERE name = $1', [`${BEHAVIOR}Unknown`]);
    assert.strictEqual(row.rowCount, 0, 'a rejected POST must not create a row');
  });

  await t.test('power_scale out of 0.1..1.5 is a 400', async () => {
    for (const scale of [0.05, 1.6, -1]) {
      const r = await request(app).post('/api/creature-behaviors').set(...as(admin)).send(behaviorBody({
        name: `${BEHAVIOR}Scale`,
        skills: [{ skill_id: skillOne.id, power_scale: scale }],
      }));
      assert.strictEqual(r.status, 400, `power_scale ${scale}`);
      assert.match(r.body.error, /power_scale/);
    }
  });

  await t.test('PUT replaces the skill set transactionally; a rejected PUT leaves it untouched', async () => {
    const created = await request(app).post('/api/creature-behaviors').set(...as(admin)).send(behaviorBody({
      name: `${BEHAVIOR}Replace`,
      skills: [{ skill_id: skillOne.id, power_scale: 1 }, { skill_id: skillTwo.id, power_scale: 1 }],
    }));
    assert.strictEqual(created.status, 201);
    const id = created.body.id;

    const replaced = await request(app).put(`/api/creature-behaviors/${id}`).set(...as(admin)).send(behaviorBody({
      name: `${BEHAVIOR}Replace`,
      skills: [{ skill_id: skillTwo.id, power_scale: 0.8 }],
    }));
    assert.strictEqual(replaced.status, 200);
    assert.strictEqual(replaced.body.skills.length, 1);
    assert.strictEqual(replaced.body.skills[0].name, SKILL_B);

    const rejected = await request(app).put(`/api/creature-behaviors/${id}`).set(...as(admin)).send(behaviorBody({
      name: `${BEHAVIOR}Replace`,
      skills: [{ skill_id: 2147483000, power_scale: 1 }],
    }));
    assert.strictEqual(rejected.status, 400);

    const row = await pool.query(
      `SELECT cs.name FROM creature_behavior_skills cbs JOIN creature_skills cs ON cs.id = cbs.skill_id WHERE cbs.behavior_id = $1`,
      [id],
    );
    assert.deepStrictEqual(row.rows.map((r) => r.name), [SKILL_B],
      'a rejected PUT must not touch the skills that were already bound');
    await pool.query('DELETE FROM creature_behaviors WHERE id = $1', [id]);
  });

  await t.test('omitting `skills` entirely means "no skills", same as an empty array', async () => {
    const r = await request(app).post('/api/creature-behaviors').set(...as(admin)).send(behaviorBody({
      name: `${BEHAVIOR}NoSkills`,
    }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.skills, []);
    await pool.query('DELETE FROM creature_behaviors WHERE id = $1', [r.body.id]);
  });

  await t.test('deleting a behavior cascades away its skill bindings (not its catalog skills)', async () => {
    const created = await request(app).post('/api/creature-behaviors').set(...as(admin)).send(behaviorBody({
      name: `${BEHAVIOR}Cascade`,
      skills: [{ skill_id: skillOne.id, power_scale: 1 }],
    }));
    const id = created.body.id;
    const del = await request(app).delete(`/api/creature-behaviors/${id}`).set(...as(admin));
    assert.strictEqual(del.status, 204);
    const bindings = await pool.query('SELECT 1 FROM creature_behavior_skills WHERE behavior_id = $1', [id]);
    assert.strictEqual(bindings.rowCount, 0);
    const skillStillExists = await pool.query('SELECT 1 FROM creature_skills WHERE id = $1', [skillOne.id]);
    assert.strictEqual(skillStillExists.rowCount, 1, 'the CATALOG skill must survive the behavior that bound it');
  });
});
