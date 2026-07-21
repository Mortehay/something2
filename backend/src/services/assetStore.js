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

// Test seam: inject a fake client ({ getObject(bucket, key) -> Readable }).
const __setAssetClient = (impl) => { client = impl; };

module.exports = { getObjectStream, __setAssetClient, BUCKET };
