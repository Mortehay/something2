exports.up = (pgm) => {
  pgm.addColumn('entity_types', {
    is_creature: { type: 'boolean', notNull: true, default: false },
  });
  // Backfill to preserve prior spawn behavior: the old creature-spawn heuristic
  // was `hp > 0 && name !== 'Player'`. Flag those so existing worlds keep
  // spawning the same creatures on a fresh deploy (matches the render_mode
  // migration's backfill precedent). New rows default to false (opt-in).
  pgm.sql("UPDATE entity_types SET is_creature = true WHERE hp > 0 AND name <> 'Player'");
};

exports.down = (pgm) => {
  pgm.dropColumn('entity_types', 'is_creature');
};
