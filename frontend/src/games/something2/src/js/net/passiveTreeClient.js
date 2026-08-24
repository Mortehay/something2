// The tree graph, the allocate call and the respec, for the canvas overlay.
// Same shape as progressionClient.js next door: dependency-free (no React, no
// query client) so it is unit-testable in the node vitest env against a stubbed
// fetch, and authenticated through the one authHeaders()/apiFetch() pair every
// other mutating client in this app uses.
//
// NOTE ON THE ALLOCATE RESPONSE. `allocatePassive` deliberately returns nothing
// but a thrown error on failure. The success body carries the new progression,
// and applying it to Game.progression would reintroduce the second writer
// CharacterSheet.jsx's F1 header describes: the HTTP response and a concurrent
// kill/death websocket push travel on two independent connections with no
// ordering between them. progressionRoutes.js calls refreshLivePlayerStats
// after every successful allocate, which pushes an ordered `progression`
// frame -- that frame is the only thing that may update client state.
import { authHeaders, apiFetch } from './auth.js';
import { readActiveCharacterId } from '../../../characterSession.js';
import { API_URL } from '../../../../../config.js';

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

// { nodes, edges, version }. The graph is the same for everyone and changes
// only when an admin edits a node or the seeder runs, so Game fetches it once
// per session on the first open rather than on join.
export async function fetchPassiveTree(apiUrl = API_URL) {
  const res = await apiFetch(`${apiUrl}/api/passive-tree`, { headers: authHeaders() });
  return parseOrThrow(res);
}

// Resolves to true; throws with the server's message on refusal. The body is
// discarded on purpose -- see the module header.
export async function allocatePassive(nodeId, apiUrl = API_URL) {
  const res = await apiFetch(
    `${apiUrl}/api/progression/passives/${encodeURIComponent(nodeId)}`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ character_id: activeCharacterId() }),
    },
  );
  await parseOrThrow(res);
  return true;
}

// Contract §6.4: respec is a passive-tree action now. Same discard rule as
// allocatePassive -- the ordered websocket frame updates progression, not this
// response. `gold` is the one field with no websocket echo (refreshPlayerStats
// carries no wallet and a respec sends no `wallet` frame), so the caller
// applies THAT much and nothing else.
export async function respecPassives(apiUrl = API_URL) {
  const res = await apiFetch(`${apiUrl}/api/progression/respec`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ character_id: activeCharacterId() }),
  });
  const body = await parseOrThrow(res);
  return { gold: body.gold };
}

// The affordability inputs, straight from the server. The COST is never
// recomputed here (CharacterSheet.jsx's F2 header): it rides GET
// /api/progression, which also returns the gold it is measured against and the
// server's own verdict, so the overlay renders a decision it did not make.
export async function fetchRespecQuote(apiUrl = API_URL) {
  const res = await apiFetch(
    `${apiUrl}/api/progression?character_id=${encodeURIComponent(activeCharacterId())}`,
    { headers: authHeaders() },
  );
  const body = await parseOrThrow(res);
  return {
    respecCost: Number(body.respecCost),
    gold: Number(body.gold),
    respecDisabled: body.respecDisabled === true,
  };
}

// Which sector the player starts in. The server resolves this itself on every
// allocate (passiveTreeStore.startNodeIdFor: characters -> entity_types.name ->
// passive_nodes.start_class) and is the only thing that authorizes one; this is
// read ONLY to decide which nodes to draw as reachable.
//
// It comes off GET /api/characters rather than a new field on the join frame:
// the class name is already on that row (characters.js listCharacters returns
// `className`), and adding a second server-side source for the same fact is how
// the two drift.
export async function fetchStartClass(apiUrl = API_URL) {
  const id = activeCharacterId();
  const res = await apiFetch(`${apiUrl}/api/characters`, { headers: authHeaders() });
  const body = await parseOrThrow(res);
  const mine = (body.characters || []).find((c) => c.id === id);
  // null, not a default: a class with no start node must draw nothing as
  // allocatable rather than silently borrowing another class's sector.
  return mine ? mine.className : null;
}
