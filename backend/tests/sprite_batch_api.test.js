const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

test('POST /api/sprite-admin/jobs derives queue options from entity rows', async () => {
  const calls = [];
  __setPool({
    query: async (sql, params = []) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      if (/FROM entity_types WHERE id = ANY/i.test(sql)) {
        return { rows: [{
          id: 4, name: 'Wolf', prompt: 'grey wolf', render_mode: 'static',
          is_creature: true, is_playable: false,
        }] };
      }
      if (/count\(\*\).*FROM sprite_sets/is.test(sql)) return { rows: [] };
      if (/INSERT INTO sprite_sets/i.test(sql)) return { rows: [{ id: 'job-row', status: 'queued' }] };
      if (/SELECT status, count/i.test(sql)) return { rows: [{ status: 'queued', n: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  });

  const res = await request(app).post('/api/sprite-admin/jobs').set(...AUTH)
    .send({ entity_ids: [4] });

  assert.equal(res.status, 201);
  assert.equal(res.body.queued, 1);
  const insert = calls.find((call) => /INSERT INTO sprite_sets/i.test(call.sql));
  assert.deepEqual(insert.params[1], ['Wolf']);
  assert.deepEqual(insert.params[2], ['creature']);
  assert.deepEqual(insert.params[3], ['grey wolf']);
  assert.deepEqual(insert.params[5], [4]);
});

