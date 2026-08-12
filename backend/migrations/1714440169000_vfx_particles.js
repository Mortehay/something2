/* eslint-disable camelcase */

// Attack VFX slice C (SOMET-160): the particle_* columns, plus the impact
// effects that use them.
//
// Deliberately NOT in slice A. A's own migration comment says so: "Geometry
// columns only -- the particle_* columns arrive in slice C, so this slice is
// not blocked on settling particle semantics it cannot yet draw." Those
// semantics are settled now, by having drawn the geometry first.

// The ceiling is a CHECK, not a client-side clamp. Particles are the one
// genuine performance risk in this epic (22 weapons bursting in a crowded
// neighbourhood), and the design says particle_count is "validated on write,
// not only at draw time" -- a row authored with 10000 must be impossible to
// SAVE, not merely survivable to render.
const MAX_PARTICLE_COUNT = 64;

// [name, shape, color, count, spread, speed, gravity, lifetime, size]
// Impacts are `burst` shaped: a hit reads as force leaving a point.
const IMPACTS = [
  ['spark_hit', 'burst', '#ffffff', 10, 6.283, 90, 40, 260, 2],
  ['spark_fire', 'burst', '#ff9a4d', 14, 6.283, 110, 30, 300, 2],
  ['spark_ice', 'burst', '#8fdcff', 12, 6.283, 80, 60, 320, 2],
  ['spark_lightning', 'burst', '#ffe66b', 16, 6.283, 140, 0, 200, 2],
  ['spark_arcane', 'burst', '#c08cff', 12, 6.283, 100, -20, 340, 2],
];

exports.up = (pgm) => {
  pgm.addColumns('vfx_effects', {
    // 0 means "this effect draws no particles", which is every geometry-only
    // row slices A and B seeded -- so the default keeps them behaving exactly
    // as they do today rather than silently sprouting particles.
    particle_count: { type: 'integer', notNull: true, default: 0 },
    // Radians. 6.283 is a full circle (an impact spraying every way); a
    // narrower cone is what a directional effect would use.
    particle_spread: { type: 'real', notNull: true, default: 6.283 },
    particle_speed: { type: 'real', notNull: true, default: 100 },
    // World units per second squared. Negative floats upward, which is what
    // arcane uses.
    particle_gravity: { type: 'real', notNull: true, default: 0 },
    particle_lifetime_ms: { type: 'integer', notNull: true, default: 300 },
    particle_size: { type: 'real', notNull: true, default: 2 },
  });

  pgm.addConstraint('vfx_effects', 'vfx_effects_particle_count_check',
    `CHECK (particle_count >= 0 AND particle_count <= ${MAX_PARTICLE_COUNT})`);
  // A zero or negative lifetime would divide by zero in the client's progress
  // maths; a negative size is meaningless and would reach a canvas radius.
  pgm.addConstraint('vfx_effects', 'vfx_effects_particle_lifetime_check',
    'CHECK (particle_lifetime_ms > 0)');
  pgm.addConstraint('vfx_effects', 'vfx_effects_particle_size_check',
    'CHECK (particle_size >= 0)');

  for (const [name, shape, color, count, spread, speed, gravity, lifetime, size] of IMPACTS) {
    pgm.sql(`
      INSERT INTO vfx_effects
        (name, shape, color, width, duration_ms, ease, fade, follows_weapon,
         particle_count, particle_spread, particle_speed, particle_gravity,
         particle_lifetime_ms, particle_size)
      VALUES ('${name}', '${shape}', '${color}', 2, ${lifetime}, 'out', true, false,
              ${count}, ${spread}, ${speed}, ${gravity}, ${lifetime}, ${size})
      ON CONFLICT (name) DO NOTHING
    `);
  }

  // EVERY weapon binds the NEUTRAL spark, and the element does its work at
  // draw time via the tint carried on the impact descriptor.
  //
  // Binding an elemental spark per catalog element was the obvious move and it
  // is WRONG here, which a test caught: Magic Stones gave bare magic weapons
  // "replace semantics" (items.js activeWeaponType), so a flame staff with no
  // spell stone socketed resolves to element 'physical' at attack time. A
  // static binding would have sparked fire while dealing physical damage, and
  // — worse — a weapon whose element comes from a SOCKETED stone would spark
  // in the wrong colour, because the binding is fixed at author time while the
  // element is decided per swing.
  //
  // Tinting off the EFFECTIVE element (which is what the authority sends) is
  // correct in both cases for free. The elemental spark rows above stay
  // seeded: they are there for an author who wants to bind one explicitly on a
  // weapon whose element really is fixed.
  pgm.sql(`
    UPDATE item_types SET vfx = COALESCE(vfx, '{}'::jsonb) || '{"impact":"spark_hit"}'::jsonb
     WHERE category = 'weapon'
  `);
};

exports.down = (pgm) => {
  pgm.sql("UPDATE item_types SET vfx = vfx - 'impact' WHERE category = 'weapon' AND vfx IS NOT NULL");
  const names = IMPACTS.map(([n]) => `'${n}'`).join(', ');
  pgm.sql(`DELETE FROM vfx_effects WHERE name IN (${names})`);
  pgm.dropConstraint('vfx_effects', 'vfx_effects_particle_size_check');
  pgm.dropConstraint('vfx_effects', 'vfx_effects_particle_lifetime_check');
  pgm.dropConstraint('vfx_effects', 'vfx_effects_particle_count_check');
  pgm.dropColumns('vfx_effects', [
    'particle_count', 'particle_spread', 'particle_speed', 'particle_gravity',
    'particle_lifetime_ms', 'particle_size',
  ]);
};

module.exports.IMPACTS = IMPACTS;
module.exports.MAX_PARTICLE_COUNT = MAX_PARTICLE_COUNT;
