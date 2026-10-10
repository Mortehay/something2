exports.shorthands = undefined;

// SOMET-604 (S3). The behaviour aura is now aura_effects + entity_types.auras
// (1714440680000), proven equivalent by champion_aura_golden.test.js. Dropping
// the four columns removes the second source of truth.
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE creature_behaviors DROP CONSTRAINT IF EXISTS creature_behaviors_aura_check');
  pgm.sql(`ALTER TABLE creature_behaviors
             DROP COLUMN IF EXISTS aura_radius, DROP COLUMN IF EXISTS aura_damage_mult,
             DROP COLUMN IF EXISTS aura_defense_mult, DROP COLUMN IF EXISTS aura_speed_mult`);
};

// Restores the columns with their original defaults and CHECK, and copies
// pack_leader back onto Champion, so a rollback runs the pre-S3 code unchanged.
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE creature_behaviors
             ADD COLUMN aura_radius real NOT NULL DEFAULT 0,
             ADD COLUMN aura_damage_mult real NOT NULL DEFAULT 1,
             ADD COLUMN aura_defense_mult real NOT NULL DEFAULT 1,
             ADD COLUMN aura_speed_mult real NOT NULL DEFAULT 1`);
  pgm.sql(`ALTER TABLE creature_behaviors ADD CONSTRAINT creature_behaviors_aura_check
             CHECK (aura_radius >= 0 AND aura_damage_mult > 0 AND aura_defense_mult > 0 AND aura_speed_mult > 0)`);
  pgm.sql(`UPDATE creature_behaviors b
              SET aura_radius = a.radius, aura_damage_mult = a.damage_mult,
                  aura_defense_mult = a.defense_mult, aura_speed_mult = a.speed_mult
             FROM aura_effects a WHERE a.name = 'pack_leader' AND b.name = 'Champion'`);
};
