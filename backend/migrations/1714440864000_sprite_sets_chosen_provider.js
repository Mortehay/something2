/* eslint-disable camelcase */
// sprite_sets.chosen_provider_id (SOMET-712): the sprite connector the admin
// chose for this row in the Sprite tab, or NULL = the active connector at draw
// time. Separate from provider_id, which the box-attach step writes on every
// row and so cannot tell "chosen" from "happened to draw it".
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_sets', { chosen_provider_id: { type: 'integer' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', 'chosen_provider_id');
};
