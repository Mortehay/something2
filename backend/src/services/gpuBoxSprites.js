// Client for the GPU box's sprite-sheet API (spec "Observed contract").
//
// Two box surfaces are used: the concept pipeline (POST /api/generate_core,
// polled through /api/task-status/{id}) and the sheet-job API (/api/jobs).
// Every call goes through safeFetch (scheme/redirect/credential guard) and a
// capped read, and the box is the ORIGIN of the provider's base_url -- the
// stored URL usually points at a txt2img path, which is irrelevant here.
//
// Every function takes `provider` first and an options bag last
// ({ fetchImpl, sleep, pollMs, timeoutMs }) and returns { ok: true, ... } or
// { ok: false, error, retryable? } like remoteAudioProvider.callJson.
const { safeFetch, readCapped, readJsonCapped, redactUrl, errorDetail } = require('./safeFetch');
const { authHeaders, resolveUrl } = require('./providerDiscovery');

const JSON_CAP = () => Number(process.env.GPU_BOX_JSON_MAX_BYTES) || 8 * 1024 * 1024;
const SHEET_CAP = () => Number(process.env.GPU_BOX_SHEET_MAX_BYTES) || 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = () => Number(process.env.GPU_BOX_REQUEST_TIMEOUT_MS) || 60 * 1000;
const POLL_MS = () => Number(process.env.GPU_BOX_POLL_MS) || 3000;
const CONCEPT_TIMEOUT_MS = () => Number(process.env.GPU_BOX_CONCEPT_TIMEOUT_MS) || 15 * 60 * 1000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A box job in one of these will never change again.
const STATUS_TERMINAL = new Set(['done', 'failed', 'cancelled', 'missing']);

async function call(provider, method, pathAndQuery, { body, headers: extra, fetchImpl } = {}) {
  const url = resolveUrl(provider.base_url, pathAndQuery);
  const headers = { ...authHeaders(provider), ...(extra || {}) };
  try {
    const res = await safeFetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS()),
    }, { fetchImpl });
    return { res };
  } catch (err) {
    return { error: `could not reach ${redactUrl(url)}: ${err.message}`, retryable: true };
  }
}

// The box's own words for a non-2xx answer.
async function httpFailure(res, method, pathAndQuery) {
  const detail = await errorDetail(res);
  return {
    ok: false,
    status: res.status,
    retryable: res.status === 409 || res.status === 429 || res.status === 503,
    error: `GPU box answered ${res.status} for ${method} ${pathAndQuery.split('?')[0]}`
      + (detail ? `: ${detail}` : ''),
  };
}

async function callJson(provider, method, pathAndQuery, opts = {}) {
  const { res, error, retryable } = await call(provider, method, pathAndQuery, opts);
  if (error) return { ok: false, error, retryable };
  if (!res.ok) return httpFailure(res, method, pathAndQuery);
  const read = await readJsonCapped(res, JSON_CAP());
  if (read.error) return { ok: false, error: `GPU box did not answer with usable JSON: ${read.error}`, providerFault: true };
  return { ok: true, json: read.json, status: res.status };
}

async function callPng(provider, pathAndQuery, opts = {}) {
  const { res, error, retryable } = await call(provider, 'GET', pathAndQuery, opts);
  if (error) return { ok: false, error, retryable };
  if (!res.ok) return httpFailure(res, 'GET', pathAndQuery);
  const read = await readCapped(res, SHEET_CAP());
  if (read.error) return { ok: false, error: `GPU box image rejected: ${read.error}`, providerFault: true };
  return { ok: true, png: read.buffer };
}

async function actionCatalog(provider, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'GET', '/api/action-catalog', { fetchImpl });
  if (!r.ok) return r;
  if (!r.json || !Array.isArray(r.json.actions)) return { ok: false, error: 'GPU box action catalog has no actions list', providerFault: true };
  return { ok: true, catalog: r.json };
}

// Submits a concept task, polls it to a terminal state, downloads the image.
// The concept is whatever THIS task's result.url names -- never the newest
// asset, which a concurrent run (or another user of the box) can own.
async function generateConcept(provider, { prompt }, {
  fetchImpl = fetch, sleep = realSleep, pollMs = POLL_MS(), timeoutMs = CONCEPT_TIMEOUT_MS(),
} = {}) {
  // No model on the provider -> no llm_name, so the box uses its own default
  // instead of being told to load a model named "".
  const form = new URLSearchParams({ prompt });
  if (provider.model) form.set('llm_name', provider.model);
  const sub = await callJson(provider, 'POST', '/api/generate_core', {
    body: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    fetchImpl,
  });
  if (!sub.ok) return sub;
  const taskId = sub.json && sub.json.task_id;
  if (!taskId) return { ok: false, error: 'GPU box accepted the concept request but returned no task_id', providerFault: true };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const st = await callJson(provider, 'GET', `/api/task-status/${encodeURIComponent(taskId)}`, { fetchImpl });
    if (!st.ok) return st;
    const status = String(st.json && st.json.status || '').toUpperCase();
    if (status === 'SUCCESS') {
      const url = st.json.result && st.json.result.url;
      if (typeof url !== 'string' || !url) {
        return { ok: false, error: 'GPU box concept task succeeded but result.url is missing, so no image can be tied to it', providerFault: true };
      }
      // The URL is box-supplied data and the auth header rides on every call,
      // so it must resolve to the box's own origin (rejects //host/x, other
      // absolute URLs and backslash tricks) before anything is fetched.
      let sameOrigin = false;
      try { sameOrigin = new URL(url, provider.base_url).origin === new URL(provider.base_url).origin; } catch (_) { /* invalid */ }
      if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\') || !sameOrigin) {
        return { ok: false, error: 'GPU box concept task returned a result.url outside the box origin; refusing to fetch it', providerFault: true };
      }
      // eslint-disable-next-line no-await-in-loop
      const img = await callPng(provider, url, { fetchImpl });
      if (!img.ok) return img;
      return { ok: true, conceptPath: url.replace(/^\/+/, ''), png: img.png };
    }
    if (status !== 'PENDING' && status !== 'PROGRESS' && status !== 'STARTED') {
      const r = st.json.result;
      const why = r && (r.error || r.message || (typeof r === 'string' ? r : ''));
      return { ok: false, error: `GPU box concept task ended ${status || 'UNKNOWN'}${why ? `: ${why}` : ''}` };
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: `GPU box concept task timed out after ${Math.round(timeoutMs / 1000)}s`, retryable: true };
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs);
  }
}

async function createSheetJob(provider, spec, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'POST', '/api/jobs', {
    body: JSON.stringify(spec),
    headers: { 'Content-Type': 'application/json' },
    fetchImpl,
  });
  if (!r.ok) return r;
  if (!r.json || !r.json.job_id) return { ok: false, error: 'GPU box accepted the job but returned no job_id', providerFault: true };
  return { ok: true, boxJobId: r.json.job_id, cells: r.json.cells, estimatedSeconds: r.json.estimated_seconds };
}

const STATUS_MAP = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', error: 'failed', cancelled: 'cancelled', canceled: 'cancelled' };

async function getSheetJob(provider, boxJobId, { fetchImpl = fetch } = {}) {
  const p = `/api/jobs/${encodeURIComponent(boxJobId)}`;
  const { res, error, retryable } = await call(provider, 'GET', p, { fetchImpl });
  if (error) return { ok: false, error, retryable };
  if (res.status === 404) return { ok: true, job: { status: 'missing' } };
  if (!res.ok) return httpFailure(res, 'GET', p);
  const read = await readJsonCapped(res, JSON_CAP());
  if (read.error) return { ok: false, error: `GPU box did not answer with usable JSON: ${read.error}`, providerFault: true };
  const j = read.json || {};
  const status = STATUS_MAP[String(j.status || '').toLowerCase()];
  if (!status) return { ok: false, error: `GPU box reported an unknown job status "${j.status}"`, providerFault: true };
  return {
    ok: true,
    job: {
      status,
      progress: { pct: j.progress_pct, message: j.progress_msg, stage: j.stage },
      error: j.error || null,
    },
  };
}

const fetchSheet = (provider, boxJobId, { fetchImpl = fetch } = {}) =>
  callPng(provider, `/api/jobs/${encodeURIComponent(boxJobId)}/sheet`, { fetchImpl });

async function fetchAtlas(provider, boxJobId, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'GET', `/api/jobs/${encodeURIComponent(boxJobId)}/atlas`, { fetchImpl });
  if (!r.ok) return r;
  return { ok: true, atlas: r.json };
}

module.exports = {
  STATUS_TERMINAL, actionCatalog, generateConcept, createSheetJob, getSheetJob, fetchSheet, fetchAtlas,
};
