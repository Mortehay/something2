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

test('GET /api/assets/* serves .webp as image/webp', async () => {
  assetStore.__setAssetClient({
    getObject: async () => Readable.from([Buffer.from('WEBPDATA')]),
  });
  const res = await request(app).get('/api/assets/seedsync/abc/x.webp');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/webp/);
});

test('assetStore.statObject returns size+etag, null on NotFound', async () => {
  assetStore.__setAssetClient({
    statObject: async (bucket, key) => {
      if (key === 'gone') { const e = new Error('nf'); e.code = 'NotFound'; throw e; }
      return { size: 12, etag: 'abc' };
    },
  });
  assert.deepEqual(await assetStore.statObject('here'), { size: 12, etag: 'abc' });
  assert.equal(await assetStore.statObject('gone'), null);
});

test('assetStore.statObject maps NoSuchKey to null and rethrows other errors', async () => {
  assetStore.__setAssetClient({
    statObject: async (bucket, key) => {
      const e = new Error('boom');
      e.code = key === 'nosuch' ? 'NoSuchKey' : 'AccessDenied';
      throw e;
    },
  });
  assert.equal(await assetStore.statObject('nosuch'), null);
  await assert.rejects(assetStore.statObject('other'), /boom/);
});

test('assetStore.readObject returns the whole object as a Buffer', async () => {
  assetStore.__setAssetClient({
    getObject: async () => Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
  });
  const b = await assetStore.readObject('k');
  assert.ok(Buffer.isBuffer(b));
  assert.equal(b.toString(), 'abcd');
});

test('GET /api/assets/* returns 404 when the object is missing', async () => {
  assetStore.__setAssetClient({
    getObject: async () => { throw new Error('NoSuchKey'); },
  });
  const res = await request(app).get('/api/assets/sprites/tiles/nope/static.png');
  assert.equal(res.status, 404);
});
