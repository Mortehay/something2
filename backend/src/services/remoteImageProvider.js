// SOMET-327: generating an image on a registered remote service.
//
// SCOPE, stated up front because it is a real limitation and not an oversight:
// this is the SYNC path -- one POST, one image in the response. That means a
// remote provider produces a STATIC image (the `image_key` shape the tile and
// object panels already consume). It cannot produce the multi-frame
// directional atlas that animated creature sprites need, because a single
// txt2img call returns a single picture. Animated generation continues to go
// to the local sprite-gen service; asking a remote provider for frames > 1
// fails loudly rather than quietly handing back a still image.
// ComfyUI-style async queues are SOMET-334.
//
// The job document this produces is deliberately identical in shape to
// sprite-gen's (id/status/progress/result/error), so the three
// GET /api/*-jobs/:jobId proxy routes and the admin UI polling them need no
// special case for where the pixels came from.

const crypto = require('node:crypto');
const { selectOne } = require('./pointerPath');
const assetStore = require('./assetStore');
const { safeFetch, redactUrl, readCapped, readJsonCapped } = require('./safeFetch');
const { manifestForSheet } = require('./spriteSheet');

// Image generation on CPU can take a minute or more. This is NOT the 30s
// control-plane budget spriteGen.js uses -- there the long work happens
// elsewhere and the call returns immediately; here the call IS the work.
const GENERATE_TIMEOUT_MS = () => parseInt(process.env.AI_PROVIDER_GENERATE_TIMEOUT_MS || '300000', 10);

// A hostile or broken service must not be able to make this process buffer
// unbounded memory. 32 MB is far above any plausible PNG at sprite sizes.
const MAX_IMAGE_BYTES = () => parseInt(process.env.AI_PROVIDER_MAX_IMAGE_BYTES || '33554432', 10);

// Remote job ids are prefixed so the shared /api/*-jobs/:jobId routes can tell
// which backend owns a job without a database lookup. The suffix is hex, which
// keeps the whole id inside the existing traversal-safe id pattern.
const REMOTE_JOB_PREFIX = 'rmt_';

function isRemoteJobId(id) {
  return typeof id === 'string' && id.startsWith(REMOTE_JOB_PREFIX);
}

// In-memory job registry.
//
// KNOWN LIMITATION, accepted for v1 and called out in the ticket: a backend
// restart loses in-flight remote jobs, and the admin sees a job that never
// finishes rather than one that failed. sprite-gen's own JobManager has
// exactly the same property (a dict in the Python process), so this is parity
// with the thing it sits beside, not a new class of fragility.
// Entries are { at, doc }: the timestamp is registry bookkeeping and is kept
// OUT of `doc`, because doc is handed to the client verbatim and must keep
// sprite-gen's exact field set (id/status/progress/result/error).
const jobs = new Map();

// The registry is bounded in two ways, because without either it grows for the
// lifetime of the process: one entry per generation, forever. sprite-gen has
// the same shape of storage but is a separate, restartable process; this one
// lives inside the long-running API server.
//
// TTL is generous relative to how long a poll lasts (the admin UI stops
// polling within seconds of `done`), and the hard cap is the backstop for a
// burst that outruns the TTL.
const JOB_TTL_MS = () => parseInt(process.env.AI_PROVIDER_JOB_TTL_MS || '3600000', 10);
const MAX_JOBS = () => parseInt(process.env.AI_PROVIDER_MAX_JOBS || '500', 10);

// Called on insert rather than on a timer: no interval to leak, and the work
// is proportional to how much the feature is actually used.
function pruneJobs(now) {
  const ttl = JOB_TTL_MS();
  for (const [id, entry] of jobs) {
    if (now - entry.at > ttl) jobs.delete(id);
  }
  // Map preserves insertion order, so the oldest surviving entries are first.
  const max = MAX_JOBS();
  if (jobs.size > max) {
    const overflow = jobs.size - max;
    let dropped = 0;
    for (const id of jobs.keys()) {
      if (dropped >= overflow) break;
      jobs.delete(id);
      dropped += 1;
    }
  }
}

function createJob(now = Date.now()) {
  const id = REMOTE_JOB_PREFIX + crypto.randomBytes(12).toString('hex');
  jobs.set(id, {
    at: now,
    doc: { id, status: 'queued', progress: { done: 0, total: 1 }, result: null, error: null },
  });
  // Prune AFTER inserting, so MAX_JOBS is a true ceiling rather than a
  // ceiling the registry is allowed to sit one above. The just-created job is
  // the newest, so it is never the one evicted.
  pruneJobs(now);
  return id;
}

function setJob(id, patch) {
  const entry = jobs.get(id);
  if (entry) jobs.set(id, { ...entry, doc: { ...entry.doc, ...patch } });
}

function getJob(id) {
  const entry = jobs.get(id);
  return entry ? entry.doc : null;
}

// Test seam: the registry's size, without exposing the Map itself.
function __jobCount() {
  return jobs.size;
}

// Test seam: lets a test assert on registry state without exporting the Map.
function __resetJobs() {
  jobs.clear();
}

// --- Template substitution ----------------------------------------------

// Deep-walks the stored template replacing {{placeholder}} in string leaves.
//
// THE TYPE RULE: when a placeholder is the ENTIRE string leaf and its value is
// a number, the result is a number, not a numeric string. A1111 and most
// OpenAI-compatible endpoints reject {"width": "512"} with a validation error
// that surfaces to the admin as an opaque 422 from a machine they cannot see.
// Inside a longer string ("a {{prompt}}, 4k") the value is interpolated as
// text, which is the only sensible reading.
//
// Unknown placeholders are left EXACTLY as written rather than blanked: a
// typo'd {{promt}} that silently became "" would send an empty prompt to the
// service and return a plausible-looking picture of nothing.
function substituteTemplate(template, vars) {
  const whole = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/;
  const inline = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

  const walk = (node) => {
    if (typeof node === 'string') {
      const m = whole.exec(node.trim());
      if (m && Object.prototype.hasOwnProperty.call(vars, m[1])) {
        return vars[m[1]];                       // preserves number/boolean type
      }
      return node.replace(inline, (match, name) => (
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
      ));
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        // defineProperty, not assignment: a template containing a "__proto__"
        // key (JSON.parse makes it an ordinary own property) would otherwise
        // hit the prototype setter -- silently DROPPING that key from the body
        // and changing the output's prototype. Nothing global is polluted
        // either way, but "the template goes out as written" has to be true.
        Object.defineProperty(out, k, {
          value: walk(v), enumerable: true, writable: true, configurable: true,
        });
      }
      return out;
    }
    return node;
  };
  return walk(template);
}

// --- Response decoding ---------------------------------------------------

// Strips a data: URI wrapper if present. Services disagree about whether the
// base64 they hand back is bare or prefixed, and both are common enough that
// requiring the admin to know which they have would be a support burden.
function stripDataUri(value) {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(value);
  return m ? m[1] : value;
}

// Returns { buffer } or { error }.
//
// Two shapes are supported and they are distinguished by content type, not by
// guessing: a JSON body (dig out the base64 at response_image_pointer) and a
// raw image body (use it directly, pointer irrelevant).
function decodeImage({ contentType, json, body }, pointer) {
  if (contentType && /^image\//i.test(contentType)) {
    if (!body || !body.length) return { error: 'service returned an empty image body' };
    return { buffer: Buffer.from(body) };
  }
  if (!json) return { error: 'service did not return JSON or an image' };

  const picked = selectOne(json, pointer || '');
  if (picked === null) {
    return { error: `response_image_pointer is not a valid path: ${pointer}` };
  }
  if (picked === undefined) {
    return { error: `no image found at response_image_pointer "${pointer}"` };
  }
  if (typeof picked !== 'string') {
    return { error: 'response_image_pointer selected a non-string; expected base64 image data' };
  }
  const b64 = stripDataUri(picked);
  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch (_) {
    return { error: 'image data at response_image_pointer is not valid base64' };
  }
  // Buffer.from is famously forgiving -- it does not throw on garbage, it
  // returns something short. An empty result from a non-empty string means the
  // field held something that was never base64.
  if (buffer.length === 0) {
    return { error: 'image data at response_image_pointer decoded to zero bytes' };
  }
  return { buffer };
}

// --- Storage -------------------------------------------------------------

// Mirrors sprite-gen's storage.py layout exactly:
//   <bucket>/<prefix>/<name>/<job_id>/static.png    for tiles and objects
//   <bucket>/<name>/<job_id>/static.png             for creatures
// Matching it is what lets the existing GET /api/assets/* route serve these
// with no change, and keeps the MinIO console browsable in one scheme.
function storageKey({ bucket, kind, subject, jobId, file = 'static.png' }) {
  const safe = String(subject).replace(/[^A-Za-z0-9_-]/g, '_');
  if (kind === 'tile') return `${bucket}/tiles/${safe}/${jobId}/${file}`;
  if (kind === 'object') return `${bucket}/objects/${safe}/${jobId}/${file}`;
  return `${bucket}/${safe}/${jobId}/${file}`;
}

// Same defaults sprite-gen uses (main.py): tiles are square, everything else
// is taller than it is wide.
function defaultSize(kind) {
  return kind === 'tile' ? { width: 128, height: 128 } : { width: 128, height: 160 };
}

function authHeaders(provider) {
  if (provider.auth_header_name && provider.auth_token) {
    return { [provider.auth_header_name]: provider.auth_token };
  }
  return {};
}

// --- Generation ----------------------------------------------------------

// Starts a generation and returns { job_id } immediately; the work continues
// on a floating promise that only ever writes into the job registry. The admin
// UI already polls, so returning early keeps the request/response cycle short
// even though the underlying call can take minutes.
function startGeneration(provider, req, deps = {}) {
  const jobId = createJob();
  runGeneration(jobId, provider, req, deps).catch((err) => {
    // Nothing above awaits this promise, so an unexpected throw would
    // otherwise be an unhandledRejection that takes the process down.
    setJob(jobId, { status: 'error', error: err && err.message ? err.message : String(err) });
  });
  return { job_id: jobId, provider_id: provider.id, provider_name: provider.name };
}

async function runGeneration(jobId, provider, req, deps = {}) {
  const { fetchImpl = fetch, store = assetStore } = deps;
  const { subject, kind = 'object', prompt, seed = 0, frames = 1 } = req;

  setJob(jobId, { status: 'running' });

  const size = defaultSize(kind);
  const frameCount = Math.max(1, Number(frames) || 1);
  // {{frames}} lets the template tell the REMOTE how many frames to draw. The
  // other machine builds the sheet; this side only needs to know how to cut it.
  const body = substituteTemplate(provider.request_template, {
    prompt,
    model: provider.model || '',
    seed: Number(seed) || 0,
    width: req.width || size.width,
    height: req.height || size.height,
    frames: frameCount,
  });

  let res;
  try {
    // Call-time scheme re-validation plus redirect re-validation. See
    // services/safeFetch.js for why this is not the same check as the one the
    // Settings form already did.
    res = await safeFetch(provider.base_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS()),
    }, { fetchImpl });
  } catch (err) {
    setJob(jobId, {
      status: 'error',
      error: `could not reach ${redactUrl(provider.base_url)}: ${err.message}`,
    });
    return;
  }
  if (!res.ok) {
    setJob(jobId, { status: 'error', error: `provider answered ${res.status}` });
    return;
  }

  const contentType = res.headers && res.headers.get ? res.headers.get('content-type') : null;
  let decoded;
  try {
    if (contentType && /^image\//i.test(contentType)) {
      // Streamed with a hard ceiling, so an enormous body is abandoned
      // part-way instead of being buffered and only then measured.
      const read = await readCapped(res, MAX_IMAGE_BYTES());
      if (read.error) {
        setJob(jobId, { status: 'error', error: `provider response rejected: ${read.error}` });
        return;
      }
      decoded = decodeImage({ contentType, body: read.buffer }, provider.response_image_pointer);
    } else {
      // Same ceiling for the JSON path. A base64 image inflates ~33%, so the
      // JSON carrying it is legitimately larger than the image itself; the
      // cap is applied to the transport bytes either way.
      const read = await readJsonCapped(res, MAX_IMAGE_BYTES());
      if (read.error) {
        setJob(jobId, { status: 'error', error: `provider response rejected: ${read.error}` });
        return;
      }
      decoded = decodeImage({ contentType, json: read.json }, provider.response_image_pointer);
    }
  } catch (err) {
    setJob(jobId, { status: 'error', error: `could not read the provider response: ${err.message}` });
    return;
  }
  if (decoded.error) {
    setJob(jobId, { status: 'error', error: decoded.error });
    return;
  }
  if (decoded.buffer.length > MAX_IMAGE_BYTES()) {
    setJob(jobId, { status: 'error', error: 'provider response exceeded the image size cap' });
    return;
  }

  // A multi-frame request means the remote returned a SHEET. Compute the
  // manifest BEFORE storing anything, so a grid that does not match the image
  // fails without leaving an atlas the renderer would crop wrongly.
  let sheet = null;
  if (frameCount > 1) {
    sheet = manifestForSheet(decoded.buffer, provider, frameCount);
    if (sheet.error) {
      setJob(jobId, { status: 'error', error: `sprite sheet unusable: ${sheet.error}` });
      return;
    }
  }

  // Storage is the LAST step, after every validation above. A failed job must
  // never leave a half-written object behind for the asset route to serve.
  const bucket = store.BUCKET();
  try {
    if (sheet) {
      // Same names and layout sprite-gen's _put_flat writes, so the admin UI's
      // existing animated path (atlas_key + manifest_key) needs no change.
      const atlasKey = storageKey({ bucket, kind, subject, jobId, file: 'atlas.png' });
      const manifestKey = storageKey({ bucket, kind, subject, jobId, file: 'atlas.json' });
      await store.putObject(atlasKey, decoded.buffer, 'image/png');
      await store.putObject(
        manifestKey, Buffer.from(JSON.stringify(sheet.manifest)), 'application/json',
      );
      setJob(jobId, {
        status: 'done',
        progress: { done: sheet.frameCount, total: sheet.frameCount },
        result: {
          atlas_key: atlasKey,
          manifest_key: manifestKey,
          frames: sheet.frameCount,
          provider_id: provider.id,
        },
      });
      return;
    }
    const key = storageKey({ bucket, kind, subject, jobId });
    await store.putObject(key, decoded.buffer, 'image/png');
    setJob(jobId, {
      status: 'done',
      progress: { done: 1, total: 1 },
      // Same field names sprite-gen's _put_flat returns, so TileTypesAdmin's
      // `result.image_key` and its approve mutation work unchanged.
      result: { image_key: key, frames: 1, provider_id: provider.id },
    });
  } catch (err) {
    setJob(jobId, { status: 'error', error: `could not store the generated image: ${err.message}` });
  }
}

module.exports = {
  REMOTE_JOB_PREFIX,
  isRemoteJobId,
  substituteTemplate,
  decodeImage,
  stripDataUri,
  storageKey,
  defaultSize,
  startGeneration,
  runGeneration,
  createJob,
  getJob,
  setJob,
  __resetJobs,
  __jobCount,
  pruneJobs,
  JOB_TTL_MS,
  MAX_JOBS,
  GENERATE_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
};
