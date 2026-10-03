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

// --- The model gateway (plan 2026-10-03) ----------------------------------
//
// The box's GPU worker holds ONE model at a time. The drain switches it once
// per phase boundary (text model for the prompt phase, then each audio drain
// group's model) instead of letting each call pull in its own model and
// evict the other's.
//
// Which gateway model each drain group needs. Read 2026-10-03 (plan Task 0)
// from GET /api/model-gateway, /api/text/models and the "requested <model>"
// text of failed rows in the box's job log (GET /api/audio?limit=200):
//   music     audio:ace-step      (11 failed rows named it)
//   ambience  audio:stable-audio  (one failed row named it)
// The sfx groups (sfx_realistic, sfx_retro) are UNKNOWN -- no refusal in the
// log named one -- so they have no entry: the drain skips the up-front switch
// for them and, when a call is refused, switches to the model the refusal
// names (requestedModel). The text model is not here: it is
// `brain:${textProvider.model}`, since /api/text/models lists ids without
// the prefix.
const GATEWAY_MODEL_FOR_GROUP = Object.freeze({
  music: 'audio:ace-step',
  ambience: 'audio:stable-audio',
});

// The model a gateway refusal asked for -- "requested audio:ace-step, but
// brain:... holds the card" -> 'audio:ace-step' -- or null. Trailing
// punctuation is the sentence's, not the id's.
function requestedModel(error) {
  const m = typeof error === 'string' ? /requested (\S+)/.exec(error) : null;
  const id = m ? m[1].replace(/[,;.]+$/, '') : '';
  return id || null;
}

// Whether a failure is the model gateway refusing to load the model the call
// needs ("Model gateway: requested audio:ace-step, but brain:... holds the
// card" / "... but 1 job(s) queued for the active model ..."). The box says
// this through an HTTP 409 OR as a FAILED row in its job log, which reaches
// us with no status at all (generateTrack's ledger poll) -- so the text, not
// the status, is what marks it. A refusal is "not now", never a bad job.
function isGatewayRefusal(error) {
  return typeof error === 'string' && /Model gateway: requested \S+/.test(error);
}

// Makes `model` the box's active (pinned) model. NORMAL mode only: the box
// answers 409 while any job is queued, running or deferred, and the caller
// waits that out. `force` is never sent -- it would cut off whatever the box
// is doing for someone else. callJson's shape: a 409/503 is retryable with
// its status, which the drain reads as "wait".
async function switchModel(provider, model, { fetchImpl = fetch } = {}) {
  if (typeof model !== 'string' || !model) return { ok: false, error: 'switchModel requires a model id' };
  return callJson(provider, 'POST', '/api/model-gateway/switch', { model }, fetchImpl);
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

// A batch of decoded, checked clips from a `POST /api/audio/sfx[-pack]`
// response's `audio` array -- shared by generateSfx and generateSfxPack's
// per-item loop so both check every variant the same way. Returns
// `{ ok:false, error }` on the first bad buffer rather than partial results:
// the box returning even one variant that isn't a usable clip is the box's
// output being wrong (same reasoning as `finish` above), not something a
// caller can use half of.
function sfxClips(audio) {
  const list = Array.isArray(audio) ? audio : (typeof audio === 'string' ? [audio] : []);
  if (!list.length) return { ok: false, error: 'audio service returned no sfx variants' };
  const clips = [];
  for (const b64 of list) {
    const buffer = Buffer.from(b64, 'base64');
    const checked = checkClipBuffer(buffer, 'sfx');
    if (!checked.ok) return { ok: false, error: checked.error };
    clips.push({ buffer, durationMs: checked.durationMs, sampleRate: checked.sampleRate });
  }
  return { ok: true, clips };
}

async function generateSfx(provider, req, { fetchImpl = fetch } = {}) {
  const {
    cue, entity, engine, seed,
  } = req;
  const variants = Number.isInteger(req.variants) ? req.variants : 1;
  if (typeof cue !== 'string' || !cue) return { ok: false, error: 'generateSfx requires a cue' };
  // Every generation sends an explicit seed (spec, global constraint), even
  // though the box's SFX cache key ignores it (spec §2 "SFX variation =
  // entity text") -- a missing seed must still fail loudly rather than let
  // JSON.stringify silently drop the field.
  if (!Number.isInteger(seed)) return { ok: false, error: 'generateSfx requires an explicit integer seed' };
  const body = { cue, variants, seed };
  if (entity) body.entity = entity;
  if (engine) body.engine = engine;

  const r = await callJson(provider, 'POST', '/api/audio/sfx', body, fetchImpl);
  if (!r.ok) return r;
  const j = r.json || {};
  const decoded = sfxClips(j.audio);
  // A malformed/unusable clip in the response is the box's fault, same as
  // callJson's own providerFault cases (unusable JSON, a failed ledger row).
  if (!decoded.ok) return { ok: false, error: decoded.error, providerFault: true };
  const info = j.info || {};
  return {
    ok: true,
    clips: decoded.clips,
    prompt: info.prompt || null,
    seed: Number.isFinite(info.seed) ? info.seed : seed,
    cached: Boolean(info.cached),
  };
}

async function generateSfxPack(provider, req, { fetchImpl = fetch } = {}) {
  const { items, engine, seed } = req;
  const variants = Number.isInteger(req.variants) ? req.variants : 1;
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'generateSfxPack requires at least one item' };
  if (!Number.isInteger(seed)) return { ok: false, error: 'generateSfxPack requires an explicit integer seed' };
  const body = {
    items: items.map((it) => {
      const out = { cue: it.cue };
      if (it.entity) out.entity = it.entity;
      if (it.engine) out.engine = it.engine;
      return out;
    }),
    variants,
    seed,
  };
  if (engine) body.engine = engine;

  const r = await callJson(provider, 'POST', '/api/audio/sfx-pack', body, fetchImpl);
  if (!r.ok) {
    // A whole-pack 400 for one unknown cue names the cue in the box's own
    // detail text (spec §2 "SFX caching and packs": `unknown cue '<x>'; see
    // GET /api/audio/styles?kind=sfx`), already folded into r.error by
    // callJson -- surface it as `unknownCue` so a caller can report which
    // subject broke the pack rather than just "the pack failed". Not a
    // providerFault: an unknown cue is OUR request being wrong (a stale
    // registry entry, or models_cache out of date), not the box
    // malfunctioning.
    const m = typeof r.error === 'string' && r.error.match(/unknown cue '([^']+)'/);
    if (m) {
      return {
        ok: false, error: r.error, retryable: false, providerFault: false, unknownCue: m[1],
      };
    }
    return r;
  }
  const rows = Array.isArray(r.json && r.json.items) ? r.json.items : [];
  const outItems = [];
  for (const row of rows) {
    if (!row || row.error) {
      outItems.push({
        ok: false, cue: row && row.cue, entity: row && row.entity, error: (row && row.error) || 'sfx pack item failed', providerFault: true,
      });
      continue;
    }
    const decoded = sfxClips(row.audio);
    if (!decoded.ok) {
      outItems.push({
        ok: false, cue: row.cue, entity: row.entity, error: decoded.error, providerFault: true,
      });
      continue;
    }
    outItems.push({
      ok: true,
      cue: row.cue,
      entity: row.entity,
      clips: decoded.clips,
      prompt: row.prompt || null,
      seed: Number.isFinite(row.seed) ? row.seed : seed,
      cached: Boolean(row.cached),
    });
  }
  return { ok: true, items: outItems };
}

module.exports = {
  listStyles, propose, generateTrack, generateSfx, generateSfxPack, switchModel, requestedModel, isGatewayRefusal, GATEWAY_MODEL_FOR_GROUP,
};
