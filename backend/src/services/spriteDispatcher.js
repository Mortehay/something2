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
const defaultBoxCancels = require('./spriteBoxCancels.js');
const { buildBoxSheetManifest } = require('./spriteSheetManifest.js');
const { applyTurnaround } = require('./spriteTurnaround.js');
// The Art pipeline's trim (SOMET-563): a prop is stored cropped to its opaque
// content, so the renderer's fit fills the display box and a bottom-anchored
// idle effect pivots at the real base, not in empty canvas.
const { trimForStorage } = require('./remoteImageProvider.js');
const { decodeRGBA, CLEAR } = require('./pngAlpha.js');
const { withSizeJumpFlags } = require('./spriteSizeCheck.js');
const crypto = require('node:crypto');
const { planReuse, carryPlan, mergeSheets } = require('./spriteIncremental.js');
const { SPRITE_ALL_DIRECTIONS } = require('./spriteBatchOptions.js');
const { spriteEngineOf } = require('./aiProviders.js');
const { samplingSpec, expectedSecondsPerCell, sheetDeadlineMs } = require('./spriteSampling.js');
const { secondsPerCellFor, boxSeconds } = require('./spriteEta.js');
const { replaceFrames, autoReplaceTargets } = require('./spriteFrameReplace.js');

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

// Until a QA-off sheet has been measured the run estimates at the 4-step model rate.
const DEFAULT_SECONDS_PER_CELL = secondsPerCellFor({ steps: 4 });

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

// Thrown when force regenerate replaced the row being polled (SOMET-698). The
// row is gone and the force route cancels the box job, so drain() only moves on.
function replacedError() {
  const err = new Error('replaced by force regenerate');
  err.replaced = true;
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

// How a row is drawn (aiProviders.SHEET_METHODS): the row's own choice, else the
// provider's, else '2d'. The ComfyUI engine draws 2d only.
const sheetMethod = (provider, row = null) => {
  if (spriteEngineOf(provider) === 'comfyui-hq') return '2d';
  return (row && row.sheet_method) || (provider && provider.request_template && provider.request_template.sheet_method) || '2d';
};

// A 3D turnaround measured 2m42s on the box. It runs on the box's CPU mesh
// worker, which has been seen not consuming its queue at all, so the wait is
// capped short: the 2D sheet is kept and the row is not held for hours.
const TURNAROUND_DEADLINE_MS = 15 * 60 * 1000;
const TURNAROUND_QUEUE_CAP_MS = 20 * 60 * 1000;
const turnaroundNote = (why) => `3D turnaround skipped, kept the 2D sheet: ${why}`.slice(0, 500);

const CONNECTOR_GONE = 'the connector chosen for this row is no longer enabled';
const BOX_JOB_GONE = "The GPU box no longer has this sheet's job. Queue the whole sheet again.";

// SOMET-702 incremental re-runs.
// A row's cell size: NULL / unset is the 48x64 default (SOMET-706).
const rowCellSize = (row) => String((row && row.cell) || '48x64');
const rowCellPair = (row) => rowCellSize(row).split('x').map(Number);
// The box must return the cell size the row asked for; a sheet at another size
// is never stored (it would be approved as something it is not).
function assertCellMatches(manifest, row) {
  const got = manifest && manifest.cell;
  const want = rowCellPair(row);
  if (!Array.isArray(got) || got[0] !== want[0] || got[1] !== want[1]) {
    throw new Error(`the GPU box returned ${Array.isArray(got) ? got.join('x') : 'no'} cells, the row asked for ${rowCellSize(row)}`);
  }
}
// HQ lane (SOMET-712): the box must say it drew the sheet with the engine the
// row's connector asked for; a box that ignored `engine` answers without an
// echo, which reads as diffusers and fails an HQ row instead of passing a
// standard sheet off as HQ.
function assertEngineMatches(manifest, provider) {
  const want = spriteEngineOf(provider);
  const got = (manifest && manifest.box_engine) || 'diffusers';
  if (got !== want) throw new Error(`the GPU box drew this with ${got}, the row asked for ${want}`);
}
// A box that ignored body_plan would draw a four-legged row through human poses
// and still report done, so the echo has to name the body the row asked for.
function assertBodyPlanMatches(manifest, row) {
  if (row.body_plan !== 'quadruped') return;
  const echo = manifest && manifest.box_engine_info && manifest.box_engine_info.body_plan;
  const got = (echo && echo.value) || 'none';
  if (got !== 'quadruped') throw new Error(`the GPU box drew this with body ${got}, the row asked for quadruped`);
}
const baseEngine = (manifest) => (manifest && manifest.box_engine) || 'diffusers';

// Sampling presets: the manifest records the row's preset key (absent = box
// default) so an A/B can be reconstructed, and a base is reused only at the
// same preset, so one sheet never mixes cells drawn at different steps/cfg.
const baseSampling = (manifest) => (manifest && manifest.sampling) || null;
function stampSampling(manifest, row) {
  if (row.sampling) manifest.sampling = row.sampling;
  else delete manifest.sampling;
  return manifest;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isMissing = (err) => Boolean(err && (err.code === 'NoSuchKey' || err.code === 'NotFound'));
const baseGone = (id) => `the earlier sheet ${id} this re-run keeps frames from is gone — queue the whole sheet again`;
const baseUnreadable = (id) => `the earlier sheet ${id} is unreadable`;
const stamp = (at) => {
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') : 'unknown date';
};
// M1: can the base be merged at all? Its PNG must decode as 8-bit RGBA and
// every manifest rect must lie inside it. Checked before the GPU is asked, so a
// broken base means a full draw instead of a wasted partial job.
function mergeable(base) {
  const img = decodeRGBA(base.png);
  const frames = base.manifest.frames;
  if (!img || !frames || typeof frames !== 'object') return false;
  return Object.values(frames).every((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
    && r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= img.width && r[1] + r[3] <= img.height);
}

// Which cells of `base` the row keeps and which rows it still draws.
const planFor = (row, base) => planReuse({
  actions: row.actions, directions: row.directions, frames: row.frames_per_action, baseManifest: base.manifest,
  redraw: row.redraw_actions === true,
});

// A box client result -> its value, or an Error carrying the box's words.
function must(result) {
  if (result && result.ok) return result;
  const err = new Error((result && result.error) || 'GPU box call failed');
  // SOMET-756: the request never got an answer. That says nothing about this row.
  if (result && result.unreachable) err.boxUnreachable = true;
  throw err;
}

function createDispatcher({
  db,
  queue = defaultQueue,
  box,
  loadProvider,
  loadProviderById = null,
  store,
  concepts = defaultConcepts,
  boxCancels = defaultBoxCancels,
  pollMs = 3000,
  stallMs = 20 * 60 * 1000,
  queueCapMs = QUEUE_CAP_MS,
  cellTimeoutMs = 120000,
  turnaroundDeadlineMs = TURNAROUND_DEADLINE_MS,
  turnaroundQueueCapMs = TURNAROUND_QUEUE_CAP_MS,
}) {
  let run = null;

  // Every cancel goes through the tracker (SOMET-695) so the page can show
  // whether the box really stopped. Same { ok, error } answer as the box call.
  const cancelOnBox = (provider, boxJobId, source, row = null) => boxCancels.request(
    db, provider, { boxJobId, spriteSetId: row && row.id ? row.id : null, subject: row && row.creature ? row.creature : null, source },
    { box },
  );

  async function readObject(key) {
    const chunks = [];
    for await (const chunk of await store.getObjectStream(key)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  // A base row's sheet.json + sheet.png -> { base } or { problem: 'gone' |
  // 'unreadable' }. Any other store error is thrown.
  async function readBase(baseRow) {
    try {
      const manifest = JSON.parse((await readObject(baseRow.manifest_key)).toString('utf8'));
      if (!manifest || typeof manifest !== 'object') return { problem: 'unreadable' };
      const png = await readObject(baseRow.atlas_key);
      return { base: { row: baseRow, manifest, png } };
    } catch (err) {
      if (isMissing(err)) return { problem: 'gone' };
      if (err instanceof SyntaxError) return { problem: 'unreadable' };
      throw err;
    }
  }

  // SOMET-761. "The current sheet", the one the Sprite tab warns against: the
  // newest sheet of this subject and variant that has an atlas, by created_at,
  // whatever its status, cell, engine, sampling or concept (spriteBatchRoutes.js
  // /subjects uses the same rule). Losing a direction is about what the admin
  // sees today, not about which sheet a reuse happens to borrow cells from. The
  // row being drawn is excluded: its own old atlas is replaced by this run.
  async function currentSheetDirections(row) {
    const { rows } = await db.query(
      `SELECT directions FROM sprite_sets
        WHERE entity_type_id = $1 AND appearance_variant IS NOT DISTINCT FROM $2::smallint
          AND atlas_key IS NOT NULL AND id <> $3::uuid
        ORDER BY created_at DESC LIMIT 1`,
      [row.entity_type_id, row.appearance_variant == null ? null : Number(row.appearance_variant), row.id],
    );
    return (rows[0] && rows[0].directions) || null;
  }

  // The directions the current sheet has and this run does not, as a phrase, or ''.
  async function lostDirectionsNote(row) {
    const had = await currentSheetDirections(row);
    if (!Array.isArray(had)) return '';
    const lost = SPRITE_ALL_DIRECTIONS.filter((d) => had.includes(d) && !(row.directions || []).includes(d));
    return lost.length ? `dropped directions ${lost.join(', ')}` : '';
  }

  // SOMET-702. The newest finished sheet of the subject drawn from exactly this
  // concept (sha256 of the concept files) with the row's own cell size, or null.
  async function findBase(row, conceptBytes, provider = null) {
    if (typeof queue.reuseBaseCandidates !== 'function') return null;
    const want = sha256(conceptBytes);
    const wantCell = rowCellPair(row);
    const candidates = await queue.reuseBaseCandidates(db, {
      entityTypeId: row.entity_type_id, variant: row.appearance_variant, excludeId: row.id,
    });
    for (const c of candidates || []) {
      let concept;
      try {
        // eslint-disable-next-line no-await-in-loop
        concept = await readObject(c.concept_key);
      } catch (err) {
        if (isMissing(err)) continue;
        throw err;
      }
      if (sha256(concept) !== want) continue;
      // eslint-disable-next-line no-await-in-loop
      const { base } = await readBase(c);
      const cell = base && base.manifest.cell;
      // SOMET-712: never mix lanes; a base drawn by another engine is skipped.
      if (base && baseEngine(base.manifest) !== spriteEngineOf(provider)) continue;
      if (base && baseSampling(base.manifest) !== (row.sampling || null)) continue;
      // A 3D row must not inherit 2D idle rows, which would skip its turnaround, or the reverse.
      // A four-legged row must not inherit cells drawn through human poses, or the reverse.
      if (base && ((base.manifest.box_engine_info || {}).body_plan || {}).value !== (row.body_plan || undefined)) continue;
      if (base && row.sheet_method && Boolean(base.manifest.turnaround3d) !== (row.sheet_method === 'turnaround3d')) continue;
      if (Array.isArray(cell) && cell[0] === wantCell[0] && cell[1] === wantCell[1] && mergeable(base)) return base;
    }
    return null;
  }

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

  // SOMET-660: the art a creature sheet starts from -- the appearance variant's
  // own image when it has one, else the entity's (the game draws the same
  // COALESCE). Null when there is none or the stored object is gone.
  async function creatureArt(row) {
    if (row.appearance_variant != null) {
      const { rows } = await db.query(
        'SELECT image FROM character_appearances WHERE entity_type_id = $1 AND variant = $2',
        [row.entity_type_id, Number(row.appearance_variant)]);
      const key = rows[0] && rows[0].image;
      if (key) {
        try { return await readObject(key); } catch (err) { if (!isMissing(err)) throw err; }
      }
    }
    return existingEntityImage(row.entity_type_id);
  }

  // The row whose main sheet job is being polled, while it is (see detachCurrent).
  let sheetPoll = null;

  async function detachGate() {
    const decision = sheetPoll && sheetPoll.decision;
    if (decision && await decision) throw replacedError();
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
    measure = true, onPoll = null, queueCapMessage = null, capMs = queueCapMs, row = null, gate = null,
  } = {}) {
    const queueStart = Date.now();
    let startedAt = queueStart;
    let lastSig = null;
    let lastChange = startedAt;
    let lastError = null;
    let runningAt = null;
    let sawRunning = false;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      if (gate) await gate();
      // Halt: cancel the box job (cooperative there -- the cell in progress
      // finishes) and stop polling. A failed cancel is logged, not fatal: a
      // sheet row is requeued detached either way; a redraw row keeps its
      // task (drain passes keepTask) so the next run resumes it.
      if (run && run.halting) {
        // eslint-disable-next-line no-await-in-loop
        const c = await cancelOnBox(provider, boxJobId, 'halt', row);
        const cancelled = Boolean(c && c.ok);
        if (!cancelled) console.error(`sprite halt: could not cancel box job ${boxJobId}: ${c && c.error}`);
        throw haltedError(cancelled);
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await box.getSheetJob(provider, boxJobId);
      // Again here: a detach taken during this read must beat the status it returned.
      // eslint-disable-next-line no-await-in-loop
      if (gate) await gate();
      const now = Date.now();
      if (r && r.ok) {
        lastError = null;
        const { status, progress = {}, error } = r.job;
        if (onPoll) onPoll(status, progress);
        if (status === 'done') return runningAt;
        if (status === 'cancelling') {
          // Not terminal: the box still holds the card. Nobody here asked for it (our own
          // cancels stop polling first), so fail the row without a second cancel.
          throw boxEnded('box job is being cancelled');
        }
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
      } else if (r && (r.retryable || r.status >= 500)) {
        // SOMET-748: a 5xx on a status read says nothing about the job, which
        // may be drawing fine behind a proxy or a restarting box. Same rule as
        // the concept poll: the stall window decides.
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
      const c = await cancelOnBox(provider, boxJobId, 'abandoned', row);
      if (c && c.ok) return;
      console.error(`sprite: could not cancel box job ${boxJobId} for ${row.id}: ${c && c.error}`);
    } catch (err) {
      console.error(`sprite: could not cancel box job ${boxJobId} for ${row.id}: ${err.message}`);
    }
  }

  // Records the box job on the row; if that write fails the job would run with
  // nothing pointing at it, so it is cancelled before the error propagates.
  async function attachOrCancel(provider, row, job, conceptKey, reuseBaseId = null) {
    const info = { boxJobId: job.boxJobId, conceptKey, providerId: provider.id };
    if (reuseBaseId) info.reuseBaseId = reuseBaseId;
    try {
      await queue.attachBox(db, row.id, info);
    } catch (err) {
      await cancelAbandoned(provider, job.boxJobId, row);
      throw err;
    }
  }

  // The sheet job spec for a row, drawn from the given box concept path.
  const sheetSpec = (row, conceptPath, provider) => ({
    ...(spriteEngineOf(provider) === 'comfyui-hq' ? { engine: 'comfyui-hq' } : {}),
    ...samplingSpec(row.sampling, spriteEngineOf(provider)),
    // The box's quality checks, as the row was queued. NULL (a legacy row) and
    // the HQ engine send nothing, so the box keeps its own default.
    ...(typeof row.quality_checks === 'boolean' && spriteEngineOf(provider) === 'diffusers' ? { quality_checks: row.quality_checks } : {}),
    ...(row.body_plan === 'quadruped' && spriteEngineOf(provider) === 'diffusers' ? { body_plan: 'quadruped' } : {}),
    prompt: row.base_prompt,
    concept_image: conceptPath,
    actions: row.actions,
    directions: row.directions,
    frames: row.frames_per_action,
    cell: rowCellSize(row),
    colors: 24,
    seed: Number(row.seed),
    style_profile: null,
    concept_check: false,
  });

  // Copies the kept concept's object under the row's own prefix and returns its
  // bytes; null when the stored object is gone (the caller then draws a new concept).
  async function copyKeptConcept(kept, conceptKey) {
    try {
      const bytes = await readObject(kept.concept_key);
      await store.putObject(conceptKey, bytes, 'image/png');
      return bytes;
    } catch (err) {
      if (err && (err.code === 'NoSuchKey' || err.code === 'NotFound')) return null;
      throw err;
    }
  }

  // Best effort (SOMET-749), like cancelAbandoned: a failed cancel only costs the
  // box the rest of that task, so it is logged and the row keeps its own outcome.
  // Not through the cancel tracker: that follows sheet jobs at /api/jobs/{id}.
  async function cancelAbandonedConcept(provider, taskId, row) {
    try {
      const c = await box.cancelConceptTask(provider, taskId);
      if (c && c.ok) return;
      console.error(`sprite: could not cancel concept task ${taskId} for ${row.id}: ${c && c.error}`);
    } catch (err) {
      console.error(`sprite: could not cancel concept task ${taskId} for ${row.id}: ${err.message}`);
    }
  }

  // Draws (or reuses) the concept, then creates the sheet job. A subject keeps
  // one concept (sprite_concepts): it is reused while the SAME box (origin)
  // still has it. If the box refuses the reused concept with a
  // non-retryable 4xx, a new one is drawn once; a second refusal fails the row.
  async function submit(provider, row, prefix, cur = null) {
    const conceptKey = `${prefix}concept.png`;
    const origin = new URL(provider.base_url).origin;
    const art = await creatureArt(row);
    let kept = await concepts.getKept(db, { entityTypeId: row.entity_type_id, variant: row.appearance_variant });
    // A kept concept drawn from other bytes than the art now on file is not this
    // subject's look any more: it is passed over (and replaced below), not
    // "unavailable", so no note and no removal before the new upload succeeds.
    if (kept && art) {
      let keptBytes = null;
      try { keptBytes = await readObject(kept.concept_key); } catch (err) { if (!isMissing(err)) throw err; }
      if (!keptBytes || sha256(keptBytes) !== sha256(art)) kept = null;
    }
    if (kept) {
      // Same box = same origin: the HQ and standard connectors of one box share
      // the subject's concept (SOMET-712), so both lanes draw the same character.
      const sameBox = kept.box_origin === origin;
      if (sameBox && await box.conceptAvailable(provider, kept.box_concept_path)) {
        const copied = await copyKeptConcept(kept, conceptKey);
        if (copied) {
          // SOMET-702: keep the good frames of an earlier sheet drawn from this
          // same concept; the box draws only rows with missing cells, or nothing.
          // The base is an optimisation: a failed lookup draws the whole sheet.
          let base = null;
          try {
            base = await findBase(row, copied, provider);
          } catch (err) {
            console.error(`sprite reuse: base lookup failed for ${row.id}, drawing the whole sheet: ${err.message}`);
          }
          const plan = base ? planFor(row, base) : null;
          if (plan && !plan.jobSpec) return { boxJobId: null, conceptKey, base };
          if (run && run.halting) throw haltedError();
          const spec = sheetSpec(row, kept.box_concept_path, provider);
          if (plan) Object.assign(spec, plan.jobSpec);
          const reused = await box.createSheetJob(provider, spec);
          if (reused.ok) {
            await attachOrCancel(provider, row, reused, conceptKey, base ? base.row.id : null);
            return {
              boxJobId: reused.boxJobId, conceptKey, cells: reused.cells, estimatedSeconds: reused.estimatedSeconds, base,
            };
          }
          // Only a 4xx the concept can explain drops the kept concept. With a
          // non-default cell the 4xx may just as well be the box refusing that
          // cell size, so it fails the row with the box's message instead of
          // discarding a good concept and drawing a new one that fails again.
          // SOMET-712: on the HQ lane a 4xx is the engine (e.g. 422
          // engine_unavailable), never the concept, so it fails the row too.
          // invalid_guidance: the box refused the sampling settings before touching
          // the concept, so the concept must survive. Our presets stay inside the
          // box's cfg/steps bounds, so its header-less 422 for those cannot occur here.
          const refused = reused.status >= 400 && reused.status < 500 && !reused.retryable
            && reused.status !== 401 && reused.status !== 403 && rowCellSize(row) === '48x64'
            && spriteEngineOf(provider) === 'diffusers'
            && reused.errorKind !== 'invalid_guidance' && reused.errorKind !== 'unsupported_body_plan';
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
    // halt ends its poll. A concept given up on (halt, queue cap, run timeout)
    // would still run and delay what is queued after it, so it is cancelled.
    let concept = null;
    if (art) {
      // SOMET-660: the sheet starts from the creature's own approved art. A box
      // that has no upload route (404/405) cannot take it, so it draws as before.
      const up = await box.uploadImage(provider, art);
      if (up.ok) concept = { png: art, conceptPath: up.conceptPath };
      else if (up.status === 404 || up.status === 405) {
        console.error(`sprite: box has no image upload route; drawing a new concept for ${row.id}`);
      } else must(up);
    }
    if (!concept) {
      const generated = await box.generateConcept(provider, { prompt: row.base_prompt }, {
        shouldStop: () => Boolean(run && run.halting),
      });
      if (generated && generated.abandonedTaskId) await cancelAbandonedConcept(provider, generated.abandonedTaskId, row);
      if (generated && generated.halted) throw haltedError();
      concept = must(generated);
    }
    await store.putObject(conceptKey, concept.png, 'image/png');
    // A halt that lands after the concept finished, before a sheet job exists.
    if (run && run.halting) throw haltedError();
    const job = must(await box.createSheetJob(provider, sheetSpec(row, concept.conceptPath, provider)));
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
      realWestern: row.real_western === true,
    });
    if (!built.ok) throw new Error(`box sheet rejected: ${built.error}`);
    // SOMET-712 review I2: a frame redraw keeps its lane; an HQ redraw the box
    // does not confirm as HQ fails instead of being stored as a standard sheet.
    assertEngineMatches(built.manifest, provider);
    assertBodyPlanMatches(built.manifest, row);
    stampSampling(built.manifest, row);
    const keys = { atlas_key: `${prefix}sheet.png`, manifest_key: `${prefix}sheet.json` };
    await store.putObject(keys.atlas_key, sheet.png, 'image/png');
    await store.putObject(keys.manifest_key, Buffer.from(JSON.stringify(withSizeJumpFlags(sheet.png, built.manifest))), 'application/json');
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
        row,
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
        directions: merged.directions,
      };
    } catch (err) {
      if (err.halted) throw err;
      if (err.taskMayRun) {
        const c = await cancelOnBox(provider, created.boxJobId, 'turnaround', row);
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
        row,
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
        const c = await cancelOnBox(provider, taskId, 'redraw', row);
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

  // SOMET-702 intake: the box's partial sheet (if any) merged with the base,
  // then the size check, then use-good-frames on every cell the box failed
  // (a size flag alone only marks the cell for the admin, SOMET-697). Stored
  // under the row's own prefix; the base row and its files are never touched.
  async function storeIncremental(provider, row, prefix, cur, job) {
    const { base } = job;
    const plan = planFor(row, base);
    let drawn = null;
    if (job.boxJobId && plan.jobSpec) {
      const sheet = must(await box.fetchSheet(provider, job.boxJobId));
      const atlas = must(await box.fetchAtlas(provider, job.boxJobId));
      const built = buildBoxSheetManifest({
        atlas: atlas.atlas,
        sheetPng: sheet.png,
        actions: plan.jobSpec.actions,
        directions: plan.jobSpec.directions,
        frames: row.frames_per_action,
        engine: ENGINE_LABEL,
        boxJobId: job.boxJobId,
        kind: row.generation_kind,
        realWestern: row.real_western === true,
      });
      if (!built.ok) throw new Error(`box sheet rejected: ${built.error}`);
      assertCellMatches(built.manifest, row);
      assertEngineMatches(built.manifest, provider);
      assertBodyPlanMatches(built.manifest, row);
      drawn = { png: sheet.png, manifest: built.manifest };
    }
    // SOMET-709: the base's other whole actions come along unchanged, so
    // queuing one action adds it to the sheet instead of replacing the sheet.
    const { carried, dropped } = carryPlan({
      actions: row.actions, directions: row.directions, frames: row.frames_per_action, baseManifest: base.manifest,
    });
    const allActions = [...carried, ...row.actions];
    const keep = new Set(plan.keep);
    for (const a of carried) {
      for (const d of row.directions) for (let i = 0; i < row.frames_per_action; i += 1) keep.add(`${a}/${d}/${i}`);
    }
    let merged;
    try {
      merged = mergeSheets({
        actions: allActions,
        directions: row.directions,
        frames: row.frames_per_action,
        realWestern: row.real_western === true,
        base: { png: base.png, manifest: base.manifest },
        drawn,
        keep,
      });
    } catch (err) {
      if (err.code === 'SPRITE_MERGE') throw new Error(`could not merge with the earlier sheet: ${err.message}`);
      throw err;
    }
    let kept = keep.size;
    const total = allActions.length * row.directions.length * row.frames_per_action;
    let sheetPng = merged.png;
    let manifest = { ...merged.manifest, reused_from: base.row.id, reused_cells: kept };
    // SOMET-712: the merged sheet keeps the lane it was drawn on.
    const laneSrc = drawn ? drawn.manifest : base.manifest;
    manifest.box_engine = baseEngine(laneSrc);
    if (laneSrc.box_engine_info) manifest.box_engine_info = laneSrc.box_engine_info;
    else delete manifest.box_engine_info;
    stampSampling(manifest, row);
    let turnNote = null;
    // The turnaround redraws every idle row, so it runs only when this run drew
    // an idle row; otherwise the base's idle rows (and its marker) are kept.
    if (drawn && sheetMethod(provider, row) === 'turnaround3d' && plan.drawRows.some((r) => r.action === 'idle')) {
      const t = await turnaround(provider, row, job.boxJobId, sheetPng, manifest, cur);
      cur.phase = 'storing';
      cur.pct = 100;
      if (t.note) {
        turnNote = t.note;
      } else {
        const replaced = new Set(t.directions || []);
        kept -= [...keep].filter((k) => k.startsWith('idle/') && replaced.has(k.split('/')[1])).length;
        sheetPng = t.png;
        manifest = { ...t.manifest, reused_cells: kept };
        await store.putObject(`${prefix}turnaround.png`, t.turnaroundPng, 'image/png');
      }
    }
    let note = `reused ${kept} of ${total} cells from sheet ${stamp(base.row.updated_at)}`;
    // Directions first: the note is cut at 500, and "kept X" alone would read as whole.
    const actionNotes = [
      await lostDirectionsNote(row),
      carried.length ? `kept ${carried.join(', ')}` : '',
      ...dropped.map((x) => `dropped ${x.action} (${x.reason})`),
    ].filter(Boolean);
    if (actionNotes.length) note = `${note} (${actionNotes.join('; ')})`;
    if (turnNote) note = `${note}; ${turnNote}`;
    note = note.slice(0, 500);
    manifest = withSizeJumpFlags(sheetPng, manifest);
    // Carried actions are copied as-is: use-good-frames never touches them.
    const targets = autoReplaceTargets(manifest).filter((t) => !carried.includes(t.action));
    if (targets.length) {
      try {
        const fixed = replaceFrames(sheetPng, manifest, targets);
        sheetPng = fixed.png;
        ({ manifest } = fixed);
        if (fixed.skipped.length) manifest.replace_skipped = fixed.skipped;
      } catch (err) {
        console.error(`sprite reuse: use-good-frames failed for ${row.id}, kept the merged sheet: ${err.message}`);
      }
    }
    const sheetKey = `${prefix}sheet.png`;
    const manifestKey = `${prefix}sheet.json`;
    await store.putObject(sheetKey, sheetPng, 'image/png');
    await store.putObject(manifestKey, Buffer.from(JSON.stringify(manifest)), 'application/json');
    await queue.setNote(db, row.id, note);
    // No sheet_seconds: the time covers only the drawn rows, and the per-cell
    // estimate divides by the whole sheet.
    await queue.complete(db, row.id, {
      atlas_key: sheetKey, manifest_key: manifestKey, concept_key: job.conceptKey, sheet_seconds: null,
      actions: carried.length ? allActions : undefined,
    });
  }

  async function execute(row, cur) {
    if (!Array.isArray(row.actions) || row.actions.length === 0) throw new Error(NO_ACTIONS);
    // HQ lane (SOMET-712): a row queued with a connector is drawn by exactly
    // that one; if it is no longer enabled the row fails (never a silent swap
    // to the active connector, which may draw with another engine).
    let provider;
    if (row.chosen_provider_id != null) {
      provider = typeof loadProviderById === 'function' ? await loadProviderById(row.chosen_provider_id) : null;
      if (!provider) throw new Error(CONNECTOR_GONE);
    } else {
      provider = await loadProvider();
    }
    if (!provider) throw new Error(NO_PROVIDER);
    // The batch countdown runs this row at its own preset/engine rate.
    const rowRate = expectedSecondsPerCell(row.sampling, spriteEngineOf(provider));
    if (rowRate) cur.secondsPerCell = rowRate;
    if (cur.predictedSeconds == null) {
      try { cur.predictedSeconds = Math.round(await rowSeconds(row, new Map(), provider)); } catch { /* countdown falls back to cells x rate */ }
    }
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
        // SOMET-702: a partial job merges against the base it was planned on.
        if (row.reuse_base_id) {
          const baseRow = await queue.reuseBaseById(db, row.reuse_base_id);
          const read = baseRow ? await readBase(baseRow) : { problem: 'gone' };
          if (!read.base) {
            if (st.job.status !== 'done') await cancelAbandoned(provider, row.box_job_id, row);
            throw new Error(read.problem === 'unreadable' ? baseUnreadable(row.reuse_base_id) : baseGone(row.reuse_base_id));
          }
          attached.base = read.base;
        }
      }
    }
    cur.phase = attached ? 'queued' : 'concept';
    const job = attached || await submit(provider, row, prefix, cur);
    if (job.base && !job.boxJobId) {
      cur.phase = 'storing';
      cur.pct = 100;
      return storeIncremental(provider, row, prefix, cur, job);
    }
    cur.phase = 'queued';

    const plannedCells = (row.actions || []).length * (row.directions || []).length * (row.frames_per_action || 0);
    const cells = Number(job.cells) || plannedCells;
    // A preset or the HQ engine runs far slower than the box's own estimate
    // (an HQ guided_sharp test job was cancelled at 63% by the old deadline).
    const deadlineMs = sheetDeadlineMs({
      cells, cellTimeoutMs, estimatedSeconds: job.estimatedSeconds,
      secondsPerCell: expectedSecondsPerCell(row.sampling, spriteEngineOf(provider)),
    });
    // A poll that gives up while the job may still run is cancelled on the box
    // (SOMET-665) -- except at the queue cap, where the job is kept so that
    // re-queuing the row resumes its place in the box queue. A halt has
    // already cancelled it; a job the box ended needs nothing.
    let runningAt;
    sheetPoll = { id: row.id, decision: null };
    try {
      runningAt = await pollToDone(provider, job.boxJobId, deadlineMs, {
        measure,
        row,
        gate: detachGate,
        onPoll: (status, progress) => {
          cur.phase = status === 'queued' ? 'queued' : status === 'done' ? 'storing' : 'running';
          const pct = status === 'done' ? 100 : Number(progress.pct);
          cur.pct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : (status === 'queued' ? 0 : cur.pct);
          cur.message = progress.message || '';
        },
      });
    } catch (err) {
      if (!err.halted && !err.boxEnded && !err.queueCapped && !err.replaced) await cancelAbandoned(provider, job.boxJobId, row);
      throw err;
    } finally {
      sheetPoll = null;
    }
    cur.phase = 'storing';
    cur.pct = 100;
    const sheetSeconds = runningAt == null ? null : (Date.now() - runningAt) / 1000;
    if (job.base) return storeIncremental(provider, row, prefix, cur, job);

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
      realWestern: row.real_western === true,
    });
    if (!built.ok) throw new Error(`box sheet rejected: ${built.error}`);
    assertCellMatches(built.manifest, row);
    assertEngineMatches(built.manifest, provider);
    assertBodyPlanMatches(built.manifest, row);
    stampSampling(built.manifest, row);

    let sheetPng = sheet.png;
    let freshNote = '';
    let { manifest } = built;
    if (sheetMethod(provider, row) === 'turnaround3d') {
      const t = await turnaround(provider, row, job.boxJobId, sheetPng, manifest, cur);
      cur.phase = 'storing';
      cur.pct = 100;
      if (t.note) {
        freshNote = t.note;
      } else {
        sheetPng = t.png;
        ({ manifest } = t);
        await store.putObject(`${prefix}turnaround.png`, t.turnaroundPng, 'image/png');
      }
    }
    // SOMET-761: a fresh draw loses directions too; say so, without "reused".
    const lostNote = await lostDirectionsNote(row);
    const note = [lostNote, freshNote].filter(Boolean).join('; ').slice(0, 500);
    if (note) await queue.setNote(db, row.id, note);

    const sheetKey = `${prefix}sheet.png`;
    const manifestKey = `${prefix}sheet.json`;
    await store.putObject(sheetKey, sheetPng, 'image/png');
    await store.putObject(manifestKey, Buffer.from(JSON.stringify(withSizeJumpFlags(sheetPng, manifest))), 'application/json');
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

  // Seconds per cell for the ETA formula: the median of recent QA-off sheets of
  // the row's sampling and connector, else the model rate (same source as the
  // stored predictions). null when the connector cannot be resolved.
  async function etaRate(row, memo, known) {
    const key = `${row.sampling ?? ''}|${row.chosen_provider_id ?? 'active'}`;
    if (memo.has(key)) return memo.get(key);
    let provider = known || null;
    if (!known) try {
      provider = row.chosen_provider_id != null
        ? (typeof loadProviderById === 'function' ? await loadProviderById(row.chosen_provider_id) : null)
        : await loadProvider();
    } catch { provider = null; }
    const engine = provider ? spriteEngineOf(provider) : 'diffusers';
    let measured = null;
    if (typeof queue.calibratedSecondsPerCell === 'function') {
      try {
        measured = await queue.calibratedSecondsPerCell(db, {
          sampling: row.sampling ?? null, providerId: provider ? provider.id : null, includeNullQa: engine === 'comfyui-hq',
        });
      } catch { measured = null; }
    }
    const c = Number(measured) > 0 ? Number(measured) : secondsPerCellFor({ steps: 4, sampling: row.sampling ?? null, engine });
    memo.set(key, c);
    return c;
  }

  // Box seconds one row is expected to take: its stored prediction, else the
  // ETA formula (typical; NULL quality_checks is the box default, QA on). A prop
  // or partial redraw has no sheet overhead: its cells at the rate.
  async function rowSeconds(row, memo, provider) {
    if (Number(row.predicted_seconds) > 0) return Number(row.predicted_seconds);
    const c = await etaRate(row, memo, provider);
    if (row.redraw_of || row.generation_kind === 'object') return rowCells(row) * c;
    return boxSeconds({
      actions: row.actions, directions: row.directions, frames: row.frames_per_action,
      secondsPerCell: c, qualityChecks: row.quality_checks !== false,
    }).typical;
  }

  // Seconds the still-queued rows will take (their predicted box seconds);
  // null when the queue cannot say.
  async function queuedSeconds() {
    if (typeof queue.queuedRowsForEta !== 'function') return null;
    try {
      const rows = await queue.queuedRowsForEta(db);
      const memo = new Map();
      let total = 0;
      for (const r of rows) {
        // eslint-disable-next-line no-await-in-loop
        total += await rowSeconds(r, memo);
      }
      return Math.round(total);
    } catch { return null; }
  }

  async function refreshSecondsPerCell(current) {
    if (typeof queue.calibratedSecondsPerCell !== 'function') return;
    try {
      const provider = await loadProvider();
      const spc = await queue.calibratedSecondsPerCell(db, {
        sampling: null, providerId: provider ? provider.id : null, includeNullQa: spriteEngineOf(provider) === 'comfyui-hq',
      });
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
        // eslint-disable-next-line no-await-in-loop
        current.queuedSeconds = await queuedSeconds();
        const cur = {
          id: row.id, entity_type_id: row.entity_type_id, creature: row.creature,
          phase: 'concept', pct: 0, message: '', cells,
          predictedSeconds: null,
        };
        if (Number(row.predicted_seconds) > 0) cur.predictedSeconds = Number(row.predicted_seconds);
        current.current = cur;
        let ok = false;
        let replaced = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          await execute(row, cur);
          current.completed += 1;
          ok = true;
        } catch (err) {
          if (err.replaced) {
            // The row is deleted and its fresh set is queued: nothing to write.
            replaced = true;
            current.replaced += 1;
          } else if (err.boxUnreachable) {
            // SOMET-756: no answer from the box says nothing about this row, and
            // the next claim would hit the same wall. The row goes back keeping
            // its box job, the rest stay queued, and the run ends saying why.
            // eslint-disable-next-line no-await-in-loop
            await queue.requeueUnreachable(db, row.id, err);
            current.endedReason = `the GPU box could not be reached (${err.message}); `
              + 'the rest of the queue was left queued. Start batch again once the box is back.';
            current.stopping = true;
          } else if (err.halted) {
            // eslint-disable-next-line no-await-in-loop
            await queue.requeueHalted(db, row.id, { keepTask: err.cancelled === false });
            current.halted += 1;
          } else {
            // eslint-disable-next-line no-await-in-loop
            await queue.fail(db, row.id, err);
            current.failed += 1;
          }
        }
        // A replaced row's cells were not drawn; its fresh set stands in for them.
        if (!replaced) current.doneCells += cells;
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
      replaced: 0,
      endedReason: null,
      totalCells: 0,
      doneCells: 0,
      secondsPerCell: DEFAULT_SECONDS_PER_CELL,
      queuedSeconds: null,
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

  // Force regenerate on the row being drawn (SOMET-698). Granted only while the
  // row's own sheet job is being polled: the concept stage has no job to cancel,
  // and storing or a turnaround (which also reads `running`) is past the sheet.
  // The caller takes this inside its transaction, while it holds the row lock,
  // and MUST settle it: the poller waits at its gate meanwhile, so a sheet that
  // finishes during the transaction is not stored for a row about to vanish.
  // confirm() drops the row; keep() (a rollback) resumes polling. Null = refused.
  function detachCurrent(id) {
    const poll = sheetPoll;
    if (!poll || poll.id !== id || poll.decision) return null;
    const cur = run && run.current;
    if (!cur || cur.id !== id || (cur.phase !== 'queued' && cur.phase !== 'running')) return null;
    let settle;
    poll.decision = new Promise((resolve) => { settle = resolve; });
    return {
      confirm: () => settle(true),
      keep: () => { poll.decision = null; settle(false); },
    };
  }

  function status() {
    return run ? { ...run, current: run.current ? { ...run.current } : null } : null;
  }

  // SOMET-721: why these connectors (null = the active one) cannot take a resumed
  // run, or null. Draining with the box down would fail every row within seconds.
  // A chosen connector that is gone is skipped: execute fails only that row.
  async function boxProblem(providerIds) {
    for (const id of providerIds) {
      // eslint-disable-next-line no-await-in-loop
      const provider = id == null ? await loadProvider() : (loadProviderById && await loadProviderById(id));
      if (!provider && id == null) return NO_PROVIDER;
      if (!provider) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const r = await box.checkAuth(provider);
      if (!r.ok) return r.error || `box answered ${r.status}`;
    }
    return null;
  }

  return { start, stop, halt, detachCurrent, status, boxProblem };
}

// SOMET-721: a run lives only in this process, so at boot a row still 'running'
// belongs to a process that is gone. Puts those rows back (keeping their box job)
// and starts draining, the same as pressing Rescue stranded then Start batch.
// Opt-in: this claims rows from the whole database, so a second instance sharing
// it must never do so. A run that was only Stopped is resumed too: its stop
// request died with the process. With the box unreachable nothing moves: the
// rows stay running, the page says Batch interrupted, the next boot tries again.
async function resumeInterruptedBatch({ db, dispatcher, queue = defaultQueue, env = process.env }) {
  if (env.SPRITE_RESUME_ON_BOOT !== 'true') return 0;
  const { interrupted, providerIds } = await queue.resumePlan(db);
  if (!interrupted) return 0;
  const problem = await dispatcher.boxProblem(providerIds);
  if (problem) {
    console.error(`sprite batch: not resumed after a restart, rows stay interrupted: ${problem}`);
    return 0;
  }
  // The server already listens and the probe can take a minute: an admin may have started a run.
  if (dispatcher.status()?.running) return 0;
  const rows = await queue.requeueStale(db, 0);
  if (rows.length === 0) return 0;
  dispatcher.start().catch((err) => console.error('sprite dispatcher stopped:', err));
  return rows.length;
}

module.exports = { createDispatcher, resumeInterruptedBatch, NO_PROVIDER, QUEUE_CAP_MS, safeName };
