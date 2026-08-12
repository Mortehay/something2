const { villageGatePosts, villageMerchantPost } = require('./mapService');
const { seedBaseCatalog } = require('./merchantStock');
const { MAP_TILE_SIZE } = require('../authority/coords');
const { scaleCreature } = require('./creatureLevel');
const { GUARD_DAMAGE } = require('../authority/creatures');

// ---------------------------------------------------------------------------
// SOMET-282 — the ON-SCREEN size budget.
//
// Acceptance criterion: a village must cover at most ONE QUARTER of the fixed
// 1280x720 viewport. Three different areas can be called "the village on
// screen"; the one enforced here is the strict reading, the axis-aligned
// BOUNDING BOX of the projected box (what a player perceives as "how much of
// my screen is village"), not the smaller painted parallelogram inside it.
//
// THE DERIVATION. Redo it if any constant below moves; every input is named
// with the file it lives in so that is a five-minute job.
//
//   MAP_TILE_SIZE = 100 world px / tile   (authority/coords.js, imported above;
//                                          frontend core/constants.js agrees)
//   ISO_TILE_W    = 128 screen px         (frontend core/constants.js)
//   ISO_K         = ISO_TILE_W / (2 * MAP_TILE_SIZE) = 0.64   (core/iso.js)
//   GAME_WIDTH x GAME_HEIGHT = 1280 x 720 (frontend core/constants.js; Game.js
//                                          sets canvas.width/height to these)
//
// The camera is TRANSLATE-ONLY -- Camera.apply calls ctx.translate and nothing
// else, and no ctx.scale/setTransform exists on the render path -- so one
// world->screen projected pixel is exactly one viewport pixel. No zoom factor
// enters the arithmetic. (villageScreenBudget.test.js re-reads all four
// frontend files and fails if any of that stops being true.)
//
// worldToScreen(wx,wy) = ((wx - wy) * K, (wx + wy) * K / 2). A w x h tile box
// spans W = 100w by H = 100h world px, whose four corners project to:
//
//     (0,0) -> (      0    ,        0        )      <- topmost
//     (W,0) -> (   K*W     ,     K*W/2       )      <- rightmost
//     (0,H) -> (  -K*H     ,     K*H/2       )      <- leftmost
//     (W,H) -> ( K*(W-H)   ,   K*(W+H)/2     )      <- bottommost
//
//   screen width  = K*W - (-K*H) = K*(W+H)
//   screen height = K*(W+H)/2 - 0 = K*(W+H)/2
//
// Both depend on W+H only -- i.e. on the TILE SUM w+h, never on w and h
// separately. That is why a per-axis maximum cannot express this rule and why
// VILLAGE_LIMITS carries maxSum below.
//
//   bounding-box area = K*(W+H) * K*(W+H)/2
//                     = (K * MAP_TILE_SIZE)^2 * (w+h)^2 / 2
//                     = 2048 * (w+h)^2  px^2
//
//   budget = 1280 * 720 / 4 = 230400 px^2
//   2048 * (w+h)^2 <= 230400  ->  (w+h)^2 <= 112.5  ->  w+h <= 10.606...
//   integers: w + h <= 10.
//
// Sanity checks against measured values:
//   w+h = 10 (e.g. 6x4):  640 x 320 px =  204800 px^2 =  88.9% of budget  OK
//   w+h = 11 (e.g. 6x5):  704 x 352 px =  247808 px^2 = 107.6% of budget  NO
//   w+h = 14 (i.e. 8x6):  896 x 448 px =  401408 px^2 = 174.2% of budget  NO
// The 8x6 line is the 896x448 / 401408 figure measured on screen before this
// ticket, and 8x6 in world pixels is 800x600 = 480000 px^2 (208% of budget) --
// the world-pixel reading, which is NOT what a player sees and is not used.
const ISO_TILE_W = 128;         // frontend/src/.../core/constants.js
const GAME_WIDTH = 1280;        // frontend/src/.../core/constants.js
const GAME_HEIGHT = 720;        // frontend/src/.../core/constants.js
const ISO_K = ISO_TILE_W / (2 * MAP_TILE_SIZE);          // frontend core/iso.js
const VILLAGE_SCREEN_BUDGET_PX2 = (GAME_WIDTH * GAME_HEIGHT) / 4;

// On-screen bounding box, in viewport pixels, of a village whose width+height
// is `tileSum` tiles. Exported for the tests and for the error message, so the
// number a caller is told is the number the rule actually used.
function villageScreenBox(tileSum) {
  const span = ISO_K * tileSum * MAP_TILE_SIZE;  // K*(W+H)
  return { width: span, height: span / 2, area: (span * span) / 2 };
}

// The largest legal w+h, SEARCHED rather than hardcoded: nobody has to trust
// that the 10 in a literal still follows from the constants above. Starts at
// the smallest village the limits allow (3+3) and grows while the next sum
// still fits, so a constant change moves this automatically.
function largestTileSumWithinBudget(minSum) {
  let sum = minSum;
  while (villageScreenBox(sum + 1).area <= VILLAGE_SCREEN_BUDGET_PX2) sum++;
  return sum;
}

// A village create/read/update caller may pick one of two ranges for width
// (columns) vs height (rows); a village that falls outside them is rejected
// by validateVillageBody in index.js and, later, by the map-spec validator.
// Both places import this single object so the numbers cannot drift apart.
//
// maxSum is the SOMET-282 screen budget derived above. It is the binding
// constraint: with minH 3 it caps width at 7, which makes maxW's 8 (and the
// tall end of maxH) unreachable. maxW/maxH are deliberately left where they
// are anyway -- index.js phrases its per-axis rejections as the literal
// strings "between 3 and 8 tiles" / "between 3 and 6 tiles", so narrowing the
// object without being able to edit that file would make those messages lie.
const VILLAGE_LIMITS = {
  minW: 3, maxW: 8, minH: 3, maxH: 6,
  maxSum: largestTileSumWithinBudget(3 + 3),
};

// SOMET-282. Null when the village fits the on-screen budget, otherwise a
// message naming the numbers. Integer width/height are NOT this function's
// business: both callers reject non-integers first, and returning null here
// for a garbage shape keeps their existing (more specific) message.
function villageSizeError(village) {
  const { width, height } = village || {};
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  const sum = width + height;
  if (sum <= VILLAGE_LIMITS.maxSum) return null;
  const box = villageScreenBox(sum);
  const pct = Math.round((box.area / VILLAGE_SCREEN_BUDGET_PX2) * 100);
  // Rounded for display only -- ISO_K is 0.64, so the exact products carry
  // float noise (896.0000000000001) that would make the message look broken.
  // The comparison above uses the exact value.
  return `width + height must be at most ${VILLAGE_LIMITS.maxSum} tiles `
    + `(got ${width} + ${height} = ${sum}): on screen that box is `
    + `${Math.round(box.width)}x${Math.round(box.height)} px = ${pct}% of the `
    + `${GAME_WIDTH}x${GAME_HEIGHT} viewport, and a village may cover at most `
    + 'a quarter of it';
}

// The spawn/respawn point must land on an INTERIOR tile of the village box.
// stampVillage walls the whole perimeter (only the single gate tile is
// passable), so a spawn on the ring teleports the player *into* a wall tile:
// respawn-at-village then drops them inside the wall with no way out
// (SOMET-153, shipped live on three p5-descent hubs).
//
// ONE rule, TWO callers: validateVillageBody in src/index.js (the HTTP admin
// API) and validateMapSpec in seeds/mapSpec.js (the seed path). The seed path
// had NO spawn check at all -- scripts/seed-map.js calls createVillage
// directly, bypassing the route -- which is exactly how the broken villages
// got written. Both now import this function, for the same
// cannot-drift-apart reason VILLAGE_LIMITS is shared rather than duplicated.
//
// Returns null when the spawn is legal, otherwise a message describing what
// is wrong. Fields are the snake_case shape used by both the API body and the
// map spec's `village` object.
//
// Callers use villageGeometryError (below), which runs this AND the SOMET-282
// size check; this half is separated only so each rule can be read and tested
// on its own.
function villageSpawnPointError(village) {
  const { min_row, min_col, width, height, spawn_x, spawn_y } = village || {};
  if (!Number.isFinite(spawn_x) || !Number.isFinite(spawn_y)) {
    return 'spawn_x and spawn_y are required';
  }
  const sCol = Math.floor(spawn_x / MAP_TILE_SIZE);
  const sRow = Math.floor(spawn_y / MAP_TILE_SIZE);
  // Interior = the box minus its one-tile wall ring. Written as inclusive
  // bounds so the error can name them; identical to the strict-inequality
  // form (sRow > min_row && sRow < min_row + height - 1) for integer tiles.
  const loRow = min_row + 1;
  const hiRow = min_row + height - 2;
  const loCol = min_col + 1;
  const hiCol = min_col + width - 2;
  const inInterior = sRow >= loRow && sRow <= hiRow && sCol >= loCol && sCol <= hiCol;
  if (inInterior) return null;
  return 'spawn point must be inside the village interior — '
    + `spawn (${spawn_x},${spawn_y}) lands on tile (row ${sRow}, col ${sCol}), `
    + `but the interior is rows ${loRow}..${hiRow}, cols ${loCol}..${hiCol}`;
}

// THE one geometry gate every village write passes through: the SOMET-282
// on-screen size budget, then the SOMET-153 interior-spawn rule. Returns null
// when the village is legal, otherwise the first message.
//
// Size is checked FIRST because it is a property of the box alone: telling a
// caller its spawn is misplaced when the box itself is illegal would send them
// to fix the wrong number.
//
// ONE name, called by BOTH the HTTP route (validateVillageBody in
// src/index.js) and the seed path (validateMapSpec in seeds/mapSpec.js) -- the
// same cannot-drift-apart reason VILLAGE_LIMITS is shared rather than copied,
// and the reason SOMET-153's wall-ring bug existed at all: that rule lived on
// only one of the two paths that can create a village, and the unguarded path
// is the one that wrote production data.
function villageGeometryError(village) {
  return villageSizeError(village) || villageSpawnPointError(village);
}

async function fetchVillages(pool, worldId) {
  const r = await pool.query(
    `SELECT id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y, merchant_x, merchant_y
       FROM villages WHERE world_id = $1 ORDER BY created_at ASC`,
    [worldId],
  );
  return r.rows.map((v) => ({
    id: v.id,
    minRow: v.min_row, minCol: v.min_col,
    width: v.width, height: v.height,
    gateEdge: v.gate_edge,
    spawnX: v.spawn_x, spawnY: v.spawn_y,
    merchantX: v.merchant_x == null ? null : Number(v.merchant_x),
    merchantY: v.merchant_y == null ? null : Number(v.merchant_y),
  }));
}

const GUARD_TYPE = 'Village Guard';

// Only reached if the Village Guard entity type is missing or mis-authored --
// the seeded row carries hp 300 / defense 10. A structural gate defender must
// still spawn (and still be a real fight) when the catalog is incomplete,
// because insertVillageGuards runs inside the caller's village-create /
// re-roll transaction and a throw here rolls the whole village back.
const GUARD_FALLBACK_HP = 300;
const GUARD_FALLBACK_DEFENSE = 10;

// SOMET-279. A guard's level/hp/damage/defense come from its world's level
// band, through the SAME scaleCreature curve placeMapCreatures /
// placeCreaturePacks / insertVaultChest already use for every other creature.
// A second curve here would drift from that one the first time either is
// tuned -- this repo has been bitten by exactly that.
//
// The level is the band's TOP (worlds.level_max), not a roll and not the
// bottom: a guard exists to beat the hostiles of its own world, and a guard
// rolled at level_min in a 46..50 world would be facing level-50 hostiles
// with level-46 numbers. Guards are structural (fixed posts, fixed count),
// so there is nothing for a random roll to add.
//
// Relative to a same-level hostile the guard's advantage is entirely the
// Village Guard entity type's own base stats, carried through the shared
// curve -- no extra guard-only multiplier is introduced here. At every level
// that is 10x a Line's hp, 5x its damage and 3.3x its defense (2.3x hp / 5x
// damage / 0.92x defense against an Apex), which keeps a guard's
// time-to-kill on a hostile roughly level-invariant instead of collapsing to
// the applyDamage floor the way a flat 25 damage does above level ~25.
async function guardStatsForWorld(db, worldId) {
  const w = await db.query('SELECT level_max FROM worlds WHERE id = $1', [worldId]);
  const rawLevel = w.rows[0] ? Number(w.rows[0].level_max) : NaN;
  // Same posture rollCreatureLevel takes on a missing/invalid band: fall back
  // to 1 (today's behaviour exactly) rather than throw inside the caller's
  // transaction.
  const level = Number.isFinite(rawLevel) && rawLevel >= 1 ? Math.floor(rawLevel) : 1;

  const t = await db.query('SELECT hp, defense FROM entity_types WHERE name = $1', [GUARD_TYPE]);
  const row = t.rows[0] || {};
  const baseHp = Number(row.hp);
  // `== null` deliberately, not Number.isFinite alone: entity_types.defense is
  // NOT NULL with default 0, so a defense of 0 is a real authored value that
  // must survive -- only an ABSENT column/row falls back.
  const baseDefense = row.defense == null ? NaN : Number(row.defense);
  const scaled = scaleCreature({
    hp: baseHp > 0 ? baseHp : GUARD_FALLBACK_HP,
    // The guard's base damage is NOT a world_creatures value and is not on
    // entity_types either -- it is GUARD_DAMAGE, seeded into
    // creature_behaviors.Guard.damage_override. Imported from the authority
    // rather than re-typed so the two cannot drift.
    damage: GUARD_DAMAGE,
    defense: Number.isFinite(baseDefense) ? baseDefense : GUARD_FALLBACK_DEFENSE,
  }, level);
  return { level, ...scaled };
}

// Two guards per village, standing on the interior tiles flanking the gate.
// home_x/home_y is the post: the authority leashes a guard to it.
// `db` is any queryable (the module-level pool, or a connected client mid-
// transaction — village create/delete, the creature re-roll route, and the
// regenerate-terrain route (SOMET-252) all pass their transaction's client
// so this participates in it, F-007 / SOMET-187). The two extra SELECTs
// guardStatsForWorld makes therefore run on the caller's client too, and see
// the caller's uncommitted world row.
//
// One band lookup per call, not per guard: every village passed in belongs to
// `worldId` by construction (both callers derive `villages` from that world).
async function insertVillageGuards(db, worldId, villages) {
  // Nothing to place -> no band lookup. The village DELETE route calls this
  // with the villages that SURVIVE the delete, so removing a world's last
  // village lands here with an empty list; querying the world band and the
  // Village Guard row to scale zero guards is two pointless round-trips
  // inside the caller's transaction.
  if (!villages || villages.length === 0) return;
  const stats = await guardStatsForWorld(db, worldId);
  for (const v of villages) {
    for (const post of villageGatePosts(v)) {
      await db.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, damage, defense)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [worldId, GUARD_TYPE, post.x, post.y, stats.hp, 'S', post.x, post.y,
          stats.level, stats.damage, stats.defense],
      );
    }
  }
}

// The three dependent writes a village needs to be playable: the row itself,
// its gate guards, and its merchant's base catalog. `client` is the caller's
// transaction client (village create/delete and the seed applier all run
// this inside their own BEGIN/COMMIT/ROLLBACK) so this function owns none of
// the transaction handling or error mapping -- only the write sequence.
async function createVillage(client, worldId, village) {
  const { min_row, min_col, width, height, gate_edge, spawn_x, spawn_y } = village;
  const mpost = villageMerchantPost({
    minRow: min_row, minCol: min_col, width, height, gateEdge: gate_edge,
  });

  const ins = await client.query(
    `INSERT INTO villages (world_id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y, merchant_x, merchant_y)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [worldId, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y, mpost.x, mpost.y],
  );
  const row = ins.rows[0];
  await insertVillageGuards(client, worldId, [{
    minRow: row.min_row, minCol: row.min_col,
    width: row.width, height: row.height, gateEdge: row.gate_edge,
  }]);
  await seedBaseCatalog(client, worldId, row.id);
  return row;
}

module.exports = {
  fetchVillages, createVillage, insertVillageGuards, guardStatsForWorld,
  GUARD_TYPE, VILLAGE_LIMITS,
  villageGeometryError,
  // The two halves, exported for tests that need to attribute a rejection to
  // one rule or the other.
  villageSizeError, villageSpawnPointError,
  // Screen-budget internals, so a test can re-derive the limit instead of
  // restating it.
  villageScreenBox, VILLAGE_SCREEN_BUDGET_PX2, ISO_K,
};
