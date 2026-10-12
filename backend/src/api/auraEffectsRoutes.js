// backend/src/api/auraEffectsRoutes.js
// SOMET-604 (S3). Aura library CRUD. Modelled on the vfx-effects routes
// (index.js:1797-1960) with one deliberate difference: a RENAME cascades into
// entity_types.auras in the same transaction (the SOMET-228 entity-rename
// pattern, index.js:982-1013) instead of 409ing -- a typo'd aura name must be
// fixable. DELETE is still refused while bound (spec §5).
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const { auraEffectError } = require('../services/auraEffects.js');

const COLS = ['name', 'target_side', 'radius', 'damage_mult', 'defense_mult', 'speed_mult', 'dot_dps',
  'dot_element', 'tick_ms', 'shape', 'color', 'pulse_ms', 'particle_count', 'particle_spread',
  'particle_speed', 'particle_gravity', 'particle_lifetime_ms', 'particle_size'];
const DEFAULTS = { damage_mult: 1, defense_mult: 1, speed_mult: 1, dot_dps: 0, dot_element: 'physical',
  tick_ms: 1000, shape: 'ring', color: '#d4a017', pulse_ms: 1200, particle_count: 0, particle_spread: 6.283,
  particle_speed: 100, particle_gravity: 0, particle_lifetime_ms: 300, particle_size: 2 };

function values(b) {
  return COLS.map((c) => (c === 'name' ? String(b.name).trim()
    : c === 'target_side' || c === 'shape' || c === 'color' || c === 'dot_element'
      ? (b[c] ?? DEFAULTS[c]) : Number(b[c] ?? DEFAULTS[c])));
}
function dbError(res, err, fallback) {
  if (err.code === '23505') return res.status(409).json({ error: 'An aura with that name already exists' });
  if (err.code === '23503') return res.status(400).json({ error: 'dot_element must name a known element' });
  if (err.code === '23514') return res.status(400).json({ error: `rejected by ${err.constraint}` });
  console.error(err);
  return res.status(500).json({ error: fallback });
}
const USED_BY = `COALESCE((SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name)
                   FROM entity_types e WHERE e.auras ? ae.name), '[]'::json) AS used_by`;

module.exports = function auraEffectsRoutes(pool) {
  const router = express.Router();
  const guard = requireAdmin(pool);

  // Open, like /api/vfx-effects: S5's client draws auras from this library.
  router.get('/', async (req, res) => {
    try {
      const r = await pool.query(`SELECT ae.*, ${USED_BY} FROM aura_effects ae ORDER BY ae.name`);
      res.json(r.rows);
    } catch (err) { dbError(res, err, 'Failed to fetch auras'); }
  });

  router.post('/', guard, async (req, res) => {
    const bad = auraEffectError(req.body);
    if (bad) return res.status(400).json({ error: bad });
    try {
      const r = await pool.query(
        `INSERT INTO aura_effects (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        values(req.body));
      res.status(201).json({ ...r.rows[0], used_by: [] });
    } catch (err) { dbError(res, err, 'Failed to create aura'); }
  });

  router.put('/:id', guard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id must be an integer' });
    const bad = auraEffectError(req.body);
    if (bad) return res.status(400).json({ error: bad });
    let client = null;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const cur = await client.query('SELECT name FROM aura_effects WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Aura not found' }); }
      const oldName = cur.rows[0].name;
      const newName = String(req.body.name).trim();
      const v = values(req.body);
      const r = await client.query(
        `UPDATE aura_effects SET ${COLS.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now()
          WHERE id = $${COLS.length + 1} RETURNING *`, [...v, req.params.id]);
      let renamedBindings = 0;
      if (oldName !== newName) {
        // Rewrite the ONE matching element, keep order (index.js:982 pattern).
        const u = await client.query(
          `UPDATE entity_types SET auras = (
             SELECT jsonb_agg(CASE WHEN elem.value = $1 THEN $2 ELSE elem.value END ORDER BY elem.ord)
               FROM jsonb_array_elements_text(auras) WITH ORDINALITY AS elem(value, ord))
            WHERE auras ? $1`, [oldName, newName]);
        renamedBindings = u.rowCount;
      }
      await client.query('COMMIT');
      res.json({ ...r.rows[0], renamedBindings });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      dbError(res, err, 'Failed to update aura');
    } finally { client?.release(); }
  });

  router.delete('/:id', guard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id must be an integer' });
    try {
      const cur = await pool.query('SELECT name FROM aura_effects WHERE id = $1', [req.params.id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Aura not found' });
      const name = cur.rows[0].name;
      const refs = await pool.query('SELECT id, name FROM entity_types WHERE auras ? $1 ORDER BY name', [name]);
      if (refs.rowCount > 0) {
        return res.status(409).json({
          error: `Cannot delete '${name}': still bound by ${refs.rowCount} entity type(s)`,
          referencing_entity_types: refs.rows.map((e) => ({ id: e.id, name: e.name })),
        });
      }
      await pool.query('DELETE FROM aura_effects WHERE id = $1', [req.params.id]);
      res.status(204).end();
    } catch (err) { dbError(res, err, 'Failed to delete aura'); }
  });

  return router;
};
