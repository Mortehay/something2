// Kind-aware model discovery for the admin provider form: asks a registered
// provider which models each KIND (text, sprite, image_edit, audio, image)
// can choose from, and shapes the answer as flat entries for discovery_cache.
//
//   entry = { kind, id, label, available, group? }
//
// Dispatch is on provider.adapter. A NULL adapter on a modality that only
// exists on the GPU box (audio/text/sprite/image_edit) is treated as 'box';
// a NULL-adapter image row goes through the models_path/models_pointer
// discovery like a1111/generic.
//
// Never throws: every path resolves to { ok, ... }. The fetch is injected so
// the tests exercise real parsing against stubbed service shapes.
//
// Require-cycle note: textProvider may come to require this module (its
// listTextModels will delegate to listOllamaModels/listOpenAiModels), so
// textProvider is required LAZILY inside the box-text branch, never at the
// top of this file.
const { safeFetch, readJsonCapped, redactUrl, errorDetail } = require('./safeFetch');
const {
  authHeaders, resolveUrl, fetchModels, TIMEOUT_MS,
} = require('./providerDiscovery');
const { MODALITIES } = require('./aiProviders');
const gpuBoxSprites = require('./gpuBoxSprites');

const JSON_CAP = () => Number(process.env.AI_PROVIDER_MAX_DISCOVERY_BYTES) || 2 * 1024 * 1024;

// GET path under base_url -> { ok, json } | { ok:false, error, status? }.
async function getJson(provider, path, fetchImpl) {
  let url;
  try {
    url = resolveUrl(provider.base_url, path);
  } catch (err) {
    return { ok: false, error: `invalid base_url: ${err.message}` };
  }
  let res;
  try {
    res = await safeFetch(url, {
      method: 'GET', headers: { ...authHeaders(provider) }, signal: AbortSignal.timeout(TIMEOUT_MS()),
    }, { fetchImpl });
  } catch (err) {
    return { ok: false, error: `could not reach ${redactUrl(url)}: ${err.message}` };
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    return { ok: false, status: res.status, error: `service answered ${res.status} for ${path}${detail ? `: ${detail}` : ''}` };
  }
  const read = await readJsonCapped(res, JSON_CAP());
  if (read.error) return { ok: false, status: res.status, error: `${path} did not answer with usable JSON: ${read.error}` };
  return { ok: true, json: read.json };
}

// Ollama: GET /api/tags -> { models: [{ name }] }.
async function listOllamaModels(provider, { fetchImpl = fetch } = {}) {
  const r = await getJson(provider, '/api/tags', fetchImpl);
  if (!r.ok) return r;
  const list = r.json && r.json.models;
  if (!Array.isArray(list)) return { ok: false, error: 'Ollama /api/tags has no models list' };
  return { ok: true, models: list.map((m) => m && m.name).filter((n) => typeof n === 'string' && n) };
}

// OpenAI-compatible: GET /v1/models -> { data: [{ id }] }.
async function listOpenAiModels(provider, { fetchImpl = fetch } = {}) {
  const r = await getJson(provider, '/v1/models', fetchImpl);
  if (!r.ok) return r;
  const list = r.json && r.json.data;
  if (!Array.isArray(list)) return { ok: false, error: '/v1/models has no data list' };
  return { ok: true, models: list.map((m) => m && m.id).filter((n) => typeof n === 'string' && n) };
}

// The box's /api/models/status payload shape was never captured (Task 0), so
// this deliberately makes NO network call and returns null: discovery falls
// through to the per-kind sources. When the payload is verified, kind-labelled
// discovery plugs in HERE and returns entries (kinds outside MODALITIES then
// land in `unsupported`).
async function fromModelsStatus() { // eslint-disable-line no-unused-vars
  return null;
}

const entry = (kind, id, label, extra = {}) => ({
  kind, id, label: label || id, available: true, ...extra,
});

// An id out of a gateway choice: a string, or the first string field among
// id/model/value/name of an object.
function choiceId(c) {
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    for (const k of ['id', 'model', 'value', 'name']) if (typeof c[k] === 'string') return c[k];
  }
  return null;
}

async function boxText(provider, fetchImpl) {
  const { listTextModels } = require('./textProvider'); // lazy: see header
  const r = await listTextModels(provider, { fetchImpl });
  return r.ok ? { ok: true, entries: r.models.map((m) => entry('text', m)) } : r;
}

async function boxSprite(provider, fetchImpl) {
  const r = await gpuBoxSprites.listConceptModels(provider, { fetchImpl });
  return r.ok ? { ok: true, entries: r.models.map((m) => entry('sprite', m)) } : r;
}

// GET /api/edit-capabilities -> [null, 'pixelate', ...]; null is the base model.
async function boxImageEdit(provider, fetchImpl) {
  const r = await getJson(provider, '/api/edit-capabilities', fetchImpl);
  if (!r.ok) return r;
  if (!Array.isArray(r.json)) return { ok: false, error: '/api/edit-capabilities is not a list' };
  const entries = [];
  for (const c of r.json) {
    if (c === null) entries.push(entry('image_edit', '', 'Base model'));
    else {
      const id = choiceId(c);
      if (id) entries.push(entry('image_edit', id));
    }
  }
  return { ok: true, entries };
}

// GET /api/model-gateway `choices`; only audio:* ids are audio models.
async function boxAudio(provider, fetchImpl) {
  const r = await getJson(provider, '/api/model-gateway', fetchImpl);
  if (!r.ok) return r;
  const choices = r.json && r.json.choices;
  if (!Array.isArray(choices)) return { ok: false, error: '/api/model-gateway has no choices list' };
  const entries = choices.map(choiceId)
    .filter((id) => typeof id === 'string' && id.startsWith('audio:'))
    .map((id) => entry('audio', id));
  return { ok: true, entries };
}

// Each source is independent; ok:false only if every one failed.
async function discoverBox(provider, fetchImpl) {
  const sources = [boxText, boxSprite, boxImageEdit, boxAudio];
  const results = await Promise.all(sources.map((s) => s(provider, fetchImpl).catch((err) => ({ ok: false, error: err.message }))));
  const good = results.filter((r) => r.ok);
  if (good.length === 0) {
    const first = results[0];
    return { ok: false, error: first.error, ...(first.status ? { status: first.status } : {}) };
  }
  return { ok: true, entries: good.flatMap((r) => r.entries), source: 'per_kind' };
}

const BOX_NULL_ADAPTER = new Set(['audio', 'text', 'sprite', 'image_edit']);

function effectiveAdapter(provider) {
  if (provider.adapter) return provider.adapter;
  return BOX_NULL_ADAPTER.has(provider.modality) ? 'box' : null;
}

async function discover(provider, { fetchImpl = fetch } = {}) {
  try {
    const adapter = effectiveAdapter(provider);
    let found;
    if (adapter === 'box') {
      const labelled = await fromModelsStatus(provider, fetchImpl);
      found = labelled ? { ok: true, entries: labelled, source: 'models_status' } : await discoverBox(provider, fetchImpl);
    } else if (adapter === 'ollama' || adapter === 'openai_compatible') {
      const r = adapter === 'ollama'
        ? await listOllamaModels(provider, { fetchImpl })
        : await listOpenAiModels(provider, { fetchImpl });
      found = r.ok
        ? { ok: true, entries: r.models.map((m) => entry(provider.modality, m)), source: adapter === 'ollama' ? 'ollama' : 'openai' }
        : r;
    } else {
      const r = await fetchModels(provider, { fetchImpl });
      found = r.ok
        ? { ok: true, entries: r.models.map((m) => entry(provider.modality, m)), source: 'models_path' }
        : r;
    }
    if (!found.ok) {
      return { ok: false, error: found.error, ...(found.status ? { status: found.status } : {}) };
    }
    const unsupported = found.entries.filter((e) => !MODALITIES.includes(e.kind));
    return {
      ok: true,
      cache: { entries: found.entries, unsupported, source: found.source },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { discover, listOllamaModels, listOpenAiModels };
