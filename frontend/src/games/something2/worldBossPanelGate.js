// SOMET-614. The in-game admin menu (world boss tools, character grants, teleport) drives the
// debugWorldBoss / debugAdmin socket messages. Plain function so the rule is testable in the node
// vitest env (GameView itself is not).
//
// `adminGate` is the server's answer about the menu (useAdminGate), and its `allowed` field is
// the server's own verdict on whether it will act on this socket's admin messages: a role-admin
// account when no code is set, or any account that has entered ADMIN_MENU_CODE.
//   undefined         not asked (callers that predate the code): the old rule, an admin account
//   { pending: true } asked, no answer yet: hidden, so a locked menu never flashes up
//   { allowed }       shown exactly when the server says so
// This only decides what is DRAWN; the server enforces the same rule on every admin message.
export function showWorldBossTestPanel({ isPlaying, isAdmin, adminGate }) {
  if (!isPlaying) return false;
  if (adminGate === undefined) return isAdmin === true;
  if (!adminGate || adminGate.pending) return false;
  return adminGate.allowed === true;
}
