// backend/src/api/passiveNodesRoutes.js
//
// The admin node browser and single-node editor (spec §10.5, SOMET-477).
//
// ONLY THREE COLUMNS ARE WRITABLE: label, kind and grants. Structure --
// key, sector, ring, x, y, start_class -- comes from the generator and is
// deliberately not editable here. Letting an admin move a node would let them
// disconnect one, and an unreachable node is invisible in the UI and
// unallocatable forever: exactly the failure the generator's reachability
// guard exists to prevent, reintroduced through a form.
//
// THE VALIDATOR IS THE POINT OF THIS FILE. A grant with a misspelt stat
// ("strenght") satisfies the jsonb column, renders normally in the admin list
// and grants NOTHING at runtime -- statComposition.js simply does not match
// it. That failure is invisible everywhere except a stat readout nobody
// diffs, and this epic has shipped it five times in other shapes. So the
// vocabulary is not re-typed here: it is READ FROM seeds/data/passiveTree.js,
// the same table the generator's guard checks, so the editor and the
// generator cannot disagree about what a legal grant is.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const { invalidateTreeCache } = require('../services/passiveTreeStore.js');
const { GRANT_TYPES, RULE_KEYS } = require('../../seeds/data/passiveTree.js');

// 'start' is deliberately absent: kind = 'start' and a non-null start_class
// are the same fact (passive_nodes_start_class_check), so an editor that could
// set it would either violate that CHECK or hand a class a second start node.
// SOMET-517 added `greater`. Without it this route REJECTS an admin editing a
// greater node -- the tree can generate them but nobody can touch one, and the
// failure would be a 400 on save rather than anything visible in the editor.
// The admin form's own KINDS list is asserted against this one.
const KINDS = ['minor', 'notable', 'greater', 'keystone'];
const SECTORS = ['core', 'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
// Filters may name 'start' even though the editor may not write it -- an admin
// still needs to be able to LOOK at the six start nodes.
const FILTER_KINDS = [...KINDS, 'start'];

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// The noun each grant field is called in an error message. Keyed on the field
// name GRANT_TYPES declares, so a new grant type that reuses an existing field
// needs no entry here.
const FIELD_NOUN = {
  stat: 'stat', pool: 'resource pool', element: 'element', status: 'status', rule: 'rule',
};

// { field, values } for a grant type, or null when the type is unknown.
// GRANT_TYPES rows carry exactly one extra field; `rule` declares it as null
// because its legal values are the keys of RULE_KEYS.
function shapeOf(type) {
  const row = Object.prototype.hasOwnProperty.call(GRANT_TYPES, type) ? GRANT_TYPES[type] : null;
  if (!row) return null;
  const field = Object.keys(row)[0];
  return { field, values: row[field] || Object.keys(RULE_KEYS) };
}

// A value must be a real number, or a string that is one. Number() alone is
// not enough: Number(null), Number(''), Number([]) are all 0 and Number(true)
// is 1, so a validator built on Number.isFinite(Number(v)) accepts four
// values that mean "the admin left this blank" and stores them as a grant of 0.
function valueError(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? null : 'a grant value must be a finite number';
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return null;
  return 'a grant value must be a finite number';
}

// Returns null when valid, or the message to put in the 400 body. The message
// NAMES the offending token, because "invalid grant" tells an admin who typed
// `strenght` nothing at all.
function grantError(g) {
  if (g == null || typeof g !== 'object' || Array.isArray(g)) return 'each grant must be an object';
  const shape = shapeOf(g.type);
  if (!shape) return `unknown grant type: ${g.type}`;
  const bad = valueError(g.value);
  if (bad) return bad;
  const v = g[shape.field];
  if (!shape.values.includes(v)) {
    return `unknown ${FIELD_NOUN[shape.field] || shape.field}: ${v}`;
  }
  return null;
}

// Keep only the two fields this grant type actually uses. A `stat` left behind
// on a `damage` grant (the form switched type without clearing it) passes the
// validator, stores fine and is read by nothing -- a node that looks edited and
// is not.
function normaliseGrant(g) {
  const shape = shapeOf(g.type);
  return { type: g.type, [shape.field]: g[shape.field], value: Number(g.value) };
}

// `%` and `_` are ILIKE pattern syntax, NOT SQL syntax -- parameterising the
// query does nothing about them. Without this a lone `%` in the search box
// matches all 1806 rows and `start_strength` matches `start-strength`, both of
// which read as "search is broken" rather than as a wildcard doing its job.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

module.exports = function passiveNodesRoutes(pool) {
  const router = express.Router();
  const guard = requireAdmin(pool);

  router.get('/', guard, async (req, res) => {
    try {
      const where = [];
      const params = [];
      // An unrecognised sector/kind is IGNORED rather than rejected: these
      // arrive from dropdowns, and a 400 on a stale query string would blank
      // the admin's table with no way to tell why.
      if (SECTORS.includes(req.query.sector)) {
        params.push(req.query.sector);
        where.push(`sector = $${params.length}`);
      }
      if (FILTER_KINDS.includes(req.query.kind)) {
        params.push(req.query.kind);
        where.push(`kind = $${params.length}`);
      }
      const search = String(req.query.search || '').trim();
      if (search) {
        params.push(`%${escapeLike(search)}%`);
        where.push(`(key ILIKE $${params.length} ESCAPE '\\' OR label ILIKE $${params.length} ESCAPE '\\')`);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = await pool.query(`SELECT count(*)::int AS c FROM passive_nodes ${clause}`, params);
      // Clamped, not trusted: 1806 rows in one response is the thing the
      // pagination exists to prevent, and ?limit=99999 is the obvious way
      // around it.
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(req.query.limit) || DEFAULT_LIMIT)));
      const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
      // ORDER BY is load-bearing, not cosmetic: without a total order, two
      // pages of an unordered scan can repeat and skip rows.
      const rows = await pool.query(
        `SELECT id, key, sector, ring, x, y, kind, label, grants, start_class
           FROM passive_nodes ${clause}
          ORDER BY sector, ring, key
          LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      return res.json({ nodes: rows.rows, total: total.rows[0].c, limit, offset });
    } catch (err) {
      console.error('passive node list failed:', err);
      return res.status(500).json({ error: 'failed to list passive nodes' });
    }
  });

  router.put('/:id', guard, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid passive node id' });
      }
      const { label, kind, grants } = req.body || {};
      if (typeof label !== 'string' || label.trim() === '') {
        return res.status(400).json({ error: 'label is required' });
      }
      if (kind === 'start') {
        return res.status(400).json({ error: 'a start node is created by the generator, not by this editor' });
      }
      if (!KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
      }
      if (!Array.isArray(grants)) return res.status(400).json({ error: 'grants must be an array' });
      for (const g of grants) {
        const err = grantError(g);
        if (err) return res.status(400).json({ error: err });
      }

      const r = await pool.query(
        `UPDATE passive_nodes SET label = $2, kind = $3, grants = $4::jsonb
          WHERE id = $1 AND kind <> 'start'
        RETURNING id, key, sector, ring, x, y, kind, label, grants, start_class`,
        [id, label.trim(), kind, JSON.stringify(grants.map(normaliseGrant))],
      );
      if (r.rowCount !== 1) {
        // Separate "does not exist" from "is a start node", because the second
        // is a rule this editor enforces and the admin deserves to be told
        // which one they hit.
        const exists = await pool.query("SELECT kind FROM passive_nodes WHERE id = $1", [id]);
        if (exists.rowCount === 1) {
          return res.status(400).json({
            error: "a start node's label, kind and grants are structural -- "
              + 'the seeder rewrites them on every reseed, so an edit here would be silently reverted',
          });
        }
        return res.status(404).json({ error: 'passive node not found' });
      }

      // The tree is cached in module scope by passiveTreeStore.loadTree. Without
      // this, the save succeeds, the admin sees the new value in the form, and
      // every running world keeps granting the old one until a restart.
      invalidateTreeCache();
      return res.json(r.rows[0]);
    } catch (err) {
      console.error('passive node update failed:', err);
      return res.status(500).json({ error: 'failed to update passive node' });
    }
  });

  return router;
};

// Exported for the frontend↔backend vocabulary drift guard and for unit tests.
module.exports.KINDS = KINDS;
module.exports.SECTORS = SECTORS;
module.exports.grantError = grantError;
module.exports.escapeLike = escapeLike;
