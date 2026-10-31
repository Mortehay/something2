// Drains the sprite batch queue one row at a time on the GPU box (Qwen sheet
// jobs). Per creature row: concept (our own generate_core task) -> sheet job ->
// poll -> sheet.png + atlas -> sheet.json built from THAT atlas -> stored ->
// done. Per prop ('object') row: one txt2img cutout -> image.png.
//
// The box job id is recorded (attachBox) the moment the box accepts it, so a
// row put back by requeueStale after a restart resumes polling the same box
// job instead of paying for a second one. There is no local fallback: a box
// failure is a failed row with a readable last_error.
const defaultQueue = require('./spriteJobQueue.js');
const defaultConcepts = require('./spriteConcepts.js');
const { buildBoxSheetManifest } = require('./spriteSheetManifest.js');
const { applyTurnaround } = require('./spriteTurnaround.js');
// The Art pipeline's trim (SOMET-563): a prop is stored cropped to its opaque
// content, so the renderer's fit fills the display box and a bottom-anchored
// idle effect pivots at the real base, not in empty canvas.
const { trimForStorage } = require('./remoteImageProvider.js');
const { decodeRGBA, CLEAR } = require('./pngAlpha.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NO_PROVIDER = 'no sprite provider configured — add one in Settings → AI Providers (modality Sprite)';
const KEPT_CONCEPT_NOTE = 'kept concept unavailable on the box; drew a new one';
const ENGINE_LABEL = 'Qwen-Image-Edit-2511 (GGUF)';
// Box statuses worth resuming; anything else (failed, cancelled, missing)
// means the attached job will never produce a sheet, so the row resubmits.
const RESUMABLE = new Set(['queued', 'running', 'done']);

// Longest a row waits for a box job that is still `queued` (other users' jobs
// ahead of it on the shared box) before the row fails; the box job is kept.
const QUEUE_CAP_MS = 6 * 60 * 60 * 1000;
const NO_ACTIONS = 'queued before GPU-box sheets — re-queue it from the Sprite Generation page';

// Sanity gate for a prop cutout, BEFORE anything is stored. An image we cannot
// decode (not 8-bit RGBA) gets no opinion -- the same rule pngAlpha follows.
const MIN_TRANSPARENT_FRACTION = 0.15;
const MIN_SUBJECT_FRACTION = 0.03;
function checkCutout(png) {
  const img = decodeRGBA(png);
  if (!img) return null;
  const { width, height, px } = img;
  let clear = 0;
  let minX = width; let maxX = -1; let minY = height; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (px[(y * width + x) * 4 + 3] < CLEAR) clear += 1;
      else {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const frac = clear / (width * height);
  if (frac < MIN_TRANSPARENT_FRACTION) {
    return `cutout came back mostly opaque (${Math.round(frac * 100)}% transparent)`;
  }
  const bbox = maxX < 0 ? 0 : ((maxX - minX + 1) * (maxY - minY + 1)) / (width * height);
  if (bbox < MIN_SUBJECT_FRACTION) return 'subject too small';
  return null;
}

// The row's prompt, steered at pixel art and one centred object.
function propPrompt(base) {
  let p = String(base || '').trim();
  if (!/pixel art/i.test(p)) p = `pixel art, ${p}`;
  if (!/single object, centered/i.test(p)) p = `${p}, single object, centered`;
  return p;
}

const DEFAULT_SECONDS_PER_CELL = 57;

// Cells one queued row will draw: a prop is one image, a creature sheet is
// actions x directions x frames.
function rowCells(row) {
  if (row.redraw_of) return (row.redraw_frames || []).length;
  if (row.generation_kind === 'object') return 1;
  return (row.actions || []).length * (row.directions || []).length * (row.frames_per_action || 0);
}

const safeName = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

// Thrown where a halt is noticed; drain() puts the row back in the queue
// instead of failing it. `cancelled` is false when the box task was asked to
// stop and refused (it may still run), so a redraw keeps its task link.
function haltedError(cancelled = true) {
  const err = new Error('halted');
  err.halted = true;
  err.cancelled = cancelled;
  return err;
}

// A poll that gave up while the box task may still be running (stall, run
// deadline, queue cap), as opposed to a task that ended.
function mayStillRun(message) {
  const err = new Error(message);
  err.taskMayRun = true;
  return err;
}

// The box itself ended the job (failed, cancelled, missing): nothing to cancel.
function boxEnded(message) {
  const err = new Error(message);
  err.boxEnded = true;
  return err;
}

// The provider's sheet method (aiProviders.SHEET_METHODS); absent = '2d'.
const sheetMethod = (provider) => (provider && provider.request_template && provider.request_template.sheet_method) || '2d';

// A 3D turnaround measured 2m42s on the box. It runs on the box's CPU mesh
// worker, which has been seen not consuming its queue at all, so the wait is
// capped short: the 2D sheet is kept and the row is not held for hours.
const TURNAROUND_DEADLINE_MS = 15 * 60 * 1000;
const TURNAROUND_QUEUE_CAP_MS = 20 * 60 * 1000;
const turnaroundNote = (why) => `3D turnaround skipped, kept the 2D sheet: ${why}`.slice(0, 500);

const BOX_JOB_GONE = "The GPU box no longer has this sheet's job. Queue the whole sheet again.";

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
  concepts = defaultConcepts,
  pollMs = 3000,
  stallMs = 20 * 60 * 1000,
  queueCapMs = QUEUE_CAP_MS,
  cellTimeoutMs = 120000,
  turnaroundDeadlineMs = TURNAROUND_DEADLINE_MS,
  turnaroundQueueCapMs = TURNAROUND_QUEUE_CAP_MS,
}) {
  let run = null;

  // The entity's current image bytes, or null when it has none or the stored
  // object is gone (then the prop is drawn fresh, as before).
  async function existingEntityImage(entityTypeId) {
    const { rows } = await db.query('SELECT image FROM entity_types WHERE id = $1', [entityTypeId]);
    const key = rows[0] && rows[0].image;
    if (!key) return null;
    try {
      const chunks = [];
      for await (const chunk of await store.getObjectStream(key)) chunks.push(chunk);
      return Buffer.concat(chunks);
    } catch (err) {
      if (err && (err.code === 'NoSuchKey' || err.code === 'NotFound')) return null;
      throw err;
    }
  }

  // Polls a box job to done. While the box job is `queued` (behind other
  // users' jobs on the shared box) neither the stall window nor the run
  // deadline runs: both restart on every queued poll, so they start at the
  // first `running` poll. Waiting is bounded only by queueCapMs. After that:
  // fails on a terminal non-done status, on no progress change for stallMs
  // (the box can wedge while its status endpoint stays green), or past the
  // deadline. A transient poll error counts as "no progress" rather than
  // failing the row outright. Resolves to the time of the first `running`
  // observation (ms epoch) when `measure` is set and one was seen, else null.
  // `queueCapMessage(hours)` overrides the queue-cap failure text.
  async function pollToDone(provider, boxJobId, deadlineMs, {
    measure = true, onPoll = null, queueCapMessage = null, capMs = queueCapMs,
  } = {}) {
    const queueStart = Date.now();
    let startedAt = queueStart;
    let lastSig = null;
    let lastChange = startedAt;
    let lastError = null;
    let runningAt = null;
    let sawRunning = false;
    for (;;) {
      // Halt: cancel the box job (cooperative there -- the cell in progress
      // finishes) and stop polling. A failed cancel is logged, not fatal: a
      // sheet row is requeued detached either way; a redraw row keeps its
      // task (drain passes keepTask) so the next run resumes it.
      if (run && run.halting) {
        // eslint-disable-next-line no-await-in-loop
        const c = await box.cancelSheetJob(provider, boxJobId);
        const cancelled = Boolean(c && c.ok);
        if (!cancelled) console.error(`sprite halt: could not cancel box job ${boxJobId}: ${c && c.error}`);
        throw haltedError(cancelled);
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await box.getSheetJob(provider, boxJobId);
      const now = Date.now();
      if (r && r.ok) {
        lastError = null;
        const { status, progress = {}, error } = r.job;
        if (onPoll) onPoll(status, progress);
        if (status === 'done') return runningAt;
        if (!RESUMABLE.has(status)) {
          throw boxEnded(`box job ${status}${error ? `: ${error}` : ''}`);
        }
        if (status === 'queued' && !sawRunning) {
          startedAt = now;
          lastChange = now;
          lastSig = null;
          if (now - queueStart >= capMs) {
            const hours = Number((capMs / 3600000).toFixed(2));
            const capped = mayStillRun(queueCapMessage ? queueCapMessage(hours)
              : `still waiting behind other box jobs after ${hours} h — the box job ${boxJobId} may still run; re-queue to resume it`);
            capped.queueCapped = true;
            throw capped;
          }
        } else {
          if (status === 'running' && !sawRunning) {
            sawRunning = true;
            startedAt = now;
            lastChange = now;
            if (measure) runningAt = now;
          }
          const sig = JSON.stringify([status, progress.pct ?? null, progress.message ?? null, progress.stage ?? null]);
          if (sig !== lastSig) { lastSig = sig; lastChange = now; }
        }
      } else if (r && r.retryable) {
        lastError = r.error;
      } else {
        must(r);
      }
      if (now - lastChange >= stallMs) {
        const mins = Math.round(stallMs / 60000);
        throw mayStillRun(`box stalled: no progress for ${mins} min${lastError ? ` (${lastError})` : ''}`);
      }
      if (now - startedAt >= deadlineMs) {
        throw mayStillRun(`box job ${boxJobId} timed out after ${Math.round(deadlineMs / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await wait(pollMs);
    }
  }

  // SOMET-665: asks the box to stop a sheet job this row abandoned, so it does
  // not keep the shared box busy for nothing. Best effort: a refused or failed
  // cancel is logged and never replaces the row's own error.
  async function cancelAbandoned(provider, boxJobId, row) {
    try {
      const c = await box.cancelSheetJob(provider, boxJobId);
      if (c && c.ok) return;
      console.error(`sprite: could not cancel box job ${boxJobId} for ${row.id}: ${c && c.error}`);
    } catch (err) {
      console.error(`sprite: could not cancel box job ${boxJobId} for ${row.id}: ${err.message}`);
    }
  }

  // Records the box job on the row; if that write fails the job would run with
  // nothing pointing at it, so it is cancelled before the error propagates.
  async function attachOrCancel(provider, row, job, conceptKey) {
    try {
      await queue.attachBox(db, row.id, { boxJobId: job.boxJobId, conceptKey, providerId: provider.id });
    } catch (err) {
      await cancelAbandoned(provider, job.boxJobId, row);
      throw err;
    }
  }

  // The sheet job spec for a row, drawn from the given box concept path.
  const sheetSpec = (row, conceptPath) => ({
    prompt: row.base_prompt,
    concept_image: conceptPath,
    actions: row.actions,
    directions: row.directions,
    frames: row.frames_per_action,
    cell: '48x64',
    colors: 24,
    seed: Number(row.seed),
    style_profile: null,
    concept_check: false,
  });

  // Copies the kept concept's object under the row's own prefix; null when the
  // stored object is gone (the caller then draws a new concept).
  async function copyKeptConcept(kept, conceptKey) {
    try {
      const chunks = [];
      for await (const chunk of await store.getObjectStream(kept.concept_key)) chunks.push(chunk);
      await store.putObject(conceptKey, Buffer.concat(chunks), 'image/png');
      return conceptKey;
    } catch (err) {
      if (err && (err.code === 'NoSuchKey' || err.code === 'NotFound')) return null;
      throw err;
    }
  }

  // Draws (or reuses) the concept, then creates the sheet job. A subject keeps
  // one concept (sprite_concepts): it is reused while the SAME box (provider id
  // and origin) still has it. If the box refuses the reused concept with a
  // non-retryable 4xx, a new one is drawn once; a second refusal fails the row.
  async function submit(provider, row, prefix, cur = null) {
    const conceptKey = `${prefix}concept.png`;
    const origin = new URL(provider.base_url).origin;
    const kept = await concepts.getKept(db, { entityTypeId: row.entity_type_id, variant: row.appearance_variant });
    if (kept) {
      const sameBox = String(kept.provider_id) === String(provider.id) && kept.box_origin === origin;
      if (sameBox && await box.conceptAvailable(provider, kept.box_concept_path)) {
        const copied = await copyKeptConcept(kept, conceptKey);
        if (copied) {
          if (run && run.halting) throw haltedError();
          const reused = await box.createSheetJob(provider, sheetSpec(row, kept.box_concept_path));
          if (reused.ok) {
            await attachOrCancel(provider, row, reused, conceptKey);
            return { boxJobId: reused.boxJobId, conceptKey, cells: reused.cells, estimatedSeconds: reused.estimatedSeconds };
          }
          const refused = reused.status >= 400 && reused.status < 500 && !reused.retryable
            && reused.status !== 401 && reused.status !== 403;
          if (!refused) must(reused);
        }
      }
      // Unusable: forget it now, so a failure while drawing the new concept
      // never leaves a kept row pointing at a file that may be overwritten.
      await concepts.removeKept(db, { entityTypeId: row.entity_type_id, variant: row.appearance_variant });
      await queue.setNote(db, row.id, KEPT_CONCEPT_NOTE);
      if (cur) cur.message = KEPT_CONCEPT_NOTE;
    }

    // The concept may wait a long time behind other box work (SOMET-664), so a
    // halt ends its poll. The box has no cancel for a concept task: one that
    // was given up on (halt, queue cap, run timeout) may still run there.
    const generated = await box.generateConcept(provider, { prompt: row.base_prompt }, {
      shouldStop: () => Boolean(run && run.halting),
    });
    if (generated && generated.halted) throw haltedError();
    const concept = must(generated);
    await store.putObject(conceptKey, concept.png, 'image/png');
    // A halt that lands after the concept finished, before a sheet job exists.
    if (run && run.halting) throw haltedError();
    const job = must(await box.createSheetJob(provider, sheetSpec(row, concept.conceptPath)));
    await attachOrCancel(provider, row, job, conceptKey);
    // Best effort: a missed keep only costs a re-draw next time.
    try {
      await concepts.upsertKept(db, {
        entityTypeId: row.entity_type_id,
        variant: row.appearance_variant,
        conceptKey,
        boxConceptPath: concept.conceptPath,
        providerId: provider.id,
        boxOrigin: origin,
      });
    } catch (err) {
      console.error(`sprite concept: could not keep the concept for ${row.id}: ${err.message}`);
    }
    return { boxJobId: job.boxJobId, conceptKey, cells: job.cells, estimatedSeconds: job.estimatedSeconds };
  }

  // Props v2: the box's sheet builder animates every action through human
  // poses, so a prop sheet comes back with a person in it. A prop is instead
  // one clean static image -- a single txt2img with the box's cutout -- and
  // the game animates it procedurally (row.prop_fx -> entity_types.idle_fx on
  // approve). SOMET-657: the earlier concept -> /api/edit route was dropped
  // (the edit's VAE round trip re-renders the whole image and is unreliable).
  // No sheet job, so nothing to attach or resume: a re-run redoes the txt2img.
  // The raw cutout is stored as concept.png, the trimmed one as image.png.
  // When the entity already has an image (its latest approved art) that image
  // is the prop: a fresh txt2img would draw something unrelated to it.
  async function executeProp(provider, row, prefix, cur) {
    cur.phase = 'running';
    let png = await existingEntityImage(row.entity_type_id);
    if (!png) {
      const gen = must(await box.txt2imgProp(provider, { prompt: propPrompt(row.base_prompt), seed: Number(row.seed) }));
      const gate = checkCutout(gen.png);
      if (gate) throw new Error(gate);
      png = gen.png;
    }
    cur.phase = 'storing';
    cur.pct = 100;
    const conceptKey = `${prefix}concept.png`;
    await store.putObject(conceptKey, png, 'image/png');
    const imageKey = `${prefix}image.png`;
    await store.putObject(imageKey, trimForStorage(png, 'object').buffer, 'image/png');
    await queue.complete(db, row.id, {
      image_key: imageKey, concept_key: conceptKey, atlas_key: null, manifest_key: null, sheet_seconds: null,
    });
  }

  // Fetches the box's current sheet for the row's box job, builds its manifest
  // from that atlas and stores both under the row's own prefix.
  async function storeBoxSheet(provider, row, prefix) {
    const sheet = must(await box.fetchSheet(provider, row.box_job_id));
    const atlas = must(await box.fetchAtlas(provider, row.box_job_id));
    const built = buildBoxSheetManifest({
      atlas: atlas.atlas,
      sheetPng: sheet.png,
      actions: row.actions,
      directions: row.directions,
      frames: row.frames_per_action,
      engine: ENGINE_LABEL,
      boxJobId: row.box_job_id,
      kind: row.generation_kind,
    });
    if (!built.ok) throw new Error(`box sheet rejected: ${built.error}`);
    const keys = { atlas_key: `${prefix}sheet.png`, manifest_key: `${prefix}sheet.json` };
    await store.putObject(keys.atlas_key, sheet.png, 'image/png');
    await store.putObject(keys.manifest_key, Buffer.from(JSON.stringify(built.manifest)), 'application/json');
    return keys;
  }

  // The 3D sheet method: after the 2D sheet is built, the box renders a static
  // 8-direction turnaround from that sheet job and its cells replace the idle
  // rows (spriteTurnaround.js). Best effort -- any failure keeps the 2D sheet
  // and says why in the row's note; only a halt propagates. Not resumable: a
  // restart mid-turnaround resumes the 2D job and asks for a new turnaround.
  // Resolves { png, manifest, turnaroundPng } or { note }.
  async function turnaround(provider, row, sourceJobId, sheetPng, manifest, cur) {
    cur.phase = 'running';
    cur.pct = 0;
    cur.message = '3D turnaround';
    const created = await box.createTurnaround3d(provider, sourceJobId, { cell: `${manifest.cell[0]}x${manifest.cell[1]}` });
    if (!created.ok) return { note: turnaroundNote(created.error) };
    try {
      await pollToDone(provider, created.boxJobId, turnaroundDeadlineMs, {
        measure: false,
        capMs: turnaroundQueueCapMs,
        queueCapMessage: (hours) => `the box's 3D worker did not start it within ${hours} h`,
        onPoll: (status, progress) => {
          const pct = Number(progress.pct);
          if (Number.isFinite(pct)) cur.pct = Math.max(0, Math.min(100, pct));
          cur.message = `3D turnaround: ${progress.message || status}`;
        },
      });
      const sheet = must(await box.fetchSheet(provider, created.boxJobId));
      const atlas = must(await box.fetchAtlas(provider, created.boxJobId));
      const merged = applyTurnaround({
        sheetPng, manifest, turnaroundPng: sheet.png, turnaroundAtlas: atlas.atlas,
      });
      if (!merged.ok) return { note: turnaroundNote(merged.error) };
      return {
        png: merged.png,
        manifest: { ...merged.manifest, turnaround3d: { box_job_id: created.boxJobId } },
        turnaroundPng: sheet.png,
      };
    } catch (err) {
      if (err.halted) throw err;
      if (err.taskMayRun) {
        const c = await box.cancelSheetJob(provider, created.boxJobId);
        if (!c || !c.ok) console.error(`sprite 3D: could not cancel box job ${created.boxJobId} for ${row.id}: ${c && c.error}`);
      }
      return { note: turnaroundNote(err.message) };
    }
  }

  // Frame redraw (row.redraw_of). The box redraw contract is [ASSUMED]:
  // POST /api/jobs/{box_job_id}/redraw returns a task that is polled and
  // cancelled at /api/jobs/{taskId} (same statuses as a sheet job); once done,
  // /api/jobs/{box_job_id}/sheet and /atlas return the UPDATED sheet. The row
  // keeps box_job_id (the sheet) and records box_task_id (the redraw), so a
  // restart resumes polling the same task instead of redrawing twice. Unlike a
  // full sheet it never resubmits a lost job: the box no longer having the
  // sheet or the task is a failure that tells the admin to queue it again.
  // When the task fails after it started, the box's current sheet is still
  // stored (frames redrawn before the failure are kept) and recorded on the row.
  // A poll that gave up on a task that may still run (stall, deadline, queue
  // cap) cancels it first; if that cancel fails, no sheet is stored (it would
  // be a mid-task snapshot) and the row keeps box_task_id.
  async function executeRedraw(provider, row, prefix, cur) {
    if (!row.box_job_id) throw new Error(BOX_JOB_GONE);
    const frames = row.redraw_frames || [];
    cur.phase = 'queued';
    cur.message = `Redrawing ${frames.length} frame${frames.length === 1 ? '' : 's'}`;
    let taskId = row.box_task_id;
    if (!taskId) {
      taskId = must(await box.redrawFrames(provider, row.box_job_id, frames)).taskId;
      await queue.attachRedrawTask(db, row.id, taskId);
    }
    try {
      await pollToDone(provider, taskId, frames.length * cellTimeoutMs, {
        measure: false,
        queueCapMessage: (hours) => `the redraw waited too long in the GPU box queue (over ${hours} h); retry it`,
        onPoll: (status, progress) => {
          cur.phase = status === 'queued' ? 'queued' : status === 'done' ? 'storing' : 'running';
          const pct = status === 'done' ? 100 : Number(progress.pct);
          cur.pct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : (status === 'queued' ? 0 : cur.pct);
          if (progress.message) cur.message = progress.message;
        },
      });
      cur.phase = 'storing';
      cur.pct = 100;
      let conceptKey = null;
      if (row.concept_key) {
        const chunks = [];
        for await (const chunk of await store.getObjectStream(row.concept_key)) chunks.push(chunk);
        conceptKey = `${prefix}concept.png`;
        await store.putObject(conceptKey, Buffer.concat(chunks), 'image/png');
      }
      const keys = await storeBoxSheet(provider, row, prefix);
      await queue.complete(db, row.id, { ...keys, concept_key: conceptKey, sheet_seconds: null });
    } catch (err) {
      if (err.halted) throw err;
      let capture = true;
      if (err.taskMayRun) {
        const c = await box.cancelSheetJob(provider, taskId);
        if (!c || !c.ok) {
          capture = false;
          console.error(`sprite redraw: could not cancel box task ${taskId} for ${row.id}: ${c && c.error}`);
        }
      }
      if (capture) {
        try {
          const keys = await storeBoxSheet(provider, row, prefix);
          await queue.recordRedrawSheet(db, row.id, keys);
        } catch (capErr) {
          console.error(`sprite redraw: could not keep the box's sheet for ${row.id}: ${capErr.message}`);
        }
      }
      if (/^box job missing/.test(err.message)) throw new Error(BOX_JOB_GONE);
      throw err;
    }
  }

  async function execute(row, cur) {
    if (!Array.isArray(row.actions) || row.actions.length === 0) throw new Error(NO_ACTIONS);
    const provider = await loadProvider();
    if (!provider) throw new Error(NO_PROVIDER);
    const prefix = `${store.BUCKET()}/${safeName(row.creature)}/${row.id}/`;
    if (row.generation_kind === 'object') return executeProp(provider, row, prefix, cur);
    if (row.redraw_of) return executeRedraw(provider, row, prefix, cur);

    let attached = null;
    // A resumed job that is already done or already running has an unknown
    // start, so its sheet time is not measured (stored NULL).
    let measure = true;
    if (row.box_job_id) {
      const st = must(await box.getSheetJob(provider, row.box_job_id));
      if (RESUMABLE.has(st.job.status)) {
        attached = { boxJobId: row.box_job_id, conceptKey: row.concept_key || null };
        measure = st.job.status === 'queued';
      }
    }
    cur.phase = attached ? 'queued' : 'concept';
    const job = attached || await submit(provider, row, prefix, cur);
    cur.phase = 'queued';

    const plannedCells = (row.actions || []).length * (row.directions || []).length * (row.frames_per_action || 0);
    const cells = Number(job.cells) || plannedCells;
    const deadlineMs = Math.max(cells * cellTimeoutMs, (Number(job.estimatedSeconds) || 0) * 3 * 1000);
    // A poll that gives up while the job may still run is cancelled on the box
    // (SOMET-665) -- except at the queue cap, where the job is kept so that
    // re-queuing the row resumes its place in the box queue. A halt has
    // already cancelled it; a job the box ended needs nothing.
    let runningAt;
    try {
      runningAt = await pollToDone(provider, job.boxJobId, deadlineMs, {
        measure,
        onPoll: (status, progress) => {
          cur.phase = status === 'queued' ? 'queued' : status === 'done' ? 'storing' : 'running';
          const pct = status === 'done' ? 100 : Number(progress.pct);
          cur.pct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : (status === 'queued' ? 0 : cur.pct);
          cur.message = progress.message || '';
        },
      });
    } catch (err) {
      if (!err.halted && !err.boxEnded && !err.queueCapped) await cancelAbandoned(provider, job.boxJobId, row);
      throw err;
    }
    cur.phase = 'storing';
    cur.pct = 100;
    const sheetSeconds = runningAt == null ? null : (Date.now() - runningAt) / 1000;

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

    let sheetPng = sheet.png;
    let { manifest } = built;
    if (sheetMethod(provider) === 'turnaround3d') {
      const t = await turnaround(provider, row, job.boxJobId, sheetPng, manifest, cur);
      cur.phase = 'storing';
      cur.pct = 100;
      if (t.note) {
        await queue.setNote(db, row.id, t.note);
      } else {
        sheetPng = t.png;
        ({ manifest } = t);
        await store.putObject(`${prefix}turnaround.png`, t.turnaroundPng, 'image/png');
      }
    }

    const sheetKey = `${prefix}sheet.png`;
    const manifestKey = `${prefix}sheet.json`;
    await store.putObject(sheetKey, sheetPng, 'image/png');
    await store.putObject(manifestKey, Buffer.from(JSON.stringify(manifest)), 'application/json');
    await queue.complete(db, row.id, {
      atlas_key: sheetKey,
      manifest_key: manifestKey,
      concept_key: job.conceptKey,
      sheet_seconds: sheetSeconds,
    });
  }

  // Remaining queued cells, or 0 when the queue cannot say (test fakes).
  async function queuedCells() {
    if (typeof queue.queuedCells !== 'function') return 0;
    try { return Number(await queue.queuedCells(db)) || 0; } catch { return 0; }
  }

  async function refreshSecondsPerCell(current) {
    if (typeof queue.lastSecondsPerCell !== 'function') return;
    try {
      const spc = await queue.lastSecondsPerCell(db);
      if (Number(spc) > 0) current.secondsPerCell = Number(spc);
    } catch { /* keep the previous estimate */ }
  }

  async function drain(current) {
    try {
      await refreshSecondsPerCell(current);
      current.totalCells = await queuedCells();
      while (!current.stopping) {
        // eslint-disable-next-line no-await-in-loop
        const row = await queue.claim(db);
        if (!row) break;
        const cells = rowCells(row);
        // eslint-disable-next-line no-await-in-loop
        const remaining = await queuedCells();
        current.totalCells = Math.max(current.totalCells, current.doneCells + cells + remaining);
        const cur = {
          id: row.id, entity_type_id: row.entity_type_id, creature: row.creature,
          phase: 'concept', pct: 0, message: '', cells,
        };
        current.current = cur;
        let ok = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          await execute(row, cur);
          current.completed += 1;
          ok = true;
        } catch (err) {
          if (err.halted) {
            // eslint-disable-next-line no-await-in-loop
            await queue.requeueHalted(db, row.id, { keepTask: err.cancelled === false });
            current.halted += 1;
          } else {
            // eslint-disable-next-line no-await-in-loop
            await queue.fail(db, row.id, err);
            current.failed += 1;
          }
        }
        current.doneCells += cells;
        // eslint-disable-next-line no-await-in-loop
        if (ok) await refreshSecondsPerCell(current);
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
      halting: false,
      completed: 0,
      failed: 0,
      halted: 0,
      totalCells: 0,
      doneCells: 0,
      secondsPerCell: DEFAULT_SECONDS_PER_CELL,
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

  // Stop AND cut off the job in progress: its box job is cancelled and the
  // row goes back to the queue (drain's halted branch). Within a poll
  // interval, plus the cell the box is finishing.
  function halt() {
    if (!run || !run.running) return false;
    run.stopping = true;
    run.halting = true;
    return true;
  }

  function status() {
    return run ? { ...run, current: run.current ? { ...run.current } : null } : null;
  }

  return { start, stop, halt, status };
}

module.exports = { createDispatcher, NO_PROVIDER, QUEUE_CAP_MS, safeName };
