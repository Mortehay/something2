// SOMET-381. Settings that are fine on a workstation and unacceptable once the
// game answers on a public URL.
//
// These are checked at BOOT and they THROW, rather than warning. A warning in a
// container's logs is a warning nobody reads: the Pi deploys by pushing to a
// branch, and the only signal anyone looks at is whether the service came up.
// A service that refuses to start is the one failure mode that cannot be
// missed, and every condition below is a misconfiguration that should stop a
// release rather than ship quietly.
//
// Only enforced when NODE_ENV === 'production' (compose/orangepi sets it).
// Dev and test keep the loose defaults deliberately -- the point is to stop a
// workstation configuration from REACHING production, not to make local work
// harder.

// JWT_SECRET IS NOT CHECKED HERE, on purpose. auth/assertJwtSecret.js already
// owns that: it rejects a missing, placeholder or too-short secret at boot in
// EVERY environment, not just production, and its test reads .env.example and
// enforces that the shipped template value stays in the rejected set. A second
// copy of that rule here would be a second place to drift, and the weaker of
// the two would eventually be the one someone trusted.

// Registration modes. `open` is the historical behaviour and remains the
// default so a dev checkout keeps working; production must choose explicitly.
const REGISTRATION_MODES = ['open', 'invite', 'closed'];
const DEFAULT_REGISTRATION_MODE = 'open';

function registrationMode(env = process.env) {
  const raw = (env.REGISTRATION_MODE || DEFAULT_REGISTRATION_MODE).trim().toLowerCase();
  if (!REGISTRATION_MODES.includes(raw)) {
    throw new Error(
      `REGISTRATION_MODE must be one of ${REGISTRATION_MODES.join(', ')} (got "${raw}")`);
  }
  return raw;
}

// Returns the list of problems rather than throwing, so the caller can report
// ALL of them at once. A deployment that fixes one secret, redeploys, and then
// discovers the next problem has burned a release cycle per fault.
function productionProblems(env = process.env) {
  const problems = [];
  if (env.NODE_ENV !== 'production') return problems;

  // The seed_test_player migration creates a known account with a known
  // password when this is "1". On a public deployment that is a published
  // credential.
  if (String(env.SEED_TEST_USER || '0') === '1') {
    problems.push(
      'SEED_TEST_USER=1 seeds a test account with a known password. Set it to 0 for a '
      + 'public deployment.');
  }

  // Not a hard failure on its own -- open registration is a legitimate choice --
  // but it must be a CHOSEN one. An unset variable is not a choice.
  if (!env.REGISTRATION_MODE) {
    problems.push(
      'REGISTRATION_MODE is unset, so registration would default to "open". A public '
      + `deployment must state its choice explicitly: ${REGISTRATION_MODES.join(', ')}.`);
  }

  return problems;
}

function assertProductionSafety(env = process.env) {
  const problems = productionProblems(env);
  if (problems.length === 0) return;
  throw new Error(
    'Refusing to start: this configuration is not safe for a public deployment.\n'
    + problems.map((p) => `  - ${p}`).join('\n'));
}

module.exports = {
  assertProductionSafety,
  productionProblems,
  registrationMode,
  REGISTRATION_MODES,
  DEFAULT_REGISTRATION_MODE,
};
