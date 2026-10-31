// frontend/src/games/something2/src/js/net/questsClient.js
//
// Client HTTP helpers for fetching, starting, and completing quests & Act IV legacy choices.
// Character-scoped calls carry the Bearer token (authHeaders); the server only
// honours a character id that belongs to the signed-in account.
//
// There is no progress helper: the server counts kills/objectives itself.

import { authHeaders } from "./auth.js";

// The server answers { ok: false, error } with a readable reason (locked,
// level too low, objective incomplete). Surface that instead of a bare status.
async function failure(res, what) {
  let reason = "";
  try { reason = (await res.json()).error || ""; } catch { /* non-JSON body */ }
  return new Error(reason || `Failed to ${what}: ${res.status}`);
}

export async function fetchAllQuests() {
  const res = await fetch('/api/quests');
  if (!res.ok) throw await failure(res, 'fetch quests');
  const data = await res.json();
  return data.quests || [];
}

export async function fetchCharacterQuests(characterId) {
  if (!characterId) return { quests: [], legacyChoice: null };
  const res = await fetch(`/api/quests/character/${characterId}`, { headers: authHeaders() });
  if (!res.ok) throw await failure(res, 'fetch character quests');
  return await res.json();
}

export async function startQuest(characterId, questKey) {
  const res = await fetch('/api/quests/start', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ characterId, questKey }),
  });
  if (!res.ok) throw await failure(res, 'start quest');
  return await res.json();
}

export async function abandonQuest(characterId, questKey) {
  const res = await fetch('/api/quests/abandon', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ characterId, questKey }),
  });
  if (!res.ok) throw await failure(res, 'abandon quest');
  return await res.json();
}

export async function completeQuest(characterId, questKey, legacyChoice = null) {
  const res = await fetch('/api/quests/complete', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ characterId, questKey, legacyChoice }),
  });
  if (!res.ok) throw await failure(res, 'complete quest');
  return await res.json();
}
