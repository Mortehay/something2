// Minimap markers for party-mates. A pure function of its arguments (not a Game
// method) so getMinimapSnapshot stays testable against a hand-built `this`.
//
// Only OTHER members who are in THIS world and have a position get a marker; a
// member in another world still has a party frame but no dot on this map.
export function partyMarkersOf(party, localUserId, worldId) {
  if (!party || !Array.isArray(party.members)) return [];
  const me = String(localUserId);
  return party.members
    .filter((m) => String(m.id) !== me && m.w === worldId && Number.isFinite(m.x) && Number.isFinite(m.y))
    .map((m) => ({ x: m.x, y: m.y, name: m.name }));
}
