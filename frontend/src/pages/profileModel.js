// Pure helpers for the Profile page (vitest runs in node, so the logic lives here).

// Mirrors backend/src/email/templates.js maskEmail exactly: first char + *** + "@domain".
export function maskEmail(email) {
  const s = String(email || "");
  const at = s.lastIndexOf("@");
  if (at < 1) return "***";
  return `${s[0]}***${s.slice(at)}`;
}

// Which Email-section variant /me calls for.
//   no email -> 'add'; unverified -> 'verify'; verified with a change in flight -> 'pending'; else 'change'.
export function emailSectionState(account) {
  if (!account || !account.email) return "add";
  if (!account.emailVerified) return "verify";
  if (account.pendingEmail) return "pending";
  return "change";
}

export function inviteStatus(invite) {
  if (invite && invite.usedAt) return "used";
  if (invite && invite.revokedAt) return "revoked";
  return "unused";
}

// remainingToday is null for admins (unlimited), else a count.
export function canCreateInvite(remainingToday) {
  if (remainingToday === null || remainingToday === undefined) return true;
  return Number(remainingToday) > 0;
}
