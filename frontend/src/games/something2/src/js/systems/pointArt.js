// Pure client-side resolution of world point art (SOMET-583). No canvas, no
// DOM: the renderer calls these and draws through drawEntity.
//
// `entityDefs` is Game.entityDefs -- the /api/map/config entityTypes map,
// name-keyed, camelCase sizes (displayWidth/displayHeight), snake_case
// render_mode/sprite (see getEntityTypesMap in backend/src/index.js).
import { MAP_TILE_SIZE } from "../core/constants.js";

// Drawable art only. A 'rect' type or one with neither image nor sprite is
// "no art" -- the caller keeps today's placeholder shape, never a hole.
export function pointArtDef(artName, entityDefs) {
  if (!artName || !entityDefs) return null;
  const def = entityDefs[artName];
  if (!def || def.render_mode === "rect" || !def.render_mode) return null;
  if (!def.image && !def.sprite) return null;
  return def;
}

// A world point's x/y is its tile CENTRE. drawEntity centres on
// (x + width/2, y + height/2), so hand it the tile's top-left and a
// full-tile box -- byte-for-byte what collectDecorations does.
export function pointBodyRef(def, x, y, extra = {}) {
  return {
    ...def, ...extra,
    x: x - MAP_TILE_SIZE / 2, y: y - MAP_TILE_SIZE / 2,
    width: MAP_TILE_SIZE, height: MAP_TILE_SIZE,
  };
}

const DIM = 0.45;

export function pointStateTreatment(kind, point) {
  if (kind === "waypoint") {
    const lit = point && point.activated === true;
    return { alpha: lit ? 1 : DIM, ring: !lit, stateKey: lit ? "lit" : "unlit" };
  }
  if (kind === "chest") {
    const state = (point && point.state) || "locked";
    return { alpha: state === "opened" ? DIM : 1, ring: false, stateKey: state };
  }
  return { alpha: 1, ring: false, stateKey: null };
}

const tileKey = (l) => `${Math.floor(l.y / MAP_TILE_SIZE)},${Math.floor(l.x / MAP_TILE_SIZE)}`;

// Which landmarks get an art body, and which diamonds landmarkRenderer must
// therefore not draw. A flagged staircase (is_waypoint: true) is a portal AND
// a waypoint on ONE tile; two bodies there would be one gate drawn twice, so
// the portal's wins and the waypoint keeps only its beam, label and ring.
export function planLandmarkBodies(landmarks, entityDefs) {
  const bodies = [];
  const skipBody = new Set();
  if (!Array.isArray(landmarks) || !entityDefs) return { bodies, skipBody };
  const portalArtTiles = new Set(
    landmarks.filter((l) => l && l.kind === "portal" && pointArtDef(l.art, entityDefs)).map(tileKey),
  );
  for (const l of landmarks) {
    if (!l) continue;
    const def = pointArtDef(l.art, entityDefs);
    if (!def) continue;
    if (l.kind === "waypoint" && portalArtTiles.has(tileKey(l))) {
      skipBody.add(l);
      continue;
    }
    skipBody.add(l);
    bodies.push({ landmark: l, def, treatment: pointStateTreatment(l.kind, l) });
  }
  return { bodies, skipBody };
}
