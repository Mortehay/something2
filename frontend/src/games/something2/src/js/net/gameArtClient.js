// GET /api/game-art (SOMET-598): which skills / passive labels / items have a
// generated icon, and its object-store key. Dependency-free like the other
// clients here so it is testable against a stubbed fetch.
import { authHeaders, apiFetch } from './auth.js';
import { API_URL } from '../../../../../config.js';

export async function fetchGameArt(apiUrl = API_URL) {
  const res = await apiFetch(`${apiUrl}/api/game-art`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
