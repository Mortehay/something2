#!/usr/bin/env node
// Draw the entity catalog on a registered AI provider. Run via
// `make entities-generate`. The tile-side sibling is
// generate-tile-textures.js and this deliberately mirrors its shape.
//
// READ THIS BEFORE USING THE REMOTE PATH. It is written, wired and tested, and
// on the provider available here it does NOT produce usable art. Recorded so
// the next person spends their time somewhere new rather than repeating this:
//
//   * SDXL + a pixel-art LoRA will not draw an isolated object. Asked for one
//     tree it returns a tileset of trees, a framed gallery card, or the tree
//     on a checkered "transparent" backdrop. Four prompt revisions -- adding
//     "single", leading with "only X and nothing else", naming every failure
//     mode in the negative prompt, and a dedicated object-only provider row --
//     each changed WHICH wrong thing it drew, never that it drew one.
//   * Colour keying cannot rescue that. Sampled key, despill, iterative peel
//     of frame-then-mat-then-backdrop, and multi-colour keying for
//     checkerboards all leave ~90% of the image opaque, because a textured or
//     gradient backdrop has no key colour to remove.
//   * The service's own sprite pipeline (POST /api/jobs, which takes
//     style_profile and would let reference images act as templates) refuses
//     a prompt: "no concept_image; prompt-to-concept is not wired yet". It
//     builds sheets from an image it already has, so references cannot steer
//     generation from this side today.
//   * Its FLUX-Kontext editor could plausibly be told "remove the background",
//     but `source` must already be a file in that machine's IMAGES_DIR and by
//     its own note it evicts the generation pipeline while loaded.
//
// REFERENCE IMAGES AND STYLE PROFILES ARE REACHABLE, with one limit worth
// knowing before planning work around them. Uploading our own quantized
// sprites to POST /api/references gets `usable: true` (the same sprites
// unquantized measured 24,268 colours and were rejected), and
// /api/style-profiles/derive turns them into a palette plus cell/outline
// rules. But POST /api/jobs, the only endpoint that consumes a profile,
// validates its concept as a CHARACTER: a boulder was refused with "not
// taller than wide (aspect 1.09) (coverage 2%)". So that route is for
// creatures, not props -- and at ~393s per cell against generate_core's 10s.
//
// USE --core (CORE=1) FOR PROPS, and --local (LOCAL=1) sprite-gen asks for an isolated subject on a
// flat field and keys the background out itself, so its output is genuinely
// transparent. It is sd-turbo on CPU: slow, and lower fidelity than the remote
// pixel art. That is the trade until one of the blockers above moves.
//
// WHAT IT PRODUCES, and the limit stated up front: ONE STILL PER ENTITY.
// Creatures normally want a directional walk atlas, which needs the remote to
// return a ready-made sheet and a sheet layout configured on the provider.
// This asks for a single silhouette instead, because a still is an enormous
// improvement on the coloured rectangle 293 creatures render as today, and it
// works against any sync provider with no extra configuration. Directional
// sets stay a sprite-gen job.
//
// THE PROMPT STYLING LIVES HERE, unlike tiles where it lives in
// seeds/data/tileTypes.js. Two reasons, and they are not laziness:
//
//   * entity prompts are spread across several seed files (entityTypes.js,
//     bestiaryP4.js and the migrations that added creatures), so there is no
//     single catalog file to own it the way tileTypes.js owns tiles; and
//   * the backdrop instruction is not styling at all -- it is a contract with
//     the cutout step, which keys the backdrop out by colour and only works
//     when the backdrop is one flat tone. A prompt somebody edits in the admin
//     UI must not be able to silently break transparency.
//
// So an entity's own prompt stays a plain subject ("a gnarled oak tree") and
// the framing is applied on the way out, matching what sprite-gen's
// build_object_prompt does locally.

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const aiProviders = require('../src/services/aiProviders.js');
const remoteImageProvider = require('../src/services/remoteImageProvider.js');
const { authHeaders } = require('../src/services/providerDiscovery.js');
const spriteGen = require('../src/services/spriteGen.js');
const { resolveProvider, parseArgs } = require('./generate-tile-textures.js');

// The backdrop colour every entity is drawn against, and the one the cutout
// step keys out. Magenta rather than white, which is what sprite-gen asks for
// locally: white is a terrible chroma key here because the catalog is full of
// pale subjects -- ice boulders, bone, snow-covered rock, marble -- and keying
// white punches holes straight through them. Nothing in this catalog is
// naturally magenta.
//
// Changing this string means changing tools/cutout-entity-textures.py's
// expectation with it; they are one contract in two files.
const BACKDROP = 'flat solid magenta background';

// Mirrors sprite-gen/app/prompts.py build_object_prompt in intent, not in
// wording. Two deliberate departures, both measured on this provider:
//
//   * "isolated on a solid white background" became the magenta backdrop
//     above, for the keying reason.
//   * "single ... object" alone was not enough -- SDXL with a pixel-art LoRA
//     answers a bare subject with a TILESET of that subject (a forest for one
//     pine tree). "one single" plus "centered" plus "nothing else in frame"
//     is what stops it, and the provider's negative prompt names the failure
//     modes as well.
function buildObjectPrompt(base) {
  // "only X and nothing else" leads, and that word order is doing work. Asked
  // for "a single pine tree" this model returns a FOREST, and asked for an
  // object on a background it returns the object as framed art on a card --
  // it has been trained on asset sheets and gallery images, so the default
  // reading of any subject is "a picture of that subject". Naming the
  // exclusions first, before any styling, is what stops it.
  return `only ${base} and nothing else, one single object, centered, `
    + `${BACKDROP}, no frame, no border, no picture frame, no card, `
    + 'no ground, no floor, no shadow, no scenery, no other objects, '
    + 'pixel art RPG game asset, isometric 3/4 top-down view, crisp clean pixels, '
    + 'limited palette, sharp outline, cut out on a plain flat background';
}

// Generate through the LOCAL sprite-gen service instead of a remote provider.
//
// WHY THIS EXISTS -- and the correction that now bounds it.
//
// The original reason was that the remote SDXL + pixel-art LoRA was "excellent
// at ground textures and unusable for isolated objects": asked for one tree it
// returned a tileset of trees, a framed gallery card, or a tree on a checkered
// backdrop, measured across four prompt revisions and three cutout strategies.
// That observation was real but the conclusion drawn from it was wrong. The
// cause was not the model and not the prompt -- it was RESOLUTION. Every one of
// those attempts rendered at 512x512, half SDXL's 1024 training resolution, and
// off-native SDXL repeats its subject rather than scaling it. What looked like
// "the model insists on drawing a sheet" was the tiling artifact.
//
// Measured 2026-09-04 against the GPU box, same model, same prompts, same
// seeds, resolution as the ONLY variable (8 icon subjects):
//   512x512  -- 2/8 usable; hammer and "focus" came back as 3x4 sprite sheets,
//               fireball as a grid of gems, leaf as a plant in a room.
//   1024x1024 -- 6/8 usable, each a single centered object that keys cleanly
//               and stays legible downscaled to a 48px slot.
// The two remaining misses are subject problems, not rendering ones: an
// abstract label ("Focus") gives the model nothing concrete to draw.
//
// So the local path is no longer the only way to get an isolated object. It
// stays because it needs no GPU box and no network, which is the honest reason
// to keep it -- not because the remote cannot do this.
//
// sprite-gen is built for this case: build_object_prompt asks for an isolated
// subject on a flat white field and cutout_background() keys it out inside
// the service, so what comes back is already transparent. It is sd-turbo on
// CPU and therefore slow -- about a minute an entity against the remote's five
// seconds -- which is the trade being made deliberately, not an oversight.
// maxWaitMs is 20 minutes, which looks absurd next to the remote path's five
// seconds and is not. sd-turbo runs on CPU here, and the FIRST job of a run
// also pays for loading the model -- a cold generate sat at progress 0/0 for
// well over five minutes before producing anything. A timeout shorter than
// the cold start turns "slow" into "every entity failed".
async function generateLocally(pool, entity, { pollMs = 5000, maxWaitMs = 1200000 } = {}) {
  const started = Date.now();
  let job;
  try {
    job = await spriteGen.postGenerate({
      creature: entity.name,
      base_prompt: entity.prompt,
      kind: 'object',
      frames: 1,
      seed: 0,
    });
  } catch (err) {
    return { ok: false, error: `could not reach sprite-gen: ${err.message}` };
  }

  // sprite-gen returns immediately and does the work in its own process, so
  // unlike the remote path this genuinely has to poll.
  for (;;) {
    if (Date.now() - started > maxWaitMs) return { ok: false, error: 'timed out waiting for sprite-gen' };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, pollMs));
    // eslint-disable-next-line no-await-in-loop
    const doc = await spriteGen.getJob(job.job_id).catch(() => null);
    if (!doc) continue;
    if (doc.status === 'error') return { ok: false, error: doc.error || 'sprite-gen reported an error' };
    if (doc.status !== 'done') continue;
    const key = doc.result && (doc.result.image_key || doc.result.static_key);
    if (!key) return { ok: false, error: 'sprite-gen finished without an image key' };
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `UPDATE entity_types SET image = $1, sprite = NULL, render_mode = 'static',
        updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [key, entity.id],
    );
    return { ok: true, key };
  }
}

// Generate through the sprite service's CONCEPT endpoint (step 1 of its own
// two-step pipeline) rather than the A1111-compatible txt2img shim.
//
// THIS IS VENDOR-SPECIFIC and deliberately not part of the generic provider
// contract: it posts form-encoded fields to /api/generate_core, then finds the
// result by polling that service's asset list. Nothing about that is portable,
// which is why it sits behind --core rather than becoming another provider
// mode. The service URL is taken from the provider's base_url origin, so the
// admin still configures one thing in one place.
//
// WHY IT IS WORTH THE SPECIAL CASE: the same box, same model, same LoRA
// answers /api/generate_core with exactly what txt2img refuses to give -- ONE
// object, centred, on a flat uniform backdrop. Flat is the whole game: a
// backdrop that is one colour can be keyed out, and the checkered and textured
// backdrops txt2img returns cannot. That difference is what makes entity art
// possible here at all.
async function generateViaCore(pool, provider, entity, { pollMs = 5000, maxWaitMs = 900000 } = {}) {
  const origin = new URL(provider.base_url).origin;

  // The provider's configured auth header, on EVERY call to that service.
  //
  // This route bypasses safeFetch (it talks to vendor endpoints rather than
  // the generic provider contract), and in doing so it originally bypassed
  // authentication too -- which went unnoticed for as long as the service
  // happened to be open. The moment it enforced keys, all ten regenerations
  // failed with 401 while the txt2img path, which does send the header, would
  // have kept working. Same credential, same row, all three calls below.
  // Shared with discovery and txt2img rather than re-derived here. This was a
  // THIRD copy of the rule, and it carried the same defect the other two had:
  // requiring both halves meant a token stored with no header name -- which the
  // admin form allows, since the header-name box is optional -- was silently
  // dropped, and every call here answered 401 while the message blamed a
  // missing key. authHeaders() defaults a nameless token to
  // `Authorization: Bearer <token>` and leaves an explicitly named header
  // verbatim.
  const auth = authHeaders(provider);
  const assetsUrl = `${origin}/api/assets?source=image&kind=core&limit=1`;

  // Remember the newest concept BEFORE submitting. The submit call answers
  // with a task id that the asset list does not carry, so "which row is mine"
  // has to be answered by "the one that did not exist a moment ago" -- and
  // matching on the title instead would pick up a re-run of the same subject.
  const before = await fetch(assetsUrl, { headers: auth })
    .then((r) => r.json()).catch(() => ({ items: [] }));
  const beforeId = before.items && before.items[0] ? Number(before.items[0].id) : 0;

  const body = new URLSearchParams({
    // The prompt is used VERBATIM. It carries its own styling now -- see
    // seeds/data/spritePrompt.js -- because a catalog prompt should say what
    // it will actually draw, and because wrapping it here meant editing one in
    // the admin UI silently dropped the part that made it work. Wrapping it
    // again would also stack the styling twice.
    prompt: entity.prompt,
    llm_name: provider.model || '',
  });
  const submit = await fetch(`${origin}/api/generate_core`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...auth },
    body,
  });
  if (!submit.ok) {
    // 401 here means the service now enforces keys and this provider row has
    // no token, or the wrong one. Say that rather than the bare status, which
    // reads like a bug in the request.
    const hint = submit.status === 401
      ? ' -- the service requires a key; set the auth header and token on this'
        + ' provider in Settings (it is sent verbatim, so include any "Bearer " prefix)'
      : '';
    return { ok: false, error: `generate_core answered ${submit.status}${hint}` };
  }

  const started = Date.now();
  for (;;) {
    if (Date.now() - started > maxWaitMs) return { ok: false, error: 'timed out waiting for a concept' };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, pollMs));
    // eslint-disable-next-line no-await-in-loop
    const list = await fetch(assetsUrl, { headers: auth })
      .then((r) => r.json()).catch(() => null);
    const newest = list && list.items && list.items[0];
    if (!newest || Number(newest.id) <= beforeId) continue;

    // eslint-disable-next-line no-await-in-loop
    const img = await fetch(`${origin}${newest.url}`, { headers: auth });
    if (!img.ok) return { ok: false, error: `could not fetch ${newest.url}: ${img.status}` };
    // eslint-disable-next-line no-await-in-loop
    const buf = Buffer.from(await img.arrayBuffer());

    const store = require('../src/services/assetStore.js');
    const safe = String(entity.name).replace(/[^A-Za-z0-9_-]/g, '_');
    const key = `${store.BUCKET()}/${safe}/concept/static.png`;
    // eslint-disable-next-line no-await-in-loop
    await store.putObject(key, buf, 'image/png');
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `UPDATE entity_types SET image = $1, sprite = NULL, render_mode = 'static',
        updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [key, entity.id],
    );
    return { ok: true, key };
  }
}

async function generateOne(pool, provider, entity) {
  const jobId = remoteImageProvider.createJob();
  await remoteImageProvider.runGeneration(jobId, provider, {
    subject: entity.name,
    kind: 'object',
    prompt: buildObjectPrompt(entity.prompt),
    seed: 0,
    frames: 1,
  });
  const job = remoteImageProvider.getJob(jobId);
  if (!job || job.status !== 'done') {
    return { ok: false, error: (job && job.error) || 'generation did not finish' };
  }
  const key = job.result && job.result.image_key;
  if (!key) return { ok: false, error: 'job finished without an image key' };

  // What POST /api/entity-types/:id/image does on Approve. 'static' is the
  // entity-side name for what tiles call 'image'.
  await pool.query(
    `UPDATE entity_types SET image = $1, sprite = NULL, render_mode = 'static',
      updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [key, entity.id],
  );
  return { ok: true, key };
}

async function generateEntityTextures(pool, args) {
  const provider = args.local ? null : await resolveProvider(pool, args.provider);
  if (provider && provider.enabled === false) {
    throw new Error(`AI provider '${provider.name}' is disabled`);
  }

  const r = await pool.query(
    `SELECT id, name, prompt, render_mode, is_creature FROM entity_types ORDER BY is_creature, name`,
  );
  let entities = args.only ? r.rows.filter((e) => args.only.includes(e.name)) : r.rows;
  // --objects-only is the cheap first pass: the props are what a player walks
  // past constantly, and there are eleven of them rather than 293.
  if (args.objectsOnly) entities = entities.filter((e) => !e.is_creature);
  if (args.creaturesOnly) entities = entities.filter((e) => e.is_creature);

  const stats = { pinned: 0, drawn: 0, skipped: 0, failed: 0, noPrompt: 0 };
  console.log(`${provider ? `provider: ${provider.name} (id ${provider.id})` : 'local sprite-gen'}`
    + `  entities: ${entities.length}${args.dryRun ? '  [DRY RUN]' : ''}`);

  for (const entity of entities) {
    if (args.pin && provider && !args.dryRun) {
      await pool.query(
        `UPDATE entity_types SET ai_provider_mode = 'provider', ai_provider_id = $1,
          updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [provider.id, entity.id],
      );
      stats.pinned += 1;
    }
    if (!entity.prompt || !entity.prompt.trim()) {
      console.log(`  ${entity.name}: SKIP (no prompt)`);
      stats.noPrompt += 1;
      continue;
    }
    if (entity.render_mode !== 'rect' && !args.force) {
      stats.skipped += 1;
      continue;
    }
    if (args.dryRun) {
      console.log(`  ${entity.name}: would draw`);
      stats.drawn += 1;
      continue;
    }

    const started = Date.now();
    let res;
    if (args.local) res = await generateLocally(pool, entity);
    else if (args.core) res = await generateViaCore(pool, provider, entity);
    else res = await generateOne(pool, provider, entity);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (res.ok) {
      console.log(`  ${entity.name}: ok (${secs}s)`);
      stats.drawn += 1;
    } else {
      console.log(`  ${entity.name}: FAILED ${res.error}`);
      stats.failed += 1;
    }
  }
  return stats;
}

module.exports = { generateEntityTextures, buildObjectPrompt, BACKDROP, generateLocally, generateViaCore };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  args.objectsOnly = argv.includes('--objects-only');
  args.local = argv.includes('--local');
  args.core = argv.includes('--core');
  args.creaturesOnly = argv.includes('--creatures-only');
  const pool = new Pool({ connectionString: url });
  generateEntityTextures(pool, args)
    .then((s) => {
      console.log(`pinned ${s.pinned}, drawn ${s.drawn}, skipped ${s.skipped} already drawn, `
        + `${s.noPrompt} without a prompt, ${s.failed} failed`);
      console.log('next: make entities-export && make entities-cutout && make entities-seed');
      if (s.failed) process.exitCode = 1;
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
