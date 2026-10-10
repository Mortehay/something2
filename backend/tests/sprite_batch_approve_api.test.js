const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

test('POST /api/sprite-admin/jobs/approve applies a completed static object', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const calls = [];
  __setPool({
    query: async (sql, params = []) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      if (/SELECT \* FROM sprite_sets/i.test(sql)) return { rows: [{
        id, entity_type_id: 8, generation_kind: 'object', frames: 1,
        image_key: 'sprites/objects/tree/job/static.png', status: 'done',
      }] };
      return { rows: [], rowCount: 1 };
    },
  });

  const res = await request(app).post('/api/sprite-admin/jobs/approve').set(...AUTH)
    .send({ job_ids: [id] });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.approved, [id]);
  assert.ok(calls.some((call) => /UPDATE entity_types SET image/i.test(call.sql)));
  assert.ok(calls.some((call) => /UPDATE sprite_sets SET status = 'approved'/i.test(call.sql)));
  assert.match(calls.find((call) => /SELECT \* FROM sprite_sets/i.test(call.sql)).sql, /::uuid\[\]/);
});

