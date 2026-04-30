exports.up = pgm => {
  pgm.createTable("map_environments", {
    id: { 
      type: "uuid", 
      primaryKey: true, 
      default: pgm.func("uuid_generate_v4()") 
    },
    map_id: { 
      type: "uuid",
      notNull: true,
      references: '"maps"',
      onDelete: 'CASCADE'
    },
    data: { type: "jsonb", notNull: true },
    created_at: {
      type: "timestamp with time zone",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
    updated_at: {
      type: "timestamp with time zone",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  }, { ifNotExists: true });

  pgm.createIndex("map_environments", "map_id");
};

exports.down = pgm => {
    pgm.dropTable("map_environments");
};
