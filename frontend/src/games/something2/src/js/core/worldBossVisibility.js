// Where a world boss's HUD card and minimap marker may be drawn.
//
// The boss lives in ONE world, and its status frame is broadcast to every world.
// The card and the minimap marker used to be drawn from that frame alone, so a
// player anywhere saw "boss alive, 20000 / 20000" for a fight they could not reach,
// and the minimap drew a skull at the boss's coordinates in the WRONG world.
//
// The announcement that a boss is about to emerge is different: it is a call to
// go somewhere, so it stays visible everywhere.
export function worldBossHereOnly(status, worldId) {
  if (!status || status.state !== 'active') return status || null;
  // An active status that names no world cannot be placed: show nothing rather than
  // a card for a boss nobody can find.
  if (status.worldId == null || worldId == null) return null;
  return String(status.worldId) === String(worldId) ? status : null;
}
