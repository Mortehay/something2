// backend/tests/gpu_box_sprites.test.js
// The GPU box sheet client against a fake box serving the captured fixtures.
// Every fake records the request, so a test cannot pass while the client
// sends the wrong path/method/auth.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const box = require('../src/services/gpuBoxSprites');

const FIX = path.join(__dirname, 'fixtures/gpuBox');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const png = (n) => fs.readFileSync(path.join(FIX, n));
const provider = {
  base_url: 'http://box:8001/sdapi/v1/txt2img',
  auth_token: 'sk_test',
  model: 'qwen-x',
  modality: 'image',
};

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function fakeBox(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, url: u, headers: init.headers || {}, body: init.body });
    const h = routes[key];
    if (!h) return new Response('not found', { status: 404 });
    return h(u, init, calls.filter((c) => c.key === key).length);
  };
  return { fetchImpl, calls };
}
const sleep = async () => {};

test('actionCatalog returns the box catalog', async () => {
  const { fetchImpl } = fakeBox({ 'GET /api/action-catalog': () => json(fx('action-catalog.json')) });
  const r = await box.actionCatalog(provider, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.catalog.actions.length, 7);
  assert.equal(r.catalog.max_frames, 6);
});

test('requests carry the provider auth header and hit the base_url origin', async () => {
  const { fetchImpl, calls } = fakeBox({ 'GET /api/action-catalog': () => json(fx('action-catalog.json')) });
  await box.actionCatalog(provider, { fetchImpl });
  assert.equal(calls[0].url.href, 'http://box:8001/api/action-catalog');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk_test');
});

function conceptRoutes(statuses) {
  return {
    'POST /api/generate_core': () => json(fx('generate-core-response.json').body),
    'GET /api/task-status/ac408fbf-9f39-4488-8b06-95dcd0fce8c9': (u, i, n) => json(statuses[Math.min(n, statuses.length) - 1]),
    'GET /images/core_23e329cdf09d.png': () => new Response(png('wolf-sheet.png'), { status: 200 }),
  };
}

test('generateConcept ties the concept to the task result.url and never lists assets', async () => {
  const pending = { task_id: 't', status: 'PENDING' };
  const { fetchImpl, calls } = fakeBox(conceptRoutes([pending, { ...pending, status: 'PROGRESS' }, fx('task-status-done.json')]));
  const r = await box.generateConcept(provider, { prompt: 'a grey wolf' }, { fetchImpl, sleep });
  assert.equal(r.ok, true);
  assert.equal(r.conceptPath, 'images/core_23e329cdf09d.png');
  assert.deepEqual(r.png, png('wolf-sheet.png'));
  assert.equal(calls.some((c) => c.url.pathname.startsWith('/api/assets')), false);
  const submit = calls[0];
  assert.equal(submit.key, 'POST /api/generate_core');
  assert.equal(submit.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(String(submit.body));
  assert.equal(form.get('prompt'), 'a grey wolf');
  assert.equal(form.get('llm_name'), 'qwen-x');
  assert.equal(calls.filter((c) => c.key.includes('task-status')).length, 3);
});

// Roster shape as the box serves GET /api/core-models (captured 2026-10-21):
// its API default is SDXL, its own UI defaults to Qwen-Image.
const coreModels = (models) => () => json({ models });
const SDXL = { value: 'stabilityai/stable-diffusion-xl-base-1.0+nerijs/pixel-art-xl', default: true, ui_default: false, available: true };
const QWEN_FAST = { value: 'gguf:qwen-image-2512-Q2_K+lightning8', default: false, ui_default: true, available: true };
const QWEN_BEST = { value: 'gguf:Qwen-Image-2512-Q3_K_M', default: false, ui_default: false, available: true };

test('generateConcept with no provider model uses the box UI default Qwen model, never the SDXL API default', async () => {
  const { fetchImpl, calls } = fakeBox({
    ...conceptRoutes([fx('task-status-done.json')]),
    'GET /api/core-models': coreModels([SDXL, QWEN_FAST, QWEN_BEST]),
  });
  const r = await box.generateConcept({ ...provider, model: null }, { prompt: 'a pine tree' }, { fetchImpl, sleep });
  assert.equal(r.ok, true);
  const form = new URLSearchParams(String(calls.find((c) => c.key === 'POST /api/generate_core').body));
  assert.equal(form.get('prompt'), 'a pine tree');
  assert.equal(form.get('llm_name'), 'gguf:qwen-image-2512-Q2_K+lightning8');
});

test('generateConcept falls back to any available Qwen model when the UI default is not Qwen', async () => {
  const { fetchImpl, calls } = fakeBox({
    ...conceptRoutes([fx('task-status-done.json')]),
    'GET /api/core-models': coreModels([{ ...SDXL, ui_default: true }, { ...QWEN_FAST, ui_default: false, available: false }, QWEN_BEST]),
  });
  const r = await box.generateConcept({ ...provider, model: '' }, { prompt: 'x' }, { fetchImpl, sleep });
  assert.equal(r.ok, true);
  const form = new URLSearchParams(String(calls.find((c) => c.key === 'POST /api/generate_core').body));
  assert.equal(form.get('llm_name'), 'gguf:Qwen-Image-2512-Q3_K_M');
});

test('generateConcept refuses to run when the box offers no available Qwen model', async () => {
  const { fetchImpl, calls } = fakeBox({
    ...conceptRoutes([fx('task-status-done.json')]),
    'GET /api/core-models': coreModels([SDXL, { ...QWEN_FAST, available: false }]),
  });
  const r = await box.generateConcept({ ...provider, model: null }, { prompt: 'x' }, { fetchImpl, sleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /no available Qwen concept model/);
  assert.equal(calls.some((c) => c.key === 'POST /api/generate_core'), false);
});

test('generateConcept fails with the box words when the task fails', async () => {
  const failed = { task_id: 't', status: 'FAILURE', result: { error: 'CUDA out of memory' } };
  const { fetchImpl } = fakeBox(conceptRoutes([failed]));
  const r = await box.generateConcept(provider, { prompt: 'x' }, { fetchImpl, sleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /FAILURE/);
  assert.match(r.error, /CUDA out of memory/);
});

test('generateConcept fails on SUCCESS without result.url', async () => {
  const { fetchImpl } = fakeBox(conceptRoutes([{ task_id: 't', status: 'SUCCESS', result: { status: 'success' } }]));
  const r = await box.generateConcept(provider, { prompt: 'x' }, { fetchImpl, sleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /result\.url|no image/);
});

test('generateConcept gives up at the timeout', async () => {
  const { fetchImpl } = fakeBox(conceptRoutes([{ task_id: 't', status: 'PENDING' }]));
  const r = await box.generateConcept(provider, { prompt: 'x' }, { fetchImpl, timeoutMs: 20, pollMs: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

test('createSheetJob posts the JobSpec as JSON and accepts 202', async () => {
  const spec = fx('job-done.json').spec;
  const { fetchImpl, calls } = fakeBox({ 'POST /api/jobs': () => json(fx('job-create-response.json').body, 202) });
  const r = await box.createSheetJob(provider, spec, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.boxJobId, 'f841ec70-3d4e-4ede-9928-6b840a283d76');
  assert.equal(r.cells, 16);
  assert.equal(r.estimatedSeconds, 888);
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), spec);
});

test('createSheetJob surfaces the box refusal text', async () => {
  const { fetchImpl } = fakeBox({ 'POST /api/jobs': () => new Response('bad concept_image', { status: 422 }) });
  const r = await box.createSheetJob(provider, {}, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /422/);
  assert.match(r.error, /bad concept_image/);
});

test('getSheetJob normalizes queued, running and done', async () => {
  for (const [file, status, pct, stage] of [
    ['job-queued.json', 'queued'], ['job-running.json', 'running'], ['job-done.json', 'done', 100, 'compose'],
  ]) {
    const body = fx(file);
    const { fetchImpl } = fakeBox({ [`GET /api/jobs/${body.job_id}`]: () => json(body) });
    const r = await box.getSheetJob(provider, body.job_id, { fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.job.status, status);
    assert.equal(r.job.progress.pct, body.progress_pct);
    assert.equal(r.job.progress.message, body.progress_msg);
    assert.equal(r.job.progress.stage, body.stage);
    if (pct !== undefined) { assert.equal(r.job.progress.pct, pct); assert.equal(r.job.progress.stage, stage); }
  }
});

test('getSheetJob maps failed/cancelled and carries the error', async () => {
  for (const [boxStatus, want] of [['failed', 'failed'], ['cancelled', 'cancelled'], ['error', 'failed']]) {
    const body = { job_id: 'j', status: boxStatus, error: 'OOM at stage render', progress_pct: 40, stage: 'render' };
    const { fetchImpl } = fakeBox({ 'GET /api/jobs/j': () => json(body) });
    const r = await box.getSheetJob(provider, 'j', { fetchImpl });
    assert.equal(r.job.status, want);
    assert.equal(r.job.error, 'OOM at stage render');
  }
});

test('getSheetJob maps 404 to missing', async () => {
  const { fetchImpl } = fakeBox({ 'GET /api/jobs/gone': () => new Response('no such job', { status: 404 }) });
  const r = await box.getSheetJob(provider, 'gone', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.job.status, 'missing');
  assert.ok(box.STATUS_TERMINAL.has('missing') && box.STATUS_TERMINAL.has('done'));
  assert.ok(!box.STATUS_TERMINAL.has('running'));
});

test('cancelSheetJob sends DELETE; a gone job counts as cancelled, a 5xx does not', async () => {
  const { fetchImpl, calls } = fakeBox({
    'DELETE /api/jobs/j': () => json({ job_id: 'j', status: 'cancelled' }),
    'DELETE /api/jobs/gone': () => new Response('no such job', { status: 404 }),
    'DELETE /api/jobs/bad': () => new Response('boom', { status: 500 }),
  });
  assert.deepEqual(await box.cancelSheetJob(provider, 'j', { fetchImpl }), { ok: true });
  assert.deepEqual(await box.cancelSheetJob(provider, 'gone', { fetchImpl }), { ok: true });
  const bad = await box.cancelSheetJob(provider, 'bad', { fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /500 for DELETE \/api\/jobs\/bad/);
  assert.deepEqual(calls.map((c) => c.key), ['DELETE /api/jobs/j', 'DELETE /api/jobs/gone', 'DELETE /api/jobs/bad']);
});

test('fetchSheet returns the PNG bytes and fetchAtlas the raw atlas', async () => {
  const { fetchImpl, calls } = fakeBox({
    'GET /api/jobs/j/sheet': () => new Response(png('wolf-sheet.png'), { status: 200 }),
    'GET /api/jobs/j/atlas': () => json(fx('atlas-wolf.json')),
  });
  const s = await box.fetchSheet(provider, 'j', { fetchImpl });
  assert.equal(s.ok, true);
  assert.deepEqual(s.png, png('wolf-sheet.png'));
  const a = await box.fetchAtlas(provider, 'j', { fetchImpl });
  assert.deepEqual(a.atlas, fx('atlas-wolf.json'));
  assert.equal(calls[0].headers.Authorization, 'Bearer sk_test');
});

test('fetchSheet rejects an oversized sheet', async () => {
  const { fetchImpl } = fakeBox({ 'GET /api/jobs/j/sheet': () => new Response(Buffer.alloc(2048), { status: 200 }) });
  process.env.GPU_BOX_SHEET_MAX_BYTES = '1024';
  try {
    const r = await box.fetchSheet(provider, 'j', { fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.error, /size cap/);
  } finally { delete process.env.GPU_BOX_SHEET_MAX_BYTES; }
});

test('unreachable box returns a readable retryable error', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await box.actionCatalog(provider, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.match(r.error, /^could not reach/);
});

test('generateConcept refuses a result.url that leaves the box origin and sends no auth there', async () => {
  for (const url of ['//evil.host/x.png', 'http://other:1/x.png', '/\\evil.host/x.png']) {
    const seen = [];
    const done = { task_id: 't', status: 'SUCCESS', result: { url } };
    const routes = conceptRoutes([done]);
    const fetchImpl = async (u, init = {}) => {
      seen.push({ url: String(u), headers: init.headers || {} });
      return routes[`${init.method || 'GET'} ${new URL(u).pathname}`]
        ? routes[`${init.method || 'GET'} ${new URL(u).pathname}`](new URL(u), init, 1)
        : new Response('nf', { status: 404 });
    };
    const r = await box.generateConcept(provider, { prompt: 'x' }, { fetchImpl, sleep });
    assert.equal(r.ok, false, url);
    assert.match(r.error, /outside the box origin/);
    assert.ok(seen.every((c) => new URL(c.url).origin === 'http://box:8001'), `request left the box for ${url}`);
    assert.ok(!seen.some((c) => /evil|other/.test(c.url)));
  }
});

// POST /sdapi/v1/txt2img with cutout:true (SOMET-657): the prop route. JSON in,
// {images:[base64 png], info} out.
const PNG_B64 = (b) => b.toString('base64');
const t2iOk = (extra = {}) => () => json({
  images: [PNG_B64(png('tree-sheet.png'))],
  info: JSON.stringify({ seed: 7, model: 'qwen-x', width: 1024, height: 1024, duration_ms: 41000, cutout: { transparent: 0.7 } }),
  ...extra,
});

test('txt2imgProp posts the cutout request with the model checkpoint and decodes the base64 png', async () => {
  const { fetchImpl, calls } = fakeBox({ 'POST /sdapi/v1/txt2img': t2iOk() });
  const r = await box.txt2imgProp(provider, { prompt: 'pixel art, a pine tree', seed: 7 }, { fetchImpl });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.png, png('tree-sheet.png'));
  assert.equal(r.info.duration_ms, 41000);
  assert.equal(calls.length, 1, 'provider.model is explicit: no roster lookup');
  const c = calls[0];
  assert.equal(c.headers.Authorization, 'Bearer sk_test');
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.url.href, 'http://box:8001/sdapi/v1/txt2img');
  const b = JSON.parse(c.body);
  assert.equal(b.prompt, 'pixel art, a pine tree');
  assert.equal(b.seed, 7);
  assert.equal(b.cutout, true);
  assert.deepEqual(b.override_settings, { sd_model_checkpoint: 'qwen-x' });
  assert.equal(b.steps, 24);
  assert.equal(b.width, 1024);
  assert.equal(b.height, 1024);
  assert.equal(b.cfg_scale, 7);
  assert.equal(b.negative_prompt, box.PROP_NEGATIVE_PROMPT);
  assert.match(b.negative_prompt, /picture frame/);
});

test('txt2imgProp accepts info as an object and defaults the model to the box Qwen', async () => {
  const { fetchImpl, calls } = fakeBox({
    'GET /api/core-models': coreModels([SDXL, QWEN_FAST, QWEN_BEST]),
    'POST /sdapi/v1/txt2img': t2iOk({ info: { seed: 3 } }),
  });
  const r = await box.txt2imgProp({ ...provider, model: '' }, { prompt: 'x', seed: 3 }, { fetchImpl });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.info.seed, 3);
  const post = calls.find((c) => c.key === 'POST /sdapi/v1/txt2img');
  assert.equal(JSON.parse(post.body).override_settings.sd_model_checkpoint, 'gguf:qwen-image-2512-Q2_K+lightning8');
});

test('txt2imgProp reads a response larger than the small-JSON cap', async () => {
  const big = Buffer.concat([png('tree-sheet.png'), Buffer.alloc(9 * 1024 * 1024, 1)]);
  const { fetchImpl } = fakeBox({ 'POST /sdapi/v1/txt2img': () => json({ images: [PNG_B64(big)], info: '{}' }) });
  const r = await box.txt2imgProp(provider, { prompt: 'x', seed: 1 }, { fetchImpl });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.png.length, big.length);
});

test('txt2imgProp surfaces the box error text', async () => {
  const { fetchImpl } = fakeBox({ 'POST /sdapi/v1/txt2img': () => json({ error: 'cutout refused: opaque square' }, 422) });
  const r = await box.txt2imgProp(provider, { prompt: 'x', seed: 1 }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /422/);
  assert.match(r.error, /cutout refused/);
});

test('txt2imgProp fails when the answer has no image', async () => {
  const { fetchImpl } = fakeBox({ 'POST /sdapi/v1/txt2img': () => json({ images: [], info: '{}' }) });
  const r = await box.txt2imgProp(provider, { prompt: 'x', seed: 1 }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /without an image/);
});

test('txt2imgProp reports an unreachable box as retryable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await box.txt2imgProp(provider, { prompt: 'x', seed: 1 }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.match(r.error, /could not reach/);
});

test('redrawFrames posts the frames to the sheet job and returns the task id', async () => {
  const frames = [{ action: 'idle', direction: 's', frame: 2 }];
  const { fetchImpl, calls } = fakeBox({
    'POST /api/jobs/j%201/redraw': () => json({ task_id: 't9' }, 202),
  });
  const r = await box.redrawFrames(provider, 'j 1', frames, { fetchImpl });
  assert.deepEqual(r, { ok: true, taskId: 't9' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/jobs/j%201/redraw');
  assert.deepEqual(JSON.parse(calls[0].body), { frames });
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.match(JSON.stringify(calls[0].headers), /sk_test/);
});

test('redrawFrames falls back to job_id, and flags a reply with no id', async () => {
  const f = [{ action: 'idle', direction: 's', frame: 0 }];
  const a = fakeBox({ 'POST /api/jobs/j/redraw': () => json({ job_id: 'k' }) });
  assert.deepEqual(await box.redrawFrames(provider, 'j', f, { fetchImpl: a.fetchImpl }), { ok: true, taskId: 'k' });
  const b = fakeBox({ 'POST /api/jobs/j/redraw': () => json({}) });
  const r = await box.redrawFrames(provider, 'j', f, { fetchImpl: b.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.providerFault, true);
  assert.equal(r.error, 'GPU box accepted the redraw but returned no task id');
});

test('redrawFrames maps 404 with a missing sheet job to the gone-job message and 500 to a failure', async () => {
  const f = [{ action: 'idle', direction: 's', frame: 0 }];
  const { fetchImpl, calls } = fakeBox({
    'POST /api/jobs/gone/redraw': () => new Response('no such job', { status: 404 }),
    'POST /api/jobs/bad/redraw': () => new Response('boom', { status: 500 }),
  });
  const gone = await box.redrawFrames(provider, 'gone', f, { fetchImpl });
  assert.deepEqual(gone, { ok: false, error: "The GPU box no longer has this sheet's job. Queue the whole sheet again." });
  assert.ok(calls.some((c) => c.key === 'GET /api/jobs/gone'), 'probes the sheet job before blaming it');
  const bad = await box.redrawFrames(provider, 'bad', f, { fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /500 for POST \/api\/jobs\/bad\/redraw/);
});

test('redrawFrames: a 404 while the sheet job still exists means the box has no redraw route', async () => {
  const f = [{ action: 'idle', direction: 's', frame: 0 }];
  const { fetchImpl } = fakeBox({
    'POST /api/jobs/j/redraw': () => new Response('Not Found', { status: 404 }),
    'GET /api/jobs/j': () => json({ status: 'done' }),
  });
  const r = await box.redrawFrames(provider, 'j', f, { fetchImpl });
  assert.deepEqual(r, { ok: false, error: 'The GPU box does not support frame redraw yet.' });
});

test('redrawFrames: a 404 whose sheet-job probe fails reports the probe failure, not a gone job', async () => {
  const f = [{ action: 'idle', direction: 's', frame: 0 }];
  const { fetchImpl } = fakeBox({
    'POST /api/jobs/j/redraw': () => new Response('Not Found', { status: 404 }),
    'GET /api/jobs/j': () => new Response('down', { status: 503 }),
  });
  const r = await box.redrawFrames(provider, 'j', f, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.doesNotMatch(r.error, /no longer has/);
  assert.match(r.error, /404 for POST \/api\/jobs\/j\/redraw/);
});

test('redrawFrames requires the task id to be a non-empty string', async () => {
  const f = [{ action: 'idle', direction: 's', frame: 0 }];
  for (const reply of [{ task_id: 7 }, { task_id: '' }, { task_id: { id: 'x' } }, { job_id: ['x'] }]) {
    const { fetchImpl } = fakeBox({ 'POST /api/jobs/j/redraw': () => json(reply) });
    const r = await box.redrawFrames(provider, 'j', f, { fetchImpl });
    assert.equal(r.ok, false, JSON.stringify(reply));
    assert.equal(r.providerFault, true);
    assert.equal(r.error, 'GPU box accepted the redraw but returned no task id');
  }
});

const IMG = { 'Content-Type': 'image/png' };

test('conceptAvailable: 200 image -> true, GET on the bare path with the auth header', async () => {
  const { fetchImpl, calls } = fakeBox({ 'GET /images/core_abc.png': () => new Response(png('wolf-sheet.png'), { status: 200, headers: IMG }) });
  assert.equal(await box.conceptAvailable(provider, '/images/core_abc.png', { fetchImpl }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'http://box:8001/images/core_abc.png');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk_test');
});

test('conceptAvailable: path without a leading slash resolves the same', async () => {
  const { fetchImpl, calls } = fakeBox({ 'GET /images/core_abc.png': () => new Response('x', { status: 200, headers: IMG }) });
  assert.equal(await box.conceptAvailable(provider, 'images/core_abc.png', { fetchImpl }), true);
  assert.equal(calls[0].url.pathname, '/images/core_abc.png');
});

test('conceptAvailable: a 200 that is not an image (HTML page, no type) -> false', async () => {
  for (const headers of [{ 'Content-Type': 'text/html; charset=utf-8' }, {}]) {
    const { fetchImpl } = fakeBox({ 'GET /images/x.png': () => new Response(new Uint8Array([60, 104]), { status: 200, headers }) });
    assert.equal(await box.conceptAvailable(provider, 'images/x.png', { fetchImpl }), false, JSON.stringify(headers));
  }
});

test('conceptAvailable: 404 -> false', async () => {
  const { fetchImpl } = fakeBox({});
  assert.equal(await box.conceptAvailable(provider, 'images/gone.png', { fetchImpl }), false);
});

test('conceptAvailable: 500 -> false', async () => {
  const { fetchImpl } = fakeBox({ 'GET /images/x.png': () => new Response('boom', { status: 500 }) });
  assert.equal(await box.conceptAvailable(provider, 'images/x.png', { fetchImpl }), false);
});

test('conceptAvailable: a rejecting fetch -> false', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await box.conceptAvailable(provider, 'images/x.png', { fetchImpl }), false);
});

test('createSheetJob failure exposes the HTTP status', async () => {
  const { fetchImpl } = fakeBox({ 'POST /api/jobs': () => json({ detail: 'concept_image not found' }, 422) });
  const r = await box.createSheetJob(provider, { prompt: 'p' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
});

test('createTurnaround3d posts the source job and cell, and returns the new job id', async () => {
  const { fetchImpl, calls } = fakeBox({ 'POST /api/turnaround3d': () => json({ job_id: 'turn-1', status: 'queued' }, 202) });
  const r = await box.createTurnaround3d(provider, 'sheet-1', { cell: '48x64', fetchImpl });
  assert.deepEqual(r, { ok: true, boxJobId: 'turn-1' });
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { source_job: 'sheet-1', cell: '48x64' });
});

test('createTurnaround3d refuses an answer without a job id and surfaces box errors', async () => {
  let { fetchImpl } = fakeBox({ 'POST /api/turnaround3d': () => json({}, 202) });
  let r = await box.createTurnaround3d(provider, 'sheet-1', { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /no job_id/);
  ({ fetchImpl } = fakeBox({ 'POST /api/turnaround3d': () => json({ detail: 'source job is not done' }, 409) }));
  r = await box.createTurnaround3d(provider, 'sheet-1', { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /409.*source job is not done/);
});
