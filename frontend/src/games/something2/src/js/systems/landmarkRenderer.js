// Pure Canvas-2D drawing for landmark markers -- waypoints and portals -- on
// the in-game iso canvas. No DOM/React/state, same contract as wallRenderer.js
// and minimapRenderer.js.
//
// WHY THIS EXISTS. SOMET-292/293 shipped a working waypoint network that no
// surface ever drew: RenderSystem.js, wallRenderer.js and minimapRenderer.js
// contained zero references to `waypoint` or `portal`. A player spawns one tile
// from the Old Trailhead waypoint and nothing on screen says so. This is the
// ground half of the fix (SOMET-297).

import { worldToScreen } from "../core/iso.js";

// One full brighten-and-dim. Slow on purpose: the starting village holds a
// waypoint plus a portal pad, so several markers pulse in view at once and a
// fast blink would read as a strobe rather than a beacon.
export const PULSE_PERIOD_MS = 1600;

// Alpha never reaches 0 -- a marker that fully disappears is worse than no
// marker, because a player who glanced away cannot tell whether they imagined
// it. Floor of 0.35 keeps it continuously present while still clearly moving.
const PULSE_MIN = 0.35;
const PULSE_MAX = 1;

// THE PHASE IS AN ARGUMENT, NOT A CLOCK READ. A draw function that called
// performance.now() itself could not be pinned by a test: two calls would
// differ by whatever the clock did between them, so "the pulse is wired up" and
// "the pulse is hardcoded" would look identical. The caller owns the time
// source (RenderSystem's per-frame this.nowMs, Minimap's rAF timestamp).
export function landmarkPulse(phase) {
  const t = Number.isFinite(phase) ? phase : 0;
  const wave = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / PULSE_PERIOD_MS);
  return PULSE_MIN + (PULSE_MAX - PULSE_MIN) * wave;
}

// Waypoint blue-white, per the spec.
//
// Portals are PINK, not the violet the spec named. The spec's own §2 asks these
// markers to sit alongside the minimap's existing vocabulary, and that vocabulary
// already spends purple: minimapRenderer draws every compass doorway in #c084fc.
// A violet portal beside a purple doorway would read as the same thing, and they
// are not -- one is a wall you walk into, the other is a labelled destination.
const COLORS = { waypoint: "#7dd3fc", portal: "#f472b6" };
const FALLBACK_COLOR = "#e5e7eb";

export function landmarkColor(kind) {
  return COLORS[kind] || FALLBACK_COLOR;
}

// A landmark's stored x/y is already its TILE CENTRE: waypointTileKey and
// loadWorld's portal keying both floor(coord / MAP_TILE_SIZE), and the authored
// coordinates sit at the centre of that tile (3250 -> tile 32, whose centre is
// 3250). So worldToScreen gives the diamond centre directly, with no half-extent
// adjustment of the kind ground items need.
function diamondPath(ctx, x, y, halfW, halfH) {
  ctx.beginPath();
  ctx.moveTo(x, y - halfH);
  ctx.lineTo(x + halfW, y);
  ctx.lineTo(x, y + halfH);
  ctx.lineTo(x - halfW, y);
  ctx.closePath();
}

// Draw every landmark for the current world.
//
// Call this AFTER the flat floor pass and BEFORE the depth-sorted entity pass:
// the marker is ground decoration, so a creature or player standing on the tile
// must draw over it and stay legible.
export function drawLandmarks(ctx, { landmarks, phase, halfW, halfH } = {}) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) return;

  const alpha = landmarkPulse(phase);

  for (const l of landmarks) {
    // A malformed row is skipped rather than drawn: a NaN coordinate silently
    // draws nothing on a real canvas while still costing a path, which is how
    // "it renders" and "it renders invisibly" become indistinguishable.
    if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;

    const s = worldToScreen(l.x, l.y);
    const color = landmarkColor(l.kind);

    ctx.save();
    ctx.globalAlpha = alpha;

    // An unactivated waypoint is an outline; anything usable is filled. This is
    // the same activated/unactivated distinction the travel popup already makes
    // in its list, carried onto the ground so the two cannot disagree about
    // which waypoints a player has lit.
    const filled = l.kind !== "waypoint" || l.activated === true;
    diamondPath(ctx, s.x, s.y, halfW, halfH);
    if (filled) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // A short beam above the tile, so the marker is findable when the tile
    // itself is behind a wall or below the camera's attention. Drawn at a
    // fraction of the marker alpha -- it is a hint, not a second marker.
    ctx.globalAlpha = alpha * 0.35;
    ctx.fillStyle = color;
    ctx.fillRect(s.x - 2, s.y - halfH - 46, 4, 46);

    ctx.restore();
  }
}
