// SOMET-494 — "Constant attack": hold the left button and keep attacking until
// whatever the attack costs runs out.
//
// The decision of whether THIS frame should send another attack is pure and
// lives here, not inline in Game.update, because it is the whole feature: get
// one of these conditions wrong and you either get stuck auto-firing after the
// button is up (an input bug nobody can undo without reloading) or the option
// silently does nothing. Neither is visible in a screenshot.

// How often a held button re-sends. Deliberately NOT the weapon's cooldown:
// the real rate is `w.cooldown * p.stats.cooldownMult`, and the client does not
// know cooldownMult (it is a passive-tree stat that lives on the server's
// derived player). Pacing off the base cooldown would fire slower than the
// player's build allows, and re-implementing the multiplier here would be the
// second copy of a rule this codebase has been bitten by before.
//
// So the client ticks faster than any weapon can fire and lets the server's
// cooldown gate -- the only authority on rate -- drop the extras. The fastest
// weapon in the shipped catalog has a 0.25s cooldown, 5x this interval, so the
// tick can never be the limiting factor. It matches the input stream's own
// cadence (WorldAuthorityClient's inputIntervalMs), so a held attack adds
// traffic of the same order as simply walking.
export const CONSTANT_ATTACK_INTERVAL_MS = 50;

// Should the loop send another attack this frame?
//
// `state` is read straight off Game:
//   enabled    the player's "Constant attack" setting
//   held       the left button is currently down on the world
//   playing    Game.state === 'playing' && Game.chunked && a live authority
//   panelOpen  inventory / shop / bank is up -- the cursor belongs to it
//   lastSentAt performance.now() of the last attack this hold sent
export function shouldRepeatAttack(state, nowMs) {
  if (!state) return false;
  if (!state.enabled || !state.held || !state.playing) return false;
  // A panel takes the pointer: a held button that started before the panel
  // opened must not keep swinging at a world the player can no longer see.
  if (state.panelOpen) return false;
  const last = Number.isFinite(state.lastSentAt) ? state.lastSentAt : -Infinity;
  return nowMs - last >= CONSTANT_ATTACK_INTERVAL_MS;
}

// Does this server refusal end the hold?
//
// The distinction is the point of the feature. `cooldown` is the normal rhythm
// of holding the button -- refusing many times a second is exactly what is
// supposed to happen between swings -- so it must NOT stop anything. A
// `resource` refusal means the player has run out of mana, life or stamina and
// the character stops attacking, which is what the option promises.
//
// `interrupted` (shock) deliberately does NOT stop the hold either: it is a
// temporary status effect, and a player holding the button through a shock
// should resume swinging when it expires rather than having to notice and
// re-press. Only actually running out ends it.
export function refusalStopsHold(reason) {
  return reason === 'resource';
}
