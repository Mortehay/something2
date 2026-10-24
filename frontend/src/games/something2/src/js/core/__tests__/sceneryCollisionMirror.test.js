import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ChunkedMap } from '../ChunkedMap.js';
import { resolveMove as clientResolveMove } from '../../systems/movement.js';

// Scenery collision: a blocking feature is a CIRCLE (radius px) at its
// tile-local anchor (ox, oy). The client (ChunkedMap) and the authority
// (ServerMap) must answer isWalkable identically for the same generator
// output, or client prediction rubber-bands against server collision.
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, '../../../../../../../../backend/src');
const { ServerMap, resolveMove: serverResolveMove } = require(path.join(backendDir, 'authority/collision.js'));
const { generateChunk, generateChunkDecorations } = require(path.join(backendDir, 'services/mapService.js'));

const CHUNK = 16; // dense enough: blockers clump (density field); 8 tiles yields ~1
const TILES = { grass: { walkable: true, speed: 1 } };
const DEFS = [
  { name: 'Boulder', walkable: false, spawn_tiles: ['grass'], chance: 1, block_radius: 30 },
  { name: 'Stump', walkable: false, spawn_tiles: ['grass'], chance: 1, block_radius: 8 },
  { name: 'Daisy', walkable: true, spawn_tiles: ['grass'], chance: 1 },
];
const COVER_DEFS = [
  ...DEFS.map((d) => ({ ...d, scenery_layer: 'feature' })),
  { name: 'Moss', walkable: true, spawn_tiles: ['grass'], chance: 1, scenery_layer: 'cover', max_per_tile: 3 },
];
const mk = (seed, defs, biomes, extra = {}) => ({
  seed, chunkSize: CHUNK, width: 48, height: 48, tileTypes: TILES, decorationDefs: defs,
  biomeCell: 16, ...(biomes ? { biomes } : {}), ...extra,
});
const BIOME = { name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['Boulder', 'Stump', 'Daisy', 'Moss'], creature_types: [], cover_density: 2 };
// The client receives cover-on output (what /chunk sends); the server generates cover-off.
const WORLDS = [
  { label: 'seed 4242, no biomes', world: mk(4242, DEFS, null), cover: false },
  { label: 'seed 9, no biomes', world: mk(9, DEFS, null), cover: false },
  { label: 'seed 31337, biome with cover', world: mk(31337, COVER_DEFS, [BIOME]), cover: true },
  { label: 'seed 7, biome with cover', world: mk(7, COVER_DEFS, [BIOME]), cover: true },
];

function build(world) {
  const server = new ServerMap(world);
  const grid = generateChunk(world, 0, 0);
  const decos = generateChunkDecorations(world, 0, 0, grid, world.decorationDefs); // cover on
  const client = new ChunkedMap(CHUNK, TILES);
  client.setChunk(0, 0, grid, decos);
  return { server, client, decos };
}

describe.each(WORLDS)('scenery collision mirror: $label', ({ world, cover }) => {
  const { server, client, decos } = build(world);
  const blockers = decos.filter((d) => d.blocking);

  it('fixture is not vacuous: several radii, some off-centre, cover present when expected', () => {
    expect(blockers.length).toBeGreaterThan(3);
    expect(new Set(blockers.map((d) => d.radius)).size).toBeGreaterThan(1);
    expect(blockers.some((d) => d.ox !== 50 || d.oy !== 50)).toBe(true);
    const covers = client.decorationsInChunk(0, 0).filter((d) => d.layer === 'cover');
    if (cover) expect(covers.length).toBeGreaterThan(0);
    else expect(covers.length).toBe(0);
  });

  it('client and server agree on a 5px grid over the chunk', () => {
    const px = CHUNK * 100;
    let blocked = 0;
    for (let y = 0; y < px; y += 5) {
      for (let x = 0; x < px; x += 5) {
        const s = server.isWalkable(x, y);
        if (!s) blocked++;
        if (client.isWalkable(x, y) !== s) expect.fail(`mismatch at (${x},${y}) server=${s}`);
      }
    }
    expect(blocked).toBeGreaterThan(0);
  }, 60000);

  it('client and server agree on each circle edge (inclusive) and just outside', () => {
    for (const d of blockers) {
      const ax = d.col * 100 + d.ox, ay = d.row * 100 + d.oy;
      for (const [px, py] of [
        [ax + d.radius, ay], [ax - d.radius, ay], [ax, ay + d.radius], [ax, ay - d.radius],
        [ax + d.radius + 0.5, ay], [ax, ay - d.radius - 0.5],
      ]) {
        expect(client.isWalkable(px, py)).toBe(server.isWalkable(px, py));
      }
      expect(server.isWalkable(ax - d.radius, ay)).toBe(false);
    }
  });

  it('client and server movement resolve scripted walks through the scenery to the same position', () => {
    // Every blocker approached head-on and slightly off-axis from 4 sides plus
    // 2 diagonals: the exact moves where the face-vs-circle test decides.
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1]];
    let walks = 0, stopped = 0;
    // Kept inside the one loaded chunk: beyond it the client's streaming map
    // reads "unloaded" as blocked while the server generates the neighbour.
    const px = CHUNK * 100, M = 220;
    for (const d of blockers) {
      const ax = d.col * 100 + d.ox, ay = d.row * 100 + d.oy;
      if (ax < M || ay < M || ax > px - M || ay > px - M) continue;
      for (const [dx, dy] of dirs) {
        for (const lat of [0, 5, 20]) {
          const sx = ax - dx * 70 + (dy !== 0 && dx === 0 ? lat : 0) - 32;
          const sy = ay - dy * 70 + (dx !== 0 && dy === 0 ? lat : 0) - 32;
          let c = { x: sx, y: sy, width: 64, height: 64, speed: 200 };
          let s = { ...c };
          for (let i = 0; i < 40; i++) {
            const rc = clientResolveMove(client, c, dx, dy, 1 / 60);
            const rs = serverResolveMove(server, s, dx, dy, 1 / 60);
            c = { ...c, x: rc.x, y: rc.y };
            s = { ...s, x: rs.x, y: rs.y };
          }
          walks++;
          if (c.x !== s.x || c.y !== s.y) expect.fail(`diverged from (${sx},${sy}) dir ${dx},${dy}: client (${c.x},${c.y}) server (${s.x},${s.y})`);
          const free = 200 * (40 / 60);
          if (Math.hypot(c.x - sx, c.y - sy) < free - 1) stopped++;
        }
      }
    }
    expect(walks).toBeGreaterThan(30);
    expect(stopped, 'some scripted walks must actually hit scenery').toBeGreaterThan(0);
  }, 60000);

  it('a point at a feature anchor is blocked', () => {
    for (const d of blockers) {
      const ax = d.col * 100 + d.ox, ay = d.row * 100 + d.oy;
      expect(server.isWalkable(ax, ay)).toBe(false);
      expect(client.isWalkable(ax, ay)).toBe(false);
    }
  });

  it('the tile centre of an offset feature is walkable when outside its circle', () => {
    const d = blockers.find((b) => Math.hypot(b.ox - 50, b.oy - 50) > b.radius);
    expect(d, 'fixture should contain an offset blocker clear of its tile centre').toBeTruthy();
    const cx = d.col * 100 + 50, cy = d.row * 100 + 50;
    expect(server.isWalkable(cx, cy)).toBe(true);
    expect(client.isWalkable(cx, cy)).toBe(true);
  });

  it('non-blocking entries never block, on either side', () => {
    const nonBlocking = decos.filter((x) => !x.blocking);
    expect(nonBlocking.length).toBeGreaterThan(0);
    let checked = 0;
    for (const d of nonBlocking) {
      const x = d.col * 100 + d.ox, y = d.row * 100 + d.oy;
      const covered = blockers.some((b) => b.row === d.row && b.col === d.col
        && (x - (b.col * 100 + b.ox)) ** 2 + (y - (b.row * 100 + b.oy)) ** 2 <= b.radius ** 2);
      if (covered) continue;
      checked++;
      expect(client.isWalkable(x, y)).toBe(true);
      expect(server.isWalkable(x, y)).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
