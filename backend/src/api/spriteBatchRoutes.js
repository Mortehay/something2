const crypto = require('node:crypto');
const express = require('express');
const queue = require('../services/spriteJobQueue.js');
const concepts = require('../services/spriteConcepts.js');
const { safeName } = require('../services/spriteDispatcher.js');
const { PROP_FX } = queue;
const { appearancePrompt } = require('../services/catalogSubjects.js');
const { staticFrameFor } = require('../services/spriteSheetManifest.js');
const { normalizeDirections, SPRITE_CELLS } = require('../services/spriteBatchOptions.js');
const defaultBoxCancels = require('../services/spriteBoxCancels.js');
const { replaceFrames, flaggedTargets } = require('../services/spriteFrameReplace.js');
const { spriteEngineOf, SHEET_METHODS } = require('../services/aiProviders.js');
const bodyPlans = require('../services/creatureBodyPlan.js');
const { SAMPLING_KEYS, samplingCatalog, generationMethods } = require('../services/spriteSampling.js');
const { ETA_MODEL, secondsPerCellFor, boxSeconds } = require('../services/spriteEta.js');

const CATALOG_TTL_MS = 60 * 1000;
const NO_PROVIDER_ERROR = 'no sprite provider configured — add one in Settings → AI Providers (modality Sprite)';

async function readJson(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// targets: [{entity_id, variant}], variant omitted/null for the entity's own
// sprite, 1-5 to target one of its character_appearances rows instead.
function targetsFrom(body) {
  const values = body && body.targets;
  if (!Array.isArray(values) || values.length === 0 || values.length > 1000) return null;
  // A null/primitive/array element or a blank/zero id is malformed, not an
  // unknown entity: Number(null) and Number('') are both 0.
  if (!values.every((t) => t && typeof t === 'object' && !Array.isArray(t))) return null;
  const targets = values.map((t) => ({
    entityId: Number(t.entity_id),
    variant: t.variant != null ? Number(t.variant) : null,
  }));
  const valid = targets.every((t) => Number.isInteger(t.entityId) && t.entityId > 0
    && (t.variant === null || (Number.isInteger(t.variant) && t.variant >= 1 && t.variant <= 5)));
  return valid ? targets : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The game mirrors the western facings from e / ne / se, so they are never drawn.
const WESTERN = new Set(['w', 'nw', 'sw']);

function jobIdsFrom(body) {
  const values = body && body.job_ids;
  if (!Array.isArray(values) || values.length === 0 || values.length > 1000) return null;
  const ids = values.map(String);
  return ids.every((id) => UUID_RE.test(id)) ? ids : null;
}

// Body shape only: [{action, direction, frame}], each field typed. Returns
// { frames } or { error } (naming the first bad entry where it can).
function redrawFramesFrom(body) {
  const values = body && body.frames;
  if (!Array.isArray(values) || values.length === 0 || values.length > 1000) {
    return { error: 'frames must list 1 to 1000 frames' };
  }
  const frames = [];
  for (const v of values) {
    if (!v || typeof v !== 'object' || Array.isArray(v)
        || typeof v.action !== 'string' || typeof v.direction !== 'string'
        || !Number.isInteger(v.frame) || v.frame < 0) {
      return { error: 'each frame needs a string action, a string direction and a non-negative integer frame' };
    }
    frames.push({ action: v.action, direction: v.direction, frame: v.frame });
  }
  return { frames };
}

// For a redraw row `j`: the sheet its Compare runs against and the frames it
// counts as marked. Failed ancestors (walking redraw_of) may have changed the
// box's sheet too, so they are skipped: the source is the newest ancestor that
// is done or approved, and the marked set is the union of this row's frames and
// every skipped failed ancestor's. Both NULL for a non-redraw row.
const REDRAW_LINEAGE_JOIN = `LEFT JOIN LATERAL (
               WITH RECURSIVE anc AS (
                 SELECT r.id, r.status, r.atlas_key, r.redraw_of, r.redraw_frames, 1 AS depth
                   FROM sprite_sets r WHERE r.id = j.redraw_of
                 UNION ALL
                 SELECT r.id, r.status, r.atlas_key, r.redraw_of, r.redraw_frames, anc.depth + 1
                   FROM anc JOIN sprite_sets r ON r.id = anc.redraw_of
                  WHERE anc.status = 'failed' AND anc.depth < 100
               )
               SELECT
                 (SELECT a.atlas_key FROM anc a WHERE a.status IN ('done', 'approved')
                   ORDER BY a.depth LIMIT 1) AS redraw_source_atlas_key,
                 (SELECT jsonb_agg(DISTINCT f.value)
                    FROM (SELECT j.redraw_frames AS fr
                          UNION ALL SELECT a.redraw_frames FROM anc a WHERE a.status = 'failed') x
                    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(x.fr, '[]'::jsonb)) f
                   WHERE j.redraw_of IS NOT NULL) AS redraw_compare_frames
             ) rl ON true`;

// deps is the DI seam: { box: {actionCatalog}, loadProvider: () => provider|null,
// store: {getObjectStream}, now: () => ms }. index.js passes the real ones.
function spriteBatchRoutes(pool, adminGuard, dispatcher, deps = {}) {
  const { box, loadProvider, store, now = Date.now, boxCancels = defaultBoxCancels } = deps;
  const router = express.Router();
  router.use(adminGuard);

  // Live action catalog from the GPU box, cached 60 s in-process. Only a good
  // answer is cached, so a 503 is retried on the very next request.
  let cached = null;
  async function getCatalog() {
    if (!box || !loadProvider) return { status: 503, error: NO_PROVIDER_ERROR };
    const provider = await loadProvider();
    if (!provider) return { status: 503, error: NO_PROVIDER_ERROR };
    const cacheKey = `${provider.id}|${provider.base_url}`;
    if (cached && cached.key === cacheKey && now() - cached.at < CATALOG_TTL_MS) return { catalog: cached.catalog };
    const r = await box.actionCatalog(provider);
    if (!r.ok) return { status: 503, error: `GPU box action catalog unavailable: ${r.error}` };
    cached = { key: cacheKey, at: now(), catalog: r.catalog };
    return { catalog: r.catalog };
  }

  // Cancels box jobs and records each one (SOMET-695) so GET /jobs can show
  // whether the box really stopped. items: [{boxJobId, spriteSetId?, subject?}].
  async function cancelBoxJobs(items, source) {
    const provider = await loadProvider();
    if (!provider) return;
    for (const item of items) {
      // eslint-disable-next-line no-await-in-loop
      const r = await boxCancels.request(pool, provider, { ...item, source }, { box, now });
      if (!r.ok) console.error(`sprite update: could not cancel box job ${item.boxJobId}: ${r.error}`);
    }
  }

  // Open cancels for the page. Verifying asks the box about each one, so it
  // runs in the background (never awaited by the request), one at a time per
  // process and at most every SPRITE_CANCEL_VERIFY_MS; the page gets the rows
  // as they stand now. A failure is logged and never reaches the caller.
  let lastVerifyAt = 0;
  let verifying = false;
  async function openBoxCancels() {
    const every = Number(process.env.SPRITE_CANCEL_VERIFY_MS) || 15000;
    if (!verifying && now() - lastVerifyAt >= every && box && typeof box.getSheetJob === 'function' && loadProvider) {
      lastVerifyAt = now();
      verifying = true;
      (async () => {
        const provider = await loadProvider();
        if (provider) await boxCancels.verify(pool, provider, { box, now });
      })()
        .catch((err) => console.error('sprite: verifying box cancels failed:', err.message))
        .finally(() => { verifying = false; });
    }
    try {
      return (await boxCancels.open(pool)).map(boxCancels.view);
    } catch (err) {
      console.error('sprite: reading box cancels failed:', err.message);
      return [];
    }
  }

  // Seconds per cell for an estimate: the median of recent QA-off sheets of the
  // same sampling (and connector) when there are enough, else the model rate.
  async function etaSecondsPerCell({ sampling = null, providerId = null, engine = null, steps = null }) {
    const id = Number.isInteger(Number(providerId)) && Number(providerId) > 0 ? Number(providerId) : null;
    const measured = await queue.calibratedSecondsPerCell(pool, { sampling, providerId: id, includeNullQa: engine === 'comfyui-hq' });
    return measured ?? secondsPerCellFor({ steps: steps ?? 4, sampling, engine });
  }

  // Wait already queued on the box plus a possible model switch, for the Sprite
  // tab's queue confirmation. Never an error: an unreachable box is
  // ahead_seconds null. Cached 15 s per provider, per router instance.
  const queueCache = new Map();
  function remainingSeconds(job) {
    const spec = job.spec || {};
    const c = secondsPerCellFor({ steps: spec.steps, engine: spec.engine });
    const pct = Math.min(100, Math.max(0, Number(job.progressPct) || 0));
    let total;
    if (Array.isArray(spec.frames)) total = spec.frames.length * c; // redraw job: no fixed overhead
    else {
      total = boxSeconds({
        actions: spec.actions, directions: spec.directions, frames: Number(spec.frames) || 0,
        secondsPerCell: c, qualityChecks: spec.quality_checks !== false,
      }).typical;
    }
    return Number.isFinite(total) ? total * (1 - pct / 100) : 0;
  }
  async function computeBoxQueue(provider) {
    const [jobs, gw] = await Promise.all([box.listActiveJobs(provider), box.gatewayStatus(provider)]);
    let hold = null;
    if (gw.ok && gw.hold) hold = String(gw.hold.label || gw.hold.owner || 'held');
    const sw = gw.ok && gw.activeModel && gw.activeModel !== 'qwen-image-edit' ? ETA_MODEL.gatewaySwitchMaxSeconds : 0;
    const ahead = jobs.ok ? Math.round(jobs.jobs.reduce((a, j) => a + remainingSeconds(j), 0)) : null;
    return { ahead_seconds: ahead, switch_seconds_max: sw, hold };
  }
  router.get('/box-queue', async (_req, res) => {
    const none = { ahead_seconds: null, switch_seconds_max: 0, hold: null };
    try {
      if (!box || !loadProvider || typeof box.listActiveJobs !== 'function') return res.json(none);
      const provider = await loadProvider();
      if (!provider) return res.json(none);
      const hit = queueCache.get(provider.id);
      if (hit && now() - hit.at < 15000) return res.json(hit.value);
      let value;
      try { value = await computeBoxQueue(provider); } catch (_e) { value = none; }
      queueCache.set(provider.id, { at: now(), value });
      return res.json(value);
    } catch (err) {
      console.error(err);
      return res.json(none);
    }
  });

  router.get('/action-catalog', async (_req, res) => {
    try {
      const got = await getCatalog();
      if (got.error) return res.status(got.status).json({ error: got.error });
      const c = got.catalog;
      const active = await loadProvider();
      const engine = spriteEngineOf(active);
      const methods = [];
      for (const m of generationMethods()) {
        // eslint-disable-next-line no-await-in-loop
        const rate = await etaSecondsPerCell({ sampling: m.sampling, providerId: active && active.id, engine, steps: m.steps });
        methods.push({ ...m, eta_seconds_per_cell: rate });
      }
      return res.json({
        actions: c.actions,
        directions: c.directions,
        max_frames: c.max_frames,
        engine: c.engine,
        seconds_per_cell: (methods.find((m) => m.id === 'fits_fast') || {}).eta_seconds_per_cell ?? secondsPerCellFor({ steps: 4, engine }),
        eta_model: ETA_MODEL,
        sampling_presets: samplingCatalog(),
        generation_methods: methods,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to read the sprite action catalog' });
    }
  });

  // HQ lane (SOMET-712): the enabled sprite connectors the Sprite tab can
  // choose per queue press, the active one first. Never returns secrets.
  router.get('/connectors', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, is_active, request_template FROM ai_providers
          WHERE enabled AND modality = 'sprite' ORDER BY is_active DESC, id`,
      );
      const out = [];
      for (const r of rows) {
        const engine = spriteEngineOf(r);
        // eslint-disable-next-line no-await-in-loop
        const rate = await etaSecondsPerCell({ providerId: r.id, engine });
        out.push({ id: r.id, name: r.name, engine, is_active: r.is_active === true, seconds_per_cell: rate });
      }
      res.json(out);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to list sprite connectors' });
    }
  });

  // Asks the text LLM for one chunk of creatures; the page sends the chunks one
  // at a time, so it can show progress and stop. Refused during a sprite batch:
  // the LLM takes the GPU card from the sheet being drawn. An admin's choice is kept.
  router.post('/body-plans/detect', async (req, res) => {
    try {
      const ids = Array.isArray(req.body.entity_ids) ? [...new Set(req.body.entity_ids)] : [];
      if (ids.length === 0 || ids.length > bodyPlans.CLASSIFY_CHUNK || !ids.every((id) => Number.isInteger(id) && id > 0)) {
        return res.status(400).json({ error: `entity_ids must be 1 to ${bodyPlans.CLASSIFY_CHUNK} ids` });
      }
      if ((dispatcher.status() || {}).running) {
        return res.status(409).json({ error: 'a sprite batch is running; detect bodies when it has finished' });
      }
      const { rows } = await pool.query(
        `SELECT id, name, prompt FROM entity_types
          WHERE id = ANY($1::int[]) AND is_creature AND NOT COALESCE(is_playable, false)
            AND body_plan_source IS DISTINCT FROM 'admin'`,
        [ids],
      );
      if (rows.length === 0) return res.json({ detected: {}, undecided: [] });
      const found = await (deps.classifyBodies || bodyPlans.classify)(pool, rows);
      const detected = {};
      for (const [id, plan] of found) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `UPDATE entity_types SET body_plan = $2, body_plan_source = 'llm'
            WHERE id = $1 AND body_plan_source IS DISTINCT FROM 'admin'`,
          [id, plan],
        );
        detected[id] = plan;
      }
      return res.json({ detected, undecided: rows.map((r) => r.id).filter((id) => !found.has(id)) });
    } catch (err) {
      if (err.busy) return res.status(503).json({ error: `the text LLM is busy: ${err.message}` });
      console.error(err);
      return res.status(500).json({ error: `Failed to detect creature bodies: ${err.message}` });
    }
  });

  // An admin's correction; null clears it so the LLM may decide again.
  router.post('/body-plans/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const plan = req.body.body_plan ?? null;
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });
      if (plan !== null && !bodyPlans.BODY_PLANS.includes(plan)) {
        return res.status(400).json({ error: `body_plan must be one of ${bodyPlans.BODY_PLANS.join(', ')}` });
      }
      const { rowCount } = await pool.query(
        `UPDATE entity_types SET body_plan = $2, body_plan_source = $3
          WHERE id = $1 AND is_creature AND NOT COALESCE(is_playable, false)`,
        [id, plan, plan === null ? null : 'admin'],
      );
      if (!rowCount) return res.status(404).json({ error: 'not a non-player creature' });
      return res.json({ id, body_plan: plan });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to save the creature body' });
    }
  });

  router.get('/subjects', async (_req, res) => {
    try {
      const [{ rows: entities }, { rows: appearances }] = await Promise.all([
        pool.query(
          `SELECT e.id, e.name, e.prompt, e.render_mode, e.is_creature, e.is_playable,
                  e.point_kind, e.image, e.sprite, e.body_plan, e.body_plan_source,
                  j.id AS job_id, j.status AS job_state, j.generation_kind, j.frames,
                  j.backend, j.last_error, j.image_key, j.atlas_key, j.manifest_key,
                  j.concept_key, j.actions, j.directions, j.cell, j.redraw_actions, j.sampling, j.sheet_method, j.real_western, j.frames_per_action, j.box_job_id, j.sheet_seconds, j.predicted_seconds,
                  CASE WHEN j.status = 'approved' AND j.prop_fx IS NOT NULL THEN e.idle_fx ELSE j.prop_fx END AS prop_fx,
                  j.updated_at AS job_updated_at, j.note,
                  kc.concept_key AS kept_concept_key, pj.request_template->>'engine' AS provider_engine,
                  j.redraw_of, j.redraw_frames, j.box_task_id,
                  rl.redraw_source_atlas_key, rl.redraw_compare_frames,
                  sh.id AS sheet_job_id, sh.atlas_key AS sheet_atlas_key,
                  sh.manifest_key AS sheet_manifest_key, sh.updated_at AS sheet_updated_at, sh.directions AS sheet_directions
             FROM entity_types e
             LEFT JOIN LATERAL (
               SELECT * FROM sprite_sets s
                WHERE s.entity_type_id = e.id AND s.appearance_variant IS NULL
                ORDER BY s.created_at DESC LIMIT 1
             ) j ON true
             ${REDRAW_LINEAGE_JOIN}
             LEFT JOIN sprite_concepts kc ON kc.entity_type_id = e.id AND kc.appearance_variant IS NULL
             LEFT JOIN ai_providers pj ON pj.id = COALESCE(j.chosen_provider_id, j.provider_id)
             LEFT JOIN LATERAL (
               SELECT s2.id, s2.atlas_key, s2.manifest_key, s2.updated_at, s2.directions FROM sprite_sets s2
                WHERE s2.entity_type_id = e.id AND s2.appearance_variant IS NULL AND s2.atlas_key IS NOT NULL
                ORDER BY s2.created_at DESC LIMIT 1
             ) sh ON true
            ORDER BY e.name`,
        ),
        // Each playable class's 5 appearance variants, alongside the class's
        // own row above -- a variant with no sprite of its own still renders
        // (character_appearances.sprite falls back to the class's), so this
        // batch is for giving a variant its OWN directional sheet, not a
        // prerequisite for it to appear in-game at all.
        pool.query(
          `SELECT ca.entity_type_id, ca.variant, ca.render_mode, ca.sprite, ca.image,
                  e.name AS class_name, e.prompt AS class_prompt,
                  j.id AS job_id, j.status AS job_state, j.generation_kind, j.frames,
                  j.backend, j.last_error, j.image_key, j.atlas_key, j.manifest_key,
                  j.concept_key, j.actions, j.directions, j.cell, j.redraw_actions, j.sampling, j.sheet_method, j.real_western, j.frames_per_action, j.box_job_id, j.sheet_seconds, j.predicted_seconds,
                  j.prop_fx, j.updated_at AS job_updated_at, j.note,
                  kc.concept_key AS kept_concept_key, pj.request_template->>'engine' AS provider_engine,
                  j.redraw_of, j.redraw_frames, j.box_task_id,
                  rl.redraw_source_atlas_key, rl.redraw_compare_frames,
                  sh.id AS sheet_job_id, sh.atlas_key AS sheet_atlas_key,
                  sh.manifest_key AS sheet_manifest_key, sh.updated_at AS sheet_updated_at, sh.directions AS sheet_directions
             FROM character_appearances ca
             JOIN entity_types e ON e.id = ca.entity_type_id AND e.is_playable = true
             LEFT JOIN LATERAL (
               SELECT * FROM sprite_sets s
                WHERE s.entity_type_id = ca.entity_type_id AND s.appearance_variant = ca.variant
                ORDER BY s.created_at DESC LIMIT 1
             ) j ON true
             ${REDRAW_LINEAGE_JOIN}
             LEFT JOIN sprite_concepts kc ON kc.entity_type_id = ca.entity_type_id AND kc.appearance_variant = ca.variant
             LEFT JOIN ai_providers pj ON pj.id = COALESCE(j.chosen_provider_id, j.provider_id)
             LEFT JOIN LATERAL (
               SELECT s2.id, s2.atlas_key, s2.manifest_key, s2.updated_at, s2.directions FROM sprite_sets s2
                WHERE s2.entity_type_id = ca.entity_type_id AND s2.appearance_variant = ca.variant
                  AND s2.atlas_key IS NOT NULL
                ORDER BY s2.created_at DESC LIMIT 1
             ) sh ON true
            ORDER BY e.name, ca.variant`,
        ),
      ]);
      const variantsByClass = new Map();
      for (const a of appearances) {
        if (!variantsByClass.has(a.entity_type_id)) variantsByClass.set(a.entity_type_id, []);
        variantsByClass.get(a.entity_type_id).push({
          id: `${a.entity_type_id}:${a.variant}`,
          entity_id: a.entity_type_id,
          variant: a.variant,
          name: `${a.class_name} — Appearance ${a.variant}`,
          // What the job will actually be generated from (optionsForAppearance),
          // not the class's own prompt.
          prompt: appearancePrompt(a),
          render_mode: a.render_mode,
          is_creature: false,
          is_playable: true,
          point_kind: null,
          // The appearance's own art, shown on the page as what this hero
          // looks like. Kept out of `image`: a portrait is not a sprite sheet,
          // so the row stays "missing visual" until it gets one.
          image: null,
          appearance_image: a.image || null,
          sprite: a.sprite,
          job_id: a.job_id,
          job_state: a.job_state,
          generation_kind: a.generation_kind,
          frames: a.frames,
          backend: a.backend,
          last_error: a.last_error,
          image_key: a.image_key,
          atlas_key: a.atlas_key,
          manifest_key: a.manifest_key,
          concept_key: a.concept_key,
          actions: a.actions,
          directions: a.directions,
          cell: a.cell || null,
          redraw_actions: a.redraw_actions === true,
          sampling: a.sampling || null,
          sheet_method: a.sheet_method || null,
          // SOMET-712: the engine of the connector that drew (or will draw) the row.
          provider_engine: a.provider_engine || null,
          real_western: a.real_western,
          frames_per_action: a.frames_per_action,
          box_job_id: a.box_job_id,
          prop_fx: a.prop_fx,
          job_updated_at: a.job_updated_at,
          note: a.note,
          kept_concept_key: a.kept_concept_key,
          redraw_of: a.redraw_of,
          redraw_frames: a.redraw_frames,
          redraw_source_atlas_key: a.redraw_source_atlas_key,
          redraw_compare_frames: a.redraw_compare_frames,
          sheet_seconds: a.sheet_seconds,
          predicted_seconds: a.predicted_seconds,
          box_task_id: a.box_task_id,
          sheet_job_id: a.sheet_job_id,
          sheet_atlas_key: a.sheet_atlas_key,
          sheet_manifest_key: a.sheet_manifest_key,
          sheet_updated_at: a.sheet_updated_at,
          sheet_directions: a.sheet_directions,
        });
      }
      // The console renders this list in order, so each class's variants go
      // directly under the class's own row (both queries are name-ordered).
      const subjects = entities.flatMap((e) => [
        { ...e, variant: null },
        ...(variantsByClass.get(e.id) || []),
      ]);
      res.json({ subjects });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to list sprite subjects' });
    }
  });

  router.get('/jobs', async (_req, res) => {
    try {
      res.json({ ...(await queue.queueView(pool)), run: dispatcher.status(), box_cancels: await openBoxCancels() });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to read the sprite queue' });
    }
  });

  // Shared by POST /jobs and POST /jobs/force: the body proven against the
  // request shape and the box's live catalog. { error, status } or { targets, options }.
  async function queueRequestFrom(body) {
    const targets = targetsFrom(body);
    if (!targets) return { status: 400, error: 'targets must contain 1 to 1000 {entity_id, variant?} pairs' };
    const actions = Array.isArray(body.actions) ? [...new Set(body.actions)] : [];
    if (actions.length === 0 || !actions.every((a) => typeof a === 'string' && a)) {
      return { status: 400, error: 'actions must be a non-empty list of action ids' };
    }
    // Props v2: a prop's in-game idle effect (copied to entity_types.idle_fx
    // on approve). Omitted lets enqueue decide per prop (SOMET-677); anything
    // sent, null included, must be a known one.
    const propFx = body.prop_fx;
    if ('prop_fx' in body && !PROP_FX.includes(propFx)) {
      return { status: 400, error: `prop_fx must be one of ${PROP_FX.join(', ')}` };
    }
    // Optional facings; omitted keeps the per-kind default.
    let directions;
    if (body.directions !== undefined) {
      directions = normalizeDirections(body.directions);
      if (!directions) {
        return { status: 400, error: 'directions must be a non-empty list of: s, se, e, ne, n, nw, w, sw' };
      }
    }
    // Optional cell size (SOMET-706); omitted keeps today's 48x64.
    let cell;
    if (body.cell !== undefined && body.cell !== null) {
      if (!SPRITE_CELLS.includes(body.cell)) return { status: 400, error: `cell must be one of ${SPRITE_CELLS.join(', ')}` };
      cell = body.cell;
    }
    // Optional "Redraw selected actions" (SOMET-711); omitted is false.
    if (body.redraw_actions !== undefined && typeof body.redraw_actions !== 'boolean') {
      return { status: 400, error: 'redraw_actions must be true or false' };
    }
    const redrawActions = body.redraw_actions === true;
    // HQ lane (SOMET-712): optional connector for this press; must be an
    // enabled sprite connector. Omitted = the active connector at draw time.
    let providerId = null;
    if (body.provider_id !== undefined && body.provider_id !== null) {
      const ok = Number.isInteger(body.provider_id) && body.provider_id > 0
        && (await pool.query(
          "SELECT id FROM ai_providers WHERE id = $1 AND enabled AND modality = 'sprite'", [body.provider_id],
        )).rows.length > 0;
      if (!ok) return { status: 400, error: 'provider_id must be an enabled sprite connector' };
      providerId = body.provider_id;
    }
    // Optional sampling preset (spriteSampling.js); omitted/null = box default.
    let sampling = null;
    if (body.sampling !== undefined && body.sampling !== null) {
      if (!SAMPLING_KEYS.includes(body.sampling)) return { status: 400, error: `sampling must be one of ${SAMPLING_KEYS.join(', ')}` };
      sampling = body.sampling;
    }
    // Optional per-row method; omitted/null = whatever the connector is set to.
    let sheetMethod = null;
    if (body.sheet_method !== undefined && body.sheet_method !== null) {
      if (!SHEET_METHODS.includes(body.sheet_method)) return { status: 400, error: `sheet_method must be one of ${SHEET_METHODS.join(', ')}` };
      // The turnaround replaces idle frames, so without idle there is nothing for it to do.
      if (body.sheet_method === 'turnaround3d' && !actions.includes('idle')) return { status: 400, error: 'the 3D turnaround needs the idle action' };
      sheetMethod = body.sheet_method;
    }
    // Optional box quality checks (the redraw loop); omitted is off.
    if (body.quality_checks !== undefined && typeof body.quality_checks !== 'boolean') {
      return { status: 400, error: 'quality_checks must be true or false' };
    }
    const qualityChecks = body.quality_checks === true;
    // A creature the box has no poses for is not queued, rather than drawn wrong.
    const entityIds = targets.filter((t) => t.variant === null).map((t) => t.entityId);
    if (entityIds.length) {
      const { rows: bodies } = await pool.query('SELECT id, name, body_plan FROM entity_types WHERE id = ANY($1::int[])', [entityIds]);
      const others = bodies.filter((b) => b.body_plan === 'other').map((b) => b.name);
      if (others.length) {
        return { status: 400, error: `no poses for these bodies yet, untick them or correct their Body: ${others.join(', ')}` };
      }
    }
    // enqueue comma-joins the ids into the row, so every one must be proven
    // against the box's live catalog here, not trusted from the client.
    const got = await getCatalog();
    if (got.error) return { status: got.status, error: got.error };
    const known = new Map(got.catalog.actions.map((a) => [a.id, a]));
    const unknownAction = actions.find((a) => !known.has(a));
    if (unknownAction !== undefined) {
      return { status: 400, error: `unknown action "${unknownAction}" — not in the GPU box catalog` };
    }
    // An action with no finite max_frames falls back to the catalog's own.
    const limits = actions.map((a) => {
      const own = known.get(a).max_frames;
      return Number.isFinite(own) ? own : got.catalog.max_frames;
    });
    if (!limits.every(Number.isFinite)) return { status: 400, error: 'catalog has no frame limit' };
    const cap = Math.min(...limits);
    const frames = body.frames;
    if (!Number.isInteger(frames) || frames < 1 || frames > cap) {
      return { status: 400, error: `frames must be an integer from 1 to ${cap} (the most the selected actions allow)` };
    }
    return { targets, options: { actions, framesPerAction: frames, propFx, directions, cell, redrawActions, providerId, sampling, sheetMethod, qualityChecks } };
  }

  // ETA: the typical box seconds of every creature row this press queued or
  // re-queued (enqueue clears the figure on a re-queue). NULL quality_checks
  // (HQ / legacy) is the box default, QA on. Props get none.
  async function hqProviderIdsOf() {
    const { rows } = await pool.query("SELECT id, request_template FROM ai_providers WHERE modality = 'sprite'");
    return new Set(rows.filter((p) => spriteEngineOf(p) === 'comfyui-hq').map((p) => Number(p.id)));
  }

  // enqueue options plus whether a row with no chosen connector will be drawn by
  // an HQ active connector (its quality_checks is then NULL, like a chosen HQ one).
  async function enqueueOptions(options, hqProviderIds) {
    let defaultProviderIsHq = false;
    if (options.providerId == null) {
      const active = await loadProvider();
      defaultProviderIsHq = Boolean(active) && hqProviderIds.has(Number(active.id));
    }
    return { ...options, hqProviderIds, defaultProviderIsHq };
  }

  async function predictRows(rows, hqProviderIds) {
    const creatures = rows.filter((r) => r.generation_kind === 'creature' && Array.isArray(r.actions));
    if (creatures.length === 0) return;
    const active = await loadProvider();
    const rates = new Map();
    const out = [];
    for (const r of creatures) {
      const pid = r.chosen_provider_id ?? (active ? active.id : null);
      const engine = pid != null && hqProviderIds.has(Number(pid)) ? 'comfyui-hq' : (r.chosen_provider_id == null ? spriteEngineOf(active) : 'diffusers');
      const key = `${r.sampling ?? ''}|${pid}|${engine}`;
      if (!rates.has(key)) {
        // eslint-disable-next-line no-await-in-loop
        rates.set(key, await etaSecondsPerCell({ sampling: r.sampling ?? null, providerId: pid, engine }));
      }
      const { typical } = boxSeconds({
        actions: r.actions, directions: r.directions, frames: r.frames_per_action,
        secondsPerCell: rates.get(key), qualityChecks: r.quality_checks !== false,
      });
      out.push({ id: r.id, seconds: typical });
    }
    await queue.setPredicted(pool, out);
  }

  router.post('/jobs', async (req, res) => {
    try {
      const parsed = await queueRequestFrom(req.body);
      if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
      const { targets, options } = parsed;
      const hqProviderIds = await hqProviderIdsOf();
      const result = await queue.enqueue(pool, targets, await enqueueOptions(options, hqProviderIds));
      // Box jobs detached by an options change would otherwise keep the GPU
      // busy drawing a sheet nothing will collect. Best effort, not awaited.
      const dropped = result.updated.filter((r) => r.dropped_box_job_id)
        .map((r) => ({ boxJobId: r.dropped_box_job_id, spriteSetId: r.id, subject: r.creature || null }));
      if (dropped.length && box && typeof box.cancelSheetJob === 'function') {
        cancelBoxJobs(dropped, 'options-changed').catch((err) => console.error('sprite update: cancelling detached box jobs failed:', err));
      }
      // Best effort, like the force path: the queue is already committed.
      await predictRows([...result.rows, ...result.updated], hqProviderIds)
        .catch((err) => console.error('sprite: storing the time estimate failed:', err.message));
      const selected = new Set(targets.map((t) => `${t.entityId}:${t.variant ?? ''}`)).size;
      res.status(201).json({
        selected,
        queued: result.rows.length,
        // Already-queued targets re-take this request's options in place;
        // skipped is what is left: a job the box is running right now.
        updated: result.updated.length,
        skipped: selected - result.rows.length - result.updated.length - result.unknown.length,
        unknown: result.unknown,
        stats: await queue.stats(pool),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to queue sprite jobs' });
    }
  });

  // Stored files of deleted rows, AFTER the commit and only per row-id folder
  // (never a shorter prefix). Kept concepts and keys a live sprite shows stay.
  async function removeStoredFiles(rows) {
    // Folders are sprites/<name>/<row id>/ -- a key whose directory is not
    // exactly that is never trusted as a prefix.
    const folders = new Set();
    for (const row of rows) {
      const tail = `/${row.id}/`;
      let found = false;
      for (const k of [row.atlas_key, row.manifest_key, row.image_key, row.concept_key]) {
        if (typeof k !== 'string') continue;
        const dir = k.slice(0, k.lastIndexOf('/') + 1);
        if (dir.endsWith(tail)) { folders.add(dir); found = true; }
      }
      if (!found) folders.add(`${store.BUCKET()}/${safeName(row.creature)}/${row.id}/`);
    }
    let filesDeleted = 0;
    const failed = [];
    if (folders.size) {
      let protectedKeys = null;
      try {
        const { rows } = await pool.query(
          `SELECT concept_key AS k FROM sprite_concepts
           UNION SELECT image FROM entity_types WHERE image IS NOT NULL
           UNION SELECT image FROM character_appearances WHERE image IS NOT NULL
           UNION SELECT sprite->>'atlas_key' FROM entity_types WHERE sprite->>'atlas_key' IS NOT NULL
           UNION SELECT sprite->>'manifest_key' FROM entity_types WHERE sprite->>'manifest_key' IS NOT NULL
           UNION SELECT sprite->>'atlas_key' FROM character_appearances WHERE sprite->>'atlas_key' IS NOT NULL
           UNION SELECT sprite->>'manifest_key' FROM character_appearances WHERE sprite->>'manifest_key' IS NOT NULL`,
        );
        protectedKeys = new Set(rows.map((r) => r.k));
      } catch (err) {
        console.error('sprite delete: could not read protected keys; leaving files', err);
        failed.push(...folders);
      }
      if (protectedKeys) {
        for (const prefix of folders) {
          let keys;
          try {
            // eslint-disable-next-line no-await-in-loop
            keys = await store.listObjectKeys(prefix);
          } catch (err) {
            console.error(`sprite delete: could not list ${prefix}`, err);
            failed.push(prefix);
            continue;
          }
          for (const key of keys) {
            if (protectedKeys.has(key) || !key.startsWith(prefix)) continue;
            try {
              // eslint-disable-next-line no-await-in-loop
              await store.removeObject(key);
              filesDeleted += 1;
            } catch (err) {
              console.error(`sprite delete: could not remove ${key}`, err);
              failed.push(key);
            }
          }
        }
      }
    }
    return { filesDeleted, failed };
  }

  router.post('/jobs/dispatch', async (_req, res) => {
    try {
      const draining = dispatcher.start();
      draining.catch((err) => console.error('sprite dispatcher stopped:', err));
      res.status(202).json({ run: dispatcher.status(), box_cancels: await openBoxCancels() });
    } catch (err) {
      if (err.code === 'ALREADY_RUNNING') return res.status(409).json({ error: err.message });
      console.error(err);
      return res.status(500).json({ error: 'Failed to start the sprite batch' });
    }
  });

  // Queue a redraw of chosen frames of a finished GPU-box creature sheet.
  router.post('/jobs/redraw', async (req, res) => {
    const jobId = req.body && req.body.job_id;
    if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) {
      return res.status(400).json({ error: 'job_id must be a UUID' });
    }
    const parsed = redrawFramesFrom(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const label = (f) => `${f.action}/${f.direction}/${f.frame}`;
    try {
      const { rows: [source] } = await pool.query('SELECT * FROM sprite_sets WHERE id = $1', [jobId]);
      if (!source) return res.status(404).json({ error: 'sprite job not found' });
      const sheetStatus = source.status === 'done' || source.status === 'approved'
        || (source.status === 'failed' && source.redraw_of != null && source.atlas_key);
      if (source.entity_type_id == null || source.backend !== 'gpu-box' || source.generation_kind !== 'creature'
          || !source.atlas_key || !source.manifest_key || !source.box_job_id || !sheetStatus) {
        return res.status(409).json({ error: 'only a finished GPU-box creature sheet can have frames redrawn' });
      }
      const { rows: newer } = await pool.query(
        `SELECT 1 FROM sprite_sets
          WHERE entity_type_id = $1
            AND COALESCE(appearance_variant, 0) = COALESCE($2::int, 0)
            AND id <> $3 AND atlas_key IS NOT NULL AND created_at > $4
          LIMIT 1`,
        [source.entity_type_id, source.appearance_variant, source.id, source.created_at],
      );
      if (newer.length) {
        return res.status(409).json({ error: 'a newer sheet exists for this subject; reopen it and redraw from that one' });
      }
      let manifest;
      try {
        manifest = await readJson(await store.getObjectStream(source.manifest_key));
      } catch (err) {
        console.error(`sprite redraw: cannot read ${source.manifest_key}:`, err.message);
        return res.status(500).json({ error: `Could not read the sheet manifest: ${err.message}` });
      }
      // SOMET-702: a merged sheet's box job holds only the rows that run drew,
      // so a box redraw would come back as a partial sheet.
      if (manifest && manifest.reused_from) {
        return res.status(409).json({ error: 'this sheet was merged from an earlier sheet — use "Use good frames" or Force regenerate instead of a frame redraw' });
      }
      // Western rows are mirrored in game unless the manifest lists them as drawn
      // as-is (SOMET-705: not real_western, the box always mirrors). Same rule as
      // the UI's isMarkable.
      const asIs = (manifest && manifest.unmirrored) || {};
      const west = parsed.frames.find((f) => WESTERN.has(f.direction)
        && !(Array.isArray(asIs[f.action]) && asIs[f.action].includes(f.direction)));
      if (west) {
        return res.status(400).json({ error: `${label(west)}: western directions are mirrored in game and cannot be redrawn` });
      }
      const mRows = Array.isArray(manifest && manifest.rows) ? manifest.rows : [];
      const perAction = Number(manifest && manifest.frames_per_action);
      const known = manifest && manifest.frames && typeof manifest.frames === 'object' ? manifest.frames : {};
      if (parsed.frames.length > mRows.length * perAction) {
        return res.status(400).json({ error: 'more frames than the sheet has cells' });
      }
      const order = new Map(mRows.map((r, i) => [`${r.action}/${r.direction}`, i]));
      const seen = new Set();
      for (const f of parsed.frames) {
        const key = label(f);
        if (!order.has(`${f.action}/${f.direction}`) || !(f.frame < perAction) || !(key in known)) {
          return res.status(400).json({ error: `${key}: not a frame of this sheet` });
        }
        if (seen.has(key)) return res.status(400).json({ error: `${key}: listed twice` });
        seen.add(key);
      }
      const frames = [...parsed.frames].sort((a, b) => (order.get(`${a.action}/${a.direction}`)
        - order.get(`${b.action}/${b.direction}`)) || (a.frame - b.frame));
      const created = await queue.createRedraw(pool, source, frames);
      if (!created) return res.status(409).json({ error: 'this subject already has a queued or running sprite job' });
      let started = false;
      if (!dispatcher.status()?.running) {
        try {
          dispatcher.start().catch((err) => console.error('sprite dispatcher stopped:', err));
          started = true;
        } catch (err) {
          if (err.code !== 'ALREADY_RUNNING') console.error('sprite redraw: could not start the dispatcher:', err);
        }
      }
      return res.status(201).json({ id: created.id, started });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to queue the frame redraw' });
    }
  });

  router.delete('/jobs/:id/redraw', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'redraw not found' });
    try {
      const result = await queue.discardRedraw(pool, req.params.id);
      if (result === 'deleted') return res.json({ deleted: true });
      if (result === 'not_found') return res.status(404).json({ error: 'redraw not found' });
      return res.status(409).json({ error: 'a redraw the box already worked on cannot be discarded' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to discard the redraw' });
    }
  });

  router.post('/jobs/stop', (_req, res) => {
    res.json({ stopping: dispatcher.stop(), run: dispatcher.status() });
  });

  // Stop plus cancel the sheet in progress; that row goes back to the queue.
  router.post('/jobs/halt', (_req, res) => {
    res.json({ halting: dispatcher.halt(), run: dispatcher.status() });
  });

  router.post('/jobs/requeue-stale', async (req, res) => {
    try {
      const fallback = dispatcher.status()?.running ? 60 * 60 * 1000 : 60 * 1000;
      const olderThanMs = Math.max(Number(req.body?.older_than_ms) || fallback, 60 * 1000);
      const rows = await queue.requeueStale(pool, olderThanMs);
      res.json({ requeued: rows.length, stats: await queue.stats(pool) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to rescue sprite jobs' });
    }
  });

  // Retry a cancel the box ignored (or that failed to send).
  router.post('/jobs/box-cancels/:id/retry', async (req, res) => {
    try {
      if (!/^\d{1,15}$/.test(req.params.id)) return res.status(404).json({ error: 'no such open box cancel' });
      const row = await boxCancels.getOpen(pool, req.params.id);
      if (!row) return res.status(404).json({ error: 'no such open box cancel' });
      const provider = loadProvider ? await loadProvider() : null;
      if (!provider) return res.status(503).json({ error: NO_PROVIDER_ERROR });
      const sent = await boxCancels.request(pool, provider, {
        boxJobId: row.box_job_id, spriteSetId: row.sprite_set_id, subject: row.subject, source: 'retry',
      }, { box, now });
      if (!sent.ok) return res.status(502).json({ error: sent.error });
      const fresh = await boxCancels.getOpen(pool, req.params.id);
      return res.json({ box_cancel: boxCancels.view(fresh || row) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to retry the box cancel' });
    }
  });

  router.post('/jobs/clear', async (_req, res) => {
    if (dispatcher.status()?.running) {
      return res.status(409).json({ error: 'stop the sprite batch before clearing queued jobs' });
    }
    try {
      const { rows } = await pool.query(
        "DELETE FROM sprite_sets WHERE entity_type_id IS NOT NULL AND status IN ('queued','running') RETURNING id, creature, box_job_id",
      );
      // The cleared rows' box jobs would otherwise keep drawing for nothing.
      const items = rows.filter((r) => r.box_job_id)
        .map((r) => ({ boxJobId: r.box_job_id, spriteSetId: r.id, subject: r.creature || null }));
      if (items.length && box && typeof box.cancelSheetJob === 'function') {
        // Up to 1000 sequential DELETEs: after responding, like delete-generated.
        Promise.resolve().then(() => cancelBoxJobs(items, 'clear'))
          .catch((err) => console.error('sprite clear: box cancel failed', err));
      }
      res.json({ cleared: rows.length, stats: await queue.stats(pool) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to clear sprite jobs' });
    }
  });

  // Deletes every sprite_sets row of the targeted subjects (running ones are
  // skipped) and then their stored files. Files go AFTER the commit and only
  // per row-id folder, never a shorter prefix (sprites/Cultist_1/ would also
  // match sprites/Cultist_10/); kept concepts and keys an entity or appearance
  // still shows (image, or a live sprite's atlas/manifest) are never removed.
  router.post('/jobs/delete-generated', async (req, res) => {
    const targets = targetsFrom(req.body);
    if (!targets) return res.status(400).json({ error: 'targets must list 1 to 1000 subjects' });
    let out;
    let client;
    try {
      client = await pool.connect();
      try {
        await client.query('BEGIN');
        out = await queue.deleteGeneratedRows(client, targets);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to delete generated sprites' });
    } finally {
      if (client) client.release();
    }
    if (out.cancel_box_job_ids.length) {
      const subjectOf = new Map(out.rows.map((r) => [r.box_job_id, r.creature]));
      const items = out.cancel_box_job_ids.map((id) => ({ boxJobId: id, subject: subjectOf.get(id) || null }));
      Promise.resolve().then(() => cancelBoxJobs(items, 'delete-generated'))
        .catch((err) => console.error('sprite delete: box cancel failed', err));
    }

    const { filesDeleted, failed } = await removeStoredFiles(out.rows);
    res.json({
      deleted_jobs: out.rows.length,
      subjects: out.subjects,
      skipped_running: out.skipped_running,
      files_deleted: filesDeleted,
      files_failed: failed.slice(0, 50),
    });
  });

  // Force regenerate (SOMET-698): per subject, in one transaction, drop its live
  // set, its unapproved sheets (redraws included) and its kept concept, then
  // queue a fresh set. Approved sets stay live until the new set is approved.
  // A subject whose concept is still being drawn (the box can't cancel a concept
  // task) is refused untouched. One the dispatcher is drawing in the sheet stage
  // is detached from it, replaced, and its box job cancelled; the batch goes on.
  router.post('/jobs/force', async (req, res) => {
    let parsed;
    try {
      parsed = await queueRequestFrom(req.body);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to force-regenerate sprite jobs' });
    }
    if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
    // Force deletes every set and the kept concept, so there is nothing to
    // redraw against: the SOMET-711 flag would only mislead on the new row.
    const options = { ...parsed.options, redrawActions: false };
    let hqProviderIds;
    let enqueueOpts;
    try {
      hqProviderIds = await hqProviderIdsOf();
      enqueueOpts = await enqueueOptions(options, hqProviderIds);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to force-regenerate sprite jobs' });
    }
    const seen = new Map();
    for (const t of parsed.targets) seen.set(`${t.entityId}:${t.variant ?? ''}`, t);
    const refused = [];
    const deletedRows = [];
    const cancels = [];
    let queued = 0;
    const refuse = (t, reason) => refused.push({ entity_id: t.entityId, variant: t.variant, reason });
    try {
      for (const t of seen.values()) {
        let client;
        let committed = false;
        let pendingCancel = null; // only counted once this target's COMMIT succeeded
        let detach = null; // the dispatcher's poller waits until this is settled
        try {
          // eslint-disable-next-line no-await-in-loop
          client = await pool.connect();
          // eslint-disable-next-line no-await-in-loop
          await client.query('BEGIN');
          const where = 'entity_type_id = $1 AND COALESCE(appearance_variant, 0) = COALESCE($2::smallint, 0)';
          // Locked first, so a dispatcher claim() cannot slip in between the
          // checks below and the delete.
          // eslint-disable-next-line no-await-in-loop
          await client.query(`SELECT id FROM sprite_sets WHERE ${where} FOR UPDATE`, [t.entityId, t.variant]);
          // eslint-disable-next-line no-await-in-loop
          const { rows: [live] } = await client.query(
            // Locked again: the lock above misses a row a peer's force committed
            // while this one waited, and claim() must not take that row now.
            `SELECT * FROM sprite_sets WHERE ${where} AND status IN ('queued','running') AND redraw_of IS NULL FOR UPDATE`,
            [t.entityId, t.variant],
          );
          let reason = null;
          if (live && live.status === 'running') {
            const cur = (dispatcher.status() || {}).current;
            // No dispatcher running means nothing is drawing this row: it is an
            // orphan from a restart, not a concept/claim in flight.
            if (!dispatcher.status()?.running) reason = 'this subject\'s job was interrupted — press "Rescue stranded" first';
            // A sheet row never records its concept task (box_task_id is the
            // redraw's), so only the dispatcher knows the concept stage. A rescued
            // row keeps a dead box_job_id through it, so that column says nothing.
            else if (cur && cur.id === live.id) {
              if (cur.phase === 'concept') reason = 'concept is still being drawn, try again in a minute';
              else {
                detach = dispatcher.detachCurrent(live.id);
                if (!detach) reason = 'the batch is finishing this subject\'s sheet — try again in a minute';
              }
            } else if (!live.box_job_id) reason = 'the batch just picked this subject up — try again in a minute';
          }
          if (reason) {
            // eslint-disable-next-line no-await-in-loop
            await client.query('ROLLBACK');
            refuse(t, reason);
            continue;
          }
          // A running row the delete would skip (a redraw child): refuse whole.
          // eslint-disable-next-line no-await-in-loop
          const { rows: busy } = await client.query(
            `SELECT 1 FROM sprite_sets WHERE ${where} AND status = 'running' AND id IS DISTINCT FROM $3::uuid LIMIT 1`,
            [t.entityId, t.variant, live ? live.id : null],
          );
          if (busy[0]) {
            // eslint-disable-next-line no-await-in-loop
            await client.query('ROLLBACK');
            refuse(t, 'a redraw of this subject is running — wait for it or halt the batch');
            continue;
          }
          const gone = [];
          if (live) {
            // eslint-disable-next-line no-await-in-loop
            await client.query('DELETE FROM sprite_sets WHERE id = $1', [live.id]);
            gone.push(live);
            if (live.box_job_id) pendingCancel = { boxJobId: live.box_job_id, spriteSetId: live.id, subject: live.creature || null };
          }
          // eslint-disable-next-line no-await-in-loop
          const out = await queue.deleteGeneratedRows(client, [t], { keepApproved: true });
          gone.push(...out.rows);
          // eslint-disable-next-line no-await-in-loop
          await concepts.clearKept(client, [t]);
          // A random salt: the fresh set must differ from every set deleted so far.
          // eslint-disable-next-line no-await-in-loop
          const result = await queue.enqueue(client, [t], { ...enqueueOpts, seedSalt: crypto.randomInt(2 ** 31) });
          if (result.rows.length === 0) {
            // eslint-disable-next-line no-await-in-loop
            await client.query('ROLLBACK');
            refuse(t, result.unknown.length ? 'no such subject' : 'could not queue a new set');
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          await client.query('COMMIT');
          committed = true;
          // eslint-disable-next-line no-await-in-loop
          await predictRows(result.rows, hqProviderIds).catch((err) => console.error('sprite: storing the time estimate failed:', err.message));
          if (pendingCancel) cancels.push(pendingCancel);
          queued += result.rows.length;
          deletedRows.push(...gone);
        } catch (err) {
          // One subject failing must not hide the ones already committed: roll
          // this one back, say so, and carry on (their cancels/files still run).
          if (client && !committed) await client.query('ROLLBACK').catch(() => {});
          console.error('sprite force: target failed', err);
          refuse(t, `failed: ${err.message}`);
        } finally {
          if (detach) {
            if (committed) detach.confirm();
            else detach.keep();
          }
          if (client) client.release();
        }
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to force-regenerate sprite jobs' });
    }
    if (cancels.length) {
      Promise.resolve().then(() => cancelBoxJobs(cancels, 'force'))
        .catch((err) => console.error('sprite force: box cancel failed', err));
    }
    if (deletedRows.length && store) {
      Promise.resolve().then(() => removeStoredFiles(deletedRows))
        .catch((err) => console.error('sprite force: removing files failed', err));
    }
    try {
      return res.status(201).json({ selected: seen.size, queued, refused, stats: await queue.stats(pool) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to read the sprite queue' });
    }
  });

  // Use good frames (SOMET-701): overwrite flagged frames of a finished sheet
  // with the nearest good frame of the same row, in place at the same keys.
  router.post('/jobs/:id/use-good-frames', async (req, res) => {
    const id = req.params.id;
    let wanted = null;
    if (req.body && req.body.frames !== undefined) {
      const parsed = redrawFramesFrom(req.body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      wanted = parsed.frames;
    }
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'sprite job not found' });
    let client;
    let phase = 'read';
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Locked, then re-checked: an approve or a redraw claim cannot slip in
      // between the status check and the writes below.
      const { rows: [row] } = await client.query('SELECT * FROM sprite_sets WHERE id = $1 FOR UPDATE', [id]);
      const refuse = async (status, error) => { await client.query('ROLLBACK'); return res.status(status).json({ error }); };
      if (!row) return await refuse(404, 'sprite job not found');
      if (row.status === 'approved') return await refuse(409, 'approved art is live — force regenerate instead');
      if (row.status !== 'done' || row.backend !== 'gpu-box' || row.generation_kind !== 'creature'
          || !row.atlas_key || !row.manifest_key) {
        return await refuse(409, 'only a finished sheet can be edited');
      }
      const { rows: redraws } = await client.query(
        `SELECT 1 FROM sprite_sets WHERE redraw_of = $1 AND status IN ('queued','running') LIMIT 1`, [row.id],
      );
      if (redraws.length) return await refuse(409, 'a redraw of this sheet is in progress — wait for it to finish');
      let manifest;
      let sheet;
      try {
        manifest = await readJson(await store.getObjectStream(row.manifest_key));
        const chunks = [];
        for await (const c of await store.getObjectStream(row.atlas_key)) chunks.push(Buffer.from(c));
        sheet = Buffer.concat(chunks);
      } catch (err) {
        console.error(`sprite use-good-frames: cannot read ${row.id}:`, err.message);
        return await refuse(500, `Could not read the sheet: ${err.message}`);
      }
      let out;
      try {
        out = replaceFrames(sheet, manifest, wanted || flaggedTargets(manifest));
      } catch (err) {
        return await refuse(500, err.message);
      }
      if (out.replaced.length) {
        phase = 'write';
        await store.putObject(row.atlas_key, out.png, 'image/png');
        try {
          await store.putObject(row.manifest_key, Buffer.from(JSON.stringify(out.manifest)), 'application/json');
        } catch (err) {
          console.error('sprite use-good-frames: manifest write failed:', err.message);
          let restored = true;
          try { await store.putObject(row.atlas_key, sheet, 'image/png'); } catch (e2) {
            restored = false;
            console.error('sprite use-good-frames: could not restore sheet.png:', e2.message);
          }
          await client.query('ROLLBACK').catch(() => {});
          return res.status(500).json({ error: `could not save the sheet manifest; the image ${restored ? 'was restored' : 'could NOT be restored'}` });
        }
        phase = 'db';
        await client.query('UPDATE sprite_sets SET updated_at = now() WHERE id = $1', [row.id]);
      }
      await client.query('COMMIT');
      return res.json({ replaced: out.replaced, skipped: out.skipped });
    } catch (err) {
      console.error(err);
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (phase === 'db') {
        return res.status(500).json({ error: 'the sheet files were updated but the database update failed; reopen the sprite to check' });
      }
      return res.status(500).json({ error: 'Failed to replace the flagged frames' });
    } finally {
      if (client) client.release();
    }
  });

  router.post('/concepts/clear', async (req, res) => {
    const targets = targetsFrom(req.body);
    if (!targets) return res.status(400).json({ error: 'targets must list 1 to 1000 subjects' });
    try {
      res.json(await concepts.clearKept(pool, targets));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to clear kept concepts' });
    }
  });

  router.post('/jobs/approve', async (req, res) => {
    const jobIds = jobIdsFrom(req.body);
    if (!jobIds) return res.status(400).json({ error: 'job_ids must contain 1 to 1000 UUIDs' });
    try {
      const { rows: jobs } = await pool.query(
        `SELECT * FROM sprite_sets WHERE id = ANY($1::uuid[]) AND status = 'done'
          ORDER BY created_at`,
        [jobIds],
      );
      const approved = [];
      for (const job of jobs) {
        const boxRow = job.backend === 'gpu-box';
        if (boxRow && job.generation_kind === 'object' && job.appearance_variant == null && !job.atlas_key) {
          // Props v2: one edited static image (no sheet); the game gives it the
          // idle effect chosen when it was queued (prop_fx). A box prop done
          // before Props v2 still has a sheet and takes the branch below.
          if (!job.image_key) continue;
          const idleFx = PROP_FX.includes(job.prop_fx) ? job.prop_fx : 'none';
          // eslint-disable-next-line no-await-in-loop
          await pool.query(
            `UPDATE entity_types SET image = $1, sprite = NULL, render_mode = 'static', idle_fx = $2,
                    updated_at = now() WHERE id = $3`,
            [job.image_key, idleFx, job.entity_type_id],
          );
        } else if (!boxRow && job.generation_kind === 'object' && job.frames === 1) {
          if (!job.image_key) continue;
          // eslint-disable-next-line no-await-in-loop
          await pool.query(
            `UPDATE entity_types SET image = $1, sprite = NULL, render_mode = 'static',
                    updated_at = now() WHERE id = $2`,
            [job.image_key, job.entity_type_id],
          );
        } else {
          if (!job.atlas_key || !job.manifest_key) continue;
          const isCreature = job.generation_kind === 'creature';
          let sprite;
          if (!boxRow) {
            sprite = isCreature
              ? { atlas_key: job.atlas_key, manifest_key: job.manifest_key, static_frame: 'S/0' }
              : { atlas_key: job.atlas_key, manifest_key: job.manifest_key, frames: job.frames };
          } else if (isCreature) {
            // The static frame must exist in THIS sheet's manifest; never guess it.
            let staticFrame = null;
            try {
              // eslint-disable-next-line no-await-in-loop
              staticFrame = staticFrameFor(await readJson(await store.getObjectStream(job.manifest_key)));
            } catch (err) {
              console.error(`sprite approve: cannot read ${job.manifest_key}:`, err.message);
            }
            if (!staticFrame) continue;
            sprite = { atlas_key: job.atlas_key, manifest_key: job.manifest_key, static_frame: staticFrame };
          } else {
            sprite = { atlas_key: job.atlas_key, manifest_key: job.manifest_key, frames: job.frames_per_action };
          }
          const renderMode = isCreature ? 'static' : 'animated';
          if (job.appearance_variant != null) {
            // eslint-disable-next-line no-await-in-loop
            await pool.query(
              `UPDATE character_appearances SET sprite = $1, render_mode = $2, updated_at = now()
                WHERE entity_type_id = $3 AND variant = $4`,
              [JSON.stringify(sprite), renderMode, job.entity_type_id, job.appearance_variant],
            );
          } else {
            // eslint-disable-next-line no-await-in-loop
            await pool.query(
              `UPDATE entity_types SET sprite = $1, render_mode = $2, updated_at = now()
                WHERE id = $3`,
              [JSON.stringify(sprite), renderMode, job.entity_type_id],
            );
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await pool.query("UPDATE sprite_sets SET status = 'approved', updated_at = now() WHERE id = $1", [job.id]);
        approved.push(job.id);
      }
      res.json({ approved, skipped: jobIds.length - approved.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to approve sprite jobs' });
    }
  });

  return router;
}

module.exports = spriteBatchRoutes;
