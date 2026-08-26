// Bulk re-generation of catalog art: every tile texture, every entity image,
// driven from the admin UI ("Regenerate all tiles" / "Regenerate all entities")
// and from scripts/regenerate-catalog-images.js. Both call THIS -- the script
// existed first and the buttons must not be a second implementation of the
// same rules.
//
// SPRITES ARE OUT OF SCOPE, STRICTLY:
//   * every job is frames = 1, so the remote is never asked for a sheet;
//   * the `sprite` column is never read and never written -- not even to NULL,
//     which is what the interactive approve routes do. Clearing it there is
//     right for a human approving one image; here it would be a bulk button
//     silently deleting animation work.
//
// SINGLE FLIGHT: one run at a time, process-wide. The remote is one box with
// one GPU, so a second concurrent run would not go faster -- it would just
// interleave two progress counters and double the queue depth. A second start
// is refused with a reason rather than queued.
//
// The run lives in memory, like remoteImageProvider's job registry. A backend
// restart therefore forgets an in-flight run. What it does NOT lose is the
// work: every subject is committed to the catalog as it completes, so a
// restart costs the progress bar, not the images.

const aiProviders = require('./aiProviders');
const remoteImageProvider = require('./remoteImageProvider');
const { resolveGenerationTarget } = require('./generationTarget');
const { loadBiomes } = require('./biomes');
const { composeBiomePrompt } = require('./biomePrompt');
const assetStore = require('./assetStore');

const KINDS = Object.freeze(['tiles', 'entities', 'both']);

// `image` and `render_mode` only. See the header for why `sprite` is absent.
// For entity types the mode moves rect -> static because a type carrying an
// image that still draws as a colour box would show none of the art the run
// just paid for.
const CATALOG_UPDATE = Object.freeze({
  tile_types: `UPDATE tile_types SET image = $1, updated_at = CURRENT_TIMESTAMP
               WHERE id = $2 RETURNING name`,
  entity_types: `UPDATE entity_types SET image = $1, render_mode = 'static',
                 updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING name`,
});

async function loadSubjects(pool, { kind = 'both', includeRect = false, only = null } = {}) {
  const subjects = [];
  if (kind === 'tiles' || kind === 'both') {
    const { rows } = await pool.query(
      `SELECT id, name, prompt, art_biome, ai_provider_mode, ai_provider_id
         FROM tile_types ORDER BY id`,
    );
    for (const row of rows) {
      subjects.push({
        table: 'tile_types', kind: 'tile', id: row.id, name: row.name,
        basePrompt: row.prompt || row.name, biome: row.art_biome || null, row,
      });
    }
  }
  if (kind === 'entities' || kind === 'both') {
    const { rows } = await pool.query(
      `SELECT id, name, prompt, render_mode, ai_provider_mode, ai_provider_id
         FROM entity_types ORDER BY id`,
    );
    for (const row of rows) {
      // 'rect' is a deliberate "draw a colour box" choice, not a type waiting
      // for art, so promoting one is opt-in.
      if (row.render_mode === 'rect' && !includeRect) continue;
      subjects.push({
        table: 'entity_types', kind: 'object', id: row.id, name: row.name,
        basePrompt: row.prompt || row.name, biome: null, row,
      });
    }
  }
  return only ? subjects.filter(s => only.has(s.name)) : subjects;
}

// Mirrors startGenerationJob's resolution minus the request level: a bulk run
// has no per-job override, so the type's pin wins, then the active provider.
// A subject that resolves to LOCAL is SKIPPED rather than sent to sprite-gen:
// this is the "regenerate through the AI providers" tool, and quietly falling
// back to the local stub would fill the catalog with placeholder art while
// reporting a successful run.
function resolveProviderId(subject, active, providerForDefault = null) {
  const target = resolveGenerationTarget({
    request: {},
    type: {
      ai_provider_mode: subject.row.ai_provider_mode,
      ai_provider_id: subject.row.ai_provider_id,
    },
    active,
  });
  if (target.source === 'remote') return target.providerId;
  // Only a type that made NO choice is redirected. One pinned to 'local' asked
  // for the local service by name and is left alone.
  if (providerForDefault && subject.row.ai_provider_mode !== 'local') {
    return providerForDefault;
  }
  return null;
}

async function planRun(pool, opts = {}) {
  const active = await aiProviders.loadActiveProviderWithSecret(pool).catch(() => null);
  const subjects = await loadSubjects(pool, opts);
  const planned = subjects.map(s => ({
    ...s, providerId: resolveProviderId(s, active, opts.providerForDefault),
  }));
  return {
    work: planned.filter(s => s.providerId),
    skipped: planned.filter(s => !s.providerId),
  };
}

// --- Cutout guard --------------------------------------------------------
//
// An ENTITY image composites over terrain, so it has to carry transparency.
// Every seeded entity image in this catalog does: Tree is 464x464 RGBA and
// 41% fully transparent. What a remote provider returns does NOT -- txt2img
// hands back an opaque 512x512 RGB frame, because Stable Diffusion has no
// alpha channel. The local sprite-gen service cuts the background out itself
// (sprite-gen/app/postproc.py); nothing on the remote path does.
//
// Unattended, that turns 194 cutouts into 194 opaque squares, and the first
// person to notice is a player looking at a forest of grey blocks. So an
// object image without an alpha channel is a FAILED subject, not a stored one.
//
// Tiles are exempt: a tile texture fills its diamond and is supposed to be
// opaque. This is why the check keys on kind rather than applying everywhere.
const PNG_COLOUR_TYPE_OFFSET = 25;          // IHDR: 8 sig + 4 len + 4 type + 8 w/h + 1 depth
const PNG_COLOUR_TYPES_WITH_ALPHA = new Set([4, 6]);   // grey+alpha, RGBA

function pngHasAlpha(head) {
  if (!head || head.length <= PNG_COLOUR_TYPE_OFFSET) return null;   // not a PNG we can read
  if (head[0] !== 0x89 || head[1] !== 0x50) return null;
  return PNG_COLOUR_TYPES_WITH_ALPHA.has(head[PNG_COLOUR_TYPE_OFFSET]);
}

// Reads only the first chunk: the answer lives in byte 25, and pulling a whole
// 500KB image back out of object storage to look at its header would be silly.
async function readObjectHead(key, store = assetStore) {
  const stream = await store.getObjectStream(key);
  return new Promise((resolve, reject) => {
    stream.once('data', (chunk) => {
      stream.destroy();
      resolve(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve(null));   // empty object
  });
}

// --- Per-subject seeds ---------------------------------------------------
//
// A bulk run MUST NOT send the same seed for every subject. Stable Diffusion
// starts from noise seeded by that number, so 50 tiles at seed 0 come back
// with near-identical composition -- the same arrangement of the same shapes,
// tinted differently by each prompt. Measured on this catalog: four tiles
// generated at seed 0 had a mean pairwise structural correlation of +0.83
// (cave_floor/rocks +0.94, effectively one picture); the same four at
// per-subject seeds measured -0.01, i.e. unrelated.
//
// That is not the model collapsing, which is what it looks like. It is the
// caller handing every subject the same starting noise.
//
// Derived rather than random so a run is still reproducible: the same subject
// always gets the same seed, and `base` shifts the whole catalog to a fresh
// set of variations when someone wants different art.
function seedFor(subject, base = 0) {
  const name = `${subject.table}:${subject.name}`;
  let hash = 2166136261;                       // FNV-1a, 32-bit
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Positive and well inside the range a provider will accept.
  return ((hash >>> 0) % 1000000) + (Number(base) || 0);
}

async function regenerateSubject(pool, subject, provider, { seed, sameSeed = false, deps = {} } = {}) {
  // `seed` is the BASE, not the value sent, unless the caller insists.
  const subjectSeed = sameSeed ? (Number(seed) || 0) : seedFor(subject, seed);
  const [biomeRow] = subject.biome ? await loadBiomes(pool, [subject.biome]) : [];
  const prompt = composeBiomePrompt(subject.basePrompt, biomeRow || null);

  const jobId = remoteImageProvider.createJob();
  // Awaited, unlike the route's floating promise: a bulk run is sequential by
  // design and needs each result before starting the next.
  await remoteImageProvider.runGeneration(jobId, provider, {
    subject: subject.name,
    kind: subject.kind,
    prompt,
    seed: subjectSeed,
    frames: 1,          // never a sheet. See the header.
  }, deps);

  const job = remoteImageProvider.getJob(jobId);
  if (!job || job.status !== 'done') {
    return { ok: false, error: (job && job.error) || 'job did not finish', jobId };
  }
  const imageKey = job.result && job.result.image_key;
  if (!imageKey) return { ok: false, error: 'job finished without an image_key', jobId };

  if (subject.kind === 'object') {
    // A header we cannot parse is NOT treated as a failure: the guard exists to
    // catch a known, specific shape of wrong image, not to reject anything
    // unfamiliar. Only a PNG that positively says "no alpha" is refused.
    const head = await readObjectHead(imageKey, deps.store).catch(() => null);
    if (pngHasAlpha(head) === false) {
      return {
        ok: false,
        jobId,
        error: 'provider returned an image with no transparency; an entity image '
          + 'must be a cutout or it will render as an opaque square',
      };
    }
  }

  await pool.query(CATALOG_UPDATE[subject.table], [imageKey, subject.id]);
  return { ok: true, imageKey, jobId, prompt, seed: subjectSeed };
}

// --- The single in-flight run -------------------------------------------

let current = null;
let runCounter = 0;

// A WHITELIST, not a blacklist. This is polled every 2s for hours, and the run
// object carries `plan` -- the full subject list with its catalog rows. Spread
// -minus-a-few-keys shipped 26KB per poll for 50 tiles and would have been
// ~190KB for 358, none of which the UI reads. Anything the client needs has to
// be named here.
function publicView(run) {
  if (!run) return null;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    total: run.total,
    done: run.done,
    failed: run.failed,
    skipped: run.skipped,
    errors: run.errors,
    current: run.current,
    error: run.error,
    started_at: run.started_at,
    finished_at: run.finished_at,
    cancelling: Boolean(run.cancelRequested) && run.status === 'running',
  };
}

function getRun() {
  return publicView(current);
}

function isRunning() {
  return Boolean(current && current.status === 'running');
}

// Resolves true if a run was actually asked to stop. The run ends after the
// subject in flight finishes: aborting mid-generation would leave the remote
// drawing an image nobody will store, and the next subject is at most a
// minute away.
function cancelRun() {
  if (!isRunning()) return false;
  current.cancelRequested = true;
  return true;
}

async function drive(run, opts, deps) {
  const { pool } = run;
  const loadProvider = deps.loadProvider
    || ((id) => aiProviders.loadProviderWithSecret(pool, id));
  const runSubject = deps.regenerateSubject || regenerateSubject;

  const providerCache = new Map();
  const provider = async (id) => {
    if (!providerCache.has(id)) providerCache.set(id, await loadProvider(id));
    return providerCache.get(id);
  };

  for (const subject of run.plan) {
    if (run.cancelRequested) {
      run.status = 'cancelled';
      break;
    }
    run.current = { table: subject.table, name: subject.name };
    let result;
    try {
      result = await runSubject(pool, subject, await provider(subject.providerId),
        { seed: opts.seed || 0, sameSeed: opts.sameSeed === true, deps });
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (result.ok) {
      run.done += 1;
      run.consecutiveFailures = 0;
    } else {
      run.failed += 1;
      run.consecutiveFailures += 1;
      // Capped: a run of 358 against a box that has gone away would otherwise
      // return a 358-entry error list, all saying the same thing.
      if (run.errors.length < 20) {
        run.errors.push({ table: subject.table, name: subject.name, error: result.error });
      }
      // A remote that has died fails every remaining subject identically.
      // Stopping keeps the report readable and lets the admin fix and re-run.
      if (run.consecutiveFailures >= (opts.giveUpAfter || 5)) {
        run.status = 'error';
        run.error = `stopped after ${run.consecutiveFailures} consecutive failures`;
        break;
      }
    }
  }

  run.current = null;
  if (run.status === 'running') run.status = 'done';
  run.finished_at = new Date().toISOString();
}

// Starts a run and returns its public view immediately. Throws when one is
// already in flight -- the caller turns that into a 409.
async function startRun(pool, opts = {}, deps = {}) {
  if (isRunning()) {
    const err = new Error('a bulk regeneration is already running');
    err.code = 'ALREADY_RUNNING';
    throw err;
  }
  if (!KINDS.includes(opts.kind || 'both')) {
    const err = new Error(`kind must be one of ${KINDS.join(', ')}`);
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const { work, skipped } = await planRun(pool, opts);
  runCounter += 1;
  const run = {
    id: `bulk_${runCounter}`,
    kind: opts.kind || 'both',
    status: 'running',
    total: work.length,
    done: 0,
    failed: 0,
    // Named subjects, not just a count: "12 skipped" tells an admin nothing,
    // and these are precisely the types they need to go and pin.
    skipped: skipped.map(s => ({ table: s.table, name: s.name })),
    errors: [],
    current: null,
    error: null,
    consecutiveFailures: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    plan: work,
    pool,
    cancelRequested: false,
  };
  current = run;

  if (work.length === 0) {
    run.status = 'done';
    run.finished_at = new Date().toISOString();
    return publicView(run);
  }

  // Floating on purpose: the HTTP request returns now and the UI polls. The
  // catch is what keeps an unexpected throw from becoming an
  // unhandledRejection that takes the process down mid-run.
  drive(run, opts, deps).catch((err) => {
    run.status = 'error';
    run.error = err && err.message ? err.message : String(err);
    run.current = null;
    run.finished_at = new Date().toISOString();
  });

  return publicView(run);
}

// Tests only: drop the in-flight run so each case starts clean.
function __reset() {
  current = null;
  runCounter = 0;
}

module.exports = {
  KINDS,
  pngHasAlpha,
  seedFor,
  CATALOG_UPDATE,
  loadSubjects,
  resolveProviderId,
  planRun,
  regenerateSubject,
  startRun,
  getRun,
  isRunning,
  cancelRun,
  __reset,
};
