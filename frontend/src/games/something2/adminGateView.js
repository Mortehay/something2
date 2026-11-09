// What the Settings "Admin" tab shows for the admin menu's code. Pure, so the wording and the
// states are testable (the component is not renderable in the node vitest env).
//
// `gate` is the server's last `adminGate` frame for this account, or null before it answers.
//   mode 'checking'  no answer yet
//   mode 'none'      no code is set on the server and this is not an admin account: nothing to do
//   mode 'open'      no code is set, and this admin account has the menu already
//   mode 'locked'    a code is set and has not been entered
//   mode 'unlocked'  the code was entered: the menu is on
// `error` is set when the last attempt failed.
export function adminGateView(gate) {
  if (!gate) return { mode: 'checking', message: 'Asking the server…', error: null };
  if (gate.required !== true) {
    return gate.admin === true
      ? {
        mode: 'open',
        message: 'No admin code is set on this server (ADMIN_MENU_CODE), so the admin menu is always available to admin accounts.',
        error: null,
      }
      : { mode: 'none', message: 'The admin menu is not available.', error: null };
  }
  if (gate.unlocked === true) return { mode: 'unlocked', message: 'The admin menu is on.', error: null };
  const error = gate.op === 'unlock' && gate.ok === false ? attemptError(gate) : null;
  return { mode: 'locked', message: 'Enter the admin code to turn on the admin menu.', error };
}

// Whether the Settings "Admin" tab is drawn at all: for an admin account, or whenever the server
// has a code to enter. An ordinary player on a server with no code never sees it.
export function showAdminTab(gate) {
  return Boolean(gate) && (gate.admin === true || gate.required === true);
}

function attemptError(gate) {
  if (gate.error === 'too many attempts') {
    const s = Math.max(1, Math.ceil((Number(gate.retryMs) || 0) / 1000));
    return `Too many wrong codes: try again in ${s} s.`;
  }
  return 'Wrong code.';
}

// A code worth sending: not blank, and short enough for the server to accept whole.
export function codeToSend(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.length > 0 && s.length <= 200 ? s : null;
}
