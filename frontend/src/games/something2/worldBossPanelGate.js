// SOMET-614. The world-boss test panel drives the debugWorldBoss socket
// message, which the server only honours for admins. Plain function so the
// rule is testable in the node vitest env (GameView itself is not).
export function showWorldBossTestPanel({ isPlaying, isAdmin }) {
  return Boolean(isPlaying) && isAdmin === true;
}
