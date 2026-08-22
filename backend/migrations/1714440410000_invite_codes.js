/* eslint-disable camelcase */
// SOMET-381. Invite codes, for REGISTRATION_MODE=invite.
//
// Timestamp picked against the tree (latest on main was 1714440400000), not
// guessed: colliding timestamps have broken `migrate:up` in this project more
// than once, and node-pg-migrate's ordering error blames the wrong migration
// when it happens.
//
// `used_by` is ON DELETE SET NULL rather than CASCADE: deleting a user must
// not delete the record that a code was spent. The code stays burned, which is
// the point of tracking it -- otherwise removing an account silently returns
// its invite to circulation.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('invite_codes', {
    code: { type: 'citext', primaryKey: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    note: { type: 'text' },                       // who it was issued to, free text
    used_at: { type: 'timestamptz' },
    used_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
  });

  // The only query the register path makes is "is this code present and
  // unspent", and it runs on an unauthenticated endpoint, so it is worth an
  // index rather than a scan.
  pgm.createIndex('invite_codes', 'used_at', {
    name: 'invite_codes_unused_index',
    where: 'used_at IS NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('invite_codes');
};
