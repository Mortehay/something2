// F-007 (SOMET-187): POST /api/worlds/:id/villages used to run INSERT
// villages, insertVillageGuards and seedBaseCatalog as three independent,
// non-transactional statements. If seedBaseCatalog (the merchant_stock
// INSERT) failed, the village row and its guards were already committed --
// the client got a 500, but a subsequent GET still listed the "failed"
// village, and a retry then 400'd against it as an overlap the admin was
// never told existed.
//
// This test builds a pool with real committed/pending state (not a mock that
// just returns canned rows), so a GET after the failure is genuine evidence
// that a rollback actually undid the write, not an assumption about what
// COMMIT/ROLLBACK "should" do.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool, __setAuthorityHandle } = require('../src/index.js');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');

test.afterEach(() => { __setAuthorityHandle(null); });

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

function mkTransactionalPool({ failMerchantStock = false } = {}) {
  let committedVillages = [];
  let nextId = 1;
  let pending = [];

  const client = {
    query: async (sql, params) => {
      if (/^BEGIN$/i.test(sql.trim())) { pending = []; return { rows: [] }; }
      if (/^COMMIT$/i.test(sql.trim())) { committedVillages = committedVillages.concat(pending); pending = []; return { rows: [] }; }
      if (/^ROLLBACK$/i.test(sql.trim())) { pending = []; return { rows: [] }; }
      if (/INSERT INTO villages/i.test(sql)) {
        const row = {
          id: `v${nextId++}`, world_id: params[0], min_row: params[1], min_col: params[2],
          width: params[3], height: params[4], gate_edge: params[5], spawn_x: params[6], spawn_y: params[7],
        };
        pending.push(row);
        return { rows: [row] };
      }
      if (/INSERT INTO world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO merchant_stock/i.test(sql)) {
        if (failMerchantStock) throw new Error('simulated merchant_stock insert failure');
        return { rows: [] };
      }
      throw new Error('unexpected client query: ' + sql);
    },
    release: () => {},
  };

  return {
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      if (/SELECT id, width, height FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: params[0], width: 30, height: 30 }] };
      if (/FROM villages WHERE world_id/i.test(sql)) {
        return { rows: committedVillages.filter((v) => v.world_id === params[0]) };
      }
      if (/DELETE FROM world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error('unexpected pool query: ' + sql);
    },
    connect: async () => client,
  };
}

test('a failed village create rolls back: the village does not appear in a later GET', async () => {
  const pool = mkTransactionalPool({ failMerchantStock: true });
  __setPool(pool);

  const createRes = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S', spawn_x: 650, spawn_y: 650 });
  assert.equal(createRes.status, 500);

  const listRes = await request(app).get('/api/worlds/w1/villages');
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 0, 'a partially-failed village create must not be visible after rollback');
});

// Control: the same pool, without the injected failure, must actually commit
// -- otherwise the rollback assertion above would be trivially true.
test('a successful village create is visible in a later GET (control for the rollback test)', async () => {
  const pool = mkTransactionalPool({ failMerchantStock: false });
  __setPool(pool);

  const createRes = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S', spawn_x: 650, spawn_y: 650 });
  assert.equal(createRes.status, 200);

  const listRes = await request(app).get('/api/worlds/w1/villages');
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 1, 'a successful create must commit and be visible');
});
