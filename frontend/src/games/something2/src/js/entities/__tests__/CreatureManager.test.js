import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { CHUNK_KEY } from "../../core/worldCoords.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const N = 4;
const T = MAP_TILE_SIZE;
const DEFS = { grass: { walkable: true, speed: 1 } };
const allGrass = () => Array.from({ length: N }, () => Array(N).fill("grass"));

// deterministic rng
function seqRng(vals) { let i = 0; return () => vals[i++ % vals.length]; }

function mapWith(...chunks) {
  const m = new ChunkedMap(N, DEFS);
  for (const [cx, cy] of chunks) m.setChunk(cx, cy, allGrass());
  return m;
}

describe("CreatureManager", () => {
  it("adds creatures without duplicating by id", () => {
    const cm = new CreatureManager(N);
    cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50 }]);
    cm.addCreatures([{ id: "a", type: "wolf", x: 999, y: 999 }, { id: "b", type: "boar", x: 60, y: 60 }]);
    expect(cm.count()).toBe(2);
    expect(cm.has("a")).toBe(true);
  });

  it("roams creatures in a loaded chunk and marks them dirty", () => {
    const cm = new CreatureManager(N, seqRng([0.9, 0.0, 0.9, 0.0]));
    cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50, hp: 10 }]);
    const map = mapWith([0, 0]);
    const roamed = cm.update(0.5, [CHUNK_KEY(0, 0)], map);
    expect(roamed).toBe(1);
    const dirty = cm.takeDirty();
    expect(dirty.length).toBe(1);
    expect(dirty[0].id).toBe("a");
    // second takeDirty is empty (flag cleared)
    expect(cm.takeDirty().length).toBe(0);
  });

  it("freezes creatures whose chunk is not loaded", () => {
    const cm = new CreatureManager(N, seqRng([0.9, 0.0]));
    cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50 }]);
    const map = mapWith([5, 5]); // (0,0) NOT loaded
    const before = { ...cm.all()[0] };
    const roamed = cm.update(0.5, [CHUNK_KEY(5, 5)], map);
    expect(roamed).toBe(0);
    const after = cm.all()[0];
    expect(after.x).toBe(before.x); // frozen, unchanged
    expect(cm.takeDirty().length).toBe(0);
  });
});
