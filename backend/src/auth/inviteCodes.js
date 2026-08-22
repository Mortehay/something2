// SOMET-381. Claiming an invite code, exactly once.
//
// Extracted from the register route so the claim can be RACED in a test. At
// the HTTP level it cannot be: password hashing runs before the transaction
// and costs ~550 ms of CPU per request, so three concurrent registrations
// serialise and the window this code exists to close never opens. A test
// driven through HTTP therefore passes just as happily against a
// SELECT-then-UPDATE implementation, which is the bug — verified by mutation,
// not assumed. Testing the claim directly, with two real clients, is the only
// form of that test that can fail.

// Claim `code` inside the caller's transaction. Returns true if this caller
// won it, false if it does not exist or was already spent.
//
// ONE conditional UPDATE, never SELECT-then-UPDATE. Two transactions both
// pass a SELECT because neither has written yet; with the UPDATE, the second
// blocks on the first's row lock and then re-evaluates `used_at IS NULL`
// against the committed value, so it matches nothing and returns no rows.
// That is the whole mechanism.
//
// The caller must already be in a transaction: the claim has to roll back with
// the registration it was for, or a request that failed to create an account
// would still have burned the code.
async function claimInviteCode(client, code) {
  const { rows } = await client.query(
    `UPDATE invite_codes SET used_at = now()
      WHERE code = $1 AND used_at IS NULL
      RETURNING code`,
    [code],
  );
  return rows.length > 0;
}

// Record WHO spent it, once the user row exists. Separate from the claim
// because the claim must happen before the insert (to lock the code) and the
// user id only exists after it.
async function attachInviteToUser(client, code, userId) {
  await client.query('UPDATE invite_codes SET used_by = $1 WHERE code = $2', [userId, code]);
}

module.exports = { claimInviteCode, attachInviteToUser };
