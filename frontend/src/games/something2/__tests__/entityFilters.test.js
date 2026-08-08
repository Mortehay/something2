import { describe, it, expect } from "vitest";
import {
  buildBiomeIndex, biomesWithEntities, filterByBiomeTab, filterBySearch, paginate,
  ALL_TAB, UNASSIGNED_TAB,
} from "../entityFilters.js";

const BIOMES = [
  { name: "Meadow", flora_types: ["Tree", "Stone"], creature_types: ["Slime", "Wolf"] },
  { name: "Deep Forest", flora_types: ["Tree"], creature_types: ["Wolf", "Bat"] },
  { name: "Abyssal Rift", flora_types: [], creature_types: [] },
];

describe("buildBiomeIndex", () => {
  it("indexes an entity under every biome that references it, via either list", () => {
    const idx = buildBiomeIndex(BIOMES);
    expect([...idx.get("Wolf")].sort()).toEqual(["Deep Forest", "Meadow"]);
    expect([...idx.get("Tree")].sort()).toEqual(["Deep Forest", "Meadow"]);
    expect([...idx.get("Slime")]).toEqual(["Meadow"]);
  });

  it("an entity referenced by no biome has no entry at all", () => {
    const idx = buildBiomeIndex(BIOMES);
    expect(idx.has("Tundra Apex")).toBe(false);
  });

  it("handles missing biomes / missing arrays without throwing", () => {
    expect(buildBiomeIndex(undefined).size).toBe(0);
    expect(buildBiomeIndex([{ name: "Empty" }]).size).toBe(0);
  });
});

describe("biomesWithEntities", () => {
  it("excludes a biome with empty flora_types and creature_types", () => {
    const idx = buildBiomeIndex(BIOMES);
    expect(biomesWithEntities(BIOMES, idx)).toEqual(["Deep Forest", "Meadow"]);
  });
});

describe("filterByBiomeTab", () => {
  const idx = buildBiomeIndex(BIOMES);
  const entities = [
    { name: "Wolf" }, { name: "Slime" }, { name: "Bat" }, { name: "Tundra Apex" },
  ];

  it("ALL_TAB returns every entity untouched", () => {
    expect(filterByBiomeTab(entities, ALL_TAB, idx)).toBe(entities);
  });

  it("a biome name filters to entities that biome's lists reference", () => {
    const result = filterByBiomeTab(entities, "Deep Forest", idx).map((e) => e.name);
    expect(result).toEqual(["Wolf", "Bat"]);
  });

  it("UNASSIGNED_TAB returns entities no biome references at all", () => {
    // Real state as of P4 (SOMET-250): 288 of 293 creatures have no biome
    // placement yet -- this is the load-bearing case, not an edge case.
    const result = filterByBiomeTab(entities, UNASSIGNED_TAB, idx).map((e) => e.name);
    expect(result).toEqual(["Tundra Apex"]);
  });
});

describe("filterBySearch", () => {
  const entities = [{ name: "Tundra Apex" }, { name: "Ruin Apex" }, { name: "Wolf" }];

  it("matches case-insensitively, anywhere in the name", () => {
    expect(filterBySearch(entities, "apex").map((e) => e.name)).toEqual(["Tundra Apex", "Ruin Apex"]);
    expect(filterBySearch(entities, "WOLF").map((e) => e.name)).toEqual(["Wolf"]);
  });

  it("a blank or whitespace-only search returns everything, not nothing", () => {
    expect(filterBySearch(entities, "")).toBe(entities);
    expect(filterBySearch(entities, "   ")).toBe(entities);
  });

  it("no match returns an empty array, not undefined", () => {
    expect(filterBySearch(entities, "zzz")).toEqual([]);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 14 }, (_, i) => ({ name: `e${i}` }));

  it("slices exactly pageSize items per page", () => {
    const p1 = paginate(items, 1, 6);
    expect(p1.pageItems).toHaveLength(6);
    expect(p1.pageItems[0].name).toBe("e0");
    expect(p1.totalPages).toBe(3); // 14 items / 6 per page -> 3 pages, last one partial
  });

  it("the last page holds the remainder, not a full page", () => {
    const p3 = paginate(items, 3, 6);
    expect(p3.pageItems).toHaveLength(2);
    expect(p3.pageItems[0].name).toBe("e12");
  });

  it("clamps a page number past the end to the real last page, rather than returning empty", () => {
    // The load-bearing case: switching biome tabs can shrink the filtered
    // list out from under whatever page you were on.
    const clamped = paginate(items, 99, 6);
    expect(clamped.page).toBe(3);
    expect(clamped.pageItems).toHaveLength(2);
  });

  it("clamps page 0 or negative up to page 1", () => {
    expect(paginate(items, 0, 6).page).toBe(1);
    expect(paginate(items, -5, 6).page).toBe(1);
  });

  it("an empty list is always exactly 1 page, not 0", () => {
    const empty = paginate([], 1, 6);
    expect(empty.totalPages).toBe(1);
    expect(empty.pageItems).toEqual([]);
  });
});
