/* eslint-disable camelcase */

// Seed comprehensive skill Attack Effects into vfx_effects for the Attack Effects admin tab.
const SKILL_EFFECTS = [
  // Fire & Pyromancy
  ['fireball_blast', 'burst', '#ff5500', 3, 350, 'out', true, false, 32, 6.283, 180, -30, 450, 4],
  ['flame_wave', 'arc', '#ff6600', 4, 280, 'out', true, true, 24, 6.283, 140, 0, 350, 3],
  ['meteor_impact', 'ring', '#ff3300', 5, 400, 'out', true, false, 40, 6.283, 220, 50, 500, 4],
  ['combustion', 'burst', '#ffaa00', 3, 250, 'out', true, false, 28, 6.283, 160, 0, 300, 3],

  // Lightning & Storm
  ['lightning_strike', 'bolt', '#ffee44', 4, 220, 'linear', true, true, 30, 6.283, 240, 0, 280, 3],
  ['chain_lightning', 'bolt', '#ffff88', 3, 200, 'linear', true, true, 25, 6.283, 200, 0, 240, 3],
  ['thunder_clap', 'ring', '#ffffaa', 4, 300, 'out', true, false, 24, 6.283, 180, 0, 320, 3],
  ['storm_burst', 'burst', '#fff066', 3, 250, 'out', true, false, 28, 6.283, 200, 0, 300, 3],

  // Frost & Ice
  ['frost_nova', 'ring', '#7fe8ff', 4, 350, 'out', true, false, 32, 6.283, 130, 0, 400, 3],
  ['ice_shard', 'bolt', '#a6f0ff', 3, 220, 'linear', true, true, 16, 6.283, 150, 0, 250, 3],
  ['blizzard_blast', 'burst', '#c8f5ff', 3, 400, 'out', true, false, 36, 6.283, 140, 40, 450, 3],
  ['glacial_spike', 'line', '#88e0ff', 4, 260, 'out', true, true, 20, 6.283, 120, 0, 300, 3],

  // Holy & Divine
  ['holy_pillar', 'burst', '#ffe866', 4, 380, 'out', true, false, 36, 6.283, 160, -40, 450, 3],
  ['divine_smite', 'arc', '#fff399', 4, 240, 'out', true, true, 24, 6.283, 140, 0, 280, 3],
  ['holy_nova', 'ring', '#fff8b3', 4, 320, 'out', true, false, 28, 6.283, 150, 0, 340, 3],
  ['judgment_ray', 'line', '#ffee77', 5, 260, 'out', true, true, 20, 6.283, 160, 0, 300, 3],

  // Shadow & Cultist
  ['shadow_vortex', 'ring', '#aa44ff', 4, 360, 'out', true, false, 32, 6.283, 120, -30, 420, 3],
  ['void_bolt', 'bolt', '#c055ff', 3, 240, 'linear', true, true, 20, 6.283, 170, 0, 280, 3],
  ['soul_drain', 'line', '#7722aa', 3, 300, 'out', true, true, 18, 6.283, 90, 0, 350, 3],
  ['curse_blast', 'burst', '#9933dd', 3, 280, 'out', true, false, 24, 6.283, 140, 0, 320, 3],

  // Nature & Druid
  ['entangling_roots', 'burst', '#55cc44', 4, 340, 'out', true, false, 26, 6.283, 110, 0, 380, 3],
  ['bear_maul', 'arc', '#dd8833', 4, 200, 'out', true, true, 20, 6.283, 150, 0, 250, 3],
  ['wolf_bite', 'arc', '#aacc33', 3, 170, 'out', true, true, 16, 6.283, 140, 0, 200, 3],
  ['hawk_talon', 'line', '#88ee66', 3, 180, 'out', true, true, 18, 6.283, 160, 0, 220, 3],

  // Warrior / Physical / Rogue
  ['crushing_blow', 'arc', '#ffaa44', 5, 240, 'out', true, true, 24, 6.283, 160, 0, 300, 3],
  ['whirlwind', 'ring', '#e0e0e0', 4, 320, 'out', true, false, 30, 6.283, 180, 0, 340, 3],
  ['piercing_thrust', 'line', '#ffffff', 4, 180, 'out', true, true, 16, 6.283, 160, 0, 220, 3],
  ['shield_slam', 'burst', '#e8c468', 4, 220, 'out', true, false, 22, 6.283, 150, 0, 260, 3],
  ['cleave', 'arc', '#ffcc66', 4, 200, 'out', true, true, 20, 6.283, 140, 0, 240, 3],
  ['backstab', 'line', '#ff4466', 3, 160, 'out', true, true, 18, 6.283, 170, 0, 200, 3],

  // Mage & Arcane & Chrono
  ['arcane_beam', 'line', '#a855f7', 5, 450, 'out', true, true, 28, 6.283, 180, 0, 360, 3],
  ['fire_wall', 'line', '#f97316', 5, 550, 'out', true, false, 32, 6.283, 120, -20, 450, 4],
  ['blast_wave', 'ring', '#ea580c', 4, 340, 'out', true, false, 30, 6.283, 190, 0, 360, 3],
  ['mirror_image', 'burst', '#c084fc', 3, 450, 'out', true, false, 24, 6.283, 140, 0, 380, 3],
  ['temporal_warp', 'ring', '#6366f1', 4, 500, 'out', true, false, 28, 6.283, 160, 0, 420, 3],
  ['prismatic_burst', 'burst', '#f472b6', 4, 380, 'out', true, false, 32, 6.283, 170, 0, 380, 4],
  ['polymorph', 'burst', '#fb7185', 3, 340, 'out', true, false, 26, 6.283, 150, 0, 320, 3],
  ['ball_lightning', 'burst', '#38bdf8', 4, 360, 'out', true, false, 32, 6.283, 200, 0, 380, 3],
  ['gravity_singularity', 'ring', '#6b21a8', 5, 550, 'out', true, false, 36, 6.283, 140, -40, 480, 4],
  ['blink_flash', 'burst', '#e0e7ff', 4, 250, 'out', true, false, 24, 6.283, 190, 0, 260, 3],

  // Archer & Ranger
  ['barrage_shot', 'line', '#f59e0b', 3, 180, 'out', true, true, 16, 6.283, 160, 0, 220, 2],
  ['rain_of_arrows', 'burst', '#d97706', 3, 400, 'out', true, false, 32, 6.283, 150, 30, 420, 3],
  ['poison_dart', 'line', '#22c55e', 3, 200, 'out', true, true, 18, 6.283, 140, 0, 240, 3],
  ['caltrops', 'burst', '#71717a', 3, 300, 'out', true, false, 20, 6.283, 110, 20, 320, 2],
  ['shuriken', 'arc', '#94a3b8', 3, 190, 'out', true, true, 18, 6.283, 150, 0, 220, 3],

  // Necromancer & Cultist
  ['scythe_sweep', 'arc', '#7c3aed', 5, 260, 'out', true, true, 26, 6.283, 160, 0, 300, 3],
  ['blood_surge', 'burst', '#dc2626', 4, 360, 'out', true, false, 30, 6.283, 170, 0, 380, 3],
  ['skull_bolt', 'bolt', '#8b5cf6', 3, 240, 'linear', true, true, 20, 6.283, 160, 0, 260, 3],

  // Paladin & Templar
  ['holy_cross', 'burst', '#fde047', 4, 340, 'out', true, false, 28, 6.283, 160, 0, 360, 3],
  ['hammer_smash', 'burst', '#eab308', 5, 260, 'out', true, false, 26, 6.283, 170, 0, 300, 4],

  // Druid & Shaman
  ['tornado', 'ring', '#cbd5e1', 4, 420, 'out', true, false, 28, 6.283, 180, -20, 400, 3],
  ['nature_seed', 'burst', '#84cc16', 3, 320, 'out', true, false, 22, 6.283, 130, 0, 340, 3],
];

exports.up = (pgm) => {
  for (const [name, shape, color, width, duration_ms, ease, fade, follows_weapon, count, spread, speed, gravity, lifetime, size] of SKILL_EFFECTS) {
    pgm.sql(`
      INSERT INTO vfx_effects
        (name, shape, color, width, duration_ms, ease, fade, follows_weapon,
         particle_count, particle_spread, particle_speed, particle_gravity,
         particle_lifetime_ms, particle_size)
      VALUES ('${name}', '${shape}', '${color}', ${width}, ${duration_ms}, '${ease}', ${fade}, ${follows_weapon},
              ${count}, ${spread}, ${speed}, ${gravity}, ${lifetime}, ${size})
      ON CONFLICT (name) DO UPDATE SET
        shape = EXCLUDED.shape,
        color = EXCLUDED.color,
        width = EXCLUDED.width,
        duration_ms = EXCLUDED.duration_ms,
        ease = EXCLUDED.ease,
        fade = EXCLUDED.fade,
        follows_weapon = EXCLUDED.follows_weapon,
        particle_count = EXCLUDED.particle_count,
        particle_spread = EXCLUDED.particle_spread,
        particle_speed = EXCLUDED.particle_speed,
        particle_gravity = EXCLUDED.particle_gravity,
        particle_lifetime_ms = EXCLUDED.particle_lifetime_ms,
        particle_size = EXCLUDED.particle_size
    `);
  }
};

exports.down = (pgm) => {
  const names = SKILL_EFFECTS.map(([n]) => `'${n}'`).join(', ');
  pgm.sql(`DELETE FROM vfx_effects WHERE name IN (${names})`);
};
