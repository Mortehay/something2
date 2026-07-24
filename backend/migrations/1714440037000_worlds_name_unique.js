// F-044 (SOMET-224): worlds.name has no unique constraint, unlike
// tile_types/entity_types/item_types, all of which were created with
// unique:true on name from the start (1714440002000_create_tile_types.js,
// 1714440003000_create_environment_types.js,
// 1714440016000_create_weapon_types.js). POST /api/worlds silently accepts
// a duplicate name with 201, producing two distinct worlds an admin cannot
// tell apart in the Maps admin list or any N/E/S/W link dropdown without
// opening each one -- confirmed live, and the dev DB already had more than
// one world sharing a name from prior seed/test data before this migration.
//
// A straight unique constraint would fail to apply against that existing
// data, so rename every duplicate but the first (ordered by created_at,
// then id, so the oldest keeps its bare name) before adding the constraint.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at ASC, id ASC) AS rn
      FROM worlds
    )
    UPDATE worlds w
    SET name = w.name || ' (' || ranked.rn || ')'
    FROM ranked
    WHERE w.id = ranked.id AND ranked.rn > 1;
  `);
  pgm.addConstraint('worlds', 'worlds_name_unique', { unique: 'name' });
};

exports.down = (pgm) => {
  pgm.dropConstraint('worlds', 'worlds_name_unique');
};
