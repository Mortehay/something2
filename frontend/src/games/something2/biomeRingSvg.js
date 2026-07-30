// A world's biomes as a ring of arcs, returned as an SVG data URI for
// Cytoscape's `background-image`.
//
// Cytoscape's built-in `pie` style is deliberately not used: it fills the node
// BODY, which would put colour behind the label instead of around it. A donut
// keeps the centre neutral and the name readable.

// biomes.color is admin-editable free text that ends up inside an SVG
// attribute. Only plain hex is allowed through; anything else is replaced with
// the neutral colour rather than interpolated.
export const SAFE_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const NEUTRAL = '#555555';

export function biomeRingSvg(colors, { size = 64, thickness = 8, empty = NEUTRAL } = {}) {
  const list = (Array.isArray(colors) ? colors : [])
    .map((c) => (typeof c === 'string' && SAFE_COLOR_RE.test(c.trim()) ? c.trim() : empty));
  const arcs = list.length > 0 ? list : [empty];

  const radius = (size - thickness) / 2;
  const centre = size / 2;
  const circumference = 2 * Math.PI * radius;
  const segment = circumference / arcs.length;

  const circles = arcs.map((colour, i) => (
    `<circle cx="${centre}" cy="${centre}" r="${radius}" fill="none" stroke="${colour}" `
    + `stroke-width="${thickness}" stroke-dasharray="${segment} ${circumference - segment}" `
    + `stroke-dashoffset="${-i * segment}" transform="rotate(-90 ${centre} ${centre})"/>`
  )).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 ${size} ${size}">${circles}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
