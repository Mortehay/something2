// backend/migrations/1714440811000_map_spec_state_base.js
//
// SOMET-641 (Seed/Export plan 4a, Task 4). map_spec_state.base_spec: the
// canonical text of the spec version this PC last applied or exported -- the
// three-way BASE of the Maps group. A hand edit is "the writer's output for
// the current DB differs from the base"; git is newer when git's hash differs
// from the base's. Without a copy of the base, a PC whose git moved on could
// only compare its DB with the NEW spec and would see every git change as a
// conflict. Text, not jsonb: the canonical form depends on key order.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('map_spec_state', { base_spec: { type: 'text' } });
};

exports.down = (pgm) => {
  pgm.dropColumns('map_spec_state', ['base_spec']);
};
