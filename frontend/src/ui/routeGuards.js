// Where a guarded route should send this visitor, or null to let them through.
// Kept as a plain function (no router, no React) so the gating rule is testable
// in the node vitest env. Signed-out always wins over the admin check: someone
// with no session should land on the login screen, not on the game view.
export function guardRedirect({ authed, isAdmin, requireAdmin = false }) {
  if (!authed) return "/login";
  if (requireAdmin && !isAdmin) return "/game";
  return null;
}
