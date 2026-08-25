const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { assertNavigable } = require('../src/services/navigability');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { loadDecorationDefs } = require('../src/services/decorationDefs');
const { loadTileTypes } = require('../src/services/tileTypes');
const { loadBiomes } = require('../src/services/biomes');
const { fetchVillages } = require('../src/services/villages');
const { fetchLinks } = require('../src/services/mapLinks');
const { requiredTilesFor } = require('../scripts/seed-map.js');
const {
  buildWalkGrid, floodFrom, arrivalPoints, POCKET_CELLS,
} = require('../scripts/scan-decoration-seals.js');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// SOMET-510, the live half. tests/decoration_clearance.test.js pins the rule on
// a fixture; this runs the REAL seeding guard over the REAL seeded worlds, and
// then breaks it on purpose to show it can fail.
//
// ROADS ARE OFF in every check here, because that is how seed-map.js judges a
// world (SOMET-349) and because a connector road is what was hiding this defect:
// generateChunkDecorations skips carved path cells, so with roads on every
// doorway already sits at the end of a decoration-free corridor and any
// assertion below would pass whether or not the clearance rule existed. The
// re-run of scan-decoration-seals.js that got SOMET-366 cancelled -- "0 of 100
// worlds sealed" -- was measured with roads ON.
//
// MEASURED before this rule landed, roads off, on the 100 seeded worlds:
// 11 arrival points across 10 worlds had a blocking decoration ON the arrival
// tile, Vale Crossing's own E doorway among them.

async function worldContext(pool, row, tileTypes) {
  const links = await fetchLinks(pool, row.id);
  const doorways = links.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
  const villages = await fetchVillages(pool, row.id);
  const biomes = await loadBiomes(pool, row.biomes);
  const cfg = buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes, links });
  // The spec shape requiredTilesFor wants for portals, rebuilt from the live
  // rows so this covers worlds seeded from any spec.
  const spec = {
    links: links.filter((l) => l.edge === 'PORTAL').map((l) => ({
      kind: 'portal', from: row.name, to: l.to_name,
      from_x: l.from_x, from_y: l.from_y, to_x: l.to_x, to_y: l.to_y,
    })),
  };
  return {
    links, doorways, villages,
    terrainOnly: { ...cfg, noGeneratedRoads: true },
    required: requiredTilesFor({ key: row.name }, spec, row, doorways),
  };
}

test('AC5/AC6: every seeded world survives the decoration-aware guard with roads OFF',
  { skip: !url }, async () => {
    const pool = new Pool({ connectionString: url });
    try {
      const tileTypes = await loadTileTypes(pool);
      const decorationDefs = await loadDecorationDefs(pool);
      assert.ok(decorationDefs.some((d) => d.walkable === false),
        'the catalog must contain at least one BLOCKING decoration, or this whole '
        + 'file is checking a rule against nothing');

      const { rows } = await pool.query(
        'SELECT * FROM worlds WHERE width IS NOT NULL AND height IS NOT NULL ORDER BY name ASC');
      assert.ok(rows.length >= 20,
        `expected a seeded map, found ${rows.length} bounded worlds -- seed p5-descent `
        + 'and vale-region before running this');

      const red = [];
      let checked = 0;
      for (const row of rows) {
        const { terrainOnly, required } = await worldContext(pool, row, tileTypes);
        if (!required.length) continue;
        checked++;
        const problems = assertNavigable(terrainOnly, required, { decorationDefs });
        if (problems.length) red.push(`${row.name}: ${problems.join(' | ')}`);
      }
      assert.ok(checked >= 20, `only ${checked} worlds had required tiles to check`);
      assert.deepStrictEqual(red, [],
        `worlds a player cannot leave once blocking decorations are counted:\n  ${red.join('\n  ')}`);
    } finally {
      await pool.end();
    }
  });

test('AC5: removing ONE clearance rule turns live worlds red -- the guard is not vacuous',
  { skip: !url }, async () => {
    // The portal rule is the one clause that can be switched off without
    // changing a single tile of terrain: `portals` feeds only the blocker
    // exclusion, never the generator's terrain. So this is a clean single-rule
    // mutation against real seeded data, not a fixture.
    const pool = new Pool({ connectionString: url });
    try {
      const tileTypes = await loadTileTypes(pool);
      const decorationDefs = await loadDecorationDefs(pool);
      const { rows } = await pool.query(
        `SELECT DISTINCT w.* FROM worlds w
           JOIN map_links ml ON ml.from_world_id = w.id AND ml.edge = 'PORTAL'
          WHERE w.width IS NOT NULL AND w.height IS NOT NULL
          ORDER BY w.name ASC`);
      assert.ok(rows.length > 0, 'no world in this database has a portal to test with');

      let mutantsCaught = 0;
      for (const row of rows) {
        const { terrainOnly, required } = await worldContext(pool, row, tileTypes);
        if (!required.length) continue;
        const noPortalRule = { ...terrainOnly, portals: [] };
        const problems = assertNavigable(noPortalRule, required, { decorationDefs });
        if (problems.some((p) => /portal/.test(p))) mutantsCaught++;
      }
      assert.ok(mutantsCaught > 0,
        'switching the portal clearance off must make the guard report at least one '
        + 'portal endpoint across the seeded worlds; if it does not, either the guard '
        + 'cannot see decorations or no seeded portal was ever at risk -- both make '
        + 'the green run above meaningless');
    } finally {
      await pool.end();
    }
  });

test('the seal detector can fail: a ring of blockers turns an arrival into a pocket',
  { skip: !url }, async () => {
    // The mutation SOMET-510 names by number. On the entry world's E arrival it
    // drops reachability from ~13.8k cells to 1, and the scanner reports a
    // pocket. Checked in so a future "0 of N worlds sealed" run is evidence
    // rather than comfort.
    const pool = new Pool({ connectionString: url });
    try {
      const tileTypes = await loadTileTypes(pool);
      const decorationDefs = await loadDecorationDefs(pool);
      const row = (await pool.query(
        'SELECT * FROM worlds WHERE is_entry = true AND width IS NOT NULL')).rows[0];
      assert.ok(row, 'no entry world in this database');

      const { links, doorways, villages } = await worldContext(pool, row, tileTypes);
      const world = buildWorldGenConfig({
        row, tileTypes, doorways, villages, links,
        biomes: await loadBiomes(pool, row.biomes),
      });
      const { walk, width, height } = buildWalkGrid(world, tileTypes, decorationDefs);
      const portalRows = (await pool.query(
        `SELECT edge, from_world_id, to_world_id, from_x, from_y, to_x, to_y
           FROM map_links WHERE (from_world_id = $1 OR to_world_id = $1) AND edge = 'PORTAL'`,
        [row.id])).rows;
      const points = arrivalPoints(row, doorways, portalRows, villages)
        .filter((p) => p.row > 0 && p.row < height - 1 && p.col > 0 && p.col < width - 1);
      assert.ok(points.length > 0, 'the entry world must have an interior arrival point');

      const target = points[0];
      const before = floodFrom(walk, width, height, target.row, target.col).size;
      assert.ok(before > POCKET_CELLS * 10,
        `${target.what} must start out well connected (got ${before} cells), or the `
        + 'injection below proves nothing');

      let injected = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = target.row + dr, c = target.col + dc;
          if (walk[r][c]) { walk[r][c] = 0; injected++; }
        }
      }
      assert.strictEqual(injected > 0, true, 'the ring must actually block something');

      const after = floodFrom(walk, width, height, target.row, target.col).size;
      assert.strictEqual(after, 1,
        `a full ring of blockers must leave exactly the arrival tile reachable, got ${after}`);
      assert.ok(after <= POCKET_CELLS,
        'and that must be under the pocket threshold the scanner reports on');
    } finally {
      await pool.end();
    }
  });

test('every PORTAL row is mirrored, so a world sees BOTH ends of its portals',
  { skip: !url }, async () => {
    // mapService.portalTileCells covers "either end" (AC2) by relying on
    // setPortalLink writing a mirror row: the far endpoint is the from_x/from_y
    // of its own world's outgoing row. An unmirrored row would leave one end
    // unprotected silently, so the assumption is checked rather than trusted.
    const pool = new Pool({ connectionString: url });
    try {
      const { rows } = await pool.query(
        `SELECT a.from_world_id, a.to_world_id, a.from_x, a.from_y
           FROM map_links a
          WHERE a.edge = 'PORTAL'
            AND NOT EXISTS (
              SELECT 1 FROM map_links b
               WHERE b.edge = 'PORTAL'
                 AND b.from_world_id = a.to_world_id AND b.to_world_id = a.from_world_id
                 AND b.from_x = a.to_x AND b.from_y = a.to_y
                 AND b.to_x = a.from_x AND b.to_y = a.from_y)`);
      assert.deepStrictEqual(rows, [],
        'unmirrored PORTAL rows -- their far endpoints get no decoration clearance');
    } finally {
      await pool.end();
    }
  });
