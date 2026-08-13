exports.shorthands = undefined;

// The waypoint network (SOMET-292, home-region spec §5).
//
// ONE REGISTRY, NOT TWO KINDS OF WAYPOINT. The design names two sources -- a
// standalone tile, and a hand-picked staircase opted in with
// map_links.is_waypoint -- but only ONE activation table, keyed on a single
// waypoint_id. Those cannot both be true unless a flagged portal also has a
// registry row, so that is what this builds: `waypoints` is the registry the
// runtime reads, `is_waypoint` is the authored intent a map spec writes, and a
// portal-backed waypoint is a `waypoints` row carrying map_link_id.
//
// The alternative -- two nullable FKs on character_waypoints under an
// exactly-one-of CHECK -- gives the tick loop two tables to scan, the read API
// two queries to union and the travel popup two shapes to render. Every one of
// those is a place for the halves to drift, and this repo's recorded failure
// mode (SOMET-249) is exactly a feature wired into one of two paths and dead in
// the other.
exports.up = (pgm) => {
  pgm.createTable('waypoints', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    // Pixels, the same units as map_links.from_x/from_y -- a spec authors a
    // waypoint next to the portal coordinates it sits among, and two
    // coordinate conventions in one file is how one of them ends up wrong.
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    name: { type: 'text', notNull: true },
    // Set only for a waypoint that IS a staircase. ON DELETE SET NULL rather
    // than CASCADE, following blocks_portal_id (1714440061000): re-linking a
    // dungeon must not delete the guard, and here it must not delete the
    // waypoint -- which would take every character's activation of it down
    // with it. A relinked staircase leaves a standalone waypoint on the tile.
    map_link_id: { type: 'uuid', references: 'map_links', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Globally unique, not per world. The travel popup lists waypoints ACROSS
  // worlds, so two "Old Well" entries are indistinguishable to the player
  // picking one. Same reasoning as worlds_name_unique (1714440037000).
  pgm.addConstraint('waypoints', 'waypoints_name_unique', { unique: ['name'] });

  // Tile granularity, NOT (world_id, x, y). The authority keys waypoints by
  // floor(y/100),floor(x/100) -- the same tile arithmetic every other tile rule
  // in the tick loop uses -- so two rows in one tile at different pixel offsets
  // are not two waypoints: one of them is simply unreachable. Pin the invariant
  // the runtime actually has rather than a weaker one that looks similar.
  pgm.sql(`CREATE UNIQUE INDEX waypoints_world_tile_unique
             ON waypoints (world_id, floor(y / 100), floor(x / 100))`);

  pgm.createIndex('waypoints', 'world_id');

  // Partial: many waypoints have no link, and NULLs must not collide. One
  // registry row per staircase.
  pgm.createIndex('waypoints', 'map_link_id', {
    name: 'waypoints_map_link_unique', unique: true, where: 'map_link_id IS NOT NULL',
  });

  // The authored opt-in. Kept on map_links (rather than inferred from a
  // waypoints row) because it is what a map author writes and what the map-spec
  // validator gates: the load-bearing rule is that a portal referenced by any
  // creature's blocks_portal_id may never carry this flag.
  pgm.addColumns('map_links', {
    is_waypoint: { type: 'boolean', notNull: true, default: false },
  });

  // Per CHARACTER, for the same reason character_visited_worlds (1714440160000)
  // is: two characters on one account explore independently, which is the whole
  // point of having eight of them.
  //
  // The composite PRIMARY KEY *is* the idempotency guarantee -- activation runs
  // off a hot tick path and will be attempted again on every relog, so the
  // database, not the caller, has to be the thing that makes a repeat harmless.
  // A surrogate id here would let one character activate one waypoint twice.
  pgm.createTable('character_waypoints', {
    character_id: { type: 'integer', notNull: true, references: 'characters', onDelete: 'CASCADE' },
    waypoint_id: { type: 'uuid', notNull: true, references: 'waypoints', onDelete: 'CASCADE' },
    activated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { primaryKey: ['character_id', 'waypoint_id'] },
  });
  // The PK covers (character_id, ...) lookups; this covers the other direction,
  // which is what "who has lit this waypoint" and the FK's own delete check use.
  pgm.createIndex('character_waypoints', 'waypoint_id');
};

exports.down = (pgm) => {
  // FK order: the activation rows reference waypoints, which reference
  // map_links. Dropping the column first would fail on waypoints_map_link_fkey.
  pgm.dropTable('character_waypoints');
  pgm.dropTable('waypoints');
  pgm.dropColumns('map_links', ['is_waypoint']);
};
