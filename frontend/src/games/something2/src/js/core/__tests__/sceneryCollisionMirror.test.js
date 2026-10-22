import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ChunkedMap } from '../ChunkedMap.js';

// Scenery collision: a blocking feature is a CIRCLE (radius px) at its
// tile-local anchor (ox, oy). The client (ChunkedMap) and the authority
// (ServerMap) must answer isWalkable identically for the same generator
// output, or client prediction rubber-bands against server collision.
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, '../../../../../../../../backend/src');
const { ServerMap } = require(path.join(backendDir, 'authority/collision.js'));
const { generateChunk, generateChunkDecorations } = require(path.join(backendDir, 'services/mapService.js'));

const CHUNK = 16; // dense enough: blockers clump (density field), 8 tiles yields ~1
const world = {
  seed: 4242, chunkSize: CHUNK, width: 48, height: 48,
  tileTypes: { grass: { walkable: true, speed: 1 } },
  decorationDefs: [
    { name: 'Boulder', walkable: false, spawn_tiles: ['grass'], chance: 1, block_radius: 30 },
    { name: 'Stump', walkable: false, spawn_tiles: ['grass'], chance: 1, block_radius: 8 },
    { name: 'Daisy', walkable: true, spawn_tiles: ['grass'], chance: 1 },
  ],
};

function build() {
  const server = new ServerMap(world);
  const grid = generateChunk(world, 0, 0);
  const decos = generateChunkDecorations(world, 0, 0, grid, world.decorationDefs);
  const client = new ChunkedMap(CHUNK, { grass: { walkable: true, speed: 1 } });
  client.setChunk(0, 0, grid, decos);
  return { server, client, decos };
}

describe('scenery collision mirror', () => {
  const { server, client, decos } = build();
  const blockers = decos.filter((d) => d.blocking);

  it('fixture places blockers of more than one radius, some off-centre', () => {
    expect(blockers.length).toBeGreaterThan(3);
    expect(new Set(blockers.map((d) => d.radius)).size).toBeGreaterThan(1);
    expect(blockers.some((d) => d.ox !== 50 || d.oy !== 50)).toBe(true);
  });

  it('client and server agree on a 5px grid over the chunk', () => {
    const px = CHUNK * 100;
    let blocked = 0;
    for (let y = 0; y < px; y += 5) {
      for (let x = 0; x < px; x += 5) {
        const s = server.isWalkable(x, y);
        if (!s) blocked++;
        expect(client.isWalkable(x, y), `(${x},${y})`).toBe(s);
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
      // West edge: always inside this tile (the east edge can sit exactly on the
      // tile boundary, which belongs to the neighbour).
      expect(server.isWalkable(ax - d.radius, ay)).toBe(false);
    }
  });

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

  it('non-blocking entries never block', () => {
    for (const d of decos.filter((x) => !x.blocking)) {
      const x = d.col * 100 + d.ox, y = d.row * 100 + d.oy;
      // unless a blocker on the same tile covers it, the point is walkable
      const covered = blockers.some((b) => b.row === d.row && b.col === d.col
        && (x - (b.col * 100 + b.ox)) ** 2 + (y - (b.row * 100 + b.oy)) ** 2 <= b.radius ** 2);
      if (!covered) expect(client.isWalkable(x, y)).toBe(true);
    }
  });
});
