/* eslint-disable camelcase */
// SOMET-678. Quest givers become world point entities: a `quest_giver` kind,
// one entity type per character (the name is the in-game label), and a fifth
// per-village post column next to merchant/bank/gem/skill.
//
// seed-catalogs and seed-map converge the same rows (POINT_TYPES, the
// vale-region spec's blackfen `art.quest_giver`); this migration exists so a
// database that is migrated but not re-seeded already shows the same givers.
// Every write is fill-only: ON CONFLICT DO NOTHING, default only if empty.
// sync_uuid follows the seed-sync convention md5('s2sync:<table>:<key>').
exports.shorthands = undefined;

const { POINT_TYPES } = require('../seeds/data/pointTypes.js');

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const GIVERS = POINT_TYPES.filter((t) => t.point_kind === 'quest_giver');

exports.up = (pgm) => {
  pgm.sql(`INSERT INTO world_point_kinds (kind, sync_uuid)
           VALUES ('quest_giver', md5('s2sync:world_point_kinds:quest_giver')::uuid)
           ON CONFLICT (kind) DO NOTHING`);
  pgm.addColumns('villages', {
    quest_giver_entity_type_id: {
      type: 'integer', notNull: false, references: 'entity_types', onDelete: 'SET NULL',
    },
  });
  for (const t of GIVERS) {
    pgm.sql(`INSERT INTO entity_types
               (name, is_creature, walkable, render_mode, spawn_tiles, chance,
                display_width, display_height, color, prompt, point_kind, sync_uuid)
             VALUES (${lit(t.name)}, false, true, 'rect', '[]'::jsonb, 0,
                     ${t.display_width}, ${t.display_height}, ${lit(t.color)}, ${lit(t.prompt)},
                     'quest_giver', md5('s2sync:entity_types:' || ${lit(t.name)})::uuid)
             ON CONFLICT (name) DO NOTHING`);
  }
  pgm.sql(`UPDATE world_point_kinds
              SET default_entity_type_id = (SELECT id FROM entity_types WHERE name = ${lit(GIVERS[0].name)})
            WHERE kind = 'quest_giver' AND default_entity_type_id IS NULL`);
  pgm.sql(`UPDATE villages
              SET quest_giver_entity_type_id = (SELECT id FROM entity_types WHERE name = 'Shadow Hunter')
            WHERE spec_key = 'blackfen' AND quest_giver_entity_type_id IS NULL`);
};

exports.down = (pgm) => {
  pgm.dropColumns('villages', ['quest_giver_entity_type_id']);
  pgm.sql(`UPDATE entity_types SET point_kind = NULL WHERE point_kind = 'quest_giver'`);
  pgm.sql(`DELETE FROM world_point_kinds WHERE kind = 'quest_giver'`);
};
