// SOMET-780: blockers are kept off the authored vault chest and waypoint
// tiles (worlds.clear_points), identically on every generation path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { generateRegion, generateChunkDecorations } = require('../src/services/mapService');
const { blockingDecorationCells, assertNavigable } = require('../src/services/navigability');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { ServerMap } = require('../src/authority/collision');

const tileTypes = { grass: { walkable: true }, map_wall: { walkable: false }, map_doorway: { walkable: true } };
const MEADOW = { name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['Tree'] };
const DEFS = [{ name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1, deco_layer: 'main' }];
const row = (over = {}) => ({ seed: 9, chunk_size: 64, width: 64, height: 64, ...over });
const cfgOf = (over) => ({ ...buildWorldGenConfig({ row: row(over), tileTypes, doorways: [], villages: [], biomes: [MEADOW], links: [] }), decorationDefs: DEFS });

function treeCell(cfg) {
  return [...blockingDecorationCells(cfg, DEFS)].map((k) => k.split(',').map(Number))
    .find(([r, c]) => r > 5 && c > 5 && r < 58 && c < 58);
}

test('no blocker on or next to a clear point; nothing else moves', () => {
  const bare = cfgOf({});
  const t = treeCell(bare);
  assert.ok(t, 'the fixture grows trees');
  const cleared = cfgOf({ clear_points: [{ row: t[0], col: t[1] }] });
  const before = blockingDecorationCells(bare, DEFS);
  const after = blockingDecorationCells(cleared, DEFS);
  const near = (k) => { const [r, c] = k.split(',').map(Number); return Math.max(Math.abs(r - t[0]), Math.abs(c - t[1])) <= 1; };
  assert.ok(![...after].some(near), 'a blocker within one tile of the clear point');
  assert.deepEqual([...after].sort(), [...before].filter((k) => !near(k)).sort());
});

test('the authority collides exactly like the decoration overlay', () => {
  const t = treeCell(cfgOf({}));
  const cfg = cfgOf({ clear_points: [{ row: t[0], col: t[1] }] });
  const map = new ServerMap(cfg);
  assert.equal(map.isWalkable(t[1] * 100 + 50, t[0] * 100 + 50), true, 'server still blocks the chest tile');
  const bareMap = new ServerMap(cfgOf({}));
  assert.equal(bareMap.isWalkable(t[1] * 100 + 50, t[0] * 100 + 50), false, 'fixture: the tile had a tree');
});

test('the seal guard passes a chest that a tree used to sit on', () => {
  const t = treeCell(cfgOf({}));
  const req = [{ row: 32, col: 32, what: 'spawn' }, { row: t[0], col: t[1], what: 'vault chest' }];
  const sealed = assertNavigable({ ...cfgOf({}), noGeneratedRoads: true }, req, { decorationDefs: DEFS });
  assert.ok(sealed.some((p) => /vault chest .* under a blocking decoration/.test(p)));
  const ok = assertNavigable({ ...cfgOf({ clear_points: [{ row: t[0], col: t[1] }] }), noGeneratedRoads: true }, req, { decorationDefs: DEFS });
  assert.ok(!ok.some((p) => /vault chest/.test(p)), ok.join('\n'));
});

test('loadWorld selects clear_points (explicit-column SELECT trap)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const start = src.indexOf('async function loadWorld(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  const m = /pool\.query\('SELECT ([^']+) FROM worlds WHERE id = \$1'/.exec(body);
  assert.ok(m && m[1].split(',').map((c) => c.trim()).includes('clear_points'));
});
