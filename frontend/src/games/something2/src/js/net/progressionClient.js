// Authenticated character-sheet client: GET the progression bundle, POST an
// allocation, POST a respec. Dependency-free (no React/query) so it is
// unit-testable in the node vitest env against a stubbed fetch, mirroring
// worldOverviewClient.js. Auth is carried by authHeaders()/apiFetch() from
// auth.js -- the same helper every other mutating data hook in this app uses,
// so a 401 (dead/revoked token) is handled the same way everywhere.
import { authHeaders, apiFetch } from './auth.js';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';

async function parseOrThrow(res) {
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// { progression, stats, xpFloor, xpToNext, respecCost }
export async function fetchProgression(apiUrl = API_URL) {
  const res = await apiFetch(`${apiUrl}/api/progression`, { headers: authHeaders() });
  return parseOrThrow(res);
}

// { progression, stats } on success; throws with the server's `error` message
// on a 400 (unknown stat / not enough points).
export async function allocateStat(stat, count, apiUrl = API_URL) {
  const res = await apiFetch(`${apiUrl}/api/progression/allocate`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ stat, count }),
  });
  return parseOrThrow(res);
}

// { progression, stats, gold } on success; throws with the server's `error`
// message on a 402 (not enough gold) -- callers should gate the button with
// respecDisabled() first so this is a rare race, not the normal path.
export async function respec(apiUrl = API_URL) {
  const res = await apiFetch(`${apiUrl}/api/progression/respec`, {
    method: 'POST',
    headers: authHeaders(),
  });
  return parseOrThrow(res);
}
