// Pure helpers for surfacing `liveWarning` (D3/F-017/SOMET-197): several
// admin mutations (world PUT, biome PUT, regenerate, creature re-roll,
// village add/delete, link set/clear) can succeed at the DB write while a
// player is connected to the affected world and could not be evicted --
// backend/src/index.js's evictOrWarn()/invalidateWorld(). The live
// simulation is then still serving pre-edit state, and the admin must be
// told, not just handed a plain success toast.
//
// Split out of useMapsAdmin.js/useBiomes.js so the "should this fire, and
// with what text" logic can be unit-tested directly (this app's vitest runs
// in a plain Node environment, no jsdom/RTL, so hook hooks bodies aren't a
// practical test surface -- see itemTypeForm.js/biomeForm.js for the same
// pattern).

export const LIVE_WARNING_TOAST_OPTS = { icon: '⚠️', duration: 6000 };

// Mirrors backend/src/index.js's evictOrWarn() message text exactly, for the
// routes that can only signal the condition via a response header (see
// liveWarningFromHeader below) with no room to carry the string itself.
export const DEFAULT_LIVE_WARNING =
  'a player is connected to this world; the running simulation is still serving the old, pre-edit map and will not reflect this change until the world is emptied and reloaded';

// Most routes reply 200 with `{ ...row, liveWarning }` (or omit the key
// entirely). Returns the message to show, or undefined when there is
// nothing to warn about.
export function liveWarningFromBody(data) {
  return (data && typeof data.liveWarning === 'string' && data.liveWarning) || undefined;
}

// The village-delete and link-clear routes reply 204 (no body), so the same
// condition travels as the `X-Live-World-Pending` response header instead --
// present/'true' or absent, never the message text. Maps that back to the
// same wording evictOrWarn() would have sent on a route with a body.
export function liveWarningFromHeader(headerValue) {
  return headerValue === 'true' ? DEFAULT_LIVE_WARNING : undefined;
}
