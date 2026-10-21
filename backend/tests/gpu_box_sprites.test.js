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

// POST /api/edit (Qwen-Image-Edit-2511 on the box, contract 2026-10-21):
// form-urlencoded source + instruction, answers {status:'queued', task_id},
// polled through /api/task-status like generate_core.
function editRoutes(statuses, { url = '/images/edit_aa11bb22cc33.png' } = {}) {
  return {
    'POST /api/edit': () => json({ status: 'queued', task_id: 'edit-1' }),
    'GET /api/task-status/edit-1': (u, i, n) => json(statuses[Math.min(n, statuses.length) - 1]),
    [`GET ${url}`]: () => new Response(png('tree-sheet.png'), { status: 200 }),
  };
}
const editDone = (extra = {}) => ({
  task_id: 'edit-1',
  status: 'SUCCESS',
  result: { status: 'success', url: '/images/edit_aa11bb22cc33.png', transparent: 0.63, duration_ms: 61000, ...extra },
});

test('editImage posts source + instruction only, polls its own task and downloads THAT result', async () => {
  const pending = { task_id: 'edit-1', status: 'PENDING' };
  const { fetchImpl, calls } = fakeBox(editRoutes([pending, editDone()]));
  const r = await box.editImage(provider, { source: 'core_2fd22411db4a.png', instruction: 'Remove any person.' }, { fetchImpl, sleep });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.path, 'images/edit_aa11bb22cc33.png');
  assert.deepEqual(r.png, png('tree-sheet.png'));
  assert.equal(r.transparent, 0.63);
  const submit = calls[0];
  assert.equal(submit.key, 'POST /api/edit');
  assert.equal(submit.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(submit.headers.Authorization, 'Bearer sk_test');
  const form = new URLSearchParams(String(submit.body));
  assert.deepEqual([...form.keys()].sort(), ['instruction', 'source']);
  assert.equal(form.get('source'), 'core_2fd22411db4a.png');
  assert.equal(form.get('instruction'), 'Remove any person.');
  assert.equal(calls.filter((c) => c.key === 'GET /api/task-status/edit-1').length, 2);
  // No concept-model lookup: the edit runs the box's own engine.
  assert.equal(calls.some((c) => c.key === 'GET /api/core-models'), false);
});

test('editImage surfaces the box 503 "editing disabled" words', async () => {
  const { fetchImpl } = fakeBox({
    'POST /api/edit': () => json({ error: 'image editing is disabled on this box', enable_with: 'EDIT_ENABLED=1' }, 503),
  });
  const r = await box.editImage(provider, { source: 'core_x.png', instruction: 'x' }, { fetchImpl, sleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /503/);
  assert.match(r.error, /image editing is disabled/);
});

test('editImage fails with the box words when the edit task fails', async () => {
  const { fetchImpl } = fakeBox(editRoutes([{ task_id: 'edit-1', status: 'FAILURE', result: { error: 'source not found' } }]));
  const r = await box.editImage(provider, { source: 'core_x.png', instruction: 'x' }, { fetchImpl, sleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /edit task ended FAILURE: source not found/);
});

test('editImage refuses a result.url outside the box origin', async () => {
  const { fetchImpl, calls } = fakeBox(editRoutes([editDone({ url: '//evil.host/x.png' })]));
  const r = await box.editImage(provider, { source: 'core_x.png', instruction: 'x' }, { fetchImpl, sleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /outside the box origin/);
  assert.ok(calls.every((c) => c.url.origin === 'http://box:8001'));
});

test('editImage reports transparent as null when the box omits it', async () => {
  const { fetchImpl } = fakeBox(editRoutes([editDone({ transparent: undefined })]));
  const r = await box.editImage(provider, { source: 'core_x.png', instruction: 'x' }, { fetchImpl, sleep });
  assert.equal(r.ok, true);
  assert.equal(r.transparent, null);
});
