// SOMET-379. The object store moves between environments -- MinIO in compose,
// a hosted S3 bucket on a real host -- and the only thing that should change is
// the environment. These tests are about the settings this module DERIVES,
// because that is where an endpoint like "https://abc.r2.cloudflarestorage.com"
// silently becomes host "https" on port 9000 over plain HTTP, and the symptom
// is a connection timeout that says nothing about the cause.
//
// The acceptance criterion that matters most is the boring one: with nothing
// set, the settings must be byte-for-byte what they were before this existed,
// or local development breaks for everyone.
const test = require('node:test');
const assert = require('node:assert');
const store = require('../src/services/assetStore.js');

const MINIO_VARS = [
  'MINIO_ENDPOINT', 'MINIO_PORT', 'MINIO_SECURE', 'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY', 'MINIO_REGION', 'MINIO_PATH_STYLE', 'MINIO_BUCKET',
];

// AWAITS fn. A synchronous `finally` around an async callback restores the
// environment on the first await, so the calls after it read the OLD settings
// -- which is precisely how this helper first reported a bucket mismatch that
// was its own doing rather than the module's.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(MINIO_VARS.map((k) => [k, process.env[k]]));
  for (const k of MINIO_VARS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of MINIO_VARS) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
}

test('with nothing set, the settings are exactly the old MinIO defaults', async () => {
  await withEnv({}, () => {
    const c = store.__config();
    assert.strictEqual(c.endPoint, 'minio');
    assert.strictEqual(c.port, 9000);
    assert.strictEqual(c.useSSL, false);
    assert.strictEqual(c.accessKey, 'minioadmin');
    assert.strictEqual(c.secretKey, 'minioadmin');
    assert.strictEqual(c.pathStyle, true);
    assert.ok(!('region' in c), 'region must stay unset so the SDK keeps its own default');
    assert.strictEqual(store.BUCKET(), 'sprites');
  });
});

test('every connection detail comes from the environment', async () => {
  await withEnv({
    MINIO_ENDPOINT: 'objects.example.com',
    MINIO_PORT: '9443',
    MINIO_SECURE: 'true',
    MINIO_ACCESS_KEY: 'AKIA-not-a-real-key',
    MINIO_SECRET_KEY: 'shhh',
    MINIO_REGION: 'auto',
    MINIO_PATH_STYLE: 'false',
    MINIO_BUCKET: 'game-assets',
  }, () => {
    const c = store.__config();
    assert.deepStrictEqual(
      {
        endPoint: c.endPoint, port: c.port, useSSL: c.useSSL, accessKey: c.accessKey,
        secretKey: c.secretKey, region: c.region, pathStyle: c.pathStyle,
      },
      {
        endPoint: 'objects.example.com', port: 9443, useSSL: true,
        accessKey: 'AKIA-not-a-real-key', secretKey: 'shhh', region: 'auto', pathStyle: false,
      },
    );
    assert.strictEqual(store.BUCKET(), 'game-assets');
  });
});

test('an https:// endpoint is taken apart correctly, scheme and all', async () => {
  // The shape a hosted bucket is actually given in. Host must not come out as
  // "https", the port must default to 443, and TLS must be on even though
  // MINIO_SECURE says nothing.
  await withEnv({ MINIO_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com' }, () => {
    const c = store.__config();
    assert.strictEqual(c.endPoint, 'abc123.r2.cloudflarestorage.com');
    assert.strictEqual(c.port, 443);
    assert.strictEqual(c.useSSL, true);
  });
});

test('an explicit scheme beats a stale MINIO_SECURE', async () => {
  // Disagreement is the interesting case: an https URL with MINIO_SECURE=false
  // left over from the MinIO days would otherwise speak plain HTTP to a TLS
  // port and fail as a timeout.
  await withEnv({ MINIO_ENDPOINT: 'https://objects.example.com', MINIO_SECURE: 'false' }, () => {
    assert.strictEqual(store.__config().useSSL, true);
  });
  await withEnv({ MINIO_ENDPOINT: 'http://objects.example.com', MINIO_SECURE: 'true' }, () => {
    assert.strictEqual(store.__config().useSSL, false);
    assert.strictEqual(store.__config().port, 9000);
  });
});

test('a path on the endpoint is dropped rather than folded into the host', async () => {
  await withEnv({ MINIO_ENDPOINT: 'https://objects.example.com/some/prefix' }, () => {
    assert.strictEqual(store.__parseEndpoint('https://objects.example.com/some/prefix', false).host,
      'objects.example.com');
    assert.strictEqual(store.__config().endPoint, 'objects.example.com');
  });
});

test('the two-variable form compose/develop uses still works', async () => {
  // compose/develop sets MINIO_ENDPOINT=minio and MINIO_PORT=9000 separately.
  // If MINIO_PORT stopped overriding, local development would talk to 9000 by
  // luck rather than by configuration -- and to the wrong port the day someone
  // changes it.
  await withEnv({ MINIO_ENDPOINT: 'minio', MINIO_PORT: '9002' }, () => {
    const c = store.__config();
    assert.strictEqual(c.endPoint, 'minio');
    assert.strictEqual(c.port, 9002);
  });
});

test('the read and write paths use the configured bucket, not a hardcoded one', async () => {
  // Through the real functions and the existing test seam: BUCKET() being
  // right proves nothing if getObjectStream passes something else.
  const seen = [];
  store.__setAssetClient({
    getObject: async (bucket, key) => { seen.push(['get', bucket, key]); return 'stream'; },
    bucketExists: async (bucket) => { seen.push(['exists', bucket]); return true; },
    makeBucket: async (bucket) => { seen.push(['make', bucket]); },
    putObject: async (bucket, key) => { seen.push(['put', bucket, key]); },
  });
  try {
    await withEnv({ MINIO_BUCKET: 'game-assets' }, async () => {
      await store.getObjectStream('sprite.png');
      await store.putObject('sprite.png', Buffer.from('x'));
    });
    assert.deepStrictEqual(seen, [
      ['get', 'game-assets', 'sprite.png'],
      ['exists', 'game-assets'],
      ['put', 'game-assets', 'sprite.png'],
    ]);
  } finally {
    store.__setAssetClient(null);
  }
});
