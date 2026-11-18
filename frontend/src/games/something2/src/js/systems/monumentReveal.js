// SOMET-781. A monument sprite is up to 420 px tall: a player or creature
// standing behind it disappears. The monument draws translucent while it hides
// someone. "Hides" is judged in screen space -- the sprite's drawn rectangle --
// because a tall sprite covers ground well behind its footprint, which a
// world-distance check around the footprint would miss.
//
// Only actors BEHIND the monument (smaller iso depth) count: one standing in
// front is drawn over the sprite anyway.
export const MONUMENT_REVEAL_ALPHA = 0.4;

// rect: { left, right, top, bottom } in screen px; actors: [{ sx, sy, depth }].
export function monumentHides(rect, depth, actors) {
  for (const a of actors) {
    if (a.depth >= depth) continue;
    if (a.sx >= rect.left && a.sx <= rect.right && a.sy >= rect.top && a.sy <= rect.bottom) return true;
  }
  return false;
}
