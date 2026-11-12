// Which email-gate popup (if any) covers the app. The backend decides whether
// the gate is active (`emailRequired` on /me); the client never decides it.
//   null account -> 'loading'  (/me has not answered yet)
//   'none'   gate inactive, or email verified
//   'add'    no email on the account
//   'verify' email set, not verified yet
export function gateStep(account) {
  if (!account) return 'loading';
  if (!account.emailRequired || account.emailVerified) return 'none';
  if (!account.email) return 'add';
  return 'verify';
}
