/* eslint-disable camelcase */
// sprite_sets.redraw_actions (SOMET-711): "Redraw selected actions". When true
// the reuse planner draws the row's requested actions again even where the
// earlier sheet already has them; the sheet's other actions are still kept.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_sets', { redraw_actions: { type: 'boolean', notNull: true, default: false } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', 'redraw_actions');
};
