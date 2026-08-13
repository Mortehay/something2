// Pens: authored pockets of skittish low-level wildlife (SOMET-289, spec §2).
//
// A pen is a rectangle in tile coordinates holding `count` creatures of one
// type. Deliberately NO WALLS AND NO GATE -- the gate that matters is the
// village gate you flee toward, and pen walls would be geometry with no
// mechanic behind it.
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE EXISTS AT ALL, instead of routing pens through
// placeMapCreatures like every other creature.
//
// THE PLACEMENT CHOKEPOINT REFUSES BY TILE, NOT BY FACTION.
// mapService's creatureTileCandidates returns null for ANY creature type on a
// tile safeRegion calls safe. The rule reads as "hostiles are never generated
// in safe territory", but it does not consult faction -- so a pen authored
// inside a village, or within safe_road_radius of a road, comes out SILENTLY
// EMPTY. The map spec validates, the seed exits 0, and the pen is simply not
// there: the exact failure class WORLD_KEYS was added to prevent, one level up.
//
// So pens place through here, and this placer deliberately does NOT consult
// isSafeTile. It still refuses the structurally impossible -- the map's wall
// ring, a doorway cell, an unwalkable tile, a village footprint -- because
// those are geometry rather than policy: a creature standing in a wall is
// stuck, not merely mis-zoned.
//
// Teaching creatureTileCandidates the faction distinction was the alternative
// and was rejected: it would change hostile placement in all 86 worlds to serve
// four pens, and "safe" would stop meaning one thing.
//
// ---------------------------------------------------------------------------
// WHY EVERY PENNED CREATURE CARRIES home_x / home_y. Two reasons, and they are
// the same fact rather than a marker bolted onto a mechanic:
//
//  1. CONTAINMENT. The authority leashes a homed creature to its anchor --
//     roam steps outside the leash are refused, knockback cannot punt it out,
//     and it walks home when displaced. A pen with no walls is held together
//     by nothing else.
//  2. SURVIVAL. populateWorld opens with
//       DELETE ... WHERE type <> 'Village Guard'
//                    AND blocks_portal_id IS NULL AND home_x IS NULL
//     so a penned creature carrying none of those markers is deleted on the
//     very next populate -- the bug that already bit portal guards (SOMET-246)
//     and vault chests (SOMET-244). `home_x IS NOT NULL` is the structural
//     marker, and a penned creature needs the anchor anyway.
//
// ---------------------------------------------------------------------------
// KEEP A PEN AWAY FROM THE VILLAGE GUARDS. Village guards target
// `faction = 'hostile'`, and every skittish creature type IS faction 'hostile'
// -- they are non-aggressive by chase_style, not by faction. Guard aggro is
// 400 px from the post, and SOMET-291 raises the Guard leash to 600 so that
// aggro radius is no longer clipped by the leash filter. A pen inside that ring
// is livestock the village's own guards will systematically farm, and a player
// arrives at the starting village to find the practice pen being emptied.
//
// Not enforced in code: the guard posts are derived from a village box that a
// pen's own validation has no handle on, and the numbers belong to the Guard
// behaviour row rather than to a pen. It is an AUTHORING rule -- every pen in
// the home region sits 1200 px or more from the nearest guard post, measured
// from the posts (villageGatePosts) rather than from the village box edge.
//
// ---------------------------------------------------------------------------
// The anchor is each creature's OWN spawn tile, not the pen centre: a shared
// anchor would have every creature in the pen walk back to one tile and pile up
// there. The honest consequence is that containment is "within the behaviour's
// leash radius of where this creature was placed", i.e. the pen dilated by that
// radius -- world_creatures has no per-creature leash column, so the radius
// comes from the creature's behaviour row and cannot be authored per pen.
const { generateRegion, worldConfig, villageContaining, makeRng, CREATURE_TILE_PX } = require('./mapService');
const { scaleCreature } = require('./creatureLevel');

// The baseline a creature's damage scales from -- the same CREATURE_BASE_DAMAGE
// placeMapCreatures and placeCreaturePacks use, so a penned creature and a wild
// one of the same type and level are statted identically. Restated rather than
// imported only because mapService does not export it; if it ever does, import
// it instead of keeping a second copy.
const PEN_BASE_DAMAGE = 5;

// Authoring limits for a pen box. Small: a pen is a pocket a player stumbles
// into, and a rectangle the size of a quarter of the map is not one. Unlike
// VILLAGE_LIMITS these are not derived from anything -- a pen has no walls, so
// there is no on-screen box to budget for (SOMET-282) -- they are a sanity
// range, which is why they are stated plainly rather than searched.
const PEN_LIMITS = { minW: 2, maxW: 12, minH: 2, maxH: 12 };

// Null when the pen is legal, otherwise a message naming the numbers. `world`
// supplies the map bounds; both the map-spec validator and the placer call
// THIS, the same cannot-drift-apart reason villageGeometryError is shared
// between validateMapSpec and the HTTP route.
function penGeometryError(pen, { width, height } = {}) {
  const p = pen || {};
  for (const f of ['min_row', 'min_col', 'width', 'height', 'count', 'level']) {
    if (!Number.isInteger(p[f])) {
      return `${f} must be an integer (got ${JSON.stringify(p[f])})`;
    }
  }
  if (p.width < PEN_LIMITS.minW || p.width > PEN_LIMITS.maxW) {
    return `width must be between ${PEN_LIMITS.minW} and ${PEN_LIMITS.maxW} tiles (got ${p.width})`;
  }
  if (p.height < PEN_LIMITS.minH || p.height > PEN_LIMITS.maxH) {
    return `height must be between ${PEN_LIMITS.minH} and ${PEN_LIMITS.maxH} tiles (got ${p.height})`;
  }
  if (p.count < 1) return `count must be at least 1 (got ${p.count})`;
  if (p.level < 1) return `level must be at least 1 (got ${p.level})`;
  // More creatures than tiles cannot all be seated: the placer refuses to stack
  // two creatures on one tile, because stacked sprites read as one creature.
  if (p.count > p.width * p.height) {
    return `count ${p.count} exceeds the ${p.width}x${p.height} = ${p.width * p.height} tiles in the pen`;
  }
  if (typeof p.creature_type !== 'string' || p.creature_type.length === 0) {
    return 'creature_type is required';
  }
  // Bounds are checked against the STRICT interior. The map's outer ring is
  // wall, so a pen overlapping it is not merely a smaller pen -- those tiles
  // can never hold a creature, and the pen would silently under-deliver.
  if (Number.isInteger(width) && Number.isInteger(height)) {
    if (p.min_row < 1 || p.min_col < 1
        || p.min_row + p.height > height - 1 || p.min_col + p.width > width - 1) {
      return `box (rows ${p.min_row}..${p.min_row + p.height - 1}, `
        + `cols ${p.min_col}..${p.min_col + p.width - 1}) must lie strictly inside `
        + `the ${width}x${height} map's wall ring`;
    }
  }
  return null;
}

// snake_case in the DB and the map spec, camelCase in JS -- the same convention
// safe_rects follows. Non-array input yields [], matching how a world read
// before migration 1714440200000 must behave.
function pensOf(row) {
  const raw = row && row.pens;
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({
    minRow: p.min_row, minCol: p.min_col, width: p.width, height: p.height,
    creatureType: p.creature_type, count: p.count, level: p.level,
  }));
}

// Can a creature stand here? Structure only -- see this module's header for why
// isSafeTile is deliberately not consulted.
function penTileIsPlaceable(world, cfg, gRow, gCol) {
  const { width, height, wallTile, doorwayTile } = cfg.bounds;
  if (gRow < 1 || gRow > height - 2 || gCol < 1 || gCol > width - 2) return false;
  const name = generateRegion(world, gRow, gCol, 1, 1)[0][0];
  if (name === wallTile || name === doorwayTile) return false;
  const def = world.tileTypes && world.tileTypes[name];
  if (def && def.walkable === false) return false;
  // generateRegion stamps village walls, so most of a village box is already
  // refused above -- but its INTERIOR is plain walkable terrain, and a pen
  // creature sealed inside a village would be both unreachable and a standing
  // violation of the epic's "only Village Guards stand inside a village".
  if (villageContaining(gRow, gCol, cfg.villages)) return false;
  return true;
}

// Every creature one pen contributes. Pure and deterministic given `rngSeed`.
//
// ENUMERATE-THEN-SHUFFLE rather than the rejection sampling placeMapCreatures
// uses. A pen is a handful of tiles, and rejection sampling can exhaust its
// attempt budget and ship a pen short WITHOUT SAYING SO -- on a 30-tile box
// that is a realistic outcome, not a remote one, and a half-empty pen is
// exactly the silent under-delivery this whole module exists to prevent. Here,
// if the pen has enough placeable tiles it fills, deterministically; if it does
// not, the caller can see `placed < count` and say so.
function placePenCreatures(world, pen, entityType, rngSeed) {
  const cfg = worldConfig(world);
  if (!cfg.bounds) return [];
  const count = Math.max(0, Math.floor(pen.count) || 0);
  if (count === 0) return [];

  const cells = [];
  for (let r = pen.minRow; r < pen.minRow + pen.height; r++) {
    for (let c = pen.minCol; c < pen.minCol + pen.width; c++) {
      if (penTileIsPlaceable(world, cfg, r, c)) cells.push([r, c]);
    }
  }

  // Fisher-Yates over the same mulberry32 every other seeded draw in this
  // codebase goes through, so a re-seed at a fixed rngSeed reproduces the pen
  // exactly. Shuffling (rather than taking the first `count` in row-major
  // order) keeps a partly-blocked pen from bunching every creature into its
  // north-west corner.
  const rng = makeRng(rngSeed >>> 0);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  const level = Math.max(1, Math.floor(pen.level) || 1);
  const scaled = scaleCreature({
    hp: entityType.hp || 10,
    damage: PEN_BASE_DAMAGE,
    defense: Number(entityType.defense ?? 0) || 0,
  }, level);

  return cells.slice(0, count).map(([r, c]) => {
    const x = c * CREATURE_TILE_PX + CREATURE_TILE_PX / 2;
    const y = r * CREATURE_TILE_PX + CREATURE_TILE_PX / 2;
    return {
      type: entityType.name,
      x,
      y,
      // The anchor IS the spawn tile. See the header: this is both the leash
      // anchor that contains the creature and the marker that spares the row
      // from populateWorld's opening DELETE.
      homeX: x,
      homeY: y,
      hp: scaled.hp,
      damage: scaled.damage,
      defense: scaled.defense,
      level,
      facing: 'S',
    };
  });
}

async function insertPenCreatures(client, worldId, rows) {
  for (const c of rows) {
    await client.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, damage, defense)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [worldId, c.type, c.x, c.y, c.hp, c.facing, c.homeX, c.homeY, c.level, c.damage, c.defense],
    );
  }
}

module.exports = {
  PEN_LIMITS, penGeometryError, pensOf, placePenCreatures, insertPenCreatures,
  penTileIsPlaceable,
};
