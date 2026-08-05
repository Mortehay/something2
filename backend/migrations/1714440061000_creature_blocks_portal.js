exports.shorthands = undefined;

exports.up = (pgm) => {
  // Nullable: only a structural guard defending a specific portal sets this,
  // mirroring how home_x/home_y (1714440030000) is only meaningful for
  // guard-faction creatures. ON DELETE SET NULL, not CASCADE -- deleting the
  // portal link (e.g. an admin re-links a dungeon) must not delete the
  // guard, only stop it blocking anything.
  pgm.addColumns('world_creatures', {
    blocks_portal_id: {
      type: 'uuid',
      references: 'map_links',
      onDelete: 'SET NULL',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('world_creatures', ['blocks_portal_id']);
};
