// The world-spec service: a remote generator that produces `*.map.json` region
// specs in seeds/mapSpec.js's format.
//
// WHY THIS IS NOT PART OF services/remoteImageProvider.js, even though it
// talks to the SAME host and uses the SAME credential. The AI-provider system
// carries IMAGES: one blocking POST, a base64 payload behind
// `response_image_pointer`, decoded by decodeImage. A world spec is JSON with
// no image in it and no pointer that could make it one, so routing it through
// that path would mean either teaching decodeImage about non-images or
// pretending a spec is a picture. Both are worse than a second, smaller
// client. The two share `authHeaders` rather than each growing their own copy
// -- a duplicated auth builder is exactly how one of them ends up being the
// one that forgets to send the token.
//
// WHERE THE CREDENTIAL COMES FROM. There is no separate world-service record:
// the generator lives on the same box as the registered image provider and is
// reached with the same bearer token, so the base URL's ORIGIN and the
// auth_token are read from an `ai_providers` row. That is a deliberate reuse,
// not an accident, and it has one consequence worth knowing: repointing that
// row at a different image host also repoints world generation. resolveWorldService
// therefore reports WHICH provider it used, so an operator seeing an
// unexpected host in an error message can tell why.
//
// THE TOKEN NEVER LEAVES THE PROCESS. Every function here runs server-side and
// returns decoded data, never the credential -- the same rule
// services/aiProviders.js exists to enforce. The browser talks to our own
// routes; it does not hold a bearer for the generator, and the preview PNG is
// proxied rather than linked so that no <img src> has to carry one.
const { safeFetch, redactUrl, readCapped, readJsonCapped } = require('./safeFetch');
const { authHeaders } = require('./providerDiscovery');

// Spec generation is arithmetic on the far side -- no GPU, no queue -- so a
// short timeout is right and a slow answer means something is wrong rather
// than something is working hard. Deliberately much lower than the image
// provider's GENERATE_TIMEOUT_MS.
const TIMEOUT_MS = () => Number(process.env.WORLD_GEN_TIMEOUT_MS) || 20000;

// A region spec for a large map is tens of KB; the preview is a PNG. Both caps
// are generous against real payloads and exist to stop a misconfigured host
// from streaming something unbounded into memory.
const MAX_SPEC_BYTES = () => Number(process.env.WORLD_GEN_MAX_SPEC_BYTES) || 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = () => Number(process.env.WORLD_GEN_MAX_PREVIEW_BYTES) || 8 * 1024 * 1024;

// A failure the UI must be able to TELL APART, which is the whole point of the
// class. The generator's own author shipped a bug where an auth failure and an
// unreachable host both rendered as an empty list, indistinguishable from
// "nothing has been generated yet" -- so every throw here carries a `code` the
// route maps to a status and a `message` written to be shown to a person.
class WorldGenError extends Error {
  constructor(code, message, { status = 502, detail = null } = {}) {
    super(message);
    this.name = 'WorldGenError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// Prefer the ACTIVE provider, fall back to any enabled one.
//
// Both are accepted because activation is an image-generation concept: it
// decides which box renders sprites, and an operator may legitimately have
// every profile enabled with none active (which is the state this repo's dev
// database is in today -- two enabled rows, neither active). Refusing to
// generate worlds because no IMAGE provider is active would be an unrelated
// rule enforced in the wrong place.
async function resolveWorldService(db) {
  const r = await db.query(
    `SELECT * FROM ai_providers
      WHERE enabled AND auth_token IS NOT NULL AND base_url IS NOT NULL
      ORDER BY is_active DESC, id ASC
      LIMIT 1`,
  );
  const provider = r.rows[0];
  if (!provider) {
    throw new WorldGenError(
      'not_configured',
      'No AI connector is configured, so there is no world-spec service to talk to. '
      + 'Add one under Settings -> AI connectors with the generator host and its bearer token.',
      { status: 503 },
    );
  }
  let origin;
  try {
    origin = new URL(provider.base_url).origin;
  } catch {
    throw new WorldGenError(
      'not_configured',
      `AI connector "${provider.name}" has a base URL that is not a valid URL, `
      + 'so the world-spec service host cannot be derived from it.',
      { status: 503 },
    );
  }
  return { provider, origin, providerName: provider.name };
}

// One request. Returns { json } or { buffer, contentType } depending on `as`.
//
// Every non-2xx and every transport failure becomes a WorldGenError with a
// message naming the host, because "could not load" with no host in it is the
// error that sends someone to read this file.
// `deps.fetchImpl` exists for the tests, and only for the tests: every error
// path below is a branch on a response this process cannot produce on demand
// (a 401 from a host that is answering, an unreachable port, a truncated
// body), and a suite that had to arrange a real one would either be flaky or
// would not cover them at all. safeFetch already takes the same injection
// point, for the same reason.
async function request(service, path, { method = 'GET', body = null, as = 'json' } = {}, deps = {}) {
  const url = new URL(path, `${service.origin}/`).toString();
  const headers = { ...authHeaders(service.provider) };
  if (body !== null) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await safeFetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    }, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined);
  } catch (err) {
    // The far side is WSL2 behind a port proxy that goes stale on restart with
    // no error of its own, so "unreachable" is the single most likely failure
    // in practice and deserves a message that says what to check.
    throw new WorldGenError(
      'unreachable',
      `Could not reach the world-spec service at ${redactUrl(service.origin)} `
      + `(via AI connector "${service.providerName}"): ${err.message}`,
      { status: 502 },
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new WorldGenError(
      'auth_failed',
      `The world-spec service at ${redactUrl(service.origin)} rejected the bearer token `
      + `stored on AI connector "${service.providerName}" (HTTP ${res.status}). `
      + 'The token is set but not accepted -- check it has not been rotated or revoked.',
      { status: 502 },
    );
  }
  if (res.status === 404) {
    throw new WorldGenError('not_found', 'That region does not exist on the world-spec service.', { status: 404 });
  }
  if (!res.ok) {
    // The service answers errors as {"detail": "..."}; surface it verbatim
    // when present rather than replacing a specific complaint with a generic one.
    let detail = null;
    try {
      const read = await readJsonCapped(res, MAX_SPEC_BYTES());
      detail = read.json && typeof read.json.detail === 'string' ? read.json.detail : null;
    } catch { /* a non-JSON error body is not itself an error worth reporting */ }
    throw new WorldGenError(
      'service_error',
      `The world-spec service answered HTTP ${res.status}${detail ? `: ${detail}` : ''}.`,
      { status: 502, detail },
    );
  }

  if (as === 'buffer') {
    const read = await readCapped(res, MAX_PREVIEW_BYTES());
    if (read.error) throw new WorldGenError('service_error', `Preview rejected: ${read.error}`);
    return {
      buffer: read.buffer,
      contentType: (res.headers && res.headers.get && res.headers.get('content-type')) || 'image/png',
    };
  }
  const read = await readJsonCapped(res, MAX_SPEC_BYTES());
  if (read.error) throw new WorldGenError('service_error', `Response rejected: ${read.error}`);
  return { json: read.json };
}

// A region name reaches us from the browser and is interpolated into a URL
// path and, on the download route, into a FILENAME. Both are why this is
// strict rather than merely escaped: a name outside this shape has no valid
// reading, and `..` in a spec name must never become a path.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new WorldGenError(
      'bad_name',
      'A region name must be 1-64 characters of letters, digits, hyphen or underscore.',
      { status: 400 },
    );
  }
  return name;
}

async function listWorlds(db, deps = {}) {
  const service = await resolveWorldService(db);
  const { json } = await request(service, '/api/worlds', {}, deps);
  const items = json && Array.isArray(json.items) ? json.items : [];
  return { items, total: Number(json && json.total) || items.length, provider: service.providerName };
}

async function getWorldSpec(db, name, deps = {}) {
  assertName(name);
  const service = await resolveWorldService(db);
  const { json } = await request(service, `/api/worlds/${name}`, {}, deps);
  return json;
}

async function getWorldReport(db, name, deps = {}) {
  assertName(name);
  const service = await resolveWorldService(db);
  const { json } = await request(service, `/api/worlds/${name}/report`, {}, deps);
  return json;
}

async function getPreview(db, name, deps = {}) {
  assertName(name);
  const service = await resolveWorldService(db);
  return request(service, `/api/worlds/${name}/preview.png`, { as: 'buffer' }, deps);
}

async function createWorld(db, body, deps = {}) {
  const service = await resolveWorldService(db);
  const { json } = await request(service, '/api/worlds', { method: 'POST', body }, deps);
  return json;
}

// PATCH carries over every field it is not given, INCLUDING the biome plan --
// that is the generator's contract and the reason an edit must send only what
// it changes. Sending a whole round-tripped object back would silently pin
// fields the caller never meant to freeze.
async function patchWorld(db, name, body, deps = {}) {
  assertName(name);
  const service = await resolveWorldService(db);
  const { json } = await request(service, `/api/worlds/${name}`, { method: 'PATCH', body }, deps);
  return json;
}

async function deleteWorld(db, name, deps = {}) {
  assertName(name);
  const service = await resolveWorldService(db);
  const { json } = await request(service, `/api/worlds/${name}`, { method: 'DELETE' }, deps);
  return json;
}

module.exports = {
  WorldGenError,
  resolveWorldService,
  listWorlds,
  getWorldSpec,
  getWorldReport,
  getPreview,
  createWorld,
  patchWorld,
  deleteWorld,
  assertName,
  NAME_RE,
};
