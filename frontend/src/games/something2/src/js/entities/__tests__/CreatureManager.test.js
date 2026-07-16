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

  it("copies the entity-type color from the server payload onto the creature", () => {
    const cm = new CreatureManager(N);
    cm.addCreatures([
      { id: "a", type: "wolf", x: 50, y: 50, color: "#00ff00" },
      { id: "b", type: "boar", x: 60, y: 60 },
    ]);
    expect(cm.all().find((c) => c.id === "a").color).toBe("#00ff00");
    expect(cm.all().find((c) => c.id === "b").color).toBeUndefined();
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

  describe("pruneOutOfRange", () => {
    it("drops a non-dirty creature whose chunk is not loaded", () => {
      const cm = new CreatureManager(N);
      cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50 }]);
      const dropped = cm.pruneOutOfRange([CHUNK_KEY(5, 5)]); // (0,0) not loaded
      expect(dropped).toBe(1);
      expect(cm.has("a")).toBe(false);
      expect(cm.count()).toBe(0);
    });

    it("keeps a creature whose chunk is loaded", () => {
      const cm = new CreatureManager(N);
      cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50 }]);
      const dropped = cm.pruneOutOfRange([CHUNK_KEY(0, 0)]);
      expect(dropped).toBe(0);
      expect(cm.has("a")).toBe(true);
    });

    it("keeps a dirty out-of-range creature until its position is flushed", () => {
      const cm = new CreatureManager(N, seqRng([0.9, 0.0]));
      cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50 }]);
      const map = mapWith([0, 0]);
      // Roam while (0,0) is loaded so the creature moves and gets marked dirty.
      const roamed = cm.update(0.5, [CHUNK_KEY(0, 0)], map);
      expect(roamed).toBe(1);
      expect(cm.all()[0].dirty).toBe(true);

      // Now the neighborhood no longer includes (0,0) -> creature is out of range,
      // but it's still dirty (unflushed), so prune must keep it.
      let dropped = cm.pruneOutOfRange([CHUNK_KEY(5, 5)]);
      expect(dropped).toBe(0);
      expect(cm.has("a")).toBe(true);

      // Flush clears dirty; a subsequent prune now drops it.
      const dirty = cm.takeDirty();
      expect(dirty.length).toBe(1);
      dropped = cm.pruneOutOfRange([CHUNK_KEY(5, 5)]);
      expect(dropped).toBe(1);
      expect(cm.has("a")).toBe(false);
    });

    it("accepts loadedKeys as a Set or an array", () => {
      const cm = new CreatureManager(N);
      cm.addCreatures([
        { id: "a", type: "wolf", x: 50, y: 50 },
        { id: "b", type: "boar", x: 60, y: 60 },
      ]);
      expect(cm.pruneOutOfRange(new Set([CHUNK_KEY(0, 0)]))).toBe(0);
      expect(cm.count()).toBe(2);
      expect(cm.pruneOutOfRange([CHUNK_KEY(9, 9)])).toBe(2);
      expect(cm.count()).toBe(0);
    });
  });

  describe("getDirty / clearDirty", () => {
    it("getDirty returns dirty creatures without clearing the flag", () => {
      const cm = new CreatureManager(N, seqRng([0.9, 0.0]));
      cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50 }]);
      const map = mapWith([0, 0]);
      const roamed = cm.update(0.5, [CHUNK_KEY(0, 0)], map);
      expect(roamed).toBe(1);

      const first = cm.getDirty();
      expect(first.length).toBe(1);
      expect(first[0].id).toBe("a");
      expect(cm.all()[0].dirty).toBe(true);

      // Calling it again returns the same set — nothing was cleared.
      const second = cm.getDirty();
      expect(second.length).toBe(1);
      expect(second[0].id).toBe("a");
      expect(cm.all()[0].dirty).toBe(true);
    });

    it("clearDirty(ids) clears only the listed ids' dirty flags", () => {
      const cm = new CreatureManager(N, seqRng([0.9, 0.0, 0.9, 0.0]));
      cm.addCreatures([
        { id: "a", type: "wolf", x: 50, y: 50 },
        { id: "b", type: "boar", x: 60, y: 60 },
      ]);
      const map = mapWith([0, 0]);
      cm.update(0.5, [CHUNK_KEY(0, 0)], map);
      expect(cm.all().every((c) => c.dirty)).toBe(true);

      cm.clearDirty(["a"]);
      expect(cm.creatures.get("a").dirty).toBe(false);
      expect(cm.creatures.get("b").dirty).toBe(true);

      // Clearing an id that doesn't exist is a no-op, not an error.
      expect(() => cm.clearDirty(["does-not-exist"])).not.toThrow();
    });

    it("INVARIANT: an unconfirmed flush keeps a creature dirty so it survives pruneOutOfRange, and only a confirmed flush (clearDirty) allows it to be pruned", () => {
      const cm = new CreatureManager(N, seqRng([0.9, 0.0]));
      cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50 }]);
      const map = mapWith([0, 0]);
      const roamed = cm.update(0.5, [CHUNK_KEY(0, 0)], map);
      expect(roamed).toBe(1);
      expect(cm.all()[0].dirty).toBe(true);

      // Simulate reading the dirty snapshot for a fire-and-forget flush that
      // has NOT yet confirmed success (dirty flag is NOT cleared by getDirty).
      const dirty = cm.getDirty();
      expect(dirty.length).toBe(1);
      expect(cm.all()[0].dirty).toBe(true);

      // Creature is now out of the loaded neighborhood. Because the flush
      // hasn't confirmed (still dirty), pruneOutOfRange must NOT drop it —
      // dropping here would lose the roamed position permanently.
      let dropped = cm.pruneOutOfRange([CHUNK_KEY(5, 5)]);
      expect(dropped).toBe(0);
      expect(cm.has("a")).toBe(true);
      expect(cm.all()[0].dirty).toBe(true);

      // The flush now confirms success -> clear dirty for the flushed ids.
      cm.clearDirty(dirty.map((d) => d.id));
      expect(cm.all()[0].dirty).toBe(false);

      // Now that the position is confirmed persisted, prune may drop the
      // still-out-of-range creature.
      dropped = cm.pruneOutOfRange([CHUNK_KEY(5, 5)]);
      expect(dropped).toBe(1);
      expect(cm.has("a")).toBe(false);
    });
  });
});
