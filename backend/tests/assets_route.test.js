const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Readable } = require('node:stream');
const { app } = require('../src/index.js');
const assetStore = require('../src/services/assetStore.js');

test('GET /api/assets/* streams a known object with png content-type', async () => {
  assetStore.__setAssetClient({
    getObject: async (bucket, key) => {
      assert.equal(bucket, 'sprites');
      assert.equal(key, 'sprites/tiles/grass/static.png');
      return Readable.from([Buffer.from('PNGDATA')]);
    },
  });
  const res = await request(app).get('/api/assets/sprites/tiles/grass/static.png');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/png/);
  // superagent buffers image/* responses into res.body (a Buffer), not
  // res.text, since it treats the `image` registry as binary.
  assert.equal(res.body.toString(), 'PNGDATA');
});

test('GET /api/assets/* returns 404 when the object is missing', async () => {
  assetStore.__setAssetClient({
    getObject: async () => { throw new Error('NoSuchKey'); },
  });
  const res = await request(app).get('/api/assets/sprites/tiles/nope/static.png');
  assert.equal(res.status, 404);
});
