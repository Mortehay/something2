/* eslint-disable no-undef */

exports.shorthands = undefined;

exports.up = pgm => {
  pgm.createExtension("uuid-ossp", { ifNotExists: true });
  
  pgm.createTable("maps", {
    id: { 
      type: "uuid", 
      primaryKey: true, 
      default: pgm.func("uuid_generate_v4()") 
    },
    name: { type: "varchar(255)", notNull: true },
    data: { type: "jsonb", notNull: true },
    description: { type: "text" },
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
};

exports.down = pgm => {
    pgm.dropTable("maps");
};
