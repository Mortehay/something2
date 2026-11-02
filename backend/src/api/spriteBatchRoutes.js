const express = require('express');
const queue = require('../services/spriteJobQueue.js');
const concepts = require('../services/spriteConcepts.js');
const { safeName } = require('../services/spriteDispatcher.js');
const { PROP_FX, DEFAULT_PROP_FX } = queue;
const { appearancePrompt } = require('../services/catalogSubjects.js');
const { staticFrameFor } = require('../services/spriteSheetManifest.js');
const { normalizeDirections } = require('../services/spriteBatchOptions.js');
const defaultBoxCancels = require('../services/spriteBoxCancels.js');

// Measured seconds per sheet cell is preferred; until one sheet has finished,
// this seed (Ruling R3) is what the page estimates with.
const SEED_SECONDS_PER_CELL = 57;
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

  router.get('/action-catalog', async (_req, res) => {
    try {
      const got = await getCatalog();
      if (got.error) return res.status(got.status).json({ error: got.error });
      const c = got.catalog;
      const measured = await queue.lastSecondsPerCell(pool);
      return res.json({
        actions: c.actions,
        directions: c.directions,
        max_frames: c.max_frames,
        engine: c.engine,
        seconds_per_cell: measured ?? SEED_SECONDS_PER_CELL,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to read the sprite action catalog' });
    }
  });

  router.get('/subjects', async (_req, res) => {
    try {
      const [{ rows: entities }, { rows: appearances }] = await Promise.all([
        pool.query(
          `SELECT e.id, e.name, e.prompt, e.render_mode, e.is_creature, e.is_playable,
                  e.point_kind, e.image, e.sprite,
                  j.id AS job_id, j.status AS job_state, j.generation_kind, j.frames,
                  j.backend, j.last_error, j.image_key, j.atlas_key, j.manifest_key,
                  j.concept_key, j.actions, j.directions, j.real_western, j.frames_per_action, j.box_job_id,
                  j.prop_fx, j.updated_at AS job_updated_at, j.note,
                  kc.concept_key AS kept_concept_key,
                  j.redraw_of, j.redraw_frames, j.box_task_id,
                  rl.redraw_source_atlas_key, rl.redraw_compare_frames,
                  sh.id AS sheet_job_id, sh.atlas_key AS sheet_atlas_key,
                  sh.manifest_key AS sheet_manifest_key, sh.updated_at AS sheet_updated_at
             FROM entity_types e
             LEFT JOIN LATERAL (
               SELECT * FROM sprite_sets s
                WHERE s.entity_type_id = e.id AND s.appearance_variant IS NULL
                ORDER BY s.created_at DESC LIMIT 1
             ) j ON true
             ${REDRAW_LINEAGE_JOIN}
             LEFT JOIN sprite_concepts kc ON kc.entity_type_id = e.id AND kc.appearance_variant IS NULL
             LEFT JOIN LATERAL (
               SELECT s2.id, s2.atlas_key, s2.manifest_key, s2.updated_at FROM sprite_sets s2
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
                  j.concept_key, j.actions, j.directions, j.real_western, j.frames_per_action, j.box_job_id,
                  j.prop_fx, j.updated_at AS job_updated_at, j.note,
                  kc.concept_key AS kept_concept_key,
                  j.redraw_of, j.redraw_frames, j.box_task_id,
                  rl.redraw_source_atlas_key, rl.redraw_compare_frames,
                  sh.id AS sheet_job_id, sh.atlas_key AS sheet_atlas_key,
                  sh.manifest_key AS sheet_manifest_key, sh.updated_at AS sheet_updated_at
             FROM character_appearances ca
             JOIN entity_types e ON e.id = ca.entity_type_id AND e.is_playable = true
             LEFT JOIN LATERAL (
               SELECT * FROM sprite_sets s
                WHERE s.entity_type_id = ca.entity_type_id AND s.appearance_variant = ca.variant
                ORDER BY s.created_at DESC LIMIT 1
             ) j ON true
             ${REDRAW_LINEAGE_JOIN}
             LEFT JOIN sprite_concepts kc ON kc.entity_type_id = ca.entity_type_id AND kc.appearance_variant = ca.variant
             LEFT JOIN LATERAL (
               SELECT s2.id, s2.atlas_key, s2.manifest_key, s2.updated_at FROM sprite_sets s2
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
          box_task_id: a.box_task_id,
          sheet_job_id: a.sheet_job_id,
          sheet_atlas_key: a.sheet_atlas_key,
          sheet_manifest_key: a.sheet_manifest_key,
          sheet_updated_at: a.sheet_updated_at,
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
    // on approve). Omitted means drift (SOMET-677); anything sent must be a known one.
    const propFx = 'prop_fx' in body ? body.prop_fx : DEFAULT_PROP_FX;
    if (!PROP_FX.includes(propFx)) {
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
    return { targets, options: { actions, framesPerAction: frames, propFx, directions } };
  }

  router.post('/jobs', async (req, res) => {
    try {
      const parsed = await queueRequestFrom(req.body);
      if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
      const { targets, options } = parsed;
      const result = await queue.enqueue(pool, targets, options);
      // Box jobs detached by an options change would otherwise keep the GPU
      // busy drawing a sheet nothing will collect. Best effort, not awaited.
      const dropped = result.updated.filter((r) => r.dropped_box_job_id)
        .map((r) => ({ boxJobId: r.dropped_box_job_id, spriteSetId: r.id, subject: r.creature || null }));
      if (dropped.length && box && typeof box.cancelSheetJob === 'function') {
        cancelBoxJobs(dropped, 'options-changed').catch((err) => console.error('sprite update: cancelling detached box jobs failed:', err));
      }
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
      // Western rows are mirrored in game unless this sheet drew them for real.
      const realWest = source.real_western === true && Array.isArray(source.directions) ? source.directions : [];
      const west = parsed.frames.find((f) => WESTERN.has(f.direction) && !realWest.includes(f.direction));
      if (west) {
        return res.status(400).json({ error: `${label(west)}: western directions are mirrored in game and cannot be redrawn` });
      }
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
      await boxCancels.request(pool, provider, {
        boxJobId: row.box_job_id, spriteSetId: row.sprite_set_id, subject: row.subject, source: 'retry',
      }, { box, now });
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
  // A subject whose concept is still being drawn (the box can't cancel a
  // concept task) or that the dispatcher is drawing now is refused untouched.
  router.post('/jobs/force', async (req, res) => {
    let parsed;
    try {
      parsed = await queueRequestFrom(req.body);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to force-regenerate sprite jobs' });
    }
    if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
    const { options } = parsed;
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
            `SELECT * FROM sprite_sets WHERE ${where} AND status IN ('queued','running') AND redraw_of IS NULL`,
            [t.entityId, t.variant],
          );
          let reason = null;
          if (live && live.status === 'running') {
            const cur = (dispatcher.status() || {}).current;
            if (live.box_task_id && !live.box_job_id) reason = 'concept is still being drawn, try again in a minute';
            else if (!live.box_task_id && !live.box_job_id) reason = 'the batch just picked this subject up — try again in a minute';
            else if (cur && cur.id === live.id) reason = 'the batch is drawing this subject right now — halt the batch first';
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
          // eslint-disable-next-line no-await-in-loop
          const result = await queue.enqueue(client, [t], options);
          if (result.rows.length === 0) {
            // eslint-disable-next-line no-await-in-loop
            await client.query('ROLLBACK');
            refuse(t, result.unknown.length ? 'no such subject' : 'could not queue a new set');
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          await client.query('COMMIT');
          committed = true;
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
