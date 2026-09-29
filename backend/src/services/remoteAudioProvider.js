// The adapter for the GPU box's audio API (spec §2, "Box contract, measured
// 2026-09-28"). Hand-written rather than template-driven: styles, cues and
// packs do not reduce to {{prompt}} substitution.
//
// Every call goes through safeFetch (scheme/redirect/credential guard) and a
// capped read. Every returned clip has passed checkClipBuffer, so callers can
// store what they get without re-checking.
const { safeFetch, readCapped, readJsonCapped, redactUrl, errorDetail } = require('./safeFetch');
const { authHeaders, resolveUrl } = require('./providerDiscovery');
const { checkClipBuffer, AUDIO_SIZE_CAPS } = require('./oggInfo');

const JSON_CAP = () => Number(process.env.AUDIO_JSON_MAX_BYTES) || 16 * 1024 * 1024; // base64 of an 8 MB clip + info
const TIMEOUT_MS = () => Number(process.env.AUDIO_GENERATE_TIMEOUT_MS) || 10 * 60 * 1000;
const POLL_MS = () => Number(process.env.AUDIO_POLL_MS) || 3000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(provider, method, pathAndQuery, body, fetchImpl) {
  const url = resolveUrl(provider.base_url, pathAndQuery);
  const headers = { ...authHeaders(provider) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const res = await safeFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    }, { fetchImpl });
    return { res };
  } catch (err) {
    return { error: `could not reach ${redactUrl(url)}: ${err.message}` };
  }
}

async function callJson(provider, method, pathAndQuery, body, fetchImpl) {
  const { res, error } = await call(provider, method, pathAndQuery, body, fetchImpl);
  if (error) return { ok: false, error, retryable: true };
  if (!res.ok) {
    // The box's own words about why it said no -- the ONE fact that explains
    // a 500/404/etc, the same reasoning safeFetch.errorDetail was written
    // for on the image side. Read before anything else consumes the body;
    // bounded and condensed by errorDetail itself, so this can never grow the
    // error past a sentence or leak more than a prefix of a runaway body.
    const detail = await errorDetail(res);
    return {
      ok: false,
      status: res.status,
      retryable: res.status === 409 || res.status === 503,
      error: `audio service answered ${res.status} for ${method} ${pathAndQuery.split('?')[0]}`
        + (detail ? `: ${detail}` : ''),
    };
  }
  const read = await readJsonCapped(res, JSON_CAP());
  // A 2xx that isn't usable JSON is the box malfunctioning, not a subject
  // problem -- providerFault so the dispatcher's breaker can see it even
  // though this is not itself an HTTP failure status.
  if (read.error) return { ok: false, error: `audio service did not answer with usable JSON: ${read.error}`, providerFault: true };
  return { ok: true, json: read.json };
}

async function listStyles(provider, { fetchImpl = fetch } = {}) {
  const s = await callJson(provider, 'GET', '/api/audio/styles', undefined, fetchImpl);
  if (!s.ok) return s;
  const c = await callJson(provider, 'GET', '/api/audio/styles?kind=sfx', undefined, fetchImpl);
  if (!c.ok) return c;
  if (!Array.isArray(s.json) || !Array.isArray(c.json)) return { ok: false, error: 'styles response is not a list' };
  return {
    ok: true,
    styles: s.json.map(({ value, label, kind, slots }) => ({ value, label, kind, slots: slots || {} })),
    cues: c.json.map(({ value, label, engines, entity_default }) => ({ value, label, engines: engines || [], entity_default })),
  };
}

async function propose(provider, { context, kind }, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'POST', '/api/audio/propose', { context, kind }, fetchImpl);
  if (!r.ok) return r;
  const { style, slots, prompt } = r.json || {};
  return { ok: true, style: style || null, slots: slots || {}, prompt: prompt || '' };
}

function loopMs(info, key) {
  const v = info && info[key];
  const rate = info && info.sample_rate;
  return Number.isFinite(v) && rate > 0 ? Math.round((v * 1000) / rate) : null;
}

function finish(buffer, kind, info, fallback) {
  const checked = checkClipBuffer(buffer, kind);
  // The box returned a file and it is not a usable clip (wrong format, too
  // short, etc) -- that is the box's output being wrong, not the subject's
  // fault, so it counts as a providerFault for the breaker.
  if (!checked.ok) return { ok: false, error: checked.error, providerFault: true };
  return {
    ok: true,
    buffer,
    durationMs: checked.durationMs,
    sampleRate: checked.sampleRate,
    loopStartMs: loopMs(info, 'loop_start'),
    loopEndMs: loopMs(info, 'loop_end'),
    prompt: (info && info.prompt) || fallback.prompt || null,
    seed: (info && Number.isFinite(info.seed)) ? info.seed : fallback.seed,
  };
}

async function generateTrack(provider, req, { fetchImpl = fetch, sleep = realSleep } = {}) {
  const { kind, name, style, prompt, slots, seed, duration_s: durationS } = req;
  if (kind !== 'music' && kind !== 'ambience') return { ok: false, error: `generateTrack kind must be music or ambience, got ${kind}` };
  // Every generation sends an explicit seed (spec, global constraint) -- a
  // missing seed must fail loudly here rather than silently vanish from the
  // POST body (JSON.stringify drops an undefined field) and have the box pick
  // one nobody recorded.
  if (!Number.isInteger(seed)) return { ok: false, error: 'generateTrack requires an explicit integer seed' };
  const body = { kind, name, seed };
  if (style) body.style = style;
  if (prompt) body.prompt = prompt;
  if (slots && Object.keys(slots).length) body.slots = slots;
  if (durationS) body.duration_s = durationS;

  const started = await callJson(provider, 'POST', '/api/audio', body, fetchImpl);
  if (!started.ok) return started;
  const j = started.json || {};
  const inline = Array.isArray(j.audio) ? j.audio[0] : j.audio;
  if (typeof inline === 'string') {
    return finish(Buffer.from(inline, 'base64'), kind, j.info || j, { prompt, seed });
  }

  // Queued/async shape: poll the ledger by name until it settles.
  const deadline = Date.now() + TIMEOUT_MS();
  let row = j.status === 'done' ? j : null;
  while (!row) {
    if (Date.now() > deadline) return { ok: false, retryable: true, error: `audio generation '${name}' did not finish in time` };
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS());
    // eslint-disable-next-line no-await-in-loop
    const led = await callJson(provider, 'GET',
      `/api/audio?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}&limit=1`, undefined, fetchImpl);
    if (!led.ok) return led;
    // The ledger can hold rows for other jobs (a concurrent generation, a
    // stale/previous run under the same kind). Only a row whose name matches
    // THIS request is ours -- anything else counts as "not yet seen" and
    // polling continues, rather than attaching a different job's loop points,
    // prompt and seed to the file we're about to fetch.
    const items = led.json && Array.isArray(led.json.items) ? led.json.items : [];
    const item = items.find((it) => it && it.name === name) || null;
    // The box's own ledger reporting a failure (e.g. CUDA out of memory) is
    // a fault in the box's generation, not something wrong with the request
    // -- providerFault for the breaker, same as any other box malfunction.
    if (item && item.status === 'failed') {
      return {
        ok: false, error: `audio service failed: ${item.error || 'no reason given'}`, providerFault: true,
      };
    }
    if (item && item.status === 'done') row = item;
  }
  const { res, error } = await call(provider, 'GET',
    `/api/audio/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, undefined, fetchImpl);
  if (error) return { ok: false, retryable: true, error };
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      retryable: res.status === 409 || res.status === 503,
      error: `audio file fetch answered ${res.status}`,
    };
  }
  const read = await readCapped(res, AUDIO_SIZE_CAPS[kind] + 1);
  // A read/decode failure on the file the box just told us was ready is the
  // box's output being unusable, not a transport error and not the
  // subject's fault -- providerFault for the breaker.
  if (read.error) return { ok: false, error: `audio file: ${read.error}`, providerFault: true };
  return finish(read.buffer, kind, row, { prompt, seed });
}

module.exports = { listStyles, propose, generateTrack };
