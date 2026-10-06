// frontend/src/games/something2/src/js/net/questsClient.js
//
// Client HTTP helpers for fetching, starting, and completing quests & Act IV legacy choices.

export async function fetchAllQuests() {
  const res = await fetch('/api/quests');
  if (!res.ok) throw new Error(`Failed to fetch quests: ${res.status}`);
  const data = await res.json();
  return data.quests || [];
}

export async function fetchCharacterQuests(characterId) {
  if (!characterId) return { quests: [], legacyChoice: null };
  const res = await fetch(`/api/quests/character/${characterId}`);
  if (!res.ok) throw new Error(`Failed to fetch character quests: ${res.status}`);
  return await res.json();
}

export async function startQuest(characterId, questKey) {
  const res = await fetch('/api/quests/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId, questKey }),
  });
  if (!res.ok) throw new Error(`Failed to start quest: ${res.status}`);
  return await res.json();
}

export async function completeQuest(characterId, questKey, legacyChoice = null) {
  const res = await fetch('/api/quests/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId, questKey, legacyChoice }),
  });
  if (!res.ok) throw new Error(`Failed to complete quest: ${res.status}`);
  return await res.json();
}
