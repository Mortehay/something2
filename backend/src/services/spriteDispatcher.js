// Drains the sprite batch queue one row at a time on the GPU box (Qwen sheet
// jobs). Per row: concept (our own generate_core task) -> sheet job -> poll ->
// sheet.png + atlas -> sheet.json built from THAT atlas -> stored -> done.
//
// The box job id is recorded (attachBox) the moment the box accepts it, so a
// row put back by requeueStale after a restart resumes polling the same box
// job instead of paying for a second one. There is no local fallback: a box
// failure is a failed row with a readable last_error.
const defaultQueue = require('./spriteJobQueue.js');
const { buildBoxSheetManifest } = require('./spriteSheetManifest.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NO_PROVIDER = 'no sprite provider configured — add one in Settings → AI Providers (modality Sprite)';
const ENGINE_LABEL = 'Qwen-Image-Edit-2511 (GGUF)';
// Box statuses worth resuming; anything else (failed, cancelled, missing)
// means the attached job will never produce a sheet, so the row resubmits.
const RESUMABLE = new Set(['queued', 'running', 'done']);

const safeName = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

// A box client result -> its value, or an Error carrying the box's words.
function must(result) {
  if (result && result.ok) return result;
  throw new Error((result && result.error) || 'GPU box call failed');
}

function createDispatcher({
  db,
  queue = defaultQueue,
  box,
  loadProvider,
  store,
  pollMs = 3000,
  stallMs = 20 * 60 * 1000,
  cellTimeoutMs = 120000,
}) {
  let run = null;

  // Polls a box job to done. Fails on a terminal non-done status, on no
  // progress change for stallMs (the box can wedge while its status endpoint
  // stays green), or past the overall deadline. A transient poll error counts
  // as "no progress" rather than failing the row outright.
  async function pollToDone(provider, boxJobId, deadlineMs) {
    const startedAt = Date.now();
    let lastSig = null;
    let lastChange = startedAt;
    let lastError = null;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const r = await box.getSheetJob(provider, boxJobId);
      const now = Date.now();
      if (r && r.ok) {
        lastError = null;
        const { status, progress = {}, error } = r.job;
        if (status === 'done') return;
        if (!RESUMABLE.has(status)) {
          throw new Error(`box job ${status}${error ? `: ${error}` : ''}`);
        }
        const sig = JSON.stringify([status, progress.pct ?? null, progress.message ?? null, progress.stage ?? null]);
        if (sig !== lastSig) { lastSig = sig; lastChange = now; }
      } else if (r && r.retryable) {
        lastError = r.error;
      } else {
        must(r);
      }
      if (now - lastChange >= stallMs) {
        const mins = Math.round(stallMs / 60000);
        throw new Error(`box stalled: no progress for ${mins} min${lastError ? ` (${lastError})` : ''}`);
      }
      if (now - startedAt >= deadlineMs) {
        throw new Error(`box job ${boxJobId} timed out after ${Math.round(deadlineMs / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await wait(pollMs);
    }
  }

  async function submit(provider, row, prefix) {
    const concept = must(await box.generateConcept(provider, { prompt: row.base_prompt }));
    const conceptKey = `${prefix}concept.png`;
    await store.putObject(conceptKey, concept.png, 'image/png');
    const job = must(await box.createSheetJob(provider, {
      prompt: row.base_prompt,
      concept_image: concept.conceptPath,
      actions: row.actions,
      directions: row.directions,
      frames: row.frames_per_action,
      cell: '48x64',
      colors: 24,
      seed: Number(row.seed),
      style_profile: null,
      concept_check: false,
    }));
    await queue.attachBox(db, row.id, { boxJobId: job.boxJobId, conceptKey, providerId: provider.id });
    return { boxJobId: job.boxJobId, conceptKey, cells: job.cells, estimatedSeconds: job.estimatedSeconds };
  }

  async function execute(row) {
    const provider = await loadProvider();
    if (!provider) throw new Error(NO_PROVIDER);
    const prefix = `${store.BUCKET()}/${safeName(row.creature)}/${row.id}/`;

    let attached = null;
    if (row.box_job_id) {
      const st = must(await box.getSheetJob(provider, row.box_job_id));
      if (RESUMABLE.has(st.job.status)) {
        attached = { boxJobId: row.box_job_id, conceptKey: row.concept_key || null };
      }
    }
    const t0 = Date.now();
    const job = attached || await submit(provider, row, prefix);

    const plannedCells = (row.actions || []).length * (row.directions || []).length * (row.frames_per_action || 0);
    const cells = Number(job.cells) || plannedCells;
    const deadlineMs = Math.max(cells * cellTimeoutMs, (Number(job.estimatedSeconds) || 0) * 3 * 1000);
    await pollToDone(provider, job.boxJobId, deadlineMs);
    const sheetSeconds = (Date.now() - t0) / 1000;

    const sheet = must(await box.fetchSheet(provider, job.boxJobId));
    const atlas = must(await box.fetchAtlas(provider, job.boxJobId));
    const built = buildBoxSheetManifest({
      atlas: atlas.atlas,
      sheetPng: sheet.png,
      actions: row.actions,
      directions: row.directions,
      frames: row.frames_per_action,
      engine: ENGINE_LABEL,
      boxJobId: job.boxJobId,
      kind: row.generation_kind,
    });
    if (!built.ok) throw new Error(`box sheet rejected: ${built.error}`);

    const sheetKey = `${prefix}sheet.png`;
    const manifestKey = `${prefix}sheet.json`;
    await store.putObject(sheetKey, sheet.png, 'image/png');
    await store.putObject(manifestKey, Buffer.from(JSON.stringify(built.manifest)), 'application/json');
    await queue.complete(db, row.id, {
      atlas_key: sheetKey,
      manifest_key: manifestKey,
      concept_key: job.conceptKey,
      sheet_seconds: sheetSeconds,
    });
  }

  async function drain(current) {
    try {
      while (!current.stopping) {
        // eslint-disable-next-line no-await-in-loop
        const row = await queue.claim(db);
        if (!row) break;
        current.current = { id: row.id, entity_type_id: row.entity_type_id, creature: row.creature };
        try {
          // eslint-disable-next-line no-await-in-loop
          await execute(row);
          current.completed += 1;
        } catch (err) {
          // eslint-disable-next-line no-await-in-loop
          await queue.fail(db, row.id, err);
          current.failed += 1;
        }
      }
    } finally {
      current.running = false;
      current.current = null;
      current.finished_at = new Date().toISOString();
    }
  }

  function start() {
    if (run && run.running) {
      const err = new Error('a sprite batch is already running');
      err.code = 'ALREADY_RUNNING';
      throw err;
    }
    run = {
      running: true,
      stopping: false,
      completed: 0,
      failed: 0,
      current: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    return drain(run);
  }

  // Claim nothing new; the job already on the box runs to completion.
  function stop() {
    if (!run || !run.running) return false;
    run.stopping = true;
    return true;
  }

  function status() {
    return run ? { ...run, current: run.current ? { ...run.current } : null } : null;
  }

  return { start, stop, status };
}

module.exports = { createDispatcher, NO_PROVIDER };
