/* eslint-disable camelcase */
// Profile page: change-email tokens and player-created invite codes.
//
// email_tokens.purpose CHECK is widened to allow 'change_email'. The
// constraint was created inline, so Postgres named it email_tokens_purpose_check.
//
// invite_codes.created_by is ON DELETE SET NULL: the code is a record and
// must outlive the player who made it (it still counts toward nothing once
// the creator is gone, but a spent code must stay spent).
// revoked_at is a soft revoke by the creator; claimInviteCode refuses it.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint('email_tokens', 'email_tokens_purpose_check');
  pgm.addConstraint('email_tokens', 'email_tokens_purpose_check', {
    check: "purpose IN ('verify_email','reset_password','change_email')",
  });

  pgm.addColumns('invite_codes', {
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.createIndex('invite_codes', ['created_by', 'created_at'], {
    name: 'invite_codes_created_by_created_at_index',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('invite_codes', ['created_by', 'created_at'], {
    name: 'invite_codes_created_by_created_at_index',
  });
  // Burn soft-revoked unused codes first: without revoked_at they would become claimable again.
  pgm.sql('UPDATE invite_codes SET used_at = revoked_at WHERE revoked_at IS NOT NULL AND used_at IS NULL');
  pgm.dropColumns('invite_codes', ['created_by', 'revoked_at']);

  // Rows with the new purpose would violate the restored CHECK.
  pgm.sql("DELETE FROM email_tokens WHERE purpose = 'change_email'");
  pgm.dropConstraint('email_tokens', 'email_tokens_purpose_check');
  pgm.addConstraint('email_tokens', 'email_tokens_purpose_check', {
    check: "purpose IN ('verify_email','reset_password')",
  });
};
