#!/usr/bin/env node
/* eslint-disable no-await-in-loop, no-console */
// Capture the GPU box's sprite-sheet contract (catalog, generate_core ->
// task-status -> concept, POST /api/jobs, job polling, /sheet, /atlas) and
// write every raw response to --out. Used to build backend/tests/fixtures/gpuBox
// and to re-capture them when the box changes.
//
// DB access is a single read-only SELECT of the active image provider. The
// token is used to build the auth header and is never printed or written.
//
// Raw captures land in --out as sheet.png / atlas.json; the committed fixtures
// pair each atlas with its own sheet (atlas-wolf.json + wolf-sheet.png, atlas-tree.json + tree-sheet.png).
//   node capture-gpu-box-sprite.js --out DIR --prompt "..." [--stage concept|job|all]
//     [--concept images/x.png] [--actions idle,sway] [--directions s,e]
//     [--frames 2] [--seed 1] [--max-minutes 30]
//
// Needs DATABASE_URL (host: use the db port mapping) and reaches the box at the
// origin of the provider's base_url.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadActiveProviderWithSecret } = require('../src/services/aiProviders');
const { authHeaders } = require('../src/services/providerDiscovery');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const out = arg('out');
  const prompt = arg('prompt');
  const stage = arg('stage', 'all');
  if (!out || !prompt) throw new Error('--out and --prompt are required');
  fs.mkdirSync(out, { recursive: true });
  const save = (name, data) => fs.writeFileSync(path.join(out, name),
    Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const provider = await loadActiveProviderWithSecret(pool, 'image');
  await pool.end();
  if (!provider) throw new Error('no active image provider');
  const origin = new URL(provider.base_url).origin;
  const auth = authHeaders(provider);
  const get = (p) => fetch(`${origin}${p}`, { headers: auth });
  const getJson = async (p) => {
    const r = await get(p);
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const timings = {};
  const t0 = Date.now();

  save('action-catalog.json', (await getJson('/api/action-catalog')).body);

  let concept = arg('concept');
  if (stage !== 'job') {
    const before = (await getJson('/api/assets?source=image&kind=core&limit=5')).body;
    const submittedAt = new Date().toISOString();
    const sub = await fetch(`${origin}/api/generate_core`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...auth },
      body: new URLSearchParams({ prompt, llm_name: provider.model || '' }),
    });
    const subBody = await sub.json().catch(() => null);
    save('generate-core-response.json', { http_status: sub.status, submittedAt, body: subBody });
    console.log('generate_core', sub.status, JSON.stringify(subBody));
    const taskId = subBody && (subBody.task_id || subBody.id);
    if (!taskId) throw new Error('generate_core returned no task id');
    const tc = Date.now();
    let st;
    for (;;) {
      st = (await getJson(`/api/task-status/${encodeURIComponent(taskId)}`)).body;
      console.log('task-status', JSON.stringify(st).slice(0, 400));
      const s = String((st && (st.status || st.state)) || '').toLowerCase();
      if (['done', 'success', 'succeeded', 'completed', 'complete'].includes(s)) break;
      if (['failed', 'failure', 'error', 'revoked'].includes(s)) {
        save('task-status-failed.json', st);
        throw new Error(`concept task ended ${s}`);
      }
      if (Date.now() - tc > 900000) throw new Error('concept timeout');
      await sleep(3000);
    }
    timings.concept_s = (Date.now() - tc) / 1000;
    save('task-status-done.json', st);
    const url = st && st.result && st.result.url;
    if (!url) throw new Error('task-status carried no result.url');
    if (!concept) concept = String(url).replace(/^\//, '');
    save('assets-before.json', before);
    save('assets-after.json', (await getJson('/api/assets?source=image&kind=core&limit=5')).body);
  }
  if (stage === 'concept') { save('timings.json', timings); return; }

  if (!concept) throw new Error('--concept required for job stage');
  const spec = {
    prompt,
    concept_image: concept,
    actions: arg('actions', 'idle').split(','),
    directions: arg('directions', 's,e').split(','),
    frames: Number(arg('frames', '2')),
    cell: '48x64',
    colors: 24,
    seed: Number(arg('seed', '1')),
    concept_check: false,
  };
  save('job-spec.json', spec);
  const cells = spec.actions.length * spec.directions.length * spec.frames;
  const tj = Date.now();
  const cr = await fetch(`${origin}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(spec),
  });
  const crBody = await cr.json().catch(() => null);
  save('job-create-response.json', { http_status: cr.status, body: crBody });
  console.log('jobs POST', cr.status, JSON.stringify(crBody).slice(0, 300));
  const id = crBody && (crBody.id || crBody.job_id);
  if (!id) throw new Error('no job id');
  const maxMs = Number(arg('max-minutes', '30')) * 60000;
  const seen = new Set();
  let last;
  for (;;) {
    last = (await getJson(`/api/jobs/${id}`)).body;
    const s = String(last && last.status);
    if (!seen.has(s)) { seen.add(s); save(`job-${s}.json`, last); }
    save('job-last.json', last);
    console.log(`${Math.round((Date.now() - tj) / 1000)}s`, JSON.stringify(last).slice(0, 240));
    if (['done', 'failed', 'cancelled', 'error', 'succeeded'].includes(s.toLowerCase())) break;
    if (Date.now() - tj > maxMs) throw new Error('job timeout');
    await sleep(7000);
  }
  timings.job_s = (Date.now() - tj) / 1000;
  timings.cells = cells;
  timings.s_per_cell = timings.job_s / cells;
  const sheet = await get(`/api/jobs/${id}/sheet`);
  save('sheet.png', Buffer.from(await sheet.arrayBuffer()));
  save('sheet-headers.json', { status: sheet.status, contentType: sheet.headers.get('content-type') });
  const atlas = await getJson(`/api/jobs/${id}/atlas`);
  save('atlas.json', atlas.body);
  if (spec.concept_image) {
    // the concept image itself, for the fixture and the eyeball check
    const ci = await get(`/${spec.concept_image.replace(/^\//, '')}`);
    save('concept-probe.json', { status: ci.status, contentType: ci.headers.get('content-type') });
  }
  timings.total_s = (Date.now() - t0) / 1000;
  save('timings.json', timings);
  console.log('timings', JSON.stringify(timings));
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
