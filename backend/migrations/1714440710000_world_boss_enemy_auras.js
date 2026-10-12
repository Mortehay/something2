exports.shorthands = undefined;

// SOMET-606 (S4, ruling G1). One enemies aura per world boss, so the new
// aura-against-players pass has something to do in the live game. The values
// are placeholders: SOMET-613 tunes them. Colours are the boss rows' own
// (1714440671000).
//
// Literals, frozen, and exported: world_boss_auras_parity.test.js pins them to
// seeds/data/auraEffects.js, so a fresh DB (seed-catalogs) and an existing one
// (this migration) end up with the same rows.
exports.BOSS_AURAS = [
  { name: 'ignis_inferno', target_side: 'enemies', radius: 360, damage_mult: 1, defense_mult: 1, speed_mult: 1,
    dot_dps: 6, dot_element: 'fire', tick_ms: 1000, shape: 'ring', color: '#ff4757', pulse_ms: 1200 },
  { name: 'glacius_permafrost', target_side: 'enemies', radius: 400, damage_mult: 1, defense_mult: 1, speed_mult: 0.7,
    dot_dps: 0, dot_element: 'physical', tick_ms: 1000, shape: 'ring', color: '#70a1ff', pulse_ms: 1200 },
  { name: 'abyssor_void_rend', target_side: 'enemies', radius: 360, damage_mult: 1, defense_mult: 0.7, speed_mult: 1,
    dot_dps: 0, dot_element: 'physical', tick_ms: 1000, shape: 'ring', color: '#a55eea', pulse_ms: 1200 },
  { name: 'gorgon_static_field', target_side: 'enemies', radius: 380, damage_mult: 0.8, defense_mult: 1, speed_mult: 1,
    dot_dps: 0, dot_element: 'physical', tick_ms: 1000, shape: 'ring', color: '#ffd166', pulse_ms: 1200 },
];
exports.BOSS_AURA_BINDINGS = {
  'Ignis, the Magma Colossus': ['ignis_inferno'],
  'Glacius, the Frost Leviathan': ['glacius_permafrost'],
  'Abyssor, the Voidreaver': ['abyssor_void_rend'],
  'Gorgon, the Thunder Titan': ['gorgon_static_field'],
};

exports.up = (pgm) => {
  for (const a of exports.BOSS_AURAS) {
    pgm.sql(
      `INSERT INTO aura_effects (${COLS.join(', ')})
       VALUES (${COLS.map((c) => lit(a[c])).join(', ')})
       ON CONFLICT (name) DO NOTHING`,
    );
  }
  // SET, not 1714440680000's append: append would turn an admin's [] into
  // ["x"]. NULL only ("never authored"), keyed by name AND boss_tier.
  for (const [name, auras] of Object.entries(exports.BOSS_AURA_BINDINGS)) {
    pgm.sql(
      `UPDATE entity_types SET auras = ${lit(JSON.stringify(auras))}::jsonb
        WHERE name = ${lit(name)} AND boss_tier = 'world' AND auras IS NULL`,
    );
  }
};

exports.down = (pgm) => {
  // Only rows still exactly as this migration bound them; an admin's edit stays.
  for (const [name, auras] of Object.entries(exports.BOSS_AURA_BINDINGS)) {
    pgm.sql(
      `UPDATE entity_types SET auras = NULL
        WHERE name = ${lit(name)} AND auras = ${lit(JSON.stringify(auras))}::jsonb`,
    );
  }
  const names = exports.BOSS_AURAS.map((a) => lit(a.name)).join(', ');
  pgm.sql(
    `DELETE FROM aura_effects
      WHERE name IN (${names})
        AND NOT EXISTS (SELECT 1 FROM entity_types WHERE jsonb_typeof(auras) = 'array' AND auras ? aura_effects.name)`,
  );
};

const COLS = ['name', 'target_side', 'radius', 'damage_mult', 'defense_mult', 'speed_mult',
  'dot_dps', 'dot_element', 'tick_ms', 'shape', 'color', 'pulse_ms'];
// Every value here is one of our own literals above; quote strings, pass numbers.
function lit(v) {
  return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
}
