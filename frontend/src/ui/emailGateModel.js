// Which email-gate popup (if any) covers the app. The backend decides whether
// the gate is active (`emailRequired` on /me); the client never decides it.
//   null account -> 'loading' while /me is pending, but 'none' once the probe
//                   FAILED (fail open: the server still enforces the gate on
//                   HTTP and WS, and a gated 403 re-opens it via the event)
//   'none'   gate inactive, or email verified
//   'add'    no email on the account
//   'verify' email set, not verified yet
export function gateStep(account, probeStatus = 'answered') {
  if (!account) return probeStatus === 'failed' ? 'none' : 'loading';
  if (!account.emailRequired || account.emailVerified) return 'none';
  if (!account.email) return 'add';
  return 'verify';
}
