/* eslint-disable camelcase */

exports.shorthands = undefined;

// SOMET-677 rework: the user does not want the shine glint on props; every
// prop on 'shine' moves to 'drift', which is now also the default effect a
// newly queued prop gets. Shine stays a valid, selectable option. sprite_sets
// carries the effect that approve copies, so a re-approve keeps drift too.
exports.up = (pgm) => {
  pgm.sql(`UPDATE entity_types SET idle_fx = 'drift' WHERE idle_fx = 'shine'`);
  pgm.sql(`UPDATE sprite_sets SET prop_fx = 'drift' WHERE prop_fx = 'shine'`);
};

// No down: once up has run, a drift row may be one an admin chose, so there is
// no telling which rows were shine before.
exports.down = () => {};
