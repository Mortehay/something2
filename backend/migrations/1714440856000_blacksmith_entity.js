/* eslint-disable camelcase */
// The village blacksmith becomes a real ENTITY, the way the quest givers did (1714440849000): an
// entity type with point_kind = 'blacksmith' that an admin can give an image, an animated sprite
// and a `nearby` sound in the Entity Types / Audio tabs, and that is the kind's default art.
//
// seed-catalogs converges the same row (POINT_TYPES 'Village Blacksmith'); this migration exists so a
// database that is migrated but not re-seeded already has it. Every write is fill-only: ON CONFLICT DO
// NOTHING, the kind default is set only when empty. sync_uuid follows the seed-sync convention
// md5('s2sync:<table>:<key>').
exports.shorthands = undefined;

const { POINT_TYPES } = require('../seeds/data/pointTypes.js');

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const SMITH = POINT_TYPES.find((t) => t.point_kind === 'blacksmith');

exports.up = (pgm) => {
  pgm.sql(`INSERT INTO entity_types
             (name, is_creature, walkable, render_mode, spawn_tiles, chance,
              display_width, display_height, color, prompt, point_kind, sync_uuid)
           VALUES (${lit(SMITH.name)}, false, true, 'rect', '[]'::jsonb, 0,
                   ${SMITH.display_width}, ${SMITH.display_height}, ${lit(SMITH.color)}, ${lit(SMITH.prompt)},
                   'blacksmith', md5('s2sync:entity_types:' || ${lit(SMITH.name)})::uuid)
           ON CONFLICT (name) DO NOTHING`);
  pgm.sql(`UPDATE world_point_kinds
              SET default_entity_type_id = (SELECT id FROM entity_types WHERE name = ${lit(SMITH.name)})
            WHERE kind = 'blacksmith' AND default_entity_type_id IS NULL`);
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE world_point_kinds SET default_entity_type_id = NULL
            WHERE kind = 'blacksmith'
              AND default_entity_type_id = (SELECT id FROM entity_types WHERE name = ${lit(SMITH.name)})`);
  pgm.sql(`DELETE FROM entity_types WHERE name = ${lit(SMITH.name)} AND point_kind = 'blacksmith'`);
};
