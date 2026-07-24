const BASE = () => process.env.SPRITE_GEN_URL || 'http://sprite-gen:8100';

// These are all control-plane calls: /generate returns 202 immediately (the
// long, CPU-bound work runs as an async job on the sprite-gen side and is
// polled via /jobs), so a bounded timeout here is safe and prevents a hung
// service from hanging the request forever. It is NOT a cap on generation time.
const TIMEOUT_MS = () => parseInt(process.env.SPRITE_GEN_TIMEOUT_MS || '30000', 10);

// F-033/SOMET-213: sprite-gen's POST /generate is gated behind this shared
// secret (backend is its only legitimate caller). Fail loudly rather than
// silently calling sprite-gen without the header — that would either 500
// against a correctly-configured sprite-gen or, worse, look identical to
// success against a misconfigured one that fell back to open. compose
// requires this var the same way it requires JWT_SECRET.
function _sharedSecretOrThrow() {
  const secret = process.env.SPRITE_GEN_SHARED_SECRET;
  if (!secret) {
    throw new Error('SPRITE_GEN_SHARED_SECRET is not configured — refusing to call sprite-gen unauthenticated');
  }
  return secret;
}

async function _fetch(path, init = {}) {
  const headers = { ...(init.headers || {}), 'X-Sprite-Gen-Secret': _sharedSecretOrThrow() };
  return fetch(`${BASE()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS()), ...init, headers });
}

async function postGenerate(body) {
  const res = await _fetch('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sprite-gen /generate ${res.status}`);
  return res.json();
}

async function getJob(jobId) {
  // Defense in depth: index.js validates jobId against a strict format before
  // calling this, but encode here too so a caller of this module directly
  // can't smuggle a "../" segment into the sprite-gen URL (SOMET-182).
  const res = await _fetch(`/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`sprite-gen /jobs ${res.status}`);
  return res.json();
}

async function getCapability() {
  const res = await _fetch('/capability');
  if (!res.ok) throw new Error(`sprite-gen /capability ${res.status}`);
  return res.json();
}

module.exports = { postGenerate, getJob, getCapability };
