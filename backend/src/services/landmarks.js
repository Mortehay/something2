// backend/src/services/landmarks.js
//
// A LANDMARK is a read model, not a table: the union of a world's waypoints and
// its PORTAL source tiles, in the one shape every display surface needs.
//
//   { kind: 'waypoint' | 'portal', x, y, name, activated }
//
// WHY THIS EXISTS. SOMET-292/293 shipped a working waypoint network with no
// visual representation anywhere -- RenderSystem.js, wallRenderer.js and
// minimapRenderer.js contained zero references to `waypoint` or `portal`. A
// player spawns one tile from the Old Trailhead waypoint and nothing on screen
// says so. This module is what the `joined` frame sends so three renderers can
// finally draw them.
//
// WHY IT IMPORTS NOTHING. Same discipline as services/safeRegion.js (SOMET-288):
// the authority requires this, so a require back into the authority would be a
// cycle. It is a pure function over data the caller already holds.
//
// WHY IT TAKES loadWorld's OWN STRUCTURES rather than querying. `loadWorld`
// already builds both Maps -- portalLinks around server.js:488 and waypoints
// around server.js:505, where a comment states outright that it is "THE ONLY
// RUNTIME READ of the waypoints table. Nothing else loads them for the sim, so
// there is no second loader to fall out of step with". Adding a query here
// would create exactly the second loader that comment is guarding against, and
// the two-loader split is what left a whole creature-behaviour catalog inert in
// SOMET-249. So: no pool, no query, no I/O.

// A portal row carries no name of its own -- map_links has no name column. Its
// label is its destination, which fetchLinks supplies as `to_name`.
function portalLabel(link) {
  return link && link.toName ? `To ${link.toName}` : 'Portal';
}

// Build the landmark list for one world.
//
//   waypoints    Map tileKey -> { id, x, y, name }              (loadWorld)
//   portalLinks  Map tileKey -> { id, fromX, fromY, toName, ... } (loadWorld)
//   activatedIds Set of WAYPOINT ids this character has lit
//
// Returns [] for anything missing. That is load-bearing rather than defensive:
// the join frame is built for every world, 86 of which hold no landmark at all,
// and a throw here would break JOINING those worlds -- not merely fail to draw
// a marker on them.
function buildLandmarks({ waypoints, portalLinks, activatedIds } = {}) {
  const lit = activatedIds instanceof Set ? activatedIds : new Set();
  const out = [];

  if (waypoints && typeof waypoints.values === 'function') {
    for (const w of waypoints.values()) {
      if (!w || !Number.isFinite(w.x) || !Number.isFinite(w.y)) continue;
      out.push({
        kind: 'waypoint',
        x: w.x,
        y: w.y,
        name: w.name || 'Waypoint',
        // Per character. The same waypoint reads true for one character and
        // false for another in the same world at the same moment.
        activated: lit.has(w.id),
      });
    }
  }

  if (portalLinks && typeof portalLinks.values === 'function') {
    for (const p of portalLinks.values()) {
      if (!p || !Number.isFinite(p.fromX) || !Number.isFinite(p.fromY)) continue;
      out.push({
        kind: 'portal',
        x: p.fromX,
        y: p.fromY,
        name: portalLabel(p),
        // ALWAYS false, and deliberately not a lookup in `lit`. Portals are not
        // activated -- walking into one uses it. `lit` holds waypoint ids, so
        // consulting it here would let an unrelated id collision light a portal.
        activated: false,
      });
    }
  }

  // Row then column, so the wire order is a property of the world rather than
  // of Map insertion order. Without this the client's marker list reshuffles
  // between joins for no reason, and the tests would be pinning a Map's
  // iteration order instead of a decision.
  out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return out;
}

module.exports = { buildLandmarks };
