/* eslint-disable camelcase */

// SOMET-517. Admit the `greater` node kind.
//
// passive_nodes_kind_check was authored as
//   CHECK (kind IN ('minor','notable','keystone','start'))
// so the seeder cannot insert a greater until this runs. Without it
// `make seed-passive-tree` fails on the first ring-3 greater with a constraint
// violation -- loudly, which is the good outcome; the bad one would be a
// silently narrower tree.
//
// The four existing kinds are re-listed rather than the constraint being
// widened by name, because a CHECK cannot be altered in place: it is dropped
// and recreated, and the recreated one has to carry the whole vocabulary.

exports.up = (pgm) => {
  pgm.dropConstraint('passive_nodes', 'passive_nodes_kind_check');
  pgm.addConstraint('passive_nodes', 'passive_nodes_kind_check',
    "CHECK (kind IN ('minor','notable','greater','keystone','start'))");
};

// Reversible ONLY while no greater rows exist -- recreating the narrower
// constraint over a seeded tree would fail, which is correct: silently
// deleting a player's allocated nodes to make a down-migration succeed would
// be far worse than refusing to run.
exports.down = (pgm) => {
  pgm.dropConstraint('passive_nodes', 'passive_nodes_kind_check');
  pgm.addConstraint('passive_nodes', 'passive_nodes_kind_check',
    "CHECK (kind IN ('minor','notable','keystone','start'))");
};
