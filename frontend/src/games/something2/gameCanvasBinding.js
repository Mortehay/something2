// Binds (or creates) the running Game instance to the current <canvas> DOM
// node. Extracted out of Something2.jsx's mount effect so the rebind
// behavior can be unit tested without a DOM rendering harness — see
// __tests__/gameCanvasBinding.test.js.
//
// Two real bugs lived in the inline version of this logic (F-045,
// SOMET-225), both about the running Game losing track of its canvas:
//
//   1. Game's constructor takes no arguments (see core/Game.js) — the old
//      `new Game(canvasRef.current)` call site silently discarded the
//      canvas, so a freshly created Game had `.canvas === null` until
//      something else set it. This is the "Enter World occasionally
//      no-ops on a mount race" symptom: initChunked() bails out with
//      "Canvas not found!" whenever nothing had rebound the canvas since
//      construction.
//   2. The rebind-an-existing-Game branch updated `.canvas`/`.ctx` but
//      never re-ran resizeCanvas(). That's invisible across a tab switch
//      (the DOM node itself is kept mounted, so it's already sized), but
//      a genuine remount — signing out and back in without a page reload
//      unmounts and remounts the whole canvas — hands back a brand-new
//      node stuck at the browser's 300x150 default, so the game rendered
//      blank while the authority socket and rAF loop kept running
//      underneath.
//
// This function always assigns canvas + ctx explicitly (never relies on
// the constructor) and always re-runs resizeCanvas(), so both a fresh
// Game and a rebind-to-a-new-node land in the same correct state.
export function bindGameCanvas(existingGame, canvasEl, createGame) {
  if (!canvasEl) return existingGame;
  const game = existingGame || createGame();
  game.canvas = canvasEl;
  game.ctx = canvasEl.getContext('2d');
  if (typeof game.resizeCanvas === 'function') game.resizeCanvas();
  return game;
}
