// frontend/src/games/something2/src/js/systems/minimapLoop.js
//
// The minimap's animation loop, with the scheduler injected.
//
// SOMET-361. Two things live here that used to be spread across two
// useEffect-owned rAF loops in Minimap.jsx (one for the docked box, a second
// started by the expand modal):
//
//   1. There is exactly ONE loop, whatever is on screen. The modal no longer
//      brings its own; it just becomes another surface the one loop draws into.
//   2. Ticking and drawing are separated. `onTick` runs on every animation
//      frame; `onDraw` runs at most once per `drawIntervalMs`.
//
// That split is the whole point, and it is not an optimisation detail -- it is
// load-bearing. `Game.getMinimapSnapshot()` has two side effects beyond
// returning data: it updates `Game._minimapDir` (which the heading arrow reads)
// and it is what drives the overview refetch edge check. Both must keep
// happening at frame rate or the HUD quietly degrades -- the arrow stops
// tracking, or the map stops streaming as the player walks. So the caller puts
// the snapshot in `onTick`, and only the canvas work in `onDraw`. Throttling
// the snapshot instead would produce a green test suite and a visibly broken
// HUD, which is exactly the failure mode SOMET-361 was written to avoid.
//
// The scheduler is a parameter rather than a direct `requestAnimationFrame`
// reference so the cadence can be asserted in a unit test: this project has no
// component-render harness, so a loop left inside the component could only be
// verified by reading it.

// Drive the minimap.
//
//   requestFrame  - schedules a callback, receives a timestamp (rAF's contract)
//   cancelFrame   - cancels a handle from requestFrame
//   drawIntervalMs- minimum gap between onDraw calls; 0 draws every frame
//   onTick(now)   - every frame, unconditionally
//   onDraw(now)   - at most once per drawIntervalMs
//
// Returns { start, stop, isRunning }. start() is idempotent: calling it twice
// does NOT produce a second loop, which is the defect this module replaces.
export function createMinimapLoop({
  requestFrame,
  cancelFrame,
  drawIntervalMs = 0,
  onTick,
  onDraw,
}) {
  let handle = 0;
  let running = false;
  let lastDraw = -Infinity; // seeded for real in start()

  const frame = (now) => {
    // The loop was stopped between this frame being scheduled and it running.
    // Without this, a stop() during the gap still lets one more tick through --
    // which on unmount means touching a canvas React has already detached.
    if (!running) return;
    handle = requestFrame(frame);

    if (onTick) onTick(now);

    if (now - lastDraw < drawIntervalMs) return;
    lastDraw = now;
    if (onDraw) onDraw(now);
  };

  return {
    start() {
      if (running) return;
      running = true;
      // -Infinity, not 0: the first frame after a start must always draw,
      // whatever timestamp the scheduler happens to be counting from. A 0 here
      // silently swallows the first draw on any page whose rAF clock has not
      // yet passed drawIntervalMs.
      lastDraw = -Infinity;
      handle = requestFrame(frame);
    },
    stop() {
      if (!running) return;
      running = false;
      cancelFrame(handle);
      handle = 0;
    },
    isRunning() {
      return running;
    },
  };
}
