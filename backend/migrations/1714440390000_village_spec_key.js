/* eslint-disable camelcase */

// A village's identity beyond its box (SOMET-312).
//
// scripts/seed-map.js used to match a spec's villages against the live rows by
// COUNT alone: a world that already held a village was skipped whole, and only
// a count difference warned. So moving a village's box in a spec and re-seeding
// in place was a silent no-op -- 1 row vs 1 declaration, nothing to report --
// and the world kept a village 16 tiles from where the spec (and the entry
// spawn derived from it) said it was. That is SOMET-308's observed failure: the
// player spawned at the resized world's centre on open grass with the village
// still sitting at its old position.
//
// `spec_key` is that identity. It is the `key` of the map-spec village entry the
// row was seeded from, so the applier can ask "where is village `commons` now?"
// and MOVE it, rather than asking "does this world have any village at all?"
// and skipping.
//
// NULLABLE, and deliberately NOT backfilled here.
//
//  - Nullable because POST /api/worlds/:id/villages (src/index.js) creates
//    villages that no spec authors. Those rows have no spec identity and must
//    not be given a fake one.
//  - Not backfilled because SOMET-335 is the standing lesson in this repo: a
//    migration that repairs seeded content is undone by the next re-seed, so
//    the repair has to live where the seed can see it. applyMapSpec ADOPTS an
//    unkeyed row into a spec key on the next run (exact box match first, then
//    the unambiguous one-left-over case), which converges every live database
//    -- migrated, re-seeded or freshly created -- through the one code path
//    that is also the one being tested. A literal backfill here would only
//    duplicate the seven boxes the specs already carry, and would be wrong the
//    moment a spec moved one.
//
// UNIQUE per world, not globally: two different maps may both name their
// village `commons`, and `key` in a map spec is already only unique within its
// own spec. Partial, so the unkeyed admin-created rows above do not collide
// with each other (in Postgres several NULLs never collide anyway -- the WHERE
// clause states the intent and keeps the index off rows it can never serve).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('villages', {
    spec_key: { type: 'text' },
  });
  pgm.createIndex('villages', ['world_id', 'spec_key'], {
    name: 'villages_world_spec_key_unique',
    unique: true,
    where: 'spec_key IS NOT NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('villages', ['world_id', 'spec_key'], { name: 'villages_world_spec_key_unique' });
  pgm.dropColumns('villages', ['spec_key']);
};
