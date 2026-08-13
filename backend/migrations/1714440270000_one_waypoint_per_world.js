/* eslint-disable camelcase */

// At most one travel landmark per world (SOMET-300).
//
// The map-spec validator rejects a world declaring two, which catches the
// authoring mistake a person actually makes, with a message naming the world.
// This index catches everything the front door does not: a hand-written INSERT,
// another migration, a future service that upserts. A rule enforced only in the
// validator is a rule that applies only to people who use the validator.
//
// NOT the same as waypoints_world_tile_unique, which already exists. That one is
// UNIQUE (world_id, floor(y/100), floor(x/100)) -- one landmark per TILE, so two
// portals in the same world on different tiles pass it happily. That is exactly
// the state SOMET-299 shipped and this ceiling removes.
//
// Safe to build: 1714440260000 removed the portal pad, and the three home worlds
// hold one waypoint each. one_portal_per_world.test.js asserts no live world
// exceeds the ceiling, so a database that would refuse this index fails there
// with a readable message rather than here with a raw constraint error.

exports.up = (pgm) => {
  pgm.createIndex('waypoints', 'world_id', {
    name: 'waypoints_world_unique',
    unique: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('waypoints', 'world_id', { name: 'waypoints_world_unique' });
};
