const express = require('express');
const queue = require('../services/spriteJobQueue.js');

// targets: [{entity_id, variant}], variant omitted/null for the entity's own
// sprite, 1-5 to target one of its character_appearances rows instead.
function targetsFrom(body) {
  const values = body && body.targets;
  if (!Array.isArray(values) || values.length === 0 || values.length > 1000) return null;
  const targets = values.map((t) => ({
    entityId: Number(t && t.entity_id),
    variant: t && t.variant != null ? Number(t.variant) : null,
  }));
  const valid = targets.every((t) => Number.isInteger(t.entityId)
    && (t.variant === null || (Number.isInteger(t.variant) && t.variant >= 1 && t.variant <= 5)));
  return valid ? targets : null;
}

function jobIdsFrom(body) {
  const values = body && body.job_ids;
  if (!Array.isArray(values) || values.length === 0 || values.length > 1000) return null;
  const ids = values.map(String);
  return ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) ? ids : null;
}

function spriteBatchRoutes(pool, adminGuard, dispatcher) {
  const router = express.Router();
  router.use(adminGuard);

  router.get('/subjects', async (_req, res) => {
    try {
      const [{ rows: entities }, { rows: appearances }] = await Promise.all([
        pool.query(
          `SELECT e.id, e.name, e.prompt, e.render_mode, e.is_creature, e.is_playable,
                  e.point_kind, e.image, e.sprite,
                  j.id AS job_id, j.status AS job_state, j.generation_kind, j.frames,
                  j.backend, j.last_error, j.image_key, j.atlas_key, j.manifest_key,
                  j.updated_at AS job_updated_at
             FROM entity_types e
             LEFT JOIN LATERAL (
               SELECT * FROM sprite_sets s
                WHERE s.entity_type_id = e.id AND s.appearance_variant IS NULL
                ORDER BY s.created_at DESC LIMIT 1
             ) j ON true
            ORDER BY e.name`,
        ),
        // Each playable class's 5 appearance variants, alongside the class's
        // own row above -- a variant with no sprite of its own still renders
        // (character_appearances.sprite falls back to the class's), so this
        // batch is for giving a variant its OWN directional sheet, not a
        // prerequisite for it to appear in-game at all.
        pool.query(
          `SELECT ca.entity_type_id, ca.variant, ca.render_mode, ca.sprite,
                  e.name AS class_name, e.prompt AS class_prompt,
                  j.id AS job_id, j.status AS job_state, j.generation_kind, j.frames,
                  j.backend, j.last_error, j.image_key, j.atlas_key, j.manifest_key,
                  j.updated_at AS job_updated_at
             FROM character_appearances ca
             JOIN entity_types e ON e.id = ca.entity_type_id AND e.is_playable = true
             LEFT JOIN LATERAL (
               SELECT * FROM sprite_sets s
                WHERE s.entity_type_id = ca.entity_type_id AND s.appearance_variant = ca.variant
                ORDER BY s.created_at DESC LIMIT 1
             ) j ON true
            ORDER BY e.name, ca.variant`,
        ),
      ]);
      const subjects = [
        ...entities.map((e) => ({ ...e, variant: null })),
        ...appearances.map((a) => ({
          id: `${a.entity_type_id}:${a.variant}`,
          entity_id: a.entity_type_id,
          variant: a.variant,
          name: `${a.class_name} — Appearance ${a.variant}`,
          prompt: a.class_prompt,
          render_mode: a.render_mode,
          is_creature: false,
          is_playable: true,
          point_kind: null,
          image: null,
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
          job_updated_at: a.job_updated_at,
        })),
      ];
      res.json({ subjects });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to list sprite subjects' });
    }
  });

  router.get('/jobs', async (_req, res) => {
    try {
      res.json({ ...(await queue.queueView(pool)), run: dispatcher.status() });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to read the sprite queue' });
    }
  });

  router.post('/jobs', async (req, res) => {
    const targets = targetsFrom(req.body);
    if (!targets) return res.status(400).json({ error: 'targets must contain 1 to 1000 {entity_id, variant?} pairs' });
    try {
      const result = await queue.enqueue(pool, targets);
      const selected = new Set(targets.map((t) => `${t.entityId}:${t.variant ?? ''}`)).size;
      res.status(201).json({
        selected,
        queued: result.rows.length,
        skipped: selected - result.rows.length - result.unknown.length,
        unknown: result.unknown,
        stats: await queue.stats(pool),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to queue sprite jobs' });
    }
  });

  router.post('/jobs/dispatch', (_req, res) => {
    try {
      const draining = dispatcher.start();
      draining.catch((err) => console.error('sprite dispatcher stopped:', err));
      res.status(202).json({ run: dispatcher.status() });
    } catch (err) {
      if (err.code === 'ALREADY_RUNNING') return res.status(409).json({ error: err.message });
      console.error(err);
      return res.status(500).json({ error: 'Failed to start the sprite batch' });
    }
  });

  router.post('/jobs/stop', (_req, res) => {
    res.json({ stopping: dispatcher.stop(), run: dispatcher.status() });
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

  router.post('/jobs/clear', async (_req, res) => {
    if (dispatcher.status()?.running) {
      return res.status(409).json({ error: 'stop the sprite batch before clearing queued jobs' });
    }
    try {
      const { rows } = await pool.query(
        "DELETE FROM sprite_sets WHERE entity_type_id IS NOT NULL AND status IN ('queued','running') RETURNING id",
      );
      res.json({ cleared: rows.length, stats: await queue.stats(pool) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to clear sprite jobs' });
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
        if (job.generation_kind === 'object' && job.frames === 1) {
          if (!job.image_key) continue;
          // eslint-disable-next-line no-await-in-loop
          await pool.query(
            `UPDATE entity_types SET image = $1, sprite = NULL, render_mode = 'static',
                    updated_at = now() WHERE id = $2`,
            [job.image_key, job.entity_type_id],
          );
        } else {
          if (!job.atlas_key || !job.manifest_key) continue;
          const sprite = job.generation_kind === 'creature'
            ? { atlas_key: job.atlas_key, manifest_key: job.manifest_key, static_frame: 'S/0' }
            : { atlas_key: job.atlas_key, manifest_key: job.manifest_key, frames: job.frames };
          const renderMode = job.generation_kind === 'creature' ? 'static' : 'animated';
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
