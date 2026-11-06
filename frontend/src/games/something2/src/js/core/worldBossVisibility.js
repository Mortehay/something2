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

// The "emerges in ..." countdown. The server sends timeToSpawnMs once (on entering the
// warning and every few seconds after); between frames the client counts down from the
// moment it received the status (`_at`, stamped in Game), so the banner ticks every
// second instead of freezing at the last number.
export function worldBossCountdown(status, nowMs) {
  if (!status || status.state !== 'warning' || !Number.isFinite(status._at)) return status;
  return { ...status, timeToSpawnMs: Math.max(0, (status.timeToSpawnMs || 0) - (nowMs - status._at)) };
}

// The arena ring to draw in the world and on the minimap: only for an ACTIVE boss in
// THIS world.
export function worldBossArenaHere(status, worldId) {
  const s = worldBossHereOnly(status, worldId);
  return s && s.state === 'active' && s.arena && Number.isFinite(s.arena.x) && Number.isFinite(s.arena.y) ? s.arena : null;
}

// The boss as the MINIMAP draws it: only in the boss's own world, standing where the
// boss actually is (its live creature), else on its arena. The status frame carries an
// arena but no x/y, so the marker used to have nothing to be drawn at. Pure, so the
// snapshot stays testable against a hand-built `this`.
export function worldBossForMinimap(status, worldId, creatures, findBoss) {
  const here = worldBossHereOnly(status, worldId);
  if (!here || here.state !== 'active') return here;
  const live = typeof findBoss === 'function' ? findBoss(creatures || [], here) : null;
  const pos = live
    ? { x: live.x + (live.width || 0) / 2, y: live.y + (live.height || 0) / 2 }
    : (here.arena && Number.isFinite(here.arena.x) ? { x: here.arena.x, y: here.arena.y } : null);
  return pos ? { ...here, x: pos.x, y: pos.y } : here;
}
