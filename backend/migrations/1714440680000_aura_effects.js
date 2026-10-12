exports.shorthands = undefined;

// SOMET-604 (S3). The aura LIBRARY. Until now an aura was four columns on
// creature_behaviors (1714440085000), one per behaviour, ally-only. This table
// lets any entity carry any number of auras by NAME (entity_types.auras, jsonb,
// no FK -- the same trade-off as vfx: an unknown name is a no-op + one log).
//
// Every enum and bound is a CHECK. The API (services/auraEffects.js) and the
// form (auraForm.js) repeat the same rules on purpose: the DB is the backstop,
// the API names the problem, the form names it before a round trip.
//
// radius <= 2000: the aura pass is O(sources x creatures). A typo'd 26000
// would buff a whole world; 2000 is ~8x Champion's 260.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aura_effects (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      target_side text NOT NULL DEFAULT 'allies',
      radius real NOT NULL,
      damage_mult real NOT NULL DEFAULT 1,
      defense_mult real NOT NULL DEFAULT 1,
      speed_mult real NOT NULL DEFAULT 1,
      dot_dps real NOT NULL DEFAULT 0,
      dot_element text NOT NULL DEFAULT 'physical'
        REFERENCES elements(name) ON UPDATE CASCADE ON DELETE RESTRICT,
      tick_ms integer NOT NULL DEFAULT 1000,
      shape text NOT NULL DEFAULT 'ring',
      color text NOT NULL DEFAULT '#d4a017',
      pulse_ms integer NOT NULL DEFAULT 1200,
      particle_count integer NOT NULL DEFAULT 0,
      particle_spread real NOT NULL DEFAULT 6.283,
      particle_speed real NOT NULL DEFAULT 100,
      particle_gravity real NOT NULL DEFAULT 0,
      particle_lifetime_ms integer NOT NULL DEFAULT 300,
      particle_size real NOT NULL DEFAULT 2,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT aura_effects_name_check CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
      CONSTRAINT aura_effects_side_check CHECK (target_side IN ('allies', 'enemies')),
      CONSTRAINT aura_effects_radius_check CHECK (radius > 0 AND radius <= 2000),
      CONSTRAINT aura_effects_mult_check CHECK (damage_mult > 0 AND defense_mult > 0 AND speed_mult > 0),
      CONSTRAINT aura_effects_dot_check CHECK (dot_dps >= 0),
      CONSTRAINT aura_effects_dot_side_check CHECK (target_side = 'enemies' OR dot_dps = 0),
      CONSTRAINT aura_effects_tick_check CHECK (tick_ms BETWEEN 100 AND 5000),
      CONSTRAINT aura_effects_shape_check CHECK (shape IN ('ring', 'disc', 'particles')),
      CONSTRAINT aura_effects_color_check CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
      CONSTRAINT aura_effects_pulse_check CHECK (pulse_ms >= 0 AND pulse_ms <= 10000),
      CONSTRAINT aura_effects_particle_count_check CHECK (particle_count >= 0 AND particle_count <= 64),
      CONSTRAINT aura_effects_particle_lifetime_check CHECK (particle_lifetime_ms > 0),
      CONSTRAINT aura_effects_particle_size_check CHECK (particle_size >= 0)
    )
  `);

  // S1 adds the same column on its own branch. IF NOT EXISTS makes the two
  // migrations commute.
  pgm.sql('ALTER TABLE entity_types ADD COLUMN IF NOT EXISTS auras jsonb');

  // pack_leader = Champion's CURRENT values (an admin may have retuned them),
  // read from the row rather than retyped. The second INSERT is the floor for a
  // DB where Champion was deleted or had its aura switched off: the library
  // must still hold pack_leader, because the seeder binds it by name.
  pgm.sql(`
    INSERT INTO aura_effects (name, target_side, radius, damage_mult, defense_mult, speed_mult)
    SELECT 'pack_leader', 'allies', aura_radius, aura_damage_mult, aura_defense_mult, aura_speed_mult
      FROM creature_behaviors WHERE name = 'Champion' AND aura_radius > 0
    ON CONFLICT (name) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO aura_effects (name, target_side, radius, damage_mult, defense_mult, speed_mult)
    VALUES ('pack_leader', 'allies', 260, 1.25, 1.2, 1.1)
    ON CONFLICT (name) DO NOTHING
  `);

  // Bind it to every entity whose behaviour is a LIVE Champion aura. Appends
  // rather than overwrites, so an S1-authored binding survives.
  pgm.sql(`
    UPDATE entity_types e
       SET auras = COALESCE(e.auras, '[]'::jsonb) || '["pack_leader"]'::jsonb
      FROM creature_behaviors b
     WHERE b.id = e.behavior_id AND b.name = 'Champion' AND b.aura_radius > 0
       AND NOT (COALESCE(e.auras, '[]'::jsonb) ? 'pack_leader')
  `);
};

exports.down = (pgm) => {
  // entity_types.auras is deliberately left in place: S1 owns it too, and the
  // drop would destroy S1's bindings. Only this slice's own table goes.
  pgm.sql("UPDATE entity_types SET auras = auras - 'pack_leader' WHERE auras ? 'pack_leader'");
  pgm.sql('DROP TABLE IF EXISTS aura_effects');
};
