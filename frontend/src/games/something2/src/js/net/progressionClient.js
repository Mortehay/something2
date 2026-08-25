// Authenticated character-sheet client: GET the progression bundle, POST an
// allocation, POST a respec. Dependency-free (no React/query) so it is
// unit-testable in the node vitest env against a stubbed fetch, mirroring
// worldOverviewClient.js. Auth is carried by authHeaders()/apiFetch() from
// auth.js -- the same helper every other mutating data hook in this app uses,
// so a 401 (dead/revoked token) is handled the same way everywhere.
import { authHeaders, apiFetch } from './auth.js';
import { readActiveCharacterId } from '../../../characterSession.js';
import { API_URL } from '../../../../../config.js';

// SOMET-257 made progression per CHARACTER, so all three of these endpoints
// now require a character_id -- without one they answer 400 and the character
// sheet renders "character_id is required" where the stats should be.
//
// Read from characterSession, the same store GameShell writes when a character
// is chosen, rather than threaded down through a component's props: this
// module already reaches into localStorage for the auth token via authHeaders(),
// so one more identity read follows the pattern instead of inventing a second
// way to answer "who is this request for". One source, so the sheet can never
// describe a different character than the canvas is drawing.
function activeCharacterId() {
  const id = readActiveCharacterId();
  if (id == null) throw new Error('No character selected');
  return id;
}

async function parseOrThrow(res) {
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// { progression, stats, xpFloor, xpToNext, respecCost }
export async function fetchProgression(apiUrl = API_URL) {
  // GET carries it as a query parameter; the POSTs below put it in the body.
  // progressionRoutes.js reads `req.query.character_id ?? req.body.character_id`
  // and accepts either, but each verb uses the idiomatic one.
  const res = await apiFetch(
    `${apiUrl}/api/progression?character_id=${encodeURIComponent(activeCharacterId())}`,
    { headers: authHeaders() });
  return parseOrThrow(res);
}

// { progression, stats, gold } on success; throws with the server's `error`
// message on a 402 (not enough gold). SOMET-470 removed the sheet's respec
// button (there is nothing left to refund until the passive tree lands), so
// this currently has no caller in the client -- it is kept because T7's tree
// respec calls the same route and there is no affordability gate left to
// pre-check against.
export async function respec(apiUrl = API_URL) {
  const res = await apiFetch(`${apiUrl}/api/progression/respec`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ character_id: activeCharacterId() }),
  });
  return parseOrThrow(res);
}
