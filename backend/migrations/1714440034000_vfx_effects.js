exports.shorthands = undefined;

// The single slice A effect. Every melee weapon binds to it; slice B replaces
// these bindings with one authored effect per weapon.
//
// follows_weapon is what makes a halberd (reach 190, arc 1.8 rad) and a knife
// (reach 70, arc 0.5) look different while sharing one row: the renderer takes
// the wedge's radius and angular width from the ATTACK EVENT rather than from
// a fixed size on the effect.
const SEED_EFFECT = {
  name: 'sweep_arc',
  shape: 'arc',
  color: '#e8e8f0',
  width: 3,
  duration_ms: 180,
  ease: 'out',
  fade: true,
  follows_weapon: true,
};

exports.up = (pgm) => {
  // The effect LIBRARY: one row per distinct look, referenced by name.
  // Geometry columns only — the particle_* columns arrive in slice C, so this
  // slice is not blocked on settling particle semantics it cannot yet draw.
  pgm.createTable('vfx_effects', {
    id: 'id',
    name: { type: 'text', notNull: true, unique: true },
    shape: { type: 'text', notNull: true },
    color: { type: 'text', notNull: true, default: '#dddddd' },
    width: { type: 'real', notNull: true, default: 2 },
    duration_ms: { type: 'integer', notNull: true, default: 180 },
    ease: { type: 'text', notNull: true, default: 'out' },
    fade: { type: 'boolean', notNull: true, default: true },
    follows_weapon: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Enum-style CHECKs, matching how item_types.element and .category are
  // constrained. The full shape vocabulary is admitted now even though slice A
  // only draws 'arc' — so slice B adds shapes with no migration.
  pgm.addConstraint('vfx_effects', 'vfx_effects_shape_check',
    "CHECK (shape IN ('arc','line','ring','burst','bolt'))");
  pgm.addConstraint('vfx_effects', 'vfx_effects_ease_check',
    "CHECK (ease IN ('linear','out','in'))");
  // A zero/negative duration would divide by zero in effectProgress; a huge one
  // would pin an effect on screen forever.
  pgm.addConstraint('vfx_effects', 'vfx_effects_duration_check',
    'CHECK (duration_ms > 0 AND duration_ms <= 5000)');

  // Bindings: { "<moment>": "<vfx_effects.name>" }. jsonb rather than eight
  // nullable FK columns, mirroring tile_types.sprite / entity_types.sprite.
  // The accepted cost is no referential integrity — an unresolved name draws
  // nothing rather than throwing (see core/vfx.js addEffects).
  pgm.addColumn('item_types', { vfx: { type: 'jsonb' } });

  const e = SEED_EFFECT;
  pgm.sql(`
    INSERT INTO vfx_effects (name, shape, color, width, duration_ms, ease, fade, follows_weapon)
    VALUES ('${e.name}', '${e.shape}', '${e.color}', ${e.width}, ${e.duration_ms},
            '${e.ease}', ${e.fade}, ${e.follows_weapon})
  `);

  // Every melee weapon, not a hand-picked list: a weapon added to the catalog
  // before slice B lands should still swing visibly.
  pgm.sql(`UPDATE item_types SET vfx = '{"attack":"sweep_arc"}'::jsonb WHERE kind = 'melee'`);
};

exports.down = (pgm) => {
  pgm.dropColumns('item_types', ['vfx']);
  pgm.dropTable('vfx_effects');
};

// Exported so the migration test can assert the seed without a database.
exports.SEED_EFFECT = SEED_EFFECT;
