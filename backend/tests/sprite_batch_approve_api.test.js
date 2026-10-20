const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const express = require('express');
const { Readable } = require('node:stream');
const { app, __setPool } = require('../src/index.js');
const spriteBatchRoutes = require('../src/api/spriteBatchRoutes.js');

function routerApp(pool, store) {
  const a = express();
  a.use(express.json());
  a.use('/api/sprite-admin', spriteBatchRoutes(pool, (_q, _s, next) => next(), { status: () => ({}) }, { store }));
  return a;
}

function boxApprovePool(calls, job) {
  return {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT \* FROM sprite_sets/i.test(sql)) return { rows: [job] };
      return { rows: [], rowCount: 1 };
    },
  };
}

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

test('POST /api/sprite-admin/jobs/approve on an appearance-variant job writes character_appearances, not entity_types', async () => {
  const id = '223e4567-e89b-42d3-a456-426614174000';
  const calls = [];
  __setPool({
    query: async (sql, params = []) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      if (/SELECT \* FROM sprite_sets/i.test(sql)) return { rows: [{
        id, entity_type_id: 3, appearance_variant: 2, generation_kind: 'creature', frames: 4,
        atlas_key: 'sprites/mage2/atlas.png', manifest_key: 'sprites/mage2/manifest.json', status: 'done',
      }] };
      return { rows: [], rowCount: 1 };
    },
  });

  const res = await request(app).post('/api/sprite-admin/jobs/approve').set(...AUTH)
    .send({ job_ids: [id] });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.approved, [id]);
  const update = calls.find((call) => /UPDATE character_appearances SET sprite/i.test(call.sql));
  assert.ok(update, 'expected an UPDATE character_appearances');
  assert.deepEqual(update.params.slice(2), [3, 2]);
  assert.ok(!calls.some((call) => /UPDATE entity_types SET sprite/i.test(call.sql)));
});


const BOX_ID = '323e4567-e89b-42d3-a456-426614174000';
const BOX_JOB = {
  id: BOX_ID, entity_type_id: 8, status: 'done', backend: 'gpu-box', frames: 4, frames_per_action: 4,
  atlas_key: 'sprites/x/sheet.png', manifest_key: 'sprites/x/sheet.json',
};
const storeWith = (manifest) => ({
  getObjectStream: async () => Readable.from([Buffer.from(JSON.stringify(manifest))]),
});

test('approve prop sheet sets animated sway', async () => {
  const calls = [];
  const res = await request(routerApp(boxApprovePool(calls, { ...BOX_JOB, generation_kind: 'object', frames: 2 }), storeWith({ frames: {} })))
    .post('/api/sprite-admin/jobs/approve').send({ job_ids: [BOX_ID] });
  assert.deepEqual(res.body.approved, [BOX_ID]);
  const up = calls.find((c) => /UPDATE entity_types SET sprite/i.test(c.sql));
  assert.deepEqual(JSON.parse(up.params[0]), { atlas_key: BOX_JOB.atlas_key, manifest_key: BOX_JOB.manifest_key, frames: 4 });
  assert.equal(up.params[1], 'animated');
  assert.ok(!calls.some((c) => /SET image/i.test(c.sql)), 'a 1-frame-style image branch must not run for box rows');
});

test('approve creature sheet sets static_frame idle/s/0', async () => {
  const calls = [];
  const manifest = { frames: { 'walk/s/0': [0, 0, 48, 64], 'idle/s/0': [0, 64, 48, 64] } };
  const res = await request(routerApp(boxApprovePool(calls, { ...BOX_JOB, generation_kind: 'creature' }), storeWith(manifest)))
    .post('/api/sprite-admin/jobs/approve').send({ job_ids: [BOX_ID] });
  assert.deepEqual(res.body.approved, [BOX_ID]);
  const up = calls.find((c) => /UPDATE entity_types SET sprite/i.test(c.sql));
  assert.deepEqual(JSON.parse(up.params[0]), {
    atlas_key: BOX_JOB.atlas_key, manifest_key: BOX_JOB.manifest_key, static_frame: 'idle/s/0',
  });
  assert.equal(up.params[1], 'static');
});

test('approve of a box creature falls back to the first manifest frame when there is no idle/s/0', async () => {
  const calls = [];
  const res = await request(routerApp(boxApprovePool(calls, { ...BOX_JOB, generation_kind: 'creature' }), storeWith({ frames: { 'walk/s/0': [0, 0, 48, 64] } })))
    .post('/api/sprite-admin/jobs/approve').send({ job_ids: [BOX_ID] });
  assert.deepEqual(res.body.approved, [BOX_ID]);
  const up = calls.find((c) => /UPDATE entity_types SET sprite/i.test(c.sql));
  assert.equal(JSON.parse(up.params[0]).static_frame, 'walk/s/0');
});

test('approve skips a box creature whose sheet.json cannot be read', async () => {
  const calls = [];
  const store = { getObjectStream: async () => { throw new Error('NoSuchKey'); } };
  const res = await request(routerApp(boxApprovePool(calls, { ...BOX_JOB, generation_kind: 'creature' }), store))
    .post('/api/sprite-admin/jobs/approve').send({ job_ids: [BOX_ID] });
  assert.deepEqual(res.body, { approved: [], skipped: 1 });
  assert.ok(!calls.some((c) => /UPDATE/i.test(c.sql)));
});

test('approve of a box appearance-variant creature writes character_appearances with the manifest frame', async () => {
  const calls = [];
  const job = { ...BOX_JOB, generation_kind: 'creature', appearance_variant: 3 };
  await request(routerApp(boxApprovePool(calls, job), storeWith({ frames: { 'idle/s/0': [0, 0, 48, 64] } })))
    .post('/api/sprite-admin/jobs/approve').send({ job_ids: [BOX_ID] });
  const up = calls.find((c) => /UPDATE character_appearances SET sprite/i.test(c.sql));
  assert.equal(JSON.parse(up.params[0]).static_frame, 'idle/s/0');
  assert.deepEqual(up.params.slice(2), [8, 3]);
});
