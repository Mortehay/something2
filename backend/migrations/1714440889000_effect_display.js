/* eslint-disable camelcase */
// SOMET-769: how an effect row is shown in game -- 'sprite' (its sheet may be
// used; the player's Animations setting then decides) or 'code' (the drawn
// version only, whatever the player chose). One column on each effect table.
// Existing rows keep today's behaviour: 'sprite'.

exports.shorthands = undefined;

const TABLES = ['vfx_effects', 'aura_effects', 'buff_visuals', 'status_visuals'];

exports.up = (pgm) => {
  for (const t of TABLES) {
    pgm.addColumns(t, { display: { type: 'text', notNull: true, default: 'sprite' } });
    pgm.addConstraint(t, `${t}_display_check`, { check: "display IN ('code', 'sprite')" });
  }
};

exports.down = (pgm) => {
  for (const t of TABLES) {
    pgm.dropConstraint(t, `${t}_display_check`);
    pgm.dropColumns(t, ['display']);
  }
};
