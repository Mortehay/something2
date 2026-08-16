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
// THAT MARKER IS SHARED, AND IS NOT AN IDENTITY. "Homed, non-guard,
// non-portal" is exactly the shape SOMET-244's chest guards carry too --
// insertVaultChest and spawnFieldChest both anchor their guard to the chest
// tile -- and a player using a `loot_map` consumable inserts one into whatever
// world they are standing in. So anything asking "is this world already
// penned?" must ALSO test the anchor against the world's authored pen boxes;
// see pennedCreatureFilter below, which is the one place that predicate lives.
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
//
// AND THAT DILATION REACHES THE ROAD. Measured on the four home-region pens:
// the authored boxes hold 0 safe tiles, but every one of them sits 2 or 3 tiles
// (Chebyshev) from the radius-2 safe corridor while Skittish leashes at 500 px
// = 5 tiles, so a creature anchored on the pen's road-facing edge can and will
// pace onto the "safe" road. ACCEPTED, not an oversight, for three reasons:
//
//  - The corridor is a SPAWN-time rule and always was (SOMET-288). Nothing on
//    the movement path consults it, deliberately: a wild hostile chasing a
//    player has to be able to follow them to the gate, which is what the guards
//    are for. Wild hostiles already walk the road, and those actually attack.
//  - A skittish creature never opens. Its promise to the player is "walking the
//    road is not a fight", and that promise survives a swarm standing on it.
//  - The alternative costs the feature. Clearing the DILATED pen of the
//    corridor needs 6 tiles of margin, and Windwatch Pass -- a full road cross
//    through both midlines -- has exactly one such pocket, in the far
//    south-east corner some 28 tiles from its village. A practice pen a new
//    player never finds is a pen that does not exist.
//
// What is NOT accepted is the same dilation reaching a guard post: that one
// empties the pen over a few hours, and home_region_db.test.js checks the
// authored boxes GROWN BY THE LIVE LEASH RADIUS against the 400 px aggro ring.
// Today's margins past aggro: 800 / 337 / 300 / 521 px.
const { generateRegion, worldConfig, villageContaining, makeRng, CREATURE_TILE_PX } = require('./mapService');
const { scaleCreature } = require('./creatureLevel');
// The one 'Village Guard' literal, not a fourth copy. villages.js does not
// require this module, so this adds no cycle, and none of its own requires
// opens a pool at import time -- mapSpec.js already imports both files for
// exactly that reason.
const { GUARD_TYPE } = require('./villages');

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

// WHICH ROWS ARE THIS MODULE'S -- the only definition of it, in SQL, so that
// every caller asks the identical question.
//
// `{ where, params }`: a complete WHERE body with positional parameters from
// $1, for `world_creatures`. It selects exactly the rows insertPenCreatures
// writes for `worldId`: a non-guard, non-portal row whose home ANCHOR lies
// inside one of the world's AUTHORED pen boxes.
//
// THE BOX TEST IS THE WHOLE POINT. The first version of this predicate stopped
// at "homed, non-guard, non-portal", which is also what a vault- or field-chest
// guard looks like (see this module's header). A world declaring both a chest
// and pens seeds its chest first and then skips its pen pass FOREVER, silently
// -- the exact failure class this module exists to prevent -- and a player
// using a `loot_map` consumable can do the same to any world by hand.
//
// The anchor, not the current position: a penned creature roams within its
// leash, so `x`/`y` drift outside the box by design and only `home_x`/`home_y`
// stay where the placer put them.
//
// `pens` is in pensOf's camelCase shape. With no pens the filter matches
// nothing, which is the honest answer: a world that authors no pen has no
// penned creature, whatever else is homed in it.
//
// The one case this still cannot separate is a chest authored INSIDE a pen
// box, whose guard is then indistinguishable from a penned creature. Left
// as-is: that is an authoring conflict rather than an accident of a shared
// marker, the spec validator already refuses a pen overlapping a village for
// the same class of reason, and `down` deletes exactly what `up` skipped on,
// so the two halves still agree about it.
// The two halves of the predicate, kept separate so "inside a pen" and "loose
// in the world" are built from ONE reading of the boxes and can never drift
// apart into disagreeing about which rows count as penned (SOMET-356).
function penPredicateParts(worldId, pens) {
  const params = [worldId, GUARD_TYPE];
  const boxes = (pens || []).map((p) => {
    const b = params.length;
    params.push(
      p.minCol * CREATURE_TILE_PX, (p.minCol + p.width) * CREATURE_TILE_PX,
      p.minRow * CREATURE_TILE_PX, (p.minRow + p.height) * CREATURE_TILE_PX,
    );
    return `(home_x >= $${b + 1} AND home_x < $${b + 2}`
      + ` AND home_y >= $${b + 3} AND home_y < $${b + 4})`;
  });
  // "homed, not a village guard, not a portal guard" -- true of a penned
  // creature AND of a chest guard, which is why the box test carries the rest
  // of the weight here and an explicit chest exclusion carries it in the
  // stray filter below.
  const base = 'world_id = $1 AND type <> $2 AND blocks_portal_id IS NULL'
    + ' AND home_x IS NOT NULL AND home_y IS NOT NULL';
  // `false` rather than an empty string: a world authoring no pens has no
  // penned creatures BY DEFINITION, and the negation of that ("everything
  // homed is a stray") is exactly the dangerous reading, so the stray filter
  // refuses an empty pen list outright rather than relying on this.
  return { base, boxes: boxes.length > 0 ? `(${boxes.join(' OR ')})` : 'false', params };
}

function pennedCreatureFilter(worldId, pens) {
  const { base, boxes, params } = penPredicateParts(worldId, pens);
  return { where: `${base} AND ${boxes}`, params };
}

// Has this world's pen pass already run? The idempotency guard every seeding
// path shares. `db` is any queryable, the same contract insertPenCreatures has.
async function worldHasPennedCreatures(db, worldId, pens) {
  const { where, params } = pennedCreatureFilter(worldId, pens);
  const r = await db.query(`SELECT 1 FROM world_creatures WHERE ${where} LIMIT 1`, params);
  return r.rows.length > 0;
}

// The exact inverse, by construction: it deletes precisely the rows
// worldHasPennedCreatures would have found. A `down` that removed anything
// narrower would leave a row that blocks the next `up` and says nothing.
async function deletePennedCreatures(db, worldId, pens) {
  const { where, params } = pennedCreatureFilter(worldId, pens);
  const r = await db.query(`DELETE FROM world_creatures WHERE ${where}`, params);
  return r.rowCount ?? 0;
}

// Livestock left behind by a pen that MOVED (SOMET-356).
//
// worldHasPennedCreatures asks "is there a penned creature inside the boxes the
// spec authors TODAY", so when a pen's box moves the answer is no, the pen pass
// runs again, and it seeds a second herd in the new box. Nothing removes the
// first: populateWorld's DELETE deliberately spares any row carrying home_x, so
// the abandoned herd is permanent. That is how the home region ended up with 17
// homed creatures standing in pens that no longer exist -- five in Windwatch
// Pass, five in Thornbriar Reach, seven in Old Trailhead.
//
// This is the same shape as SOMET-312's silently-drifting village, and it gets
// a cheaper fix for one reason: a village needed a spec_key because
// merchant_stock FKs to it and players hold listings against that id, so it had
// to be MOVED rather than replaced. Penned livestock has no such identity --
// nothing references a penned creature's id -- so reconciling by deletion and
// letting the deterministic placer rebuild the herd is enough, and it needs no
// column and no migration.
//
// THE CHEST-GUARD EXCLUSION IS LOAD-BEARING, and it is why this is not simply
// pennedCreatureFilter with a NOT around the boxes. That filter can omit chest
// guards only because it looks INSIDE pen boxes, where a chest guard has no
// business being. Invert the box test and the predicate suddenly describes
// every homed row in the world -- which includes the guard insertVaultChest and
// spawnFieldChest anchor to their chest tile (SOMET-244), and a player using a
// `loot_map` consumable can spawn one of those in any world they are standing
// in, including a home-region world. Deleting those would be a worse bug than
// the one being fixed, so guards are excluded by id off world_chests.
//
// guard_creature_ids is JSONB holding uuid STRINGS and world_creatures.id is a
// uuid, hence `@> to_jsonb(id::text)` containment rather than any numeric or
// array comparison. home_region_db.test.js got exactly this wrong in the other
// direction -- see the note added there.
function strayPennedCreatureFilter(worldId, pens) {
  const { base, boxes, params } = penPredicateParts(worldId, pens);
  const where = `${base} AND NOT ${boxes}`
    + ' AND NOT EXISTS (SELECT 1 FROM world_chests wc WHERE wc.world_id = $1'
    + ' AND wc.guard_creature_ids @> to_jsonb(world_creatures.id::text))';
  return { where, params };
}

// Delete the strays. Returns how many, so the seeder can report a number that
// is zero on a steady-state re-seed and non-zero exactly once after a pen moves
// -- silence here would reproduce the original bug's worst property.
//
// Callers MUST pass the world's authored pens and MUST only call this for a
// world that declares at least one. With an empty pen list the base predicate
// is `AND false`, whose negation matches every homed row in the world; the
// seeder's `specPens.length === 0 -> continue` is what keeps that unreachable,
// and the guard below makes it unreachable here too rather than by convention.
async function deleteStrayPennedCreatures(db, worldId, pens) {
  if (!pens || pens.length === 0) return 0;
  const { where, params } = strayPennedCreatureFilter(worldId, pens);
  const r = await db.query(`DELETE FROM world_creatures WHERE ${where}`, params);
  return r.rowCount ?? 0;
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
  penTileIsPlaceable, pennedCreatureFilter, worldHasPennedCreatures,
  deletePennedCreatures, strayPennedCreatureFilter, deleteStrayPennedCreatures,
};
