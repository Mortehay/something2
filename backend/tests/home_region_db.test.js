const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const {
  worldConfig, collectPathCells, villageGatePosts, placeMapCreatures, CREATURE_TILE_PX,
} = require('../src/services/mapService.js');
const { buildSafeContext, isSafeTile } = require('../src/services/safeRegion.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { loadTileTypes } = require('../src/services/tileTypes.js');
const { loadBiomes } = require('../src/services/biomes.js');
const { fetchLinks } = require('../src/services/mapLinks.js');
const { fetchVillages, GUARD_TYPE } = require('../src/services/villages.js');
const { populateWorld } = require('../src/services/worldPopulation.js');

// SOMET-289. The live rows and the checked-in specs must agree, or the two
// drift and a re-seed silently reverts the authored region. Migration
// 1714440201000 carries frozen LITERALS (a migration must do the same thing
// forever); this test is what stops those literals and the spec files
// disagreeing without anybody noticing.
const URL = process.env.DATABASE_URL;
const describeDb = URL ? test : test.skip;

// The three home-region worlds and their spec keys. SOMET-355: spine-descent
// and hub-vale are now the `spine_` and `vale_` REGIONS of the merged
// `vale-region` spec -- and the Old Trailhead <-> Thornbriar Reach link that
// makes them neighbours, which the comment here used to note "exists only in
// the live database and is in no checked-in spec", is now declared as
// `vale_forest --E--> spine_entry`. That undeclared link was the whole of
// SOMET-355: a re-seed would have dropped it and split the home region in two.
const HOME_SPEC = 'vale-region';
const HOME_WORLDS = [
  ['Old Trailhead', HOME_SPEC, 'spine_entry'],
  ['Windwatch Pass', HOME_SPEC, 'spine_pass'],
  ['Thornbriar Reach', HOME_SPEC, 'vale_forest'],
];

const specWorld = (specName, key) => {
  const file = path.join(__dirname, '..', 'seeds', 'maps', `${specName}.map.json`);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const w = spec.worlds.find((x) => x.key === key);
  assert.ok(w, `spec ${specName} has no world "${key}"`);
  return w;
};

const tileOf = (c) => [
  Math.floor(Number(c.y) / CREATURE_TILE_PX),
  Math.floor(Number(c.x) / CREATURE_TILE_PX),
];

const inBox = (row, col, b) =>
  row >= b.min_row && row < b.min_row + b.height
  && col >= b.min_col && col < b.min_col + b.width;

async function loadWorld(pool, name) {
  const r = await pool.query('SELECT * FROM worlds WHERE name = $1', [name]);
  assert.equal(r.rowCount, 1, `expected exactly one world named "${name}"`);
  return r.rows[0];
}

describeDb('the live home region matches the checked-in specs', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    // Guard against the whole file passing vacuously against a database that
    // was never migrated: every assertion below would then compare two things
    // that are both absent.
    const anyPen = await pool.query(
      "SELECT 1 FROM worlds WHERE jsonb_array_length(pens) > 0 LIMIT 1");
    assert.equal(anyPen.rowCount, 1,
      'no world in this database has a pen -- migration 1714440201000 has not run, '
      + 'so every assertion in this file would be vacuous');

    for (const [name, specName, key] of HOME_WORLDS) {
      const spec = specWorld(specName, key);
      const row = await loadWorld(pool, name);

      // --- the authored columns ---------------------------------------------
      assert.equal(Number(row.safe_road_radius), spec.safe_road_radius,
        `${name}: live safe_road_radius disagrees with ${specName}.map.json`);
      assert.deepEqual(row.authored_roads, spec.roads,
        `${name}: live authored_roads disagree with ${specName}.map.json`);
      assert.deepEqual(row.pens, spec.pens,
        `${name}: live pens disagree with ${specName}.map.json`);
      assert.ok(spec.roads.length > 0 && spec.pens.length > 0,
        `${name}: the spec authors no roads or no pens, so the two assertions above `
        + 'would hold for reasons unrelated to this feature');

      // --- the village ------------------------------------------------------
      const villages = await fetchVillages(pool, row.id);
      assert.equal(villages.length, 1, `${name} should have exactly one village`);
      const v = villages[0];
      assert.deepEqual(
        { min_row: v.minRow, min_col: v.minCol, width: v.width, height: v.height,
          gate_edge: v.gateEdge, spawn_x: Number(v.spawnX), spawn_y: Number(v.spawnY) },
        { min_row: spec.village.min_row, min_col: spec.village.min_col,
          width: spec.village.width, height: spec.village.height,
          gate_edge: spec.village.gate_edge,
          spawn_x: spec.village.spawn_x, spawn_y: spec.village.spawn_y },
        `${name}: the live village box disagrees with ${specName}.map.json`);

      // --- no village box covers a doorway or its arrival tile ---------------
      // A village stamped over a doorway seals the world; over the arrival tile
      // it drops an inbound player inside a wall.
      const links = await fetchLinks(pool, row.id);
      const doorways = links.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
      assert.ok(doorways.length > 0, `${name} has no doorways -- this check would be vacuous`);
      const midCol = Math.floor(row.width / 2);
      const midRow = Math.floor(row.height / 2);
      const critical = { N: [[0, midCol], [1, midCol]],
        S: [[row.height - 1, midCol], [row.height - 2, midCol]],
        W: [[midRow, 0], [midRow, 1]],
        E: [[midRow, row.width - 1], [midRow, row.width - 2]] };
      for (const e of doorways) {
        for (const [r, c] of critical[e]) {
          assert.ok(!inBox(r, c, spec.village),
            `${name}: the village box covers doorway-${e} tile (${r},${c})`);
        }
      }

      // --- the safe context, derived exactly as placement derives it ---------
      const world = buildWorldGenConfig({
        row,
        tileTypes: await loadTileTypes(pool),
        doorways,
        villages,
        biomes: await loadBiomes(pool, row.biomes),
      });
      const cfg = worldConfig(world);
      const roads = collectPathCells(cfg, 0, 0, row.height, row.width);
      const ctx = buildSafeContext({
        villages: cfg.villages,
        pathCells: roads,
        safeRoadRadius: cfg.safeRoadRadius,
        safeRects: cfg.safeRects,
      });

      // The authored road must actually be IN the carved set, or the corridor
      // the player walks is not the corridor that was authored.
      for (const line of spec.roads) {
        for (const [r, c] of line) {
          assert.ok(roads.has(`${r},${c}`),
            `${name}: authored road point (${r},${c}) is not a carved path cell`);
        }
      }

      // --- the creatures ----------------------------------------------------
      const creatures = (await pool.query(
        `SELECT id, type, x, y, home_x, home_y, level, blocks_portal_id
           FROM world_creatures WHERE world_id = $1`,
        [row.id])).rows;
      assert.ok(creatures.length > 0, `${name} holds no creatures at all`);

      // Only Village Guards stand inside a village footprint. The epic invariant.
      for (const c of creatures) {
        if (c.type === GUARD_TYPE) continue;
        const [r, cc] = tileOf(c);
        assert.ok(!inBox(r, cc, spec.village),
          `${name}: a ${c.type} stands inside the village at tile (${r},${cc})`);
      }

      // Every pen actually holds its creatures. THE check hazard 4 exists for:
      // creatureTileCandidates refuses a safe tile for any type, so a pen placed
      // through the ordinary placer comes out silently empty.
      //
      // Counted by ANCHOR, not by current position, and that distinction is
      // the honest boundary of this slice. Placement and anchoring are what
      // SOMET-289 owns; keeping a creature NEAR its anchor is the leash clamp
      // on SOMET-290's follow-up branch (before it, roam was unclamped
      // entirely -- measured 959 px of drift from a 200 px leash). Asserting
      // live positions here would make this file fail or pass on another
      // branch's behaviour rather than on this one's.
      for (const pen of spec.pens) {
        const anchoredHere = creatures.filter((c) => {
          if (c.type !== pen.creature_type || c.home_x === null || c.home_y === null) return false;
          return inBox(Math.floor(Number(c.home_y) / CREATURE_TILE_PX),
            Math.floor(Number(c.home_x) / CREATURE_TILE_PX), pen);
        });
        assert.equal(anchoredHere.length, pen.count,
          `${name}: pen of ${pen.count} ${pen.creature_type} at rows ${pen.min_row}.. `
          + `is anchored by ${anchoredHere.length} creatures`);
        for (const c of anchoredHere) {
          assert.equal(c.level, pen.level, `${name}: penned ${c.type} is level ${c.level}`);
        }
      }

      // Every creature carrying an anchor in this world belongs to a pen or to
      // one of the three OTHER things that legitimately anchor a creature.
      // Without this, the per-pen counts above would still pass if a stray
      // homed creature had been left somewhere unauthored -- and a homed
      // creature is one that survives every future populate.
      //
      // The exclusions are enumerated rather than assumed, because "homed,
      // non-guard, non-portal" is NOT unique to a pen: a vault- or field-chest
      // guard is anchored to its chest tile (SOMET-244), and a player using a
      // `loot_map` consumable spawns one in whatever world they are standing
      // in -- including this one. Excluded BY ID off world_chests rather than
      // by type, so a chest guard of a penned creature's own type is still
      // excluded exactly once and a genuine stray of that type still fails.
      // STRING, not Number, and that is not a style preference (SOMET-356).
      // world_creatures.id is a uuid and guard_creature_ids is jsonb holding
      // uuid strings, so Number() yields NaN on BOTH sides -- and a Set matches
      // NaN against itself (SameValueZero). The moment this world held one
      // guarded chest, `chestGuardIds` gained a NaN, `has(Number(c.id))` became
      // true for EVERY creature, and the stray check below silently passed no
      // matter what was loose in the world. It only ever caught anything
      // because no home-region world has a guarded chest today -- and the
      // comment above explains that a `loot_map` consumable can create one at
      // any time, which is precisely when the guard would have vanished.
      const chestGuardIds = new Set(
        (await pool.query('SELECT guard_creature_ids FROM world_chests WHERE world_id = $1',
          [row.id])).rows.flatMap((ch) => (ch.guard_creature_ids || []).map(String)));
      for (const c of creatures) {
        if (c.type === GUARD_TYPE || c.home_x === null) continue;
        if (c.blocks_portal_id !== null) continue;          // portal guard (SOMET-246)
        if (chestGuardIds.has(String(c.id))) continue;      // chest guard (SOMET-244)
        const [hr, hc] = [Math.floor(Number(c.home_y) / CREATURE_TILE_PX),
          Math.floor(Number(c.home_x) / CREATURE_TILE_PX)];
        assert.ok(spec.pens.some((pen) => inBox(hr, hc, pen)),
          `${name}: a ${c.type} is anchored at (${hr},${hc}), outside every authored pen`);
      }

      // A pen must not sit inside the village guards' aggro ring. Guards target
      // faction 'hostile' and every skittish type IS faction 'hostile', so a
      // pen within 400 px of a post is livestock the village farms. SOMET-291
      // raises the Guard leash to 600, which stops the leash filter clipping
      // that 400 px aggro -- so this is checked here rather than left to the
      // eye. Measured from the POSTS, which is where a guard stands.
      const posts = villageGatePosts({
        minRow: spec.village.min_row, minCol: spec.village.min_col,
        width: spec.village.width, height: spec.village.height,
        gateEdge: spec.village.gate_edge,
      });
      // Asked of the pen DILATED BY ITS LEASH, not of the authored box.
      //
      // The box is where creatures are seated; the leash is how far each one
      // can then roam from its OWN anchor, so the region a penned creature can
      // actually occupy is the box grown by the leash radius (see pens.js's
      // closing note). Checking only the box would pass a pen whose creatures
      // wander into the ring the next morning -- which is the failure this
      // check is for, since a guard farms the pen over hours, not on arrival.
      //
      // The radius is READ from the live behaviour row rather than typed here:
      // world_creatures has no per-creature leash column, so the number that
      // governs these creatures is whatever creature_behaviors says today, and
      // a test carrying its own copy would keep passing after a leash change
      // that broke the margin.
      const GUARD_AGGRO_PX = 400;
      for (const pen of spec.pens) {
        const leash = (await pool.query(
          `SELECT b.leash_radius FROM entity_types e
             JOIN creature_behaviors b ON b.id = e.behavior_id WHERE e.name = $1`,
          [pen.creature_type])).rows[0];
        assert.ok(leash && Number(leash.leash_radius) > 0,
          `${name}: ${pen.creature_type} has no behaviour leash, so the dilation below `
          + 'would be zero and this check would collapse back onto the authored box');
        const grow = Number(leash.leash_radius);
        for (const g of posts) {
          for (let r = pen.min_row; r < pen.min_row + pen.height; r++) {
            for (let cc = pen.min_col; cc < pen.min_col + pen.width; cc++) {
              const d = Math.hypot(cc * CREATURE_TILE_PX + 50 - g.x,
                r * CREATURE_TILE_PX + 50 - g.y);
              assert.ok(d - grow > GUARD_AGGRO_PX,
                `${name}: pen tile (${r},${cc}) is ${Math.round(d)}px from a guard post at `
                + `(${g.x},${g.y}); a ${pen.creature_type} roams ${grow}px from its anchor, so `
                + `it reaches ${Math.round(d - grow)}px -- inside the ${GUARD_AGGRO_PX}px aggro `
                + 'ring, and the village guards will farm the pen');
            }
          }
        }
      }

      // No hostile is GENERATED in safe territory, asked of THIS world's real
      // row rather than of a fixture.
      //
      // Deliberately a fresh placement and NOT a scan of live positions. Safety
      // is a spawn-time rule and nothing on the movement path consults it -- a
      // wild hostile is free to roam onto the road, and must be, because a
      // hostile chasing a player has to be able to follow them to the gate
      // (that is what the guards are for). Asserting live coordinates would
      // therefore fail on correct behaviour a few minutes after any seed; it
      // did exactly that during a full-suite run before this was rewritten.
      //
      // What IS worth pinning here is the composition slice A's own fixture
      // tests cannot reach: that the authored roads and radius on this
      // particular live row actually arrive at placement. If authored_roads
      // stopped reaching the generation config, this world would place hostiles
      // straight down the middle of its highway.
      const hostileTypes = (await pool.query(
        `SELECT name, hp, defense, resistances FROM entity_types
          WHERE is_creature = true AND name = ANY($1::text[]) AND coalesce(faction,'hostile') <> 'guard'`,
        [row.allowed_creature_types])).rows;
      assert.ok(hostileTypes.length > 0, `${name} allows no hostile types -- check would be vacuous`);
      const fresh = placeMapCreatures(world, 120, hostileTypes, Number(row.seed));
      assert.ok(fresh.length > 20,
        `${name}: placed only ${fresh.length} of 120 -- too few to prove anything, and a sign `
        + 'the safe region has eaten the map');
      for (const c of fresh) {
        const [r, cc] = tileOf(c);
        assert.ok(!isSafeTile(ctx, r, cc),
          `${name}: a freshly placed ${c.type} landed on safe tile (${r},${cc})`);
      }
    }

    // --- entry_spawn is READ FROM the entry village -------------------------
    const entry = (await pool.query(
      `SELECT w.name, w.entry_spawn, v.spawn_x, v.spawn_y
         FROM worlds w JOIN villages v ON v.world_id = w.id WHERE w.is_entry = true`)).rows;
    assert.equal(entry.length, 1, 'expected exactly one entry world, and it must have a village');
    assert.equal(Number(entry[0].entry_spawn.x), Number(entry[0].spawn_x),
      'entry_spawn.x was re-typed rather than read from the entry village');
    assert.equal(Number(entry[0].entry_spawn.y), Number(entry[0].spawn_y),
      'entry_spawn.y was re-typed rather than read from the entry village');
  } finally {
    await pool.end();
  }
});

describeDb('a penned creature survives populateWorld, and an unhomed one does not', async () => {
  // The SOMET-246 / SOMET-244 trap, asserted on a FIXTURE world so it can be
  // rolled back: populateWorld opens with a DELETE that spares only
  // `type = 'Village Guard'`, a blocks_portal_id, or a non-null home_x. Both
  // halves are asserted -- without the unhomed control this test would pass
  // even if the DELETE had stopped running at all.
  const pool = new Pool({ connectionString: URL });
  const NAME = 'zzHomeRegionPenSurvival';
  const cleanup = () => pool.query('DELETE FROM worlds WHERE name = $1', [NAME]);
  try {
    await cleanup();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        `INSERT INTO worlds (name, seed, chunk_size, width, height, density,
                             allowed_creature_types, biomes, biome_cell, level_min, level_max)
         VALUES ($1, 4242, 32, 64, 64, 'normal', $2::jsonb, '[]'::jsonb, 16, 1, 2)
         RETURNING *`,
        [NAME, JSON.stringify(['Slime'])])).rows[0];

      await client.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, damage, defense)
         VALUES ($1, 'Woodland Swarm', 1050, 1050, 8, 'S', 1050, 1050, 1, 5, 0)`, [row.id]);
      await client.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
         VALUES ($1, 'Woodland Swarm', 2050, 2050, 8, 'S', 1, 5, 0)`, [row.id]);

      await populateWorld(client, row, { rngSeed: 4242 });

      const survivors = (await client.query(
        'SELECT home_x FROM world_creatures WHERE world_id = $1 AND type = $2',
        [row.id, 'Woodland Swarm'])).rows;
      assert.equal(survivors.length, 1,
        'expected exactly the homed creature to survive the populate');
      assert.notEqual(survivors[0].home_x, null,
        'the survivor is the UNHOMED creature -- the sparing rule is not what this '
        + 'slice depends on');

      // Rolled back: this test proves a rule, it does not need to leave a world
      // behind. client.release() does NOT roll back on its own in this codebase.
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await cleanup();
    await pool.end();
  }
});
