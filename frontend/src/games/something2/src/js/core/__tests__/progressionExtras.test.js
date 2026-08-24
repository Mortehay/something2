// The progression side-channel (SOMET-483). The deleted CharacterSheet.jsx's
// F1 header documented a race that was fixed by making the websocket
// 'progression' handler the SINGLE writer of progression state, and its F2
// header documented a deleted xpCurve.js that re-implemented backend formulas
// client-side. Both records now live in ../progressionExtras.js.
//
// This module is where both lessons are enforced now:
//  - progression itself is never written here at all (Game's onProgression
//    still owns it outright), and sources/modifiers/passivePoints are LIFTED
//    off that row rather than copied into a second store that could drift;
//  - the HTTP bundle may SEED the derived `stats` bundle exactly once, and is
//    latched off permanently the moment any socket frame has carried it, so a
//    late HTTP response can never overwrite a newer push;
//  - xpFloor/xpToNext/respecCost are copied from the server, never computed.
import { describe, it, expect } from "vitest";
import {
  emptyExtras, frameCarriesStats, mergeFrameStats, mergeSeedStats,
  mergeLevelInfo, buildCharacterView,
} from "../progressionExtras.js";

const SOURCES = {
  strength:     { base: 5, tree: 33, gear: 4 },
  dexterity:    { base: 5, tree: 6,  gear: 0 },
  constitution: { base: 8, tree: 4,  gear: 2 },
  intelligence: { base: 5, tree: 0,  gear: 0 },
  wisdom:       { base: 6, tree: 2,  gear: 0 },
  charisma:     { base: 5, tree: 0,  gear: 0 },
};
const STATS = {
  maxHp: 140, maxMana: 100, maxStamina: 108, meleeMult: 1.15, spellMult: 1,
  cooldownMult: 0.8696, manaRegen: 10, priceMult: 0.55,
};
const MODIFIERS = [
  { label: "Kindling", value: 12, source: "tree", kind: "damage", detail: "fire" },
];

// The shape passiveTreeStore.js#composeProgression actually puts on the wire.
function composedRow(over = {}) {
  return {
    character_id: 7, level: 7, experience: 102, passive_points: 3,
    strength: 42, dexterity: 11, constitution: 14,
    intelligence: 5, wisdom: 8, charisma: 5,
    effective: { strength: 42 },
    passivePoints: 3,
    allocatedNodeIds: [11, 12],
    sources: SOURCES,
    modifiers: MODIFIERS,
    ...over,
  };
}

describe("emptyExtras", () => {
  it("starts with nothing known and no curve numbers invented", () => {
    expect(emptyExtras()).toEqual({
      stats: null, xpFloor: null, xpToNext: null, respecCost: null,
    });
  });
});

describe("frameCarriesStats", () => {
  it("is false for a frame that never mentions the derived bundle", () => {
    expect(frameCarriesStats({ type: "progression", progression: composedRow() })).toBe(false);
    expect(frameCarriesStats(null)).toBe(false);
  });
  it("is true once the frame carries one", () => {
    expect(frameCarriesStats({ progression: composedRow(), stats: STATS })).toBe(true);
  });
  it("counts an explicit null as the server having spoken", () => {
    // A frame that sent stats:null is not silence. Treating it as silence
    // would leave the HTTP seed armed against a socket that is already the
    // authoritative sender.
    expect(frameCarriesStats({ progression: composedRow(), stats: null })).toBe(true);
  });
});

describe("mergeFrameStats", () => {
  it("takes the bundle the frame carried", () => {
    expect(mergeFrameStats(emptyExtras(), { progression: composedRow(), stats: STATS }).stats)
      .toEqual(STATS);
  });

  it("keeps the last known bundle when a frame carries none", () => {
    const seeded = mergeFrameStats(emptyExtras(), { progression: composedRow(), stats: STATS });
    expect(mergeFrameStats(seeded, { progression: composedRow({ level: 8 }) }).stats).toEqual(STATS);
  });

  it("never invents a curve number", () => {
    const merged = mergeFrameStats(emptyExtras(), { progression: composedRow(), stats: STATS });
    expect(merged.xpFloor).toBeNull();
    expect(merged.xpToNext).toBeNull();
  });
});

describe("mergeSeedStats (F1: the HTTP bundle seeds ONCE and is latched off)", () => {
  const BUNDLE = { progression: composedRow(), stats: STATS, xpFloor: 63, xpToNext: 78, respecCost: 350 };

  it("seeds when no socket frame has carried the derived bundle yet", () => {
    // The join frame carries `progression` but NOT `stats` (server.js's
    // `joined`), so without this the derived block would be em dashes until
    // the player's first kill.
    expect(mergeSeedStats(emptyExtras(), BUNDLE, false).stats).toEqual(STATS);
  });

  it("is a NO-OP once a socket frame has carried it -- the exact F1 race", () => {
    // The reviewer's own reproduction, transposed: the player allocates a
    // node; before the HTTP response lands, the server's websocket push
    // arrives with the POST-allocation bundle. The late HTTP response then
    // tries to apply a PRE-allocation snapshot. It must not win.
    const fromSocket = mergeFrameStats(emptyExtras(), { progression: composedRow(), stats: STATS });
    const stale = mergeSeedStats(fromSocket, { stats: { maxHp: 100, maxMana: 100 } }, true);
    expect(stale.stats).toEqual(STATS);
  });

  it("leaves a bundle that mentions no stats alone", () => {
    const seeded = mergeFrameStats(emptyExtras(), { progression: composedRow(), stats: STATS });
    expect(mergeSeedStats(seeded, { xpFloor: 63 }, false).stats).toEqual(STATS);
  });

  it("never carries a progression row of its own", () => {
    const seeded = mergeSeedStats(emptyExtras(), BUNDLE, false);
    expect(seeded.progression).toBeUndefined();
    expect(seeded.sources).toBeUndefined();
    expect(seeded.modifiers).toBeUndefined();
  });
});

describe("mergeLevelInfo (F2: the curve numbers come from the server, always)", () => {
  it("applies xpFloor/xpToNext/respecCost even when the stats seed is latched off", () => {
    // These three are a function of LEVEL and no websocket frame carries them,
    // so there is no second writer to race -- unlike `stats`.
    const latched = mergeFrameStats(emptyExtras(), { progression: composedRow(), stats: STATS });
    const after = mergeLevelInfo(latched, { xpFloor: 63, xpToNext: 78, respecCost: 350 });
    expect(after.xpFloor).toBe(63);
    expect(after.xpToNext).toBe(78);
    expect(after.respecCost).toBe(350);
    expect(after.stats).toEqual(STATS);
  });

  it("keeps null for a max-level xpToNext, which JSON encodes as null", () => {
    const after = mergeLevelInfo(emptyExtras(), { xpFloor: 900000, xpToNext: null, respecCost: 7500 });
    expect(after.xpFloor).toBe(900000);
    expect(after.xpToNext).toBeNull();
  });

  it("keeps the previous value for a field the bundle omitted entirely", () => {
    const seeded = mergeLevelInfo(emptyExtras(), { xpFloor: 63, xpToNext: 78, respecCost: 350 });
    expect(mergeLevelInfo(seeded, { xpFloor: 141 })).toEqual({
      stats: null, xpFloor: 141, xpToNext: 78, respecCost: 350,
    });
  });
});

describe("buildCharacterView", () => {
  it("is null before the first join lands", () => {
    expect(buildCharacterView({ progression: null, extras: emptyExtras(), className: "Warrior", mainStat: "strength" }))
      .toBeNull();
  });

  it("lifts the breakdown off the single-writer row and the rest off extras", () => {
    const extras = mergeLevelInfo(
      mergeFrameStats(emptyExtras(), { progression: composedRow(), stats: STATS }),
      { xpFloor: 63, xpToNext: 78, respecCost: 350 },
    );
    expect(buildCharacterView({
      progression: composedRow(), extras, className: "Warrior", mainStat: "strength",
    })).toEqual({
      className: "Warrior",
      mainStat: "strength",
      level: 7,
      experience: 102,
      xpFloor: 63,
      xpToNext: 78,
      passivePoints: 3,
      sources: SOURCES,
      modifiers: MODIFIERS,
      stats: STATS,
    });
  });

  it("shows the breakdown the LATEST row carried, never a remembered one", () => {
    // The proof that sources/modifiers are lifted rather than cached: a second
    // row with a different breakdown must win outright, with no merge step
    // that a stale copy could survive.
    const extras = emptyExtras();
    const next = composedRow({ sources: { strength: { base: 5, tree: 0, gear: 0 } }, modifiers: [] });
    const view = buildCharacterView({ progression: next, extras, className: "Warrior", mainStat: "strength" });
    expect(view.sources).toEqual({ strength: { base: 5, tree: 0, gear: 0 } });
    expect(view.modifiers).toEqual([]);
  });

  it("falls back to the raw column when a row predates the composed passivePoints", () => {
    const view = buildCharacterView({
      progression: { level: 1, experience: 0, passive_points: 4 },
      extras: emptyExtras(), className: "Warrior", mainStat: "strength",
    });
    expect(view.passivePoints).toBe(4);
  });

  it("renders em dashes, not zeros, when a row carries no breakdown at all", () => {
    const view = buildCharacterView({
      progression: { level: 1, experience: 0 },
      extras: emptyExtras(), className: "Warrior", mainStat: "strength",
    });
    expect(view.sources).toBeNull();
    expect(view.modifiers).toEqual([]);
    expect(view.stats).toBeNull();
  });

  it("tolerates an unknown main stat (B/T3 has not landed yet)", () => {
    const view = buildCharacterView({
      progression: composedRow(),
      extras: emptyExtras(), className: "Warrior", mainStat: undefined,
    });
    expect(view.mainStat).toBeNull();
    expect(view.className).toBe("Warrior");
  });
});
