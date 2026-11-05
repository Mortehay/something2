// SOMET-746 ("socket hang up" on Seed from git). seedEntries decoded all 380
// entity PNGs before dropping the ones the manifest lists, which froze Node for
// 87 s on the board. The store closed its idle connection meanwhile, and the
// next store call died on the dead socket.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/services/assetStore.js');
const { SEED_POLICY, seedEntries } = require('../src/services/artSeed.js');

test('seedEntries decodes only the subjects the manifest does not list', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-entries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = SEED_POLICY.entity;
  const inDir = path.join(root, policy.dir);
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, policy.manifest)), { recursive: true });
  for (const f of ['Listed_A.png', 'Listed_B.png', 'New_One.png']) fs.writeFileSync(path.join(inDir, f), f);
  fs.writeFileSync(path.join(root, policy.manifest), JSON.stringify([
    { name: 'Listed A', file: 'Listed_A.png', cutout: true },
    { name: 'Listed B', file: 'Listed_B.png', cutout: true },
  ]));
  const syncFile = path.join(root, 'art.json');
  fs.writeFileSync(syncFile, JSON.stringify({
    tables: {
      entity_types: [
        { name: 'Listed A', image: { file: 'entities/Listed_A.png' } },
        { name: 'Listed B', image: { file: 'entities/Listed_B.png' } },
        { name: 'New One', image: { file: 'entities/New_One.png' } },
      ],
    },
  }));

  const decoded = [];
  const realAnnotate = policy.annotate;
  policy.annotate = (buf) => { decoded.push(buf.toString()); return { cutout: true }; };
  t.after(() => { policy.annotate = realAnnotate; });

  const entries = seedEntries('entity', root, syncFile);

  assert.deepStrictEqual(entries.map((e) => e.name), ['Listed A', 'Listed B', 'New One'], 'the rows above must reach the seed');
  assert.deepStrictEqual(decoded, ['New_One.png']);
  assert.strictEqual(entries[2].cutout, true, 'the one new subject still gets the bytes judgment');
});

const hangUp = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

// Every method answers `ok`, unless `failures` still holds an error for its turn.
function fakeClient(failures = {}, ok = true) {
  const calls = [];
  const method = (name) => async () => {
    calls.push(name);
    if (failures[name]?.length) throw failures[name].shift();
    return ok;
  };
  const names = ['statObject', 'bucketExists', 'makeBucket', 'putObject'];
  return { calls, ...Object.fromEntries(names.map((n) => [n, method(n)])) };
}
const count = (c, name) => c.calls.filter((x) => x === name).length;

test('store calls survive one dropped connection', async (t) => {
  t.after(() => store.__setAssetClient(null));
  for (const [method, call] of [
    ['statObject', () => store.objectExists('k')],
    ['bucketExists', () => store.ensureBucket()],
    ['bucketExists', () => store.putObject('k', Buffer.from('x'))],
    ['putObject', () => store.putObject('k', Buffer.from('x'))],
  ]) {
    const c = fakeClient({ [method]: [hangUp()] });
    store.__setAssetClient(c);
    await call();
    assert.strictEqual(count(c, method), 2, `${method} is retried once`);
  }
});

test('a connection that keeps dropping still fails, after one retry', async (t) => {
  t.after(() => store.__setAssetClient(null));
  const c = fakeClient({ statObject: [hangUp(), hangUp(), hangUp()] });
  store.__setAssetClient(c);
  await assert.rejects(() => store.objectExists('k'), /socket hang up/);
  assert.strictEqual(c.calls.length, 2);
});

test('other store errors are not retried, and a missing object stays an answer', async (t) => {
  t.after(() => store.__setAssetClient(null));
  const denied = fakeClient({ statObject: [Object.assign(new Error('Access Denied'), { code: 'AccessDenied' })] });
  store.__setAssetClient(denied);
  await assert.rejects(() => store.objectExists('k'), /Access Denied/);
  assert.strictEqual(denied.calls.length, 1);

  const refused = fakeClient({ statObject: [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })] });
  store.__setAssetClient(refused);
  await assert.rejects(() => store.objectExists('k'), /ECONNREFUSED/);
  assert.strictEqual(refused.calls.length, 1, 'a store that is down is not a stale connection');

  const missing = fakeClient({ statObject: [Object.assign(new Error('Not Found'), { code: 'NotFound' })] });
  store.__setAssetClient(missing);
  assert.strictEqual(await store.objectExists('k'), false);
  assert.strictEqual(missing.calls.length, 1);
});
