const Minio = require('minio');

// A lazily-built S3 client from env, with a test seam so routes can be
// exercised without a live object store. The sprite-gen service writes objects
// into the `sprites` bucket; this reads them back for the browser.
//
// SOMET-379: every connection detail comes from the environment, so the store
// can be MinIO in development and R2, Supabase Storage, B2 or a hosted MinIO
// anywhere else -- one endpoint and credential change, no code. The minio SDK
// speaks S3, and because the browser never contacts the store directly
// (index.js streams objects THROUGH the backend), a hosted bucket needs no CORS
// rules and no public read policy -- only reachability from this process.
//
// The variables keep their MINIO_ names on purpose. They are what the compose
// files, the Orange Pi stack and every existing .env already set, and renaming
// them would break those silently in exchange for a nicer word.
let client = null;

// Accepts either a bare host ("minio"), a host:port ("minio:9000") or a full
// URL ("https://abc123.r2.cloudflarestorage.com"). A hosted store is nearly
// always given as a URL, and taking one apart by hand -- stripping the scheme,
// finding the port, remembering that https means 443 -- is exactly the kind of
// small parsing job that gets done differently in two places.
function parseEndpoint(raw, secureDefault) {
  const value = (raw || '').trim();
  let useSSL = secureDefault;
  let rest = value;

  const scheme = /^(https?):\/\//i.exec(value);
  if (scheme) {
    // An explicit scheme wins over MINIO_SECURE: an https:// URL that spoke
    // plain HTTP because a stale env var said false would fail as a timeout,
    // which is the least informative way for a credential change to go wrong.
    useSSL = scheme[1].toLowerCase() === 'https';
    rest = value.slice(scheme[0].length);
  }
  rest = rest.replace(/\/.*$/, '');            // drop any path

  const [host, portStr] = rest.split(':');
  const port = portStr ? parseInt(portStr, 10) : (useSSL ? 443 : 9000);
  return { host, port, useSSL };
}

function config() {
  const secureDefault = (process.env.MINIO_SECURE || 'false').toLowerCase() === 'true';
  const { host, port, useSSL } = parseEndpoint(
    process.env.MINIO_ENDPOINT || 'minio:9000', secureDefault,
  );
  return {
    // MINIO_PORT overrides a port in the endpoint; compose/develop sets the two
    // separately ("minio" + "9000") and that has to keep working.
    endPoint: host,
    port: process.env.MINIO_PORT ? parseInt(process.env.MINIO_PORT, 10) : port,
    useSSL,
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    // R2 and several others require a region even though they have only one;
    // MinIO ignores it. Left undefined rather than defaulted so the SDK keeps
    // its own behaviour when nothing is set.
    ...(process.env.MINIO_REGION ? { region: process.env.MINIO_REGION } : {}),
    // Virtual-host addressing (bucket.endpoint/key) is what most hosted S3
    // services expect; MinIO needs path style (endpoint/bucket/key), which is
    // why it stays the default.
    pathStyle: (process.env.MINIO_PATH_STYLE || 'true').toLowerCase() === 'true',
  };
}

function makeClient() {
  return new Minio.Client(config());
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
// bucketExists, makeBucket, putObject }). Passing null drops the cached client
// so the next call rebuilds it from the current environment -- which is what
// lets a test change MINIO_* and see the effect.
const __setAssetClient = (impl) => { client = impl; };

module.exports = {
  getObjectStream, putObject, ensureBucket, __setAssetClient, BUCKET,
  // Exported for the configuration tests: the point of this module is the
  // settings it derives, and asserting them through a live connection would
  // need a live store.
  __config: config, __parseEndpoint: parseEndpoint,
};
