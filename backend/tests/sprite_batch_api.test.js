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
    .send({ targets: [{ entity_id: 4 }] });

  assert.equal(res.status, 201);
  assert.equal(res.body.queued, 1);
  const insert = calls.find((call) => /INSERT INTO sprite_sets/i.test(call.sql));
  assert.deepEqual(insert.params[1], [null]);
  assert.deepEqual(insert.params[2], ['Wolf']);
  assert.deepEqual(insert.params[3], ['creature']);
  assert.deepEqual(insert.params[4], ['grey wolf']);
  assert.deepEqual(insert.params[6], [4]);
});

test('POST /api/sprite-admin/jobs targets an appearance variant instead of the class itself', async () => {
  const calls = [];
  __setPool({
    query: async (sql, params = []) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      if (/FROM character_appearances ca JOIN entity_types/i.test(sql)) {
        return { rows: [{
          entity_type_id: 3, variant: 2, class_name: 'Mage', class_prompt: 'a spell-flinging mage',
        }] };
      }
      if (/count\(\*\).*FROM sprite_sets/is.test(sql)) return { rows: [] };
      if (/INSERT INTO sprite_sets/i.test(sql)) return { rows: [{ id: 'job-row', status: 'queued' }] };
      if (/SELECT status, count/i.test(sql)) return { rows: [{ status: 'queued', n: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  });

  const res = await request(app).post('/api/sprite-admin/jobs').set(...AUTH)
    .send({ targets: [{ entity_id: 3, variant: 2 }] });

  assert.equal(res.status, 201);
  assert.equal(res.body.queued, 1);
  const insert = calls.find((call) => /INSERT INTO sprite_sets/i.test(call.sql));
  assert.deepEqual(insert.params[0], [3]);
  assert.deepEqual(insert.params[1], [2]);
  assert.deepEqual(insert.params[2], ['Mage:2']);
});

test('POST /api/sprite-admin/jobs rejects an out-of-range variant', async () => {
  __setPool({ query: async (sql) => { if (isUserLookup(sql)) return ADMIN_USER_ROW; throw new Error(`unexpected query: ${sql}`); } });
  const res = await request(app).post('/api/sprite-admin/jobs').set(...AUTH)
    .send({ targets: [{ entity_id: 3, variant: 6 }] });
  assert.equal(res.status, 400);
});


// A null/primitive element used to coerce to entity_id 0 and pass validation
// (201 with unknown:[0]) instead of being rejected as malformed.
for (const bad of [null, 7, 'x', [], { entity_id: 0 }, { entity_id: '' }, { entity_id: -1 }]) {
  test(`POST /api/sprite-admin/jobs rejects a malformed target ${JSON.stringify(bad)}`, async () => {
    __setPool({ query: async (sql) => { if (isUserLookup(sql)) return ADMIN_USER_ROW; throw new Error(`unexpected query: ${sql}`); } });
    const res = await request(app).post('/api/sprite-admin/jobs').set(...AUTH)
      .send({ targets: [bad] });
    assert.equal(res.status, 400);
  });
}
