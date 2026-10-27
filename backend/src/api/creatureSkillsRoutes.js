// backend/src/api/creatureSkillsRoutes.js
// SOMET-608 (S6). The creature SKILL catalog's own CRUD, modelled on
// auraEffectsRoutes.js -- open read (the kit editor's dropdown needs it with
// no special auth, same reason /api/aura-effects and /api/vfx-effects are
// open), admin-guarded writes. Unlike an aura (bound by NAME, no FK), a skill
// is bound through a real FK (creature_behavior_skills.skill_id), so DELETE
// does not need its own soft reference-count query to stay safe -- the
// constraint (ON DELETE RESTRICT) already refuses it -- but one is run
// anyway, for the same reason aura_effects' own DELETE does: a raw 23503 is
// an unreadable 500-shaped error without it, and naming which behaviours are
// in the way is worth one extra SELECT.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const { creatureSkillError } = require('../services/creatureSkills.js');

const COLS = ['name', 'kind', 'telegraph_ms', 'cooldown_ms', 'radius', 'range',
  'damage_mult', 'element', 'summon_entity', 'summon_count', 'vfx'];
const DEFAULTS = {
  telegraph_ms: 0, radius: 0, range: 0, damage_mult: 1,
  element: null, summon_entity: null, summon_count: 1, vfx: null,
};
const NUMERIC_COLS = new Set(['telegraph_ms', 'cooldown_ms', 'radius', 'range', 'damage_mult', 'summon_count']);

function values(b) {
  return COLS.map((c) => {
    if (c === 'name') return String(b.name).trim();
    if (c === 'vfx') return b.vfx ?? null; // jsonb column: pg handles object -> jsonb itself
    if (NUMERIC_COLS.has(c)) return Number(b[c] ?? DEFAULTS[c]);
    return b[c] ?? DEFAULTS[c] ?? null; // kind, element, summon_entity
  });
}
function dbError(res, err, fallback) {
  if (err.code === '23505') return res.status(409).json({ error: 'A creature skill with that name already exists' });
  if (err.code === '23503') return res.status(409).json({ error: 'Cannot delete: still bound by a creature behavior' });
  if (err.code === '23514') return res.status(400).json({ error: `rejected by ${err.constraint}` });
  console.error(err);
  return res.status(500).json({ error: fallback });
}
const USED_BY = `COALESCE((SELECT json_agg(json_build_object('id', b.id, 'name', b.name) ORDER BY b.name)
                   FROM creature_behavior_skills cbs JOIN creature_behaviors b ON b.id = cbs.behavior_id
                   WHERE cbs.skill_id = cs.id), '[]'::json) AS used_by`;

module.exports = function creatureSkillsRoutes(pool) {
  const router = express.Router();
  const guard = requireAdmin(pool);

  router.get('/', async (req, res) => {
    try {
      const r = await pool.query(`SELECT cs.*, ${USED_BY} FROM creature_skills cs ORDER BY cs.name`);
      res.json(r.rows);
    } catch (err) { dbError(res, err, 'Failed to fetch creature skills'); }
  });

  router.post('/', guard, async (req, res) => {
    const bad = creatureSkillError(req.body);
    if (bad) return res.status(400).json({ error: bad });
    try {
      const r = await pool.query(
        `INSERT INTO creature_skills (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        values(req.body));
      res.status(201).json({ ...r.rows[0], used_by: [] });
    } catch (err) { dbError(res, err, 'Failed to create creature skill'); }
  });

  router.put('/:id', guard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id must be an integer' });
    const bad = creatureSkillError(req.body);
    if (bad) return res.status(400).json({ error: bad });
    try {
      const v = values(req.body);
      // Not RETURNING used_by here (unlike GET's list) -- same as
      // auraEffectsRoutes.js's own PUT: the admin list re-fetches after a
      // save, and a save can never change WHO is bound, only the row's own
      // fields, so there is nothing stale to avoid.
      const r = await pool.query(
        `UPDATE creature_skills SET ${COLS.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now()
          WHERE id = $${COLS.length + 1} RETURNING *`, [...v, req.params.id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'Creature skill not found' });
      res.json(r.rows[0]);
    } catch (err) { dbError(res, err, 'Failed to update creature skill'); }
  });

  router.delete('/:id', guard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id must be an integer' });
    try {
      const cur = await pool.query('SELECT name FROM creature_skills WHERE id = $1', [req.params.id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Creature skill not found' });
      const refs = await pool.query(
        `SELECT b.id, b.name FROM creature_behavior_skills cbs JOIN creature_behaviors b ON b.id = cbs.behavior_id
          WHERE cbs.skill_id = $1 ORDER BY b.name`, [req.params.id],
      );
      if (refs.rowCount > 0) {
        return res.status(409).json({
          error: `Cannot delete '${cur.rows[0].name}': still bound by ${refs.rowCount} creature behavior(s)`,
          referencing_behaviors: refs.rows,
        });
      }
      await pool.query('DELETE FROM creature_skills WHERE id = $1', [req.params.id]);
      res.status(204).end();
    } catch (err) { dbError(res, err, 'Failed to delete creature skill'); }
  });

  return router;
};
