// SOMET-329. THE element palette, served by the server from the `elements`
// catalog and applied once on `joined`.
//
// Before this slice the palette was hardcoded on the client in two separate
// literals -- `ELEMENT_COLORS` in blasts.js and `ELEMENT_TINT` in
// RenderSystem.js -- so adding an element meant a frontend edit, and the two
// copies were free to drift apart. blasts.js's own comment already warned that
// a second palette elsewhere is how a fire projectile and its burn tint end up
// different colours; that second palette already existed when it was written.
//
// The two are NOT redundant, and both survive here as separate columns,
// because they are different roles:
//   * color -- the body of the thing (projectile dot, trail, blast ring,
//     status-effect tint)
//   * tint  -- the lighter wash layered over an impact burst's own colour
// `physical` deliberately has NO tint: the effect's own colour wins.

// Today's exact on-screen values, kept as the fallback for three cases: a
// server that predates slice B, the window before `joined` arrives, and the
// unit tests, which must not need a server to assert a colour.
const DEFAULT_COLORS = {
  arcane: "#9b5de5",     // violet
  fire: "#f4763b",       // orange
  ice: "#5bc0f8",        // blue
  lightning: "#f4d35e",  // yellow
};
const DEFAULT_TINTS = {
  fire: "#ff9a4d",
  ice: "#8fdcff",
  lightning: "#ffe66b",
  arcane: "#c08cff",
  physical: null,        // explicitly no tint -- the effect's own colour wins
};

// The colour for an element nobody has authored, and for `physical`. Also the
// pre-slice-B default, so an unknown element looks exactly as it always did.
export const DEFAULT_ELEMENT_COLOR = "#f4d35e";

let COLORS = { ...DEFAULT_COLORS };
let TINTS = { ...DEFAULT_TINTS };

// Apply the catalog from the `joined` frame: [{ name, color, tint }].
//
// A missing, empty or unusable payload is IGNORED rather than applied. Losing
// the palette must degrade to the built-in colours, never to "no colours
// exist" -- which would draw every projectile, ring and burn tint in the same
// fallback yellow and read as a rendering bug rather than a missing table.
export function configureElements(list) {
  if (!Array.isArray(list) || list.length === 0) return;
  const colors = {};
  const tints = {};
  for (const e of list) {
    if (!e || typeof e.name !== "string" || !e.name) continue;
    if (typeof e.color === "string" && e.color) colors[e.name] = e.color;
    // null is a MEANINGFUL tint (physical), so it is stored as null rather
    // than skipped -- skipping would let the default table's value show
    // through and tint an element the catalog says must not be tinted.
    tints[e.name] = typeof e.tint === "string" && e.tint ? e.tint : null;
  }
  if (Object.keys(colors).length === 0) return;
  COLORS = colors;
  TINTS = tints;
}

// Test seam: restores the built-ins so one test's catalog cannot leak into the
// next. Never called by production code.
export function resetElements() {
  COLORS = { ...DEFAULT_COLORS };
  TINTS = { ...DEFAULT_TINTS };
}

// Used by the projectile draw, the blast ring, the trail and the status-effect
// tint -- so a burn reads as belonging to the fire bolt that caused it.
export function elementColor(element) {
  return COLORS[element] || DEFAULT_ELEMENT_COLOR;
}

// The impact/particle wash. null means "no tint": the caller falls back to the
// effect's own colour, which is why this returns null rather than a default.
export function elementTint(element) {
  return TINTS[element] || null;
}
