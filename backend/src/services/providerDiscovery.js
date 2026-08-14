// SOMET-325: asking a registered provider what models it has, and whether it
// is answering at all.
//
// Everything here is driven by two columns on the row -- models_path and
// models_pointer -- rather than by a provider-kind enum in this file. That is
// the point: pointing the game at a service nobody has heard of should be
// typing two strings into the admin form, not shipping a release.
//
//   A1111     path /sdapi/v1/sd-models          pointer $[*].model_name
//   Ollama    path /api/tags                    pointer models[*].name
//   OpenAI-ish path /v1/models                  pointer data[*].id
//
// The fetch is injected (`fetchImpl`) so the tests exercise the real parsing
// and error handling against stubbed service shapes, with no network.

const { selectAll } = require('./pointerPath');

// Discovery and reachability are control-plane calls against a service that is
// either up or not. They are NOT image generation, which is slow by nature and
// gets its own much longer budget in SOMET-327.
const TIMEOUT_MS = () => parseInt(process.env.AI_PROVIDER_DISCOVERY_TIMEOUT_MS || '10000', 10);

// Only sent when BOTH halves are present: a header name with no value is a
// misconfiguration that would otherwise go out as `Authorization: undefined`
// and come back as a confusing 401 from the far end.
function authHeaders(provider) {
  if (provider.auth_header_name && provider.auth_token) {
    return { [provider.auth_header_name]: provider.auth_token };
  }
  return {};
}

// `new URL(path, base)` rather than string concatenation: it gets the
// slash-joining right whether or not the admin typed trailing/leading slashes,
// and an absolute models_path correctly resolves against base_url's origin.
function resolveUrl(baseUrl, path) {
  return new URL(path || '', baseUrl).toString();
}

// Turns whatever the service answered into a list of model names.
//
// Returns { models } or { error }. The two failure modes are kept distinct on
// purpose: a pointer that does not PARSE is a typo in the admin form, while a
// pointer that parses and matches nothing usually means the service answered
// in a different shape than expected. Reporting both as "no models found"
// sends the admin looking in the wrong place.
function extractModels(payload, pointer) {
  const values = selectAll(payload, pointer || '');
  if (values === null) {
    return { error: `models_pointer is not a valid path: ${pointer}` };
  }
  const names = [];
  let sawNonPrimitive = false;
  for (const v of values) {
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      if (s) names.push(s);
    } else if (v !== null && v !== undefined) {
      sawNonPrimitive = true;
    }
  }
  if (names.length === 0 && sawNonPrimitive) {
    // The single most common mistake: pointing at the objects rather than at
    // a field inside them. Say so instead of returning an empty list.
    return {
      error: 'models_pointer selected objects rather than names — '
        + 'add the field, e.g. "$[*].model_name" instead of "$[*]"',
    };
  }
  // Order-preserving dedupe: a service may list the same checkpoint twice.
  return { models: [...new Set(names)] };
}

// Always resolves. A remote box being off is an ordinary, expected state that
// the admin needs described, not an exception that becomes a 500.
async function fetchModels(provider, { fetchImpl = fetch } = {}) {
  let url;
  try {
    url = resolveUrl(provider.base_url, provider.models_path);
  } catch (_) {
    return { ok: false, error: 'base_url and models_path do not form a valid URL' };
  }
  let res;
  try {
    res = await fetchImpl(url, {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
  } catch (err) {
    // err.message here is a transport failure (ECONNREFUSED, DNS, abort). It
    // does not contain request headers, so the token cannot ride along.
    return { ok: false, error: `could not reach ${url}: ${err.message}` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: `service answered ${res.status}` };
  }
  let payload;
  try {
    payload = await res.json();
  } catch (_) {
    return { ok: false, status: res.status, error: 'service did not answer with JSON' };
  }
  const extracted = extractModels(payload, provider.models_pointer);
  if (extracted.error) return { ok: false, status: res.status, error: extracted.error };
  return { ok: true, status: res.status, models: extracted.models };
}

// Reachability only. Hits models_path when one is configured (that is the
// endpoint discovery will actually use, so it is the more useful signal) and
// otherwise base_url itself.
async function testConnection(provider, { fetchImpl = fetch, now = Date.now } = {}) {
  let url;
  try {
    url = resolveUrl(provider.base_url, provider.models_path);
  } catch (_) {
    return { ok: false, error: 'base_url is not a valid URL' };
  }
  const started = now();
  try {
    const res = await fetchImpl(url, {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
    return {
      ok: res.ok,
      status: res.status,
      latency_ms: now() - started,
      error: res.ok ? null : `service answered ${res.status}`,
    };
  } catch (err) {
    return { ok: false, latency_ms: now() - started, error: err.message };
  }
}

module.exports = {
  authHeaders, resolveUrl, extractModels, fetchModels, testConnection, TIMEOUT_MS,
};
