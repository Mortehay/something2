/* eslint-disable camelcase */
// Email accounts: invite requests, email verification, password reset.
//
// Timestamp picked against the tree (latest on main and in this worktree was
// 1714440885000), not guessed: colliding timestamps have broken `migrate:up`
// here before.
//
// `users.email` is NOT unique on its own. An unverified address is a claim,
// not ownership, so only a VERIFIED email is unique (partial index). That
// stops someone squatting an address they do not control.
//
// `invite_requests.invite_code` and `.decided_by` are ON DELETE SET NULL: the
// request is a record of a decision and must survive the code or the admin
// being deleted.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('users', {
    email: { type: 'citext' },
    email_verified_at: { type: 'timestamptz' },
  });
  pgm.createIndex('users', 'email', {
    name: 'users_verified_email_unique',
    unique: true,
    where: 'email_verified_at IS NOT NULL',
  });

  pgm.addColumns('invite_codes', { email: { type: 'citext' } });

  pgm.createTable('invite_requests', {
    id: 'id',
    email: { type: 'citext', notNull: true },
    note: { type: 'text', check: 'char_length(note) <= 300' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending','approved','rejected')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    decided_at: { type: 'timestamptz' },
    decided_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    invite_code: {
      type: 'citext',
      references: 'invite_codes(code)',
      onDelete: 'SET NULL',
    },
  });
  pgm.createIndex('invite_requests', 'email', {
    name: 'invite_requests_one_pending',
    unique: true,
    where: "status = 'pending'",
  });

  pgm.createTable('email_tokens', {
    token_hash: { type: 'text', primaryKey: true },
    user_id: {
      type: 'integer',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    purpose: {
      type: 'text',
      notNull: true,
      check: "purpose IN ('verify_email','reset_password')",
    },
    email: { type: 'citext', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('email_tokens', ['user_id', 'purpose'], {
    name: 'email_tokens_user_purpose_index',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('email_tokens');
  pgm.dropTable('invite_requests');
  pgm.dropColumns('invite_codes', ['email']);
  pgm.dropIndex('users', 'email', { name: 'users_verified_email_unique' });
  pgm.dropColumns('users', ['email', 'email_verified_at']);
};
