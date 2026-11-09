// Client for the GPU box's sprite-sheet API (spec "Observed contract").
//
// Two box surfaces are used: the concept pipeline (POST /api/generate_core,
// polled through /api/task-status/{id}) and the sheet-job API (/api/jobs).
// Every call goes through safeFetch (scheme/redirect/credential guard) and a
// capped read, and the box is the ORIGIN of the provider's base_url -- the
// stored URL usually points at a txt2img path, which is irrelevant here.
//
// Every function takes `provider` first and an options bag last
// ({ fetchImpl, sleep, pollMs, timeoutMs, queueCapMs, shouldStop }) and returns { ok: true, ... } or
// { ok: false, error, retryable? } like remoteAudioProvider.callJson.
const { safeFetch, readCapped, readJsonCapped, redactUrl, errorDetail } = require('./safeFetch');
const { authHeaders, resolveUrl } = require('./providerDiscovery');

const JSON_CAP = () => Number(process.env.GPU_BOX_JSON_MAX_BYTES) || 8 * 1024 * 1024;
const SHEET_CAP = () => Number(process.env.GPU_BOX_SHEET_MAX_BYTES) || 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = () => Number(process.env.GPU_BOX_REQUEST_TIMEOUT_MS) || 60 * 1000;
const POLL_MS = () => Number(process.env.GPU_BOX_POLL_MS) || 3000;
const CONCEPT_TIMEOUT_MS = () => Number(process.env.GPU_BOX_CONCEPT_TIMEOUT_MS) || 15 * 60 * 1000;
// Longest a concept task may wait PENDING behind other work on the shared box
// (a full sheet job is ~25 min) before the row gives up on it.
const CONCEPT_QUEUE_CAP_MS = () => Number(process.env.GPU_BOX_CONCEPT_QUEUE_CAP_MS) || 6 * 60 * 60 * 1000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A box job in one of these will never change again.
const STATUS_TERMINAL = new Set(['done', 'failed', 'cancelled', 'missing']);

async function call(provider, method, pathAndQuery, { body, headers: extra, fetchImpl, timeoutMs } = {}) {
  const url = resolveUrl(provider.base_url, pathAndQuery);
  const headers = { ...authHeaders(provider), ...(extra || {}) };
  try {
    const res = await safeFetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs || REQUEST_TIMEOUT_MS()),
    }, { fetchImpl });
    return { res };
  } catch (err) {
    return { error: `could not reach ${redactUrl(url)}: ${err.message}`, retryable: true, unreachable: true };
  }
}

// The box's own words for a non-2xx answer.
async function httpFailure(res, method, pathAndQuery) {
  const detail = await errorDetail(res);
  return {
    ok: false,
    status: res.status,
    retryable: res.status === 409 || res.status === 429 || res.status === 503,
    errorKind: res.headers.get('x-error-kind') || null,
    error: `GPU box answered ${res.status} for ${method} ${pathAndQuery.split('?')[0]}`
      + (detail ? `: ${detail}` : ''),
  };
}

async function callJson(provider, method, pathAndQuery, opts = {}) {
  const { res, error, retryable, unreachable } = await call(provider, method, pathAndQuery, opts);
  if (error) return { ok: false, error, retryable, unreachable };
  if (!res.ok) return httpFailure(res, method, pathAndQuery);
  const read = await readJsonCapped(res, JSON_CAP());
  if (read.error) return { ok: false, error: `GPU box did not answer with usable JSON: ${read.error}`, providerFault: true };
  return { ok: true, json: read.json, status: res.status };
}

async function callPng(provider, pathAndQuery, opts = {}) {
  const { res, error, retryable, unreachable } = await call(provider, 'GET', pathAndQuery, opts);
  if (error) return { ok: false, error, retryable, unreachable };
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

// An authenticated read (GET /api/jobs?limit=1). /api/action-catalog is served
// by the box WITHOUT auth, so it cannot prove a key is valid; /api/jobs can.
// A 401/403 reads as "box rejected the key (N)".
async function checkAuth(provider, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'GET', '/api/jobs?limit=1', { fetchImpl });
  if (r.ok) return { ok: true, status: r.status };
  if (r.status === 401 || r.status === 403) {
    return { ok: false, status: r.status, error: `box rejected the key (${r.status})` };
  }
  return r;
}

const isQwen = (m) => /qwen/i.test(String(m && m.value || ''));

// The box's available concept models (GET /api/core-models), Qwen first and
// the box UI's default first among those -- the order the provider's Model
// dropdown shows them in. Each entry is the raw roster row.
async function conceptModels(provider, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'GET', '/api/core-models', { fetchImpl });
  if (!r.ok) return r;
  const rank = (m) => (isQwen(m) ? (m.ui_default ? 0 : 1) : 2);
  const models = (Array.isArray(r.json && r.json.models) ? r.json.models : [])
    .filter((m) => m && typeof m.value === 'string' && m.available !== false)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m);
  return { ok: true, models };
}

// For the provider's Refresh button: plain model ids for models_cache.
async function listConceptModels(provider, opts = {}) {
  const r = await conceptModels(provider, opts);
  return r.ok ? { ok: true, models: r.models.map((m) => m.value) } : r;
}

// The concept model when the provider names none. The box's API default is
// SDXL + pixel-art LoRA, which the user rejected (its concepts feed the Qwen
// sheet builder badly); the box's own web UI defaults to Qwen-Image. So: the
// UI default if it is an available Qwen model, else any available Qwen model,
// else refuse -- never silently fall back to SDXL.
async function resolveConceptModel(provider, opts = {}) {
  if (provider.model) return { ok: true, model: provider.model };
  const r = await conceptModels(provider, opts);
  if (!r.ok) return r;
  const pick = r.models.find(isQwen);
  if (!pick) return { ok: false, error: 'GPU box has no available Qwen concept model (GET /api/core-models)', providerFault: true };
  return { ok: true, model: pick.value };
}

// Polls a box task (/api/task-status/{id}) to a terminal state and downloads
// the image THIS task's result.url names -- never the newest asset, which a
// concurrent run (or another user of the box) can own. `label` names the task
// in errors ("concept"). Resolves { ok, path, png, result }.
//
// SOMET-664: timeoutMs bounds only the time the task RUNS; time queued behind
// other work on the shared box is bounded by queueCapMs instead. The box
// answers PENDING on task-status for the whole wait AND the whole run (seen
// live 2026-10-31: PENDING, then SUCCESS; never STARTED or PROGRESS), so the
// run clock starts at the first STARTED/PROGRESS or the first poll where
// taskState() sees the task picked up -- or seen queued and then gone from
// the gateway's list while still PENDING (lost: the run timeout bounds it).
// PENDING also means an unknown or expired id, and a new task is listed at
// once, so one the list never shows (or a box without the list) fails at the
// run timeout as lost rather than waiting out the queue cap. `shouldStop()` true ends the poll
// with { ok: false, halted: true }.
// SOMET-749: a result where the poll gave up while the task may still run
// carries `abandonedTaskId`, for the caller to pass to cancelConceptTask. A task
// that ended (any terminal status, or SUCCESS with no usable image) has none.
// A failed read is not evidence either way: a transient task-status failure
// (network, 5xx, 409/429) is polled through, and a failed gateway read keeps a
// listed task queued -- each only until it has lasted a whole timeoutMs, so a
// box or gateway that stays down still fails instead of waiting out the cap.
// 'running', 'queued', 'absent' or 'unknown', from the box's model gateway: its
// `pending` list holds every unfinished task, with `running: true` once a
// worker has it (seen live 2026-10-31: listed without `running` while queued,
// then running, then gone at SUCCESS). A failed read is 'unknown'.
async function taskState(provider, taskId, fetchImpl) {
  const r = await callJson(provider, 'GET', '/api/model-gateway', { fetchImpl });
  if (!r.ok) return 'unknown';
  const pending = r.json && Array.isArray(r.json.pending) ? r.json.pending : [];
  const t = pending.find((x) => x && x.task_id === taskId);
  if (!t) return 'absent';
  return t.running === true ? 'running' : 'queued';
}

// A row keeps the first 2000 characters of its error, and a traceback names its
// cause on the last line, so an over-long reason loses its middle instead.
function boundedFailure(prefix, reason, limit = 2000) {
  const message = `${prefix}${reason}`;
  if (message.length <= limit) return message;
  const gap = ' ... ';
  const head = Math.floor((limit - gap.length) / 4);
  return `${message.slice(0, head)}${gap}${message.slice(-(limit - gap.length - head))}`;
}

async function pollTaskImage(provider, taskId, label, {
  fetchImpl, sleep, pollMs, timeoutMs, queueCapMs, shouldStop,
}) {
  const queuedSince = Date.now();
  let runningSince = null;
  let listed = false;
  let statusFailSince = null;
  let gatewayFailSince = null;
  const gaveUp = (result) => ({ ...result, abandonedTaskId: taskId });
  for (;;) {
    if (shouldStop && shouldStop()) return gaveUp({ ok: false, halted: true, error: 'halted' });
    // eslint-disable-next-line no-await-in-loop
    const st = await callJson(provider, 'GET', `/api/task-status/${encodeURIComponent(taskId)}`, { fetchImpl });
    if (!st.ok) {
      if (!(st.retryable || st.status >= 500)) return gaveUp(st);
      if (statusFailSince === null) statusFailSince = Date.now();
      if (Date.now() - statusFailSince >= timeoutMs) return gaveUp({ ...st, retryable: true });
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollMs);
      continue; // eslint-disable-line no-continue
    }
    statusFailSince = null;
    const status = String(st.json && st.json.status || '').toUpperCase();
    if (status === 'SUCCESS') {
      const url = st.json.result && st.json.result.url;
      if (typeof url !== 'string' || !url) {
        // The box reports a failed task as SUCCESS with result.error and no url
        // (its contract, seen live 2026-11-06), so the reason is here if anywhere.
        const failure = st.json.result && st.json.result.error;
        if (typeof failure === 'string' && failure.trim()) {
          return { ok: false, error: boundedFailure(`GPU box ${label} task failed: `, failure), providerFault: true };
        }
        return { ok: false, error: `GPU box ${label} task succeeded but result.url is missing, so no image can be tied to it`, providerFault: true };
      }
      // The URL is box-supplied data and the auth header rides on every call,
      // so it must resolve to the box's own origin (rejects //host/x, other
      // absolute URLs and backslash tricks) before anything is fetched.
      let sameOrigin = false;
      try { sameOrigin = new URL(url, provider.base_url).origin === new URL(provider.base_url).origin; } catch (_) { /* invalid */ }
      if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\') || !sameOrigin) {
        return { ok: false, error: `GPU box ${label} task returned a result.url outside the box origin; refusing to fetch it`, providerFault: true };
      }
      // eslint-disable-next-line no-await-in-loop
      const img = await callPng(provider, url, { fetchImpl });
      if (!img.ok) return img;
      return { ok: true, path: url.replace(/^\/+/, ''), png: img.png, result: st.json.result };
    }
    if (status !== 'PENDING' && status !== 'PROGRESS' && status !== 'STARTED') {
      const r = st.json.result;
      const why = r && (r.error || r.message || (typeof r === 'string' ? r : ''));
      return { ok: false, error: `GPU box ${label} task ended ${status || 'UNKNOWN'}${why ? `: ${why}` : ''}` };
    }
    let queued = false;
    if (runningSince === null && status === 'PENDING') {
      // eslint-disable-next-line no-await-in-loop
      const state = await taskState(provider, taskId, fetchImpl);
      if (state !== 'unknown') gatewayFailSince = null;
      else if (gatewayFailSince === null) gatewayFailSince = Date.now();
      if (state === 'queued') listed = true;
      const unseen = !listed && (state === 'absent' || state === 'unknown');
      const blip = listed && state === 'unknown' && Date.now() - gatewayFailSince < timeoutMs;
      queued = state === 'queued' || unseen || blip;
      if (unseen && Date.now() - queuedSince >= timeoutMs) {
        return gaveUp({ ok: false, error: `GPU box ${label} task is not in the box's queue after ${Math.round(timeoutMs / 1000)}s; it may be lost`, retryable: true });
      }
    }
    const now = Date.now();
    if (queued) {
      if (now - queuedSince >= queueCapMs) {
        const hours = Number((queueCapMs / 3600000).toFixed(2));
        return gaveUp({ ok: false, error: `GPU box ${label} task still waiting behind other box work after ${hours} h`, retryable: true });
      }
    } else {
      if (runningSince === null) runningSince = now;
      if (now - runningSince >= timeoutMs) {
        return gaveUp({ ok: false, error: `GPU box ${label} task ran for over ${Math.round(timeoutMs / 1000)}s without finishing`, retryable: true });
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs);
  }
}

// Submits a form-urlencoded task (generate_core) and polls it.
async function submitTask(provider, path, form, label, opts) {
  const sub = await callJson(provider, 'POST', path, {
    body: new URLSearchParams(form).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    fetchImpl: opts.fetchImpl,
  });
  if (!sub.ok) return sub;
  const taskId = sub.json && sub.json.task_id;
  if (!taskId) return { ok: false, error: `GPU box accepted the ${label} request but returned no task_id`, providerFault: true };
  return pollTaskImage(provider, taskId, label, opts);
}

// Submits a concept task, polls it to a terminal state, downloads the image.
async function generateConcept(provider, { prompt }, {
  fetchImpl = fetch, sleep = realSleep, pollMs = POLL_MS(), timeoutMs = CONCEPT_TIMEOUT_MS(),
  queueCapMs = CONCEPT_QUEUE_CAP_MS(), shouldStop = null,
} = {}) {
  const model = await resolveConceptModel(provider, { fetchImpl });
  if (!model.ok) return model;
  const r = await submitTask(provider, '/api/generate_core', { prompt, llm_name: model.model }, 'concept', {
    fetchImpl, sleep, pollMs, timeoutMs, queueCapMs, shouldStop,
  });
  return r.ok ? { ok: true, conceptPath: r.path, png: r.png } : r;
}

// DELETE /api/tasks/{celery id} (SOMET-749): best effort on the box. It answers
// 200 for an unknown id and for a repeat cancel, so the 200 only says the request
// arrived. A queued task never runs. A running SDXL core stops within a denoise
// step; a running GGUF (Qwen) core finishes its current attempt and the result is
// discarded. `was_running` is not read: live on 2026-11-06 it said false for a
// task that went on to run.
async function cancelConceptTask(provider, taskId, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'DELETE', `/api/tasks/${encodeURIComponent(taskId)}`, { fetchImpl });
  return r.ok ? { ok: true } : r;
}

// Prop txt2img (SOMET-657): POST /sdapi/v1/txt2img with cutout:true returns an
// isolated, transparent subject straight from the prompt -- no concept, no edit
// round trip. The answer is JSON with the PNG base64-encoded, so it needs a
// bigger read cap than the small control-plane answers.
const TXT2IMG_CAP = () => Math.max(JSON_CAP(), 16 * 1024 * 1024);
const TXT2IMG_TIMEOUT_MS = () => Number(process.env.GPU_BOX_TXT2IMG_TIMEOUT_MS) || 5 * 60 * 1000;
const PROP_NEGATIVE_PROMPT = 'picture frame, framed art, poster, trading card, border, matte, vignette, sprite sheet, '
  + 'tileset, grid, panels, collage, multiple objects, duplicate, row of objects, scene, forest, landscape, '
  + 'background scenery, ground, floor, grass, shadow, reflection, text, watermark, signature, photo, realistic, '
  + '3d render, blurry';

function parseInfo(info) {
  if (info && typeof info === 'object') return info;
  if (typeof info !== 'string') return null;
  try { return JSON.parse(info); } catch (_) { return null; }
}

async function txt2imgProp(provider, { prompt, seed }, { fetchImpl = fetch } = {}) {
  const model = await resolveConceptModel(provider, { fetchImpl });
  if (!model.ok) return model;
  const body = {
    prompt,
    negative_prompt: PROP_NEGATIVE_PROMPT,
    steps: 24,
    width: 1024,
    height: 1024,
    cfg_scale: 7,
    cutout: true,
    override_settings: { sd_model_checkpoint: model.model },
  };
  if (Number.isFinite(Number(seed))) body.seed = Number(seed);
  const { res, error, retryable, unreachable } = await call(provider, 'POST', '/sdapi/v1/txt2img', {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    fetchImpl,
    timeoutMs: TXT2IMG_TIMEOUT_MS(),
  });
  if (error) return { ok: false, error, retryable, unreachable };
  if (!res.ok) return httpFailure(res, 'POST', '/sdapi/v1/txt2img');
  const read = await readJsonCapped(res, TXT2IMG_CAP());
  if (read.error) return { ok: false, error: `GPU box did not answer with usable JSON: ${read.error}`, providerFault: true };
  const first = read.json && Array.isArray(read.json.images) ? read.json.images[0] : null;
  if (typeof first !== 'string' || !first) {
    return { ok: false, error: 'GPU box txt2img answered without an image', providerFault: true };
  }
  const png = Buffer.from(first.replace(/^data:[^,]*,/, ''), 'base64');
  if (png.length === 0) return { ok: false, error: 'GPU box txt2img image decoded to zero bytes', providerFault: true };
  return { ok: true, png, info: parseInfo(read.json.info) };
}

// SOMET-660: stores approved art on the box so a sheet job can start from it
// (POST /api/images, multipart `file`; 201 {concept_image, url, transparent}).
// Unlike generate_core it is NOT a task: the file is there when this returns.
// The answer's `url` is box-supplied data and the auth header rides on every
// later call, so it must be a same-origin absolute path before it is kept; the
// returned conceptPath has the same shape generateConcept returns ("images/x.png").
// A box without the route answers 404/405: the caller falls back to generate_core.
async function uploadImage(provider, png, { name = 'approved-art.png', fetchImpl = fetch } = {}) {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), name);
  const { res, error, retryable, unreachable } = await call(provider, 'POST', '/api/images', { body: form, fetchImpl });
  if (error) return { ok: false, error, retryable, unreachable };
  if (!res.ok) return httpFailure(res, 'POST', '/api/images');
  const read = await readJsonCapped(res, JSON_CAP());
  const j = read.json;
  if (read.error || !j) return { ok: false, error: `GPU box did not answer the image upload with usable JSON: ${read.error || 'empty'}`, providerFault: true };
  const url = typeof j.url === 'string' && j.url ? j.url
    : (typeof j.concept_image === 'string' && j.concept_image ? `/images/${j.concept_image}` : '');
  let sameOrigin = false;
  try { sameOrigin = new URL(url, provider.base_url).origin === new URL(provider.base_url).origin; } catch (_) { /* invalid */ }
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\') || !sameOrigin) {
    return { ok: false, error: 'GPU box image upload answered without a usable image path', providerFault: true };
  }
  return { ok: true, conceptPath: url.replace(/^\/+/, '') };
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

// Is a concept image still on the box? true only on a 200 whose Content-Type
// is image/*; every other answer (404, 5xx, a 200 HTML page from a proxy,
// network error, timeout) is false. The body is never read: it is
// cancelled so a large image is not downloaded to answer a yes/no.
async function conceptAvailable(provider, conceptPath, { fetchImpl = fetch } = {}) {
  const { res } = await call(provider, 'GET', `/${String(conceptPath || '').replace(/^\/+/, '')}`, { fetchImpl });
  if (!res) return false;
  try { if (res.body) await res.body.cancel(); } catch { /* nothing to drain */ }
  const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
  return res.status === 200 && type.startsWith('image/');
}

// [ASSUMED] box contract (the box's redraw API is not built yet):
// POST /api/jobs/{boxJobId}/redraw with {"frames":[{action,direction,frame}]}
// answers JSON with task_id (or job_id). The task is then polled and cancelled
// like a sheet job (GET / DELETE /api/jobs/{taskId}); once done, the original
// job's /sheet and /atlas return the updated sheet.
async function redrawFrames(provider, boxJobId, frames, { fetchImpl = fetch } = {}) {
  const p = `/api/jobs/${encodeURIComponent(boxJobId)}/redraw`;
  const { res, error, retryable, unreachable } = await call(provider, 'POST', p, {
    body: JSON.stringify({ frames }),
    headers: { 'Content-Type': 'application/json' },
    fetchImpl,
  });
  if (error) return { ok: false, error, retryable, unreachable };
  if (res.status === 404) {
    // A 404 is either "no such sheet job" or "no /redraw route on this box".
    // Ask about the sheet job itself before telling the admin it is gone.
    const probe = await getSheetJob(provider, boxJobId, { fetchImpl });
    if (!probe.ok) {
      return {
        ok: false,
        retryable: probe.retryable,
        error: `GPU box answered 404 for POST ${p}, and checking the sheet job failed: ${probe.error}`,
      };
    }
    if (probe.job.status === 'missing') {
      return { ok: false, error: "The GPU box no longer has this sheet's job. Queue the whole sheet again." };
    }
    return { ok: false, error: 'The GPU box does not support frame redraw yet.' };
  }
  if (!res.ok) return httpFailure(res, 'POST', p);
  const read = await readJsonCapped(res, JSON_CAP());
  if (read.error) return { ok: false, error: `GPU box did not answer with usable JSON: ${read.error}`, providerFault: true };
  const taskId = read.json && (read.json.task_id || read.json.job_id);
  if (typeof taskId !== 'string' || taskId === '') return { ok: false, error: 'GPU box accepted the redraw but returned no task id', providerFault: true };
  return { ok: true, taskId };
}

// 'cancelling' (box d5c71f7) is NOT terminal: the task is still drawing and the card is
// busy until the job reads 'cancelled' with finished_at set.
const STATUS_MAP = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', error: 'failed', cancelled: 'cancelled', canceled: 'cancelled', cancelling: 'cancelling', canceling: 'cancelling' };

async function getSheetJob(provider, boxJobId, { fetchImpl = fetch } = {}) {
  const p = `/api/jobs/${encodeURIComponent(boxJobId)}`;
  const { res, error, retryable, unreachable } = await call(provider, 'GET', p, { fetchImpl });
  if (error) return { ok: false, error, retryable, unreachable };
  if (res.status === 404) return { ok: true, job: { status: 'missing' } };
  if (!res.ok) return httpFailure(res, 'GET', p);
  const read = await readJsonCapped(res, JSON_CAP());
  if (read.error) return { ok: false, error: `GPU box did not answer with usable JSON: ${read.error}`, providerFault: true };
  const j = read.json || {};
  const status = STATUS_MAP[String(j.status || '').toLowerCase()];
  if (!status) {
    // The raw status and progress ride along so a cancel check can still see whether the job moves.
    return {
      ok: false,
      error: `GPU box reported an unknown job status "${j.status}"`,
      providerFault: true,
      rawStatus: String(j.status),
      progress: { pct: j.progress_pct, message: j.progress_msg, stage: j.stage },
      updatedAt: j.updated_at == null ? null : String(j.updated_at),
    };
  }
  return {
    ok: true,
    job: {
      status,
      progress: { pct: j.progress_pct, message: j.progress_msg, stage: j.stage },
      error: j.error || null,
      updatedAt: j.updated_at == null ? null : String(j.updated_at),
      ...(j.finished_at ? { finishedAt: String(j.finished_at) } : {}),
    },
  };
}

// DELETE asks the box to stop a sheet job. Cooperative there: the cell being
// denoised finishes first, and a job that already ended is left alone, so a
// late cancel is harmless. A 404 (job gone) counts as cancelled.
async function cancelSheetJob(provider, boxJobId, { fetchImpl = fetch } = {}) {
  const p = `/api/jobs/${encodeURIComponent(boxJobId)}`;
  const { res, error, retryable, unreachable } = await call(provider, 'DELETE', p, { fetchImpl });
  if (error) return { ok: false, error, retryable, unreachable };
  if (res.status === 404) return { ok: true };
  if (!res.ok) return httpFailure(res, 'DELETE', p);
  return { ok: true };
}

// 3D turnaround (POST /api/turnaround3d {source_job, cell}): a STATIC
// 8-direction turnaround rendered from a finished sheet job's views on the
// box's CPU mesh worker. One cell per direction, no action frames. It is a
// box job like any other: polled and cancelled at /api/jobs/{id}, sheet and
// atlas at /api/jobs/{id}/sheet|atlas.
async function createTurnaround3d(provider, sourceJobId, { cell = '48x64', fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'POST', '/api/turnaround3d', {
    body: JSON.stringify({ source_job: sourceJobId, cell }),
    headers: { 'Content-Type': 'application/json' },
    fetchImpl,
  });
  if (!r.ok) return r;
  if (!r.json || !r.json.job_id) return { ok: false, error: 'GPU box accepted the 3D turnaround but returned no job_id', providerFault: true };
  return { ok: true, boxJobId: r.json.job_id };
}

const fetchSheet = (provider, boxJobId, { fetchImpl = fetch } = {}) =>
  callPng(provider, `/api/jobs/${encodeURIComponent(boxJobId)}/sheet`, { fetchImpl });

async function fetchAtlas(provider, boxJobId, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'GET', `/api/jobs/${encodeURIComponent(boxJobId)}/atlas`, { fetchImpl });
  if (!r.ok) return r;
  return { ok: true, atlas: r.json };
}

// Jobs still ahead of a new one on the box (queued or running), for the wait
// estimate. spec is passed through untouched; progressPct is 0-100.
async function listActiveJobs(provider, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'GET', '/api/jobs', { fetchImpl });
  if (!r.ok) return r;
  const list = r.json && Array.isArray(r.json.jobs) ? r.json.jobs : [];
  const jobs = list
    .filter((j) => j && (j.status === 'queued' || j.status === 'running'))
    .map((j) => ({ status: j.status, progressPct: Number.isFinite(Number(j.progress_pct)) ? Number(j.progress_pct) : 0, spec: j.spec || {} }));
  return { ok: true, jobs };
}

// The model gateway's loaded model and, once the box ships it, a hold on it.
async function gatewayStatus(provider, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'GET', '/api/model-gateway', { fetchImpl });
  if (!r.ok) return r;
  const j = r.json || {};
  const m = j.active && typeof j.active === 'object' ? j.active.model : null;
  return { ok: true, activeModel: typeof m === 'string' && m ? m : null, hold: j.hold && typeof j.hold === 'object' ? j.hold : null };
}

module.exports = {
  listActiveJobs, gatewayStatus,
  STATUS_TERMINAL, actionCatalog, checkAuth, listConceptModels, generateConcept, cancelConceptTask, txt2imgProp, PROP_NEGATIVE_PROMPT, createSheetJob, uploadImage, createTurnaround3d, conceptAvailable, redrawFrames, getSheetJob, cancelSheetJob, fetchSheet, fetchAtlas,
};
