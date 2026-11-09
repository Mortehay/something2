// How the expanded affixes look to the player: the tooltip line with its tier, the composed item name, the
// Character tab's gear rules, and the Ukrainian text of EVERY affix the server catalog defines.
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import {
  affixValueText, affixTier, affixTooltipLine, itemDisplayName,
} from "../itemDisplay.js";
import { formatItemTooltipLines } from "../inventoryPanel.js";
import { formatModifier } from "../characterTab.js";
import { setLang, t } from "../../i18n/i18n.js";
import { UK } from "../../i18n/uk/index.js";

// The backend's seed data is mounted next to the frontend in the container (/backend) and sits next to it on the
// host, so eight directories up is the repository root in both.
const require = createRequire(import.meta.url);
const CATALOG = require(new URL("../../../../../../../../backend/seeds/data/affixTypes.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

afterEach(() => setLang("en"));

const tiers = [
  { ilvl: 1, min: 4, max: 8 }, { ilvl: 20, min: 11, max: 15 }, { ilvl: 40, min: 18, max: 25 },
  { ilvl: 60, min: 26, max: 36 }, { ilvl: 80, min: 34, max: 45 },
];
const brutal = { key: "brutal", label: "Brutal", value: 30, effect: { type: "damage", element: "physical", text: "+{v}% Physical Damage", tiers } };
const celerity = { key: "of_celerity", label: "of Celerity", value: 12, effect: { type: "rule", rule: "attackSpeedMult", base: 1, scale: 0.01, text: "+{v}% Attack Speed", tiers } };
const volley = { key: "of_the_volley", label: "of the Volley", value: 2, effect: { type: "rule", rule: "projectileCount", int: true, text: "+{v} Additional Projectiles", tiers: [{ ilvl: 30, min: 1, max: 1 }, { ilvl: 65, min: 2, max: 2 }] } };
const might = { key: "of_might", label: "of Might", value: 6, effect: { type: "stat", stat: "strength" } };

describe("an affix's own tooltip line", () => {
  it("fills in the rolled value and names the tier", () => {
    expect(affixTooltipLine(brutal)).toEqual({ text: "+30% Physical Damage  T2", tier: 2, top: false });
    expect(affixTooltipLine({ ...brutal, value: 40 }).top).toBe(true);
    expect(affixTooltipLine({ ...brutal, value: 5 }).text).toBe("+5% Physical Damage  T5");
    expect(affixTooltipLine(volley)).toEqual({ text: "+2 Additional Projectiles  T1", tier: 1, top: true });
  });

  it("is null for an affix with no text of its own (the original twelve), so they keep their old caption", () => {
    expect(affixTooltipLine(might)).toBeNull();
    expect(affixTooltipLine(null)).toBeNull();
    expect(affixTooltipLine({ effect: { text: "" } })).toBeNull();
    expect(affixTooltipLine({ value: 3 })).toBeNull();
  });

  it("an affix with text but no tiers shows no tier", () => {
    expect(affixTooltipLine({ value: 4, effect: { type: "rule", text: "+{v} Weapon Reach" } })).toEqual({ text: "+4 Weapon Reach", tier: null, top: false });
  });

  it("formats numbers as a player reads them", () => {
    expect(affixValueText(12, {})).toBe("12");
    expect(affixValueText(1.5, {})).toBe("1.5");
    expect(affixValueText(1.26, {})).toBe("1.3");
    expect(affixValueText(2.4, { int: true })).toBe("2");
    expect(affixValueText("x", {})).toBe("");
    expect(affixValueText(null, {})).toBe("");
  });

  it("reads a tier back from the value", () => {
    expect(affixTier(brutal.effect, 4)).toBe(5);
    expect(affixTier(brutal.effect, 18)).toBe(3);
    expect(affixTier(brutal.effect, 45)).toBe(1);
    expect(affixTier({}, 5)).toBeNull();
    expect(affixTier({ tiers: [] }, 5)).toBeNull();
  });

  it("speaks Ukrainian when the language is Ukrainian", () => {
    setLang("uk");
    expect(affixTooltipLine(celerity).text).toBe("+12% швидкості атаки  T4");
  });
});

describe("the tooltip of an item", () => {
  const sword = { id: 5, name: "iron-sword", category: "weapon", kind: "melee", damage: 10, cooldown: 1, slot: "main_hand", tier: 2 };
  const item = { id: "i", typeId: 5, rarity: "yellow", item_level: 50, affixes: [brutal, celerity, might] };
  const lines = (it) => formatItemTooltipLines(it, sword).map((l) => l.text);

  it("is named from its first prefix and suffix", () => {
    expect(lines(item)[0]).toBe("Brutal iron-sword of Celerity");
    expect(lines({ ...item, affixes: [might] })[0]).toBe("iron-sword of Might");
    expect(lines({ ...item, affixes: [] })[0]).toBe("iron-sword");
  });

  it("lists the new affixes in their own words and the old ones as before", () => {
    const text = lines(item).join("\n");
    expect(text).toContain("+30% Physical Damage  T2");
    expect(text).toContain("+12% Attack Speed  T4");
    expect(text).toMatch(/of Might/);
  });

  it("colours a top-tier line apart from the rest", () => {
    const l = formatItemTooltipLines({ ...item, affixes: [{ ...brutal, value: 44 }, celerity] }, sword);
    const top = l.find((x) => x.text.startsWith("+44%"));
    const normal = l.find((x) => x.text.startsWith("+12%"));
    expect(top.color).not.toBe(normal.color);
  });

  it("keeps the enchant level in front of the composed name", () => {
    expect(formatItemTooltipLines({ ...item, enchantLevel: 6 }, sword)[0].text).toMatch(/^\+6 /);
  });

  it("in Ukrainian keeps the base name (the words would have to agree with it) and translates every line", () => {
    setLang("uk");
    const l = formatItemTooltipLines(item, sword).map((x) => x.text);
    expect(l[0]).not.toMatch(/Brutal|of Celerity/);
    expect(l.join("\n")).toContain("+30% фізичної шкоди  T2");
    expect(itemDisplayName("меч", [brutal])).toBe("меч");
  });
});

describe("the Character tab's gear rules", () => {
  it("name what the rule does, with its number", () => {
    expect(formatModifier({ source: "gear", kind: "rule", label: "of Celerity", detail: "attackSpeedMult", value: 1.12 })).toBe("of Celerity  attack speed x1.12");
    expect(formatModifier({ source: "gear", kind: "rule", label: "of Precision", detail: "critChance", value: 0.04 })).toBe("of Precision  crit chance +0.04");
    expect(formatModifier({ source: "gear", kind: "rule", label: "Sagacious", detail: "spellLevelBonus", value: 2 })).toBe("Sagacious  spell levels +2");
  });

  it("leave a tree keystone's own sentence alone", () => {
    expect(formatModifier({ source: "tree", kind: "rule", label: "Fleet — your cooldown floor drops", detail: "cooldownFloor", value: 0.35 })).toBe("Fleet — your cooldown floor drops");
    expect(formatModifier({ kind: "rule", label: "x", detail: "critChance" })).toBe("x");
  });
});

describe("every affix of the server catalog is translated", () => {
  const all = [...CATALOG.NEW_AFFIXES, ...CATALOG.TRIGGER_AFFIXES];

  it("has a Ukrainian label that differs from the English one", () => {
    const missing = all.filter((a) => !UK[a.label] || UK[a.label] === a.label).map((a) => a.label);
    expect(missing).toEqual([]);
  });

  it("has a Ukrainian tooltip line that keeps the {v} placeholder and differs from the English one", () => {
    const bad = [];
    for (const a of all) {
      const uk = UK[a.effect.text];
      if (!uk || uk === a.effect.text) bad.push(`${a.key}: no translation of "${a.effect.text}"`);
      else if (a.effect.text.includes("{v}") && !uk.includes("{v}")) bad.push(`${a.key}: lost {v}`);
    }
    expect(bad).toEqual([]);
  });

  it("composes sensible English names for all of them", () => {
    for (const a of all) {
      const name = itemDisplayName("Blade", [{ label: a.label }]);
      expect(name).toBe(a.placement === "prefix" ? `${a.label} Blade` : `Blade ${a.label}`);
    }
  });

  it("t() fills the placeholder in both languages", () => {
    expect(t("+{v}% Attack Speed", { v: 9 })).toBe("+9% Attack Speed");
    setLang("uk");
    expect(t("+{v}% Attack Speed", { v: 9 })).toBe("+9% швидкості атаки");
  });
});
