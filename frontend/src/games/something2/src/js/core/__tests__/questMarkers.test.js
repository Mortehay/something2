import { describe, it, expect } from "vitest";
import { questMarkerFor, villageMarkers } from "../questMarkers.js";

const q = (over) => ({ village_key: "v1", status: "available", required_level: 1, target_count: 1, progress_count: 0, ...over });

describe("quest markers", () => {
  it("'?' when a quest can be turned in, even if another is open", () => {
    expect(questMarkerFor([q({ status: "active", progress_count: 1 }), q({})], 5)).toBe("?");
  });

  it("'!' only for a quest open at the player's level; a level-locked one shows nothing", () => {
    expect(questMarkerFor([q({ required_level: 5 })], 3)).toBeNull();
    expect(questMarkerFor([q({ required_level: 5 })], 5)).toBe("!");
  });

  it("an active quest that is not finished and a completed one show nothing", () => {
    expect(questMarkerFor([q({ status: "active", target_count: 5, progress_count: 2 }), q({ status: "completed" })], 9)).toBeNull();
    expect(questMarkerFor(undefined)).toBeNull();
  });

  it("the minimap gets one entry per village, judged across ALL of its quests, not just the first", () => {
    const quests = [
      q({ village_key: "a", status: "completed" }),
      q({ village_key: "a", status: "available" }),          // the second quest is the open one
      q({ village_key: "b", status: "available", required_level: 9 }),
      q({ village_key: "c", status: "active", progress_count: 1 }),
      { ...q({}), village_key: null },
    ];
    expect(villageMarkers(quests, 2)).toEqual([
      { villageKey: "a", marker: "!" },
      { villageKey: "c", marker: "?" },
    ]);
  });
});
