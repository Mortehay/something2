const Minio = require('minio');

// A lazily-built MinIO client from env, with a test seam so routes can be
// exercised without a live MinIO. The sprite-gen service writes objects into
// the `sprites` bucket; this reads them back for the browser.
let client = null;

function makeClient() {
  const endpoint = process.env.MINIO_ENDPOINT || 'minio:9000';
  const [host, portStr] = endpoint.split(':');
  return new Minio.Client({
    endPoint: host,
    port: portStr ? parseInt(portStr, 10) : 9000,
    useSSL: (process.env.MINIO_SECURE || 'false').toLowerCase() === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  });
}

function getClient() {
  if (!client) client = makeClient();
  return client;
}

const BUCKET = () => process.env.MINIO_BUCKET || 'sprites';

// Resolve to a readable stream for the object, or reject if it is missing.
async function getObjectStream(key) {
  return getClient().getObject(BUCKET(), key);
}

// SOMET-327: write side. Until now every object in this bucket was written by
// the Python sprite-gen service and this module only ever read them back. A
// remote provider's image arrives as bytes in an HTTP response to THIS
// process, so the backend needs to be able to store one.
//
// ensureBucket is called on the write path because a fresh environment may
// have no bucket yet -- sprite-gen creates it lazily for the same reason, and
// whichever of the two writes first should not fail.
async function ensureBucket() {
  const bucket = BUCKET();
  const c = getClient();
  if (!(await c.bucketExists(bucket))) await c.makeBucket(bucket);
}

async function putObject(key, buffer, contentType = 'image/png') {
  await ensureBucket();
  await getClient().putObject(BUCKET(), key, buffer, buffer.length, {
    'Content-Type': contentType,
  });
  return key;
}

// Test seam: inject a fake client ({ getObject(bucket, key) -> Readable,
// bucketExists, makeBucket, putObject }).
const __setAssetClient = (impl) => { client = impl; };

module.exports = { getObjectStream, putObject, ensureBucket, __setAssetClient, BUCKET };
