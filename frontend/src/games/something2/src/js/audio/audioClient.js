// audioClient.js -- the two player routes (spec §3).
import { API_URL } from '../../../../../config.js';
import { authHeaders } from '../net/auth.js';

export async function fetchWorldAudio(worldId) {
  try {
    const res = await fetch(`${API_URL}/api/audio/world/${worldId}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[audio] no sound for world ${worldId}: ${err.message}`);
    return { world: null, bindings: {} };
  }
}

export async function postMisses(misses) {
  if (!misses.length) return;
  try {
    await fetch(`${API_URL}/api/audio/misses`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ misses }) });
  } catch (_) { /* best-effort: a lost miss report costs nothing */ }
}
