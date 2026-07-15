const BASE = () => process.env.SPRITE_GEN_URL || 'http://sprite-gen:8100';

// These are all control-plane calls: /generate returns 202 immediately (the
// long, CPU-bound work runs as an async job on the sprite-gen side and is
// polled via /jobs), so a bounded timeout here is safe and prevents a hung
// service from hanging the request forever. It is NOT a cap on generation time.
const TIMEOUT_MS = () => parseInt(process.env.SPRITE_GEN_TIMEOUT_MS || '30000', 10);

async function _fetch(path, init = {}) {
  return fetch(`${BASE()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS()), ...init });
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
  const res = await _fetch(`/jobs/${jobId}`);
  if (!res.ok) throw new Error(`sprite-gen /jobs ${res.status}`);
  return res.json();
}

async function getCapability() {
  const res = await _fetch('/capability');
  if (!res.ok) throw new Error(`sprite-gen /capability ${res.status}`);
  return res.json();
}

module.exports = { postGenerate, getJob, getCapability };
