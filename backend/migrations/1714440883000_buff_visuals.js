/* eslint-disable camelcase */
// Character buff auras. buff_visuals holds how each visual buff draws (ground or body, size,
// priority, colour, optional sprite sheet); one row per visual buff skill, seeded here from the
// skill catalog. effect_sprite_jobs gains the 'buff' subject kind so the Sprite tab can draw them.
const { SKILLS } = require('../seeds/data/skills.js');
const { VISUAL_BUFF_IDS, defaultVisual } = require('../src/services/buffVisuals.js');

exports.shorthands = undefined;

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  pgm.createTable('buff_visuals', {
    skill_id: { type: 'text', primaryKey: true },
    placement: { type: 'text', notNull: true, check: "placement IN ('ground','body')" },
    radius: { type: 'real', notNull: true, default: 64 },
    scale: { type: 'real', notNull: true, default: 1.3 },
    priority: { type: 'integer', notNull: false },
    color: { type: 'text', notNull: true },
    sprite_image: { type: 'text', notNull: false },
    sprite_frames: { type: 'integer', notNull: true, default: 1 },
    sprite_additive: { type: 'boolean', notNull: true, default: true },
    sprite_fps: { type: 'real', notNull: false },
    sync_uuid: { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()'), unique: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  const byId = new Map(SKILLS.map((s) => [s.id, s]));
  const values = VISUAL_BUFF_IDS.map((id) => {
    const d = defaultVisual(byId.get(id));
    return `(${lit(d.skill_id)}, ${lit(d.placement)}, ${lit(d.color)})`;
  });
  pgm.sql(`INSERT INTO buff_visuals (skill_id, placement, color) VALUES ${values.join(',\n  ')}`);

  pgm.dropConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check');
  pgm.addConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check',
    "CHECK (subject_kind IN ('vfx','aura','buff'))");
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM effect_sprite_jobs WHERE subject_kind = 'buff'");
  pgm.dropConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check');
  pgm.addConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check',
    "CHECK (subject_kind IN ('vfx','aura'))");
  pgm.dropTable('buff_visuals');
};
