// Audio prompt writer (spec 2026-09-30 §3.3). One way to ask a model for
// text: the active 'text' AI provider (the GPU box's /api/text) first, the
// local Ollama the art describer already uses as the fallback.
//
// FALLBACK WHEN THE BOX COULD NOT ANSWER, OR ANSWERED WITH A FAULT THAT IS
// NOT OUR REQUEST'S FAULT: no provider, a malformed provider row, a
// transport error or a timeout, 409/503 (the model gateway is switching or
// the model cannot load -- busy, not broken), or any other 5xx
// (500/502/504/... -- the box itself is broken, not the request). 409/503
// are reported as `busy: true` so a caller can choose to wait instead of
// falling back; other 5xx still fall back but are NOT busy -- there is no
// defined point at which a generic server fault "clears". Any 4xx other
// than 409 is a request WE built wrong, and hiding it behind a CPU answer
// would bury the bug -- no fallback for those.
//
// Never throws: every path returns { ok, ... } with `via` saying who
// answered or who failed, so a CPU-written prompt is visible as one. That
// includes failures outside the HTTP exchange itself -- a malformed
// base_url on the provider row, or the provider-lookup query rejecting --
// both come back as an ordinary { ok: false, via: 'box' } rather than an
// exception, and neither falls back (a misconfigured row or a DB outage is
// not something a CPU answer fixes).
const aiProviders = require('./aiProviders');
const {
  safeFetch, readJsonCapped, redactUrl, errorDetail,
} = require('./safeFetch');
const { authHeaders, resolveUrl } = require('./providerDiscovery');

const TIMEOUT_MS = () => Number(process.env.TEXT_PROVIDER_TIMEOUT_MS) || 300000;
const FALLBACK_URL = () => process.env.ART_DESCRIBER_URL || 'http://localhost:20434/v1/chat/completions';
const FALLBACK_MODEL = () => process.env.ART_DESCRIBER_MODEL || 'qwen2.5-coder:7b';
const JSON_CAP = 1024 * 1024;
const BUSY_STATUSES = new Set([409, 503]);

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// -> { ok: true, text, json, model, ms } | { ok: false, error, busy, fallbackable }
async function callBox(provider, req, fetchImpl) {
  let url;
  try {
    url = resolveUrl(provider.base_url, '/api/text');
  } catch (err) {
    // A malformed base_url is a misconfigured row, i.e. our bug -- never
    // reaches fetchImpl, and not something a CPU fallback answer fixes.
    return { ok: false, busy: false, fallbackable: false, error: `invalid base_url: ${err.message}` };
  }
  const started = Date.now();
  let res;
  try {
    res = await safeFetch(url, {
      method: 'POST',
      headers: { ...authHeaders(provider), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: req.system,
        prompt: req.prompt,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        json_schema: req.jsonSchema || undefined,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    }, { fetchImpl });
  } catch (err) {
    return { ok: false, busy: true, fallbackable: true, error: `could not reach ${redactUrl(url)}: ${err.message}` };
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    const status = res.status;
    const busy = BUSY_STATUSES.has(status);
    // Any 5xx that isn't already counted as "busy" (500/502/504/...) is the
    // box itself malfunctioning, not our request -- worth a fallback
    // answer, but not something worth waiting on (no defined point at
    // which it "clears"), so it is fallbackable without being busy.
    const serverFault = status >= 500 && !busy;
    return {
      ok: false, busy, fallbackable: busy || serverFault, status,
      error: `text service answered ${status}${detail ? `: ${detail}` : ''}`,
    };
  }
  const read = await readJsonCapped(res, JSON_CAP);
  if (read.error) return { ok: false, busy: false, fallbackable: false, error: `text service did not answer with usable JSON: ${read.error}` };
  const j = read.json || {};
  const text = typeof j.text === 'string' ? j.text : '';
  let json = null;
  if (j.json && typeof j.json === 'object') json = j.json;
  else if (req.jsonSchema) json = parseJson(text);
  return {
    ok: true, text, json, model: j.model || provider.name, ms: Number.isFinite(j.ms) ? j.ms : Date.now() - started,
  };
}

async function callFallback(req, fetchImpl) {
  const started = Date.now();
  const messages = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });
  const body = {
    model: FALLBACK_MODEL(), messages, temperature: req.temperature, max_tokens: req.maxTokens, stream: false,
  };
  if (req.jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: req.jsonSchema } };
  let res;
  try {
    res = await fetchImpl(FALLBACK_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
  } catch (err) {
    return { ok: false, error: `fallback model unreachable: ${err.message}` };
  }
  if (!res.ok) return { ok: false, error: `fallback model answered ${res.status}` };
  const j = await res.json().catch(() => null);
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  const text = msg ? String(msg.content || '') : '';
  return {
    ok: true, text, json: req.jsonSchema ? parseJson(text) : null, model: FALLBACK_MODEL(), ms: Date.now() - started,
  };
}

async function complete(db, request, { fetchImpl = fetch, boxOnly = false } = {}) {
  const req = {
    system: request.system || '',
    prompt: request.prompt,
    jsonSchema: request.jsonSchema || null,
    temperature: Number.isFinite(request.temperature) ? request.temperature : 0.15,
    maxTokens: Number.isInteger(request.maxTokens) && request.maxTokens > 0 ? request.maxTokens : 256,
  };
  let provider;
  try {
    provider = await aiProviders.loadActiveProviderWithSecret(db, 'text');
  } catch (err) {
    // A DB outage is not a box problem -- no fallback, same reasoning as a
    // malformed provider row.
    return { ok: false, error: `could not read the text provider: ${err.message}`, busy: false, via: 'box' };
  }
  let boxErr = null;
  if (provider) {
    const b = await callBox(provider, req, fetchImpl);
    if (b.ok) return { ...b, via: 'box' };
    if (!b.fallbackable) return { ok: false, error: b.error, busy: false, via: 'box' };
    boxErr = b;
  }
  if (boxOnly) {
    return {
      ok: false, error: boxErr ? boxErr.error : 'no active text provider', busy: Boolean(boxErr && boxErr.busy), via: 'box',
    };
  }
  const f = await callFallback(req, fetchImpl);
  if (f.ok) return { ...f, via: 'fallback' };
  return {
    ok: false, error: boxErr ? `${boxErr.error}; fallback: ${f.error}` : f.error, busy: false, via: 'fallback',
  };
}

async function listTextModels(provider, { fetchImpl = fetch } = {}) {
  let url;
  try {
    url = resolveUrl(provider.base_url, '/api/text/models');
  } catch (err) {
    return { ok: false, error: `invalid base_url: ${err.message}` };
  }
  let res;
  try {
    res = await safeFetch(url, {
      method: 'GET', headers: { ...authHeaders(provider) }, signal: AbortSignal.timeout(30000),
    }, { fetchImpl });
  } catch (err) {
    return { ok: false, error: `could not reach ${redactUrl(url)}: ${err.message}` };
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    return { ok: false, status: res.status, error: `text service answered ${res.status}${detail ? `: ${detail}` : ''}` };
  }
  const read = await readJsonCapped(res, JSON_CAP);
  if (read.error || !Array.isArray(read.json)) return { ok: false, error: 'models response is not a list' };
  return { ok: true, models: read.json.map((m) => m && m.value).filter((v) => typeof v === 'string') };
}

module.exports = { complete, listTextModels };
