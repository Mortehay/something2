/* eslint-disable camelcase */
// sprite_sets.reuse_base_id (SOMET-702): the finished sheet an incremental
// re-run keeps frames from. Recorded with the box job, so a job resumed after
// a restart merges against the same base. No foreign key on purpose: a deleted
// base must stay visible as a dangling id (the row then fails with a clear
// error) instead of being nulled into a full-sheet intake of a partial job.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_sets', { reuse_base_id: { type: 'uuid' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', 'reuse_base_id');
};
