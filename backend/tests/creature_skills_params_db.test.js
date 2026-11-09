// backend/tests/creature_skills_params_db.test.js
// A boss skill's mechanics live in creature_skills.params. The admin API must carry them (create and
// update), refuse a malformed block with a readable message, and -- the point of this file -- an
// UPDATE that does not mention `params` (an older editor, a script) must leave them alone rather than
// wipe the skill's mechanics. Real HTTP, real DB; every row is `zz`-prefixed and removed in t.after.
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
const NAME = `zzParamSkill${tag}`;

const body = (over = {}) => ({
  name: NAME, kind: 'zone', telegraph_ms: 1000, cooldown_ms: 8000, radius: 120, range: 700, damage_mult: 0.4,
  element: 'fire', params: { hazard: { pattern: 'targets', count: 3, linger_ms: 7000, tick_ms: 500 } }, ...over,
});

test('creature skill params: stored, validated and never wiped by an update that omits them', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const u = await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, token_version", [`zz-params-${tag}`]);
  const auth = ['Authorization', `Bearer ${signToken({ userId: u.rows[0].id, username: 'x', role: 'admin', tokenVersion: u.rows[0].token_version })}`];
  t.after(async () => {
    await pool.query('DELETE FROM creature_skills WHERE name LIKE $1', ['zzParamSkill%']).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [u.rows[0].id]).catch(() => {});
    await pool.end();
  });
  let id;

  await t.test('a zone skill with params is created and read back whole', async () => {
    const r = await request(app).post('/api/creature-skills').set(...auth).send(body());
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    id = r.body.id;
    assert.deepStrictEqual(r.body.params, body().params);
    assert.strictEqual(r.body.kind, 'zone');
  });

  await t.test('every boss kind is accepted', async () => {
    for (const kind of ['charge', 'blink', 'rain', 'chain', 'zone', 'mark', 'shelter']) {
      const r = await request(app).post('/api/creature-skills').set(...auth).send(body({ name: `${NAME}-${kind}`, kind, params: null }));
      assert.strictEqual(r.status, 201, `${kind}: ${JSON.stringify(r.body)}`);
    }
  });

  await t.test('a malformed params block is a readable 400, before the database', async () => {
    for (const [params, re] of [
      [[], /object/],
      ['x', /object/],
      [{ hits: 99 }, /params\.hits/],
      [{ status: { root_s: 99 } }, /params\.status\.root_s/],
      [{ hazard: { pattern: 'spiral' } }, /pattern/],
      [{ hazard: { count: 0 } }, /params\.hazard\.count/],
      [{ mark: { targets: 'some' } }, /params\.mark\.targets/],
      [{ shelter: { safe_radius: 5 } }, /params\.shelter\.safe_radius/],
      [{ waves: 20 }, /params\.waves/],
    ]) {
      const r = await request(app).post('/api/creature-skills').set(...auth).send(body({ name: `${NAME}-bad`, params }));
      assert.strictEqual(r.status, 400, JSON.stringify(params));
      assert.match(r.body.error, re);
    }
  });

  await t.test('an update that does not send params leaves them untouched', async () => {
    const { params, ...rest } = body({ cooldown_ms: 9000 });
    const r = await request(app).put(`/api/creature-skills/${id}`).set(...auth).send(rest);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.cooldown_ms, 9000, 'the other fields did change');
    assert.deepStrictEqual(r.body.params, body().params, 'the mechanics survived');
  });

  await t.test('an update that sends params replaces them, and null clears them', async () => {
    let r = await request(app).put(`/api/creature-skills/${id}`).set(...auth).send(body({ params: { hazard: { pattern: 'ring', outer: 600, inner: 300 } } }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.params.hazard.pattern, 'ring');
    r = await request(app).put(`/api/creature-skills/${id}`).set(...auth).send(body({ params: null }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.params, null);
  });
});
