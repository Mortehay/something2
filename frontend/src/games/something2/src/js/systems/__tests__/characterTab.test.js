// Pure formatting for the Character tab (SOMET-483, spec §10.2). Every
// expectation below is a hand-written literal string or number. Nothing here
// calls the function under test to build its own expectation, and nothing
// here re-implements a backend formula -- xpFloor/xpToNext arrive as data
// (see the F2 guard at the bottom of this file).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CHAR_STAT_KEYS, statTotal, formatStatBreakdown, strongAndWeak, formatHighlights,
  formatHeader, derivedRows, formatModifier, modifierRows, xpBar, formatXpLabel,
  formatPoints,
  layoutCharacterTab, CHAR_MOD_ROWS, CHAR_LINE_H,
} from "../characterTab.js";
import { layoutInventory, visibleItems, TABS } from "../inventoryPanel.js";

// A level-7 Warrior deep into the strength sector, wearing one +4 STR item.
const RICH_SOURCES = {
  strength:     { base: 5, tree: 33, gear: 4 },
  dexterity:    { base: 5, tree: 6,  gear: 0 },
  constitution: { base: 8, tree: 4,  gear: 2 },
  intelligence: { base: 5, tree: 0,  gear: 0 },
  wisdom:       { base: 6, tree: 2,  gear: 0 },
  charisma:     { base: 5, tree: 0,  gear: 0 },
};

// A brand-new level-1 character: class base only, no tree, no gear.
const FRESH_SOURCES = {
  strength:     { base: 5, tree: 0, gear: 0 },
  dexterity:    { base: 5, tree: 0, gear: 0 },
  constitution: { base: 5, tree: 0, gear: 0 },
  intelligence: { base: 5, tree: 0, gear: 0 },
  wisdom:       { base: 5, tree: 0, gear: 0 },
  charisma:     { base: 5, tree: 0, gear: 0 },
};

describe("CHAR_STAT_KEYS", () => {
  it("lists all six stats in the backend's whitelist order", () => {
    expect(CHAR_STAT_KEYS).toEqual([
      "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
    ]);
  });
});

describe("statTotal", () => {
  it("adds the server's own three parts", () => {
    expect(statTotal({ base: 5, tree: 33, gear: 4 })).toBe(42);
  });
  it("treats a missing part as zero", () => {
    expect(statTotal({ base: 8 })).toBe(8);
  });
  it("is null when the server sent no breakdown for this stat", () => {
    expect(statTotal(null)).toBeNull();
    expect(statTotal(undefined)).toBeNull();
  });
});

describe("formatStatBreakdown", () => {
  it("itemises a stat that has all three parts", () => {
    expect(formatStatBreakdown("strength", RICH_SOURCES.strength))
      .toBe("STR 42 = 5 base + 33 tree + 4 gear");
  });

  it("omits a zero part rather than printing '+ 0 gear'", () => {
    expect(formatStatBreakdown("constitution", { base: 8, tree: 0, gear: 2 }))
      .toBe("CON 10 = 8 base + 2 gear");
    expect(formatStatBreakdown("dexterity", { base: 5, tree: 6, gear: 0 }))
      .toBe("DEX 11 = 5 base + 6 tree");
  });

  it("keeps the base part even when it is the only one (a fresh level-1 character)", () => {
    expect(formatStatBreakdown("intelligence", { base: 5, tree: 0, gear: 0 }))
      .toBe("INT 5 = 5 base");
  });

  it("shows a negative tree part as a subtraction it can still be read from", () => {
    // A drawback keystone can push a stat DOWN. The headline must agree with
    // the parts even then, rather than the parts being rendered as absolutes.
    expect(formatStatBreakdown("wisdom", { base: 6, tree: -4, gear: 0 }))
      .toBe("WIS 2 = 6 base + -4 tree");
  });

  it("shows an em dash, not a zero, when the breakdown has not arrived", () => {
    expect(formatStatBreakdown("wisdom", null)).toBe("WIS —");
  });
});

describe("strongAndWeak", () => {
  it("picks the highest and the lowest effective stat", () => {
    // strength 42 is the clear max. intelligence 5 and charisma 5 tie for the
    // minimum; neither is the Warrior's main stat, so declaration order wins.
    expect(strongAndWeak(RICH_SOURCES, "strength"))
      .toEqual({ strong: "strength", weak: "intelligence" });
  });

  it("breaks a tie for STRONGEST toward the class main stat", () => {
    // A Mage whose strength and intelligence both total 20. Declaration order
    // would say strength; the main stat wins instead.
    const tied = {
      strength:     { base: 5, tree: 15, gear: 0 },
      dexterity:    { base: 5, tree: 0,  gear: 0 },
      constitution: { base: 5, tree: 0,  gear: 0 },
      intelligence: { base: 5, tree: 15, gear: 0 },
      wisdom:       { base: 5, tree: 0,  gear: 0 },
      charisma:     { base: 5, tree: 0,  gear: 0 },
    };
    expect(strongAndWeak(tied, "intelligence").strong).toBe("intelligence");
    // ...and the tie-break is genuinely doing the work: the SAME spread with a
    // different main stat picks the other member of the tie.
    expect(strongAndWeak(tied, "strength").strong).toBe("strength");
    expect(strongAndWeak(tied, "wisdom").strong).toBe("strength");
  });

  it("breaks a tie for WEAKEST toward the class main stat too (spec §10.2, read literally)", () => {
    // A Druid (charisma) who has poured everything into constitution. dexterity
    // and charisma both sit at 5; the main stat wins the tie.
    const tied = {
      strength:     { base: 7, tree: 0,  gear: 0 },
      dexterity:    { base: 5, tree: 0,  gear: 0 },
      constitution: { base: 6, tree: 20, gear: 0 },
      intelligence: { base: 6, tree: 0,  gear: 0 },
      wisdom:       { base: 6, tree: 0,  gear: 0 },
      charisma:     { base: 5, tree: 0,  gear: 0 },
    };
    expect(strongAndWeak(tied, "charisma").weak).toBe("charisma");
    // Declaration order is what it falls back to, so this is the control:
    // dexterity is the earlier of the two tied keys.
    expect(strongAndWeak(tied, "constitution").weak).toBe("dexterity");
  });

  it("does not let the main stat win a tie it is not part of", () => {
    // charisma is the main stat but sits at 9, above the 5/5 tie. Naming it
    // the weak point would be the tie-break firing on a non-member.
    const tied = {
      strength:     { base: 5, tree: 0, gear: 0 },
      dexterity:    { base: 5, tree: 0, gear: 0 },
      constitution: { base: 9, tree: 0, gear: 0 },
      intelligence: { base: 9, tree: 0, gear: 0 },
      wisdom:       { base: 9, tree: 0, gear: 0 },
      charisma:     { base: 9, tree: 0, gear: 0 },
    };
    expect(strongAndWeak(tied, "charisma").weak).toBe("strength");
    expect(strongAndWeak(tied, "charisma").strong).toBe("charisma");
  });

  it("falls back to declaration order when the class main stat is unknown", () => {
    // mainStat is null until B/T3 exposes entity_types.main_stat. The tab must
    // still render rather than throw or show nothing.
    expect(strongAndWeak(RICH_SOURCES, null))
      .toEqual({ strong: "strength", weak: "intelligence" });
  });

  it("reports NO weak point when every stat is equal (a fresh level-1 character)", () => {
    // Six identical numbers have no lowest one. Naming the same stat as both
    // strong and weak reads as a bug, so weak is null and the line says so.
    expect(strongAndWeak(FRESH_SOURCES, "strength"))
      .toEqual({ strong: "strength", weak: null });
  });

  it("is all-null when no breakdown has arrived", () => {
    expect(strongAndWeak(null, "strength")).toEqual({ strong: null, weak: null });
  });
});

describe("formatHighlights", () => {
  it("names both points with their totals", () => {
    expect(formatHighlights(RICH_SOURCES, "strength"))
      .toBe("Strong: STR 42    Weak: INT 5");
  });
  it("dashes the weak point on a flat spread", () => {
    expect(formatHighlights(FRESH_SOURCES, "strength"))
      .toBe("Strong: STR 5    Weak: —");
  });
});

describe("formatHeader", () => {
  it("names the class and the level", () => {
    expect(formatHeader({ className: "Warrior", level: 7 })).toBe("Warrior — Level 7");
  });
  it("says so rather than printing 'undefined' when the class is unknown", () => {
    expect(formatHeader({ className: null, level: 1 })).toBe("Unknown class — Level 1");
  });
});

describe("derivedRows", () => {
  it("renders the eight derived numbers in a fixed order and column", () => {
    // maxStamina is here because SOMET-495 made it a derived pool like the
    // other two; a seven-row block would leave the HUD's stamina bar the one
    // number the sheet cannot explain.
    expect(derivedRows({
      maxHp: 140, maxMana: 100, maxStamina: 108, meleeMult: 1.15, spellMult: 1,
      cooldownMult: 0.8696, manaRegen: 10, priceMult: 0.55,
    })).toEqual([
      "Max HP        140",
      "Max mana      100",
      "Max stamina   108",
      "Melee         x1.15",
      "Spell         x1.00",
      "Cooldown      x0.87",
      "Mana regen    10",
      "Sell price    x0.55",
    ]);
  });

  it("dashes every value when the derived bundle has not arrived yet", () => {
    expect(derivedRows(null)).toEqual([
      "Max HP        —",
      "Max mana      —",
      "Max stamina   —",
      "Melee         —",
      "Spell         —",
      "Cooldown      —",
      "Mana regen    —",
      "Sell price    —",
    ]);
  });

  it("dashes only the one field the server omitted", () => {
    // A bundle from an older push can be missing a field the client knows
    // about; the other seven must still show real numbers.
    const rows = derivedRows({
      maxHp: 140, maxMana: 100, meleeMult: 1.15, spellMult: 1,
      cooldownMult: 1, manaRegen: 10, priceMult: 0.55,
    });
    expect(rows[2]).toBe("Max stamina   —");
    expect(rows[0]).toBe("Max HP        140");
  });

  it("keeps a fractional regen readable without trailing zeros", () => {
    expect(derivedRows({
      maxHp: 100, maxMana: 100, maxStamina: 100, meleeMult: 1, spellMult: 1,
      cooldownMult: 1, manaRegen: 12.5, priceMult: 0.5,
    })[6]).toBe("Mana regen    12.5");
  });
});

// The `detail` field is the NOUN the grant acts on (statComposition.js's
// detailOf), never a unit suffix -- so the unit comes from the KIND. These
// cases are the real wire shapes seeds/data/passiveTree.js authors.
describe("formatModifier", () => {
  it("names the stat a flat stat grant moves", () => {
    // 'Sinew' and 'Vigour' both grant +2 to the sector stat AND something
    // else; without the abbreviation the two rows would be indistinguishable.
    expect(formatModifier({ label: "Sinew", value: 2, source: "tree", kind: "stat", detail: "strength" }))
      .toBe("Sinew  +2 STR");
  });

  it("renders a resource grant as FLAT pool points, not a percent", () => {
    expect(formatModifier({ label: "Thick Skin", value: 40, source: "tree", kind: "resource", detail: "hp" }))
      .toBe("Thick Skin  +40 max hp");
    expect(formatModifier({ label: "Deep Reserve", value: 15, source: "tree", kind: "resource", detail: "mana" }))
      .toBe("Deep Reserve  +15 max mana");
  });

  it("renders a damage grant as the PERCENT it is authored as", () => {
    expect(formatModifier({
      label: "Pyromancy — +35% fire damage", value: 35, source: "tree", kind: "damage", detail: "fire",
    })).toBe("Pyromancy — +35% fire damage  +35% fire damage");
    expect(formatModifier({ label: "Kindling", value: 12, source: "tree", kind: "damage", detail: "fire" }))
      .toBe("Kindling  +12% fire damage");
  });

  it("renders a resist grant in percentage points", () => {
    expect(formatModifier({ label: "Plating", value: 8, source: "tree", kind: "resist", detail: "physical" }))
      .toBe("Plating  +8% physical resist");
  });

  it("renders a NEGATIVE resist as the drawback it is, not as an absolute", () => {
    // statComposition.js: "NEGATIVE VALUES ARE DELIBERATE. Keystone drawbacks
    // author {element:'ice', value:-15}". Printing +15 here would hand the
    // player the keystone's upside twice over in the UI.
    expect(formatModifier({ label: "Ashen Heart", value: -15, source: "tree", kind: "resist", detail: "ice" }))
      .toBe("Ashen Heart  -15% ice resist");
  });

  it("says what a status grant actually does -- its value means nothing", () => {
    // composeStats keeps hitStatuses as a SET and never reads `value`; the
    // authored 1 is presence, so rendering "+1" would be a fabricated number.
    expect(formatModifier({ label: "Searing Blows", value: 1, source: "tree", kind: "status", detail: "burn" }))
      .toBe("Searing Blows  your hits burn");
    expect(formatModifier({ label: "Numbing Blows", value: 1, source: "tree", kind: "status", detail: "chill" }))
      .toBe("Numbing Blows  your hits chill");
  });

  it("lets a rule keystone's authored prose speak for itself", () => {
    // The label is a full sentence; appending "0.2 regenLifeShare" to it would
    // say less than the label already does.
    expect(formatModifier({
      label: "Clarity — mana regeneration also restores 20% as much life",
      value: 0.2, source: "tree", kind: "rule", detail: "regenLifeShare",
    })).toBe("Clarity — mana regeneration also restores 20% as much life");
  });

  it("degrades a kind it has never heard of to label + number, never to silence", () => {
    expect(formatModifier({ label: "Future Thing", value: 7, source: "gear", kind: "leech", detail: "hp" }))
      .toBe("Future Thing  +7 hp");
  });

  it("survives a modifier with no numeric value at all", () => {
    expect(formatModifier({ label: "Blood Pact", value: null, source: "tree", kind: "stat" }))
      .toBe("Blood Pact");
  });
});

describe("modifierRows", () => {
  it("keeps gear and tree entries in the server's own order, each tagged with its source", () => {
    // Deliberately interleaved: the client does not re-sort, so what the player
    // reads is what composeStats() actually produced.
    expect(modifierRows([
      { label: "Kindling", value: 12, source: "tree", kind: "damage", detail: "fire" },
      { label: "of the Bear", value: 4, source: "gear", kind: "stat", detail: "strength" },
      { label: "Numbing Blows", value: 1, source: "tree", kind: "status", detail: "chill" },
      { label: "Ashen Heart", value: -15, source: "tree", kind: "resist", detail: "ice" },
    ])).toEqual([
      { text: "Kindling  +12% fire damage", source: "tree" },
      { text: "of the Bear  +4 STR", source: "gear" },
      { text: "Numbing Blows  your hits chill", source: "tree" },
      { text: "Ashen Heart  -15% ice resist", source: "tree" },
    ]);
  });

  it("says so when a character has neither passives nor affixes", () => {
    expect(modifierRows([])).toEqual([
      { text: "No modifiers yet — allocate passives or equip gear.", source: null },
    ]);
    expect(modifierRows(null)).toEqual([
      { text: "No modifiers yet — allocate passives or equip gear.", source: null },
    ]);
  });
});

describe("xpBar", () => {
  it("reports the position inside the current level from the server's own numbers", () => {
    // Wire values, not a local curve: a level-3 character under the new curve
    // has xpFloor 63 and xpToNext 78 (spec §4). 102 XP is 39 into that 78-wide
    // band -> 50%. Literal expectations; this function never computes a curve.
    expect(xpBar({ experience: 102, xpFloor: 63, xpToNext: 78 }))
      .toEqual({ into: 39, need: 78, pct: 50 });
  });

  it("does not divide by null at max level -- JSON encodes Infinity as null", () => {
    expect(xpBar({ experience: 900000, xpFloor: 900000, xpToNext: null }))
      .toEqual({ into: 0, need: 0, pct: 100 });
  });

  it("returns an empty (not full) bar while the bundle is still loading", () => {
    expect(xpBar({ experience: 0, xpFloor: null, xpToNext: null }))
      .toEqual({ into: 0, need: 0, pct: 0 });
  });

  it("stays finite past the max-level floor", () => {
    const r = xpBar({ experience: 999999, xpFloor: 900000, xpToNext: null });
    expect(r).toEqual({ into: 99999, need: 0, pct: 100 });
    expect(Number.isFinite(r.into)).toBe(true);
  });
});

describe("formatXpLabel", () => {
  it("shows progress toward the next level", () => {
    expect(formatXpLabel({ into: 39, need: 78, pct: 50 }, true)).toBe("39 / 78 XP");
  });
  it("shows MAX LEVEL when nothing more is needed", () => {
    expect(formatXpLabel({ into: 0, need: 0, pct: 100 }, true)).toBe("MAX LEVEL");
  });
  it("shows a loading state rather than a false MAX LEVEL", () => {
    expect(formatXpLabel({ into: 0, need: 0, pct: 0 }, false)).toBe("Loading…");
  });
});

describe("formatPoints", () => {
  it("names the unspent passive points", () => {
    expect(formatPoints(3)).toBe("Passive points: 3");
  });
  it("shows zero rather than nothing", () => {
    expect(formatPoints(0)).toBe("Passive points: 0");
    expect(formatPoints(null)).toBe("Passive points: 0");
  });
});

// --- Task 15b: the pane layout, and the fifth tab --------------------------

const PANE = { x: 300, y: 200, w: 528, h: 340 };

const RICH_CHARACTER = {
  className: "Warrior",
  mainStat: "strength",
  level: 7,
  experience: 102,
  xpFloor: 63,
  xpToNext: 78,
  passivePoints: 3,
  sources: RICH_SOURCES,
  modifiers: [
    { label: "Kindling", value: 12, source: "tree", kind: "damage", detail: "fire" },
    { label: "of the Bear", value: 4, source: "gear", kind: "stat", detail: "strength" },
  ],
  stats: {
    maxHp: 140, maxMana: 100, maxStamina: 108, meleeMult: 1.15, spellMult: 1,
    cooldownMult: 0.8696, manaRegen: 10, priceMult: 0.55,
  },
};

const FRESH_CHARACTER = {
  className: "Mage",
  mainStat: "intelligence",
  level: 1,
  experience: 0,
  xpFloor: 0,
  xpToNext: 18,
  passivePoints: 0,
  sources: FRESH_SOURCES,
  modifiers: [],
  stats: {
    maxHp: 100, maxMana: 100, maxStamina: 100, meleeMult: 1, spellMult: 1,
    cooldownMult: 1, manaRegen: 10, priceMult: 0.5,
  },
};

describe("layoutCharacterTab", () => {
  it("lays out the header, the six itemised stats and the eight derived rows", () => {
    const l = layoutCharacterTab({ ...PANE, character: RICH_CHARACTER });
    expect(l.header.text).toBe("Warrior — Level 7");
    expect(l.statLines.map((s) => s.text)).toEqual([
      "STR 42 = 5 base + 33 tree + 4 gear",
      "DEX 11 = 5 base + 6 tree",
      "CON 14 = 8 base + 4 tree + 2 gear",
      "INT 5 = 5 base",
      "WIS 8 = 6 base + 2 tree",
      "CHA 5 = 5 base",
    ]);
    expect(l.derived.map((d) => d.text)).toEqual([
      "Max HP        140",
      "Max mana      100",
      "Max stamina   108",
      "Melee         x1.15",
      "Spell         x1.00",
      "Cooldown      x0.87",
      "Mana regen    10",
      "Sell price    x0.55",
    ]);
    expect(l.highlight.text).toBe("Strong: STR 42    Weak: INT 5");
    expect(l.points.text).toBe("Passive points: 3");
    expect(l.xp.label).toBe("39 / 78 XP");
    expect(l.modifiers.rows.map((r) => r.text)).toEqual([
      "Kindling  +12% fire damage",
      "of the Bear  +4 STR",
    ]);
    expect(l.modifiers.rows.map((r) => r.source)).toEqual(["tree", "gear"]);
  });

  it("marks the strong and weak stat lines so the draw can tint them", () => {
    const l = layoutCharacterTab({ ...PANE, character: RICH_CHARACTER });
    expect(l.statLines[0].strong).toBe(true);   // strength
    expect(l.statLines[0].weak).toBe(false);
    expect(l.statLines[3].weak).toBe(true);     // intelligence
    expect(l.statLines[3].strong).toBe(false);
    expect(l.statLines.filter((s) => s.strong)).toHaveLength(1);
    expect(l.statLines.filter((s) => s.weak)).toHaveLength(1);
  });

  it("puts the stat column and the derived column side by side, not on top of each other", () => {
    const l = layoutCharacterTab({ ...PANE, character: RICH_CHARACTER });
    expect(l.statLines[0].x).toBe(PANE.x);
    expect(l.derived[0].x).toBeGreaterThan(PANE.x);
    expect(l.derived[0].y).toBe(l.statLines[0].y);
  });

  it("renders a fresh level-1 character with zero passives and zero affixes", () => {
    const l = layoutCharacterTab({ ...PANE, character: FRESH_CHARACTER });
    expect(l.statLines.map((s) => s.text)).toEqual([
      "STR 5 = 5 base", "DEX 5 = 5 base", "CON 5 = 5 base",
      "INT 5 = 5 base", "WIS 5 = 5 base", "CHA 5 = 5 base",
    ]);
    expect(l.highlight.text).toBe("Strong: INT 5    Weak: —");
    expect(l.points.text).toBe("Passive points: 0");
    expect(l.xp.label).toBe("0 / 18 XP");
    expect(l.xp.fillW).toBe(0);
    expect(l.modifiers.rows).toEqual([
      { text: "No modifiers yet — allocate passives or equip gear.", source: null, x: 300, y: 440 },
    ]);
    expect(l.modifiers.pageCount).toBe(1);
    expect(l.modifiers.prev).toBeNull();
    expect(l.modifiers.next).toBeNull();
    expect(l.hitAreas).toEqual([]);
  });

  it("keeps every element inside the pane it was given", () => {
    // The one guard that turns a mis-sized constant (CHAR_MOD_ROWS, the derived
    // block's row count) into a red test instead of a list clipped off the
    // bottom of the panel in the browser.
    const many = [];
    for (let i = 0; i < CHAR_MOD_ROWS + 2; i += 1) {
      many.push({ label: `Mod ${i}`, value: i, source: "tree", kind: "stat", detail: "strength" });
    }
    const l = layoutCharacterTab({ ...PANE, character: { ...RICH_CHARACTER, modifiers: many } });
    const boxes = [
      l.xp.track, ...l.modifiers.rows, ...l.statLines, ...l.derived,
      l.highlight, l.points, l.modifiers.title, l.modifiers.next,
    ].filter(Boolean);
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(PANE.x);
      expect(b.y).toBeGreaterThanOrEqual(PANE.y);
      expect(b.y + (b.h || CHAR_LINE_H)).toBeLessThanOrEqual(PANE.y + PANE.h);
    }
  });

  it("pages a long modifier list and registers arrow hit areas", () => {
    const many = [];
    for (let i = 0; i < CHAR_MOD_ROWS + 2; i += 1) {
      many.push({ label: `Mod ${i}`, value: i, source: "tree", kind: "stat", detail: "strength" });
    }
    const p0 = layoutCharacterTab({ ...PANE, character: { ...RICH_CHARACTER, modifiers: many } });
    expect(p0.modifiers.pageCount).toBe(2);
    expect(p0.modifiers.rows).toHaveLength(CHAR_MOD_ROWS);
    expect(p0.modifiers.rows[0].text).toBe("Mod 0  +0 STR");
    expect(p0.modifiers.prev).toBeNull();
    expect(p0.hitAreas).toContainEqual({ ...p0.modifiers.next, kind: "charmodpage", id: 1 });

    const p1 = layoutCharacterTab({ ...PANE, character: { ...RICH_CHARACTER, modifiers: many }, modPage: 1 });
    expect(p1.modifiers.rows).toHaveLength(2);
    expect(p1.modifiers.rows[0].text).toBe(`Mod ${CHAR_MOD_ROWS}  +${CHAR_MOD_ROWS} STR`);
    expect(p1.modifiers.next).toBeNull();
    expect(p1.hitAreas).toContainEqual({ ...p1.modifiers.prev, kind: "charmodpage", id: 0 });
  });

  it("clamps a modifier page past the end", () => {
    const l = layoutCharacterTab({ ...PANE, character: RICH_CHARACTER, modPage: 9 });
    expect(l.modifiers.page).toBe(0);
    expect(l.modifiers.rows[0].text).toBe("Kindling  +12% fire damage");
  });

  it("says it is loading when no character view has arrived", () => {
    const l = layoutCharacterTab({ ...PANE, character: null });
    expect(l.loading.text).toBe("Loading character…");
    expect(l.statLines).toEqual([]);
    expect(l.header).toBeNull();
    expect(l.hitAreas).toEqual([]);
  });
});

describe("the Character tab inside the inventory panel", () => {
  function inv() {
    return { types: new Map(), items: [], equipment: {}, ammoCounts: new Map(), capacity: 48 };
  }

  it("offers Character as the fifth tab, after the four item filters", () => {
    expect(TABS.map((t) => t.key)).toEqual(["all", "equip", "supply", "stones", "character"]);
    const l = layoutInventory({ inventory: inv() });
    expect(l.tabs.map((t) => t.label)).toEqual(["All", "Equip", "Supply", "Stones", "Character"]);
    const last = l.tabs[4];
    expect(last.x + last.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
    expect(l.hitAreas).toContainEqual({ x: last.x, y: last.y, w: last.w, h: last.h, kind: "invtab", id: "character" });
  });

  it("feeds the item grid nothing at all on the Character tab", () => {
    // Without this the tab would inherit `categories: null` ("show everything")
    // and paint the item grid straight through the character pane.
    const i = inv();
    i.types = new Map([[1, { id: 1, name: "short sword", category: "weapon", slot: "main_hand" }]]);
    i.items = [{ id: "w", typeId: 1, quantity: 1 }];
    expect(visibleItems(i, "character")).toEqual([]);
    // ...and the control: the same inventory on any item tab is NOT empty, so
    // the assertion above is about the tab and not about an empty fixture.
    expect(visibleItems(i, "all")).toHaveLength(1);
    const l = layoutInventory({ inventory: i, tab: "character" });
    expect(l.cells.every((c) => c.item === null)).toBe(true);
    expect(l.hitAreas.some((a) => a.kind === "item")).toBe(false);
    expect(l.pages.count).toBe(1);
    expect(l.pages.prev).toBeNull();
    expect(l.pages.next).toBeNull();
  });

  it("builds the character pane only on the Character tab", () => {
    expect(layoutInventory({ inventory: inv(), tab: "all", character: RICH_CHARACTER }).character).toBeNull();
    const l = layoutInventory({ inventory: inv(), tab: "character", character: RICH_CHARACTER });
    expect(l.character).not.toBeNull();
    expect(l.character.header.text).toBe("Warrior — Level 7");
  });

  it("hoists the pane's hit areas onto the panel so clicks route", () => {
    const many = [];
    for (let i = 0; i < CHAR_MOD_ROWS + 2; i += 1) {
      many.push({ label: `Mod ${i}`, value: i, source: "tree", kind: "stat", detail: "strength" });
    }
    const l = layoutInventory({
      inventory: inv(), tab: "character",
      character: { ...RICH_CHARACTER, modifiers: many },
    });
    expect(l.hitAreas.some((a) => a.kind === "charmodpage" && a.id === 1)).toBe(true);
  });

  it("keeps the paperdoll and the footer on the Character tab", () => {
    // The left column is character-shaped already; only the right-hand grid is
    // replaced. Losing the equipment boxes here would be a regression.
    const l = layoutInventory({ inventory: inv(), tab: "character", character: RICH_CHARACTER, gold: 42 });
    expect(l.slots).toHaveLength(8);
    expect(l.footer.gold).toBe(42);
    expect(l.character.x).toBeGreaterThan(l.preview.x + l.preview.w);
  });

  it("gives the pane exactly the rectangle the grid would have had", () => {
    const l = layoutInventory({ inventory: inv(), tab: "character", character: RICH_CHARACTER });
    const grid = layoutInventory({ inventory: inv(), tab: "all", character: RICH_CHARACTER });
    expect(l.character.x).toBe(grid.cells[0].x);
    expect(l.character.y).toBe(grid.cells[0].y);
    expect(l.character.x + l.character.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
    expect(l.character.y + l.character.h).toBeLessThanOrEqual(l.footer.y);
  });
});

// SOURCE-TEXT ONLY, migrated from characterSheet.test.js's F2 block, which is
// deleted along with the popup in Task 15e. The lesson it guards outlives the
// component: a client-side copy of a backend progression constant drifts the
// first time the backend's copy moves. This is NOT behavioural evidence; it is
// a standing prohibition.
describe("F2: the Character tab declares no backend progression constant", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../characterTab.js", import.meta.url)), "utf8",
  );

  it("declares no XP_BASE / MAX_LEVEL / RESPEC_BASE of its own", () => {
    expect(source).not.toMatch(/const\s+XP_BASE/);
    expect(source).not.toMatch(/const\s+MAX_LEVEL/);
    expect(source).not.toMatch(/const\s+RESPEC_BASE/);
  });

  it("computes no power/curve arithmetic -- xpFloor and xpToNext arrive as data", () => {
    expect(source).not.toMatch(/Math\.pow/);
    expect(source).not.toMatch(/\*\*/);
  });

  it("xpCurve.js, the deleted local reimplementation, still does not exist", () => {
    const xpCurvePath = fileURLToPath(new URL("../../core/xpCurve.js", import.meta.url));
    expect(existsSync(xpCurvePath)).toBe(false);
  });
});
