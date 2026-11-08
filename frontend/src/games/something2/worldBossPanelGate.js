// SOMET-614. The in-game admin menu (world boss tools, character grants, teleport) drives the
// debugWorldBoss / debugAdmin socket messages, which the server only honours for admins. Plain
// function so the rule is testable in the node vitest env (GameView itself is not).
//
// `adminGate` is the server's answer about the menu's code lock (useAdminGate):
//   undefined         not asked (callers that predate the lock): the old rule, admin + playing
//   { pending: true } asked, no answer yet: hidden, so a locked menu never flashes up
//   { required, unlocked }  shown when no code is required, or the code has been entered
// This only decides what is DRAWN; the server enforces the same rule on every admin message.
export function showWorldBossTestPanel({ isPlaying, isAdmin, adminGate }) {
  if (!(Boolean(isPlaying) && isAdmin === true)) return false;
  if (adminGate === undefined) return true;
  if (!adminGate || adminGate.pending) return false;
  return adminGate.admin === true && (adminGate.required !== true || adminGate.unlocked === true);
}
