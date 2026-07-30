exports.shorthands = undefined;

// Canvas coordinates for the World Map admin tab. Purely cosmetic: nothing in
// world generation, collision or the authority reads these. Nullable with no
// default, so every existing world starts unpositioned and the client seeds a
// layout for it — opening the tab never writes to the database.
exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    graph_x: { type: 'double precision', notNull: false },
    graph_y: { type: 'double precision', notNull: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('worlds', ['graph_x', 'graph_y']);
};
