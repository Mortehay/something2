import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";

export const GAME_ASPECT = GAME_WIDTH / GAME_HEIGHT;

// Letterbox the fixed-resolution game canvas into a box.
//
// The backing store is always GAME_WIDTH x GAME_HEIGHT; only the CSS box the
// browser scales it into changes. The box has to be the canvas's own
// CONTAINER, never the window: the canvas lives inside GameShell's content
// area, which is the window minus the left sidebar and the top header.
// Fitting to the window made the element wider and taller than that
// container, and the container's `overflow: hidden` cropped the difference --
// the bottom and right strips, which is exactly where renderHud() draws the
// HP/MP orbs and the XP bar. Fullscreen was the one case where container ==
// window, so the HUD "only displayed normal at full window" (SOMET-489).
//
// Returns the CSS size plus the offsets that centre it, so the caller does
// not repeat the centring arithmetic (and cannot get it half-right).
export function fitCanvasBox(availableWidth, availableHeight, ratio = GAME_ASPECT) {
  const availW = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0;
  const availH = Number.isFinite(availableHeight) ? Math.max(0, availableHeight) : 0;
  // A container measured while hidden (display:none, or before first layout)
  // reports 0. Sizing to it would set a 0x0 element that never recovers on its
  // own, so report the empty fit and let the caller leave the last good box.
  if (availW <= 0 || availH <= 0) return { width: 0, height: 0, left: 0, top: 0 };

  let width;
  let height;
  if (availW / availH > ratio) {
    // Box is wider than the game: full height, bars on the left and right.
    height = availH;
    width = height * ratio;
  } else {
    // Box is taller than the game: full width, bars above and below.
    width = availW;
    height = width / ratio;
  }

  // Floor before centring so the offsets are derived from the size actually
  // applied -- rounding them independently can push the element a pixel past
  // the container edge, which is the whole class of bug this fixes.
  width = Math.floor(width);
  height = Math.floor(height);
  return {
    width,
    height,
    left: Math.floor((availW - width) / 2),
    top: Math.floor((availH - height) / 2),
  };
}
