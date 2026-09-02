// SOMET-528. Lingering melee waves, as the renderer wants them.
//
// A SEPARATE PURE MODULE for the same reason worldPlayers.js is one: this is a
// field-list remap between the server frame and the draw path, and that is
// precisely where the aura ring was lost (SOMET-523 -- the server sent it, the
// renderer drew it, and Game._onWorldState dropped it in between). Putting the
// list somewhere a test can hold it is the whole point.
//
// The server sends geometry already RESOLVED -- origin, aim, reach, arc -- and
// omits the key entirely when there are no waves. A wave outlives the swing
// that made it, so there is nothing left client-side to derive it from.

// Every value the draw path needs, filtered so nothing non-finite reaches the
// canvas. Canvas 2D SILENTLY DROPS a path with non-finite coordinates, so a
// malformed wave would not error -- it would just not be there, and could take
// the rest of the pass with it depending on ordering.
export function wavesFromFrame(msg) {
  const raw = msg && Array.isArray(msg.waves) ? msg.waves : [];
  const out = [];
  for (const v of raw) {
    if (!v) continue;
    const x = Number(v.x);
    const y = Number(v.y);
    const nx = Number(v.nx);
    const ny = Number(v.ny);
    const reach = Number(v.reach);
    const arc = Number(v.arc);
    if (![x, y, nx, ny, reach, arc].every(Number.isFinite)) continue;
    // A zero-reach or zero-arc wave is a zero-area path: nothing to draw, and
    // stroking it would be a wasted call rather than a visible one.
    if (reach <= 0 || arc <= 0) continue;
    const ms = Number(v.ms);
    out.push({
      x, y, nx, ny, reach, arc,
      el: typeof v.el === 'string' ? v.el : null,
      // Remaining lifetime, for the fade. Clamped rather than trusted: a
      // negative would invert the alpha and a NaN would delete the draw.
      ms: Number.isFinite(ms) && ms > 0 ? ms : 0,
    });
  }
  return out;
}

// The frame REPLACES the list every tick, exactly as chestsFromFrame does:
// the server re-sends every live wave, so treating a shorter list as a delta
// would leave an expired wave burning on the ground forever.
export function applyWaveFrame(msg) {
  return wavesFromFrame(msg);
}
