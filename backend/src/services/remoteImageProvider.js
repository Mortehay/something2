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
const jobs = new Map();

function createJob() {
  const id = REMOTE_JOB_PREFIX + crypto.randomBytes(12).toString('hex');
  jobs.set(id, {
    id, status: 'queued', progress: { done: 0, total: 1 }, result: null, error: null,
  });
  return id;
}

function setJob(id, patch) {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}

function getJob(id) {
  return jobs.get(id) || null;
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
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
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
function storageKey({ bucket, kind, subject, jobId }) {
  const safe = String(subject).replace(/[^A-Za-z0-9_-]/g, '_');
  if (kind === 'tile') return `${bucket}/tiles/${safe}/${jobId}/static.png`;
  if (kind === 'object') return `${bucket}/objects/${safe}/${jobId}/static.png`;
  return `${bucket}/${safe}/${jobId}/static.png`;
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

  // The honest failure for the one thing this path cannot do. Silently
  // returning a still image for an animation request would look like success
  // until somebody noticed the sprite never moved.
  if (Number(frames) > 1) {
    setJob(jobId, {
      status: 'error',
      error: 'this provider returns a single image; animated generation needs the local '
        + 'sprite-gen service (or SOMET-334 async queue support)',
    });
    return;
  }

  const size = defaultSize(kind);
  const body = substituteTemplate(provider.request_template, {
    prompt,
    model: provider.model || '',
    seed: Number(seed) || 0,
    width: req.width || size.width,
    height: req.height || size.height,
  });

  let res;
  try {
    res = await fetchImpl(provider.base_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS()),
    });
  } catch (err) {
    setJob(jobId, { status: 'error', error: `could not reach the provider: ${err.message}` });
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
      const raw = Buffer.from(await res.arrayBuffer());
      if (raw.length > MAX_IMAGE_BYTES()) {
        setJob(jobId, { status: 'error', error: 'provider response exceeded the image size cap' });
        return;
      }
      decoded = decodeImage({ contentType, body: raw }, provider.response_image_pointer);
    } else {
      const json = await res.json();
      decoded = decodeImage({ contentType, json }, provider.response_image_pointer);
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

  // Storage is the LAST step, after every validation above. A failed job must
  // never leave a half-written object behind for the asset route to serve.
  const key = storageKey({ bucket: store.BUCKET(), kind, subject, jobId });
  try {
    await store.putObject(key, decoded.buffer, 'image/png');
  } catch (err) {
    setJob(jobId, { status: 'error', error: `could not store the generated image: ${err.message}` });
    return;
  }

  setJob(jobId, {
    status: 'done',
    progress: { done: 1, total: 1 },
    // Same field names sprite-gen's _put_flat returns, so TileTypesAdmin's
    // `result.image_key` and its approve mutation work unchanged.
    result: { image_key: key, frames: 1, provider_id: provider.id },
  });
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
  GENERATE_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
};
