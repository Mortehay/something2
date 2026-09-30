// Audio prompt writer (spec 2026-09-30 §3.3). One way to ask a model for
// text: the active 'text' AI provider (the GPU box's /api/text) first, the
// local Ollama the art describer already uses as the fallback.
//
// FALLBACK ONLY WHEN THE BOX COULD NOT ANSWER: no provider, 409/503 (the
// model gateway is switching or the model cannot load -- busy, not broken),
// a transport error or a timeout. Any other 4xx is a request WE built wrong,
// and hiding it behind a CPU answer would bury the bug.
//
// Never throws: every path returns { ok, ... } with `via` saying who
// answered or who failed, so a CPU-written prompt is visible as one.
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
  const url = resolveUrl(provider.base_url, '/api/text');
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
    const busy = BUSY_STATUSES.has(res.status);
    return {
      ok: false, busy, fallbackable: busy, status: res.status,
      error: `text service answered ${res.status}${detail ? `: ${detail}` : ''}`,
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
    maxTokens: request.maxTokens || 256,
  };
  const provider = await aiProviders.loadActiveProviderWithSecret(db, 'text');
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
  const url = resolveUrl(provider.base_url, '/api/text/models');
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
