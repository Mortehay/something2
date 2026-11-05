// frontend/src/games/something2/pairedWindowHud.jsx
//
// The chest and merchant windows take the canvas width, so HUD overlays that sit
// over the canvas's right side would take the clicks meant for them. This is
// how a HUD element learns to stand aside.
import { useEffect, useState } from 'react';

// How often the HUD checks. Quick, unlike the other HUD polls: until it notices,
// an overlay can sit on the inventory's X.
const PAIRED_POLL_MS = 100;

function pairedWindowOpen(gameRef) {
  const game = gameRef.current;
  return !!(game && game.isPairedWindowOpen && game.isPairedWindowOpen());
}

export function usePairedWindowOpen(gameRef) {
  const [paired, setPaired] = useState(() => pairedWindowOpen(gameRef));
  useEffect(() => {
    const tick = () => setPaired(pairedWindowOpen(gameRef));
    tick();
    const id = setInterval(tick, PAIRED_POLL_MS);
    return () => clearInterval(id);
  }, [gameRef]);
  return paired;
}

// Hides its children without unmounting them, so an open Settings panel and its
// unsaved tab come back as they were. `contents` gives the wrapper no box of its
// own: absolutely positioned children still place against the same ancestor.
export function HiddenWhilePaired({ gameRef, children }) {
  const paired = usePairedWindowOpen(gameRef);
  return <div data-hud-stack style={{ display: paired ? 'none' : 'contents' }}>{children}</div>;
}
