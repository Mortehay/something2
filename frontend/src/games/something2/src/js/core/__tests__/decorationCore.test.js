// SOMET-788 -- client mirror of backend/tests/decoration_core.test.js. The
// client predicts movement against ChunkedMap; if its rock core differed from
// the server's, the player would rubber-band at every rock. Same literals as
// the backend file, on purpose.
import { describe, it, expect } from "vitest";
import { ChunkedMap } from "../ChunkedMap.js";
import { DECO_CORE_HALF } from "../constants.js";
import { resolveMove } from "../../systems/movement.js";

function mapWithRocks(cells, solid = false, wallCol = null) {
  const m = new ChunkedMap(8, { grass: { walkable: true, speed: 1 }, water: { walkable: false, speed: 1 } });
  m.setChunk(0, 0, Array.from({ length: 8 }, () => Array.from({ length: 8 }, (_, c) => (c === wallCol ? "water" : "grass"))),
    cells.map(([row, col]) => ({ name: "Stone", row, col, blocking: true, solid })));
  return m;
}

function walk(map, actor, dx, dy, steps) {
  const a = { ...actor };
  for (let i = 0; i < steps; i++) {
    const r = resolveMove(map, a, dx, dy, 0.05);
    a.x = r.x; a.y = r.y;
  }
  return a;
}

describe("blocking-decoration core (SOMET-788)", () => {
  it("is the value this file is written against", () => {
    expect(DECO_CORE_HALF).toBe(17);
  });

  it("blocks the rock's centre +-17 px and nothing beyond", () => {
    const m = mapWithRocks([[2, 3]]);
    for (const [x, y] of [[350, 250], [333, 250], [367, 250], [350, 233], [350, 267], [333, 233]]) {
      expect(m.isWalkable(x, y), `(${x},${y})`).toBe(false);
    }
    for (const [x, y] of [[332, 250], [368, 250], [350, 232], [350, 268], [301, 201]]) {
      expect(m.isWalkable(x, y), `(${x},${y})`).toBe(true);
    }
  });

  it("stops a player at the rock's edge instead of letting it walk in", () => {
    const m = mapWithRocks([[2, 3]]);
    const end = walk(m, { x: 150 - 32, y: 250 - 32, width: 64, height: 64, speed: 200 }, 1, 0, 60);
    const face = end.x + 32 + 16;
    expect(face).toBeLessThan(333);
    expect(face).toBeGreaterThan(332.9);
  });

  it("leaves a lane beside a wall that a player hugging the wall walks through", () => {
    const m = mapWithRocks([[2, 3]], false, 2);
    const end = walk(m, { x: 340 - 32, y: 50 - 32, width: 64, height: 64, speed: 200 }, -1, 1, 80);
    expect(end.y + 32).toBeGreaterThan(350);
  });

  it("leaves a walkable gap between neighbouring rocks for players and creatures", () => {
    const m = mapWithRocks([[2, 3], [2, 4]]);
    const player = walk(m, { x: 368, y: 518, width: 64, height: 64, speed: 200 }, 0, -1, 60);
    expect(player.y + 32).toBeLessThan(150);
    const creature = walk(m, { x: 376, y: 526, width: 48, height: 48, speed: 200 }, 0, -1, 60);
    expect(creature.y + 24).toBeLessThan(150);
  });

  it("keeps a monument (solid) cell blocking its whole tile", () => {
    const m = mapWithRocks([[2, 3]], true);
    expect(m.isWalkable(301, 201)).toBe(false);
    expect(m.isWalkable(399, 299)).toBe(false);
  });
});
