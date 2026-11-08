// What the Settings "Admin" tab shows for the admin menu's code lock. Pure, so the wording and the
// states are testable (the component is not renderable in the node vitest env).
//
// `gate` is the server's last `adminGate` frame for this account, or null before it answers.
//   mode 'checking'  no answer yet
//   mode 'open'      the server has no code set: the menu is always on for admin accounts
//   mode 'locked'    a code is required and has not been entered
//   mode 'unlocked'  the code was entered (the menu is available)
// `error` is set when the last attempt failed.
export function adminGateView(gate) {
  if (!gate) return { mode: 'checking', message: 'Asking the server…', error: null };
  if (gate.admin !== true) return { mode: 'none', message: 'This account is not an admin.', error: null };
  const error = gate.op === 'unlock' && gate.ok === false ? attemptError(gate) : null;
  if (gate.required !== true) {
    return {
      mode: 'open',
      message: 'No admin code is set on this server (ADMIN_MENU_CODE), so the admin menu is always available to admin accounts.',
      error: null,
    };
  }
  if (gate.unlocked === true) return { mode: 'unlocked', message: 'The admin menu is unlocked for this account.', error: null };
  return { mode: 'locked', message: 'Enter the admin code to unlock the admin menu.', error };
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
