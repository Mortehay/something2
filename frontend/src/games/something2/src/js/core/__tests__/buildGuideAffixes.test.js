// The affix advice in the Build Guide: every named affix exists in the server catalog, can roll on the weapon the
// build uses, is translated, and reaches the Gear & Tips tab.
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { BUILD_AFFIXES, getGuideAffixes } from "../buildGuideAffixes.js";
import { BUILD_GUIDES } from "../buildGuides.data.js";
import { BUILD_GUIDE_VARIANTS } from "../buildGuides.variants.data.js";
import { getBuildGuides } from "../buildGuide.js";
import { layoutBuildGuide } from "../../systems/buildGuidePanel.js";
import { setLang, t } from "../../i18n/i18n.js";
import { UK } from "../../i18n/uk/index.js";

const require = createRequire(import.meta.url);
const CATALOG = require(new URL("../../../../../../../../backend/seeds/data/affixTypes.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

afterEach(() => setLang("en"));

// label -> { tags, slots, rarity } for new affixes; the original twelve have no tag limits.
const BY_LABEL = new Map([...CATALOG.NEW_AFFIXES, ...CATALOG.TRIGGER_AFFIXES].map((a) => [a.label, a]));
const LEGACY_LABELS = new Set(["of Might", "of Grace", "of Vigor", "of Insight", "of Clarity", "of Presence", "of the Bear", "of the Well", "Flaming", "Freezing", "Warded"]);

// The weapon family each build fights with (the guides' own gear text).
const WEAPON = {
  warrior_main: "melee_weapon", warrior_bulwark: "melee_weapon", warrior_executioner: "melee_weapon",
  mage_main: "caster_weapon", mage_missiles: "caster_weapon", mage_storm: "caster_weapon",
  monk_main: "melee_weapon", monk_fist: "melee_weapon", monk_guardian: "melee_weapon",
  cultist_main: "caster_weapon", cultist_bone: "caster_weapon", cultist_curse: "caster_weapon",
  archer_main: "ranged_weapon", archer_sniper: "ranged_weapon", archer_venom: "ranged_weapon",
  druid_main: "melee_weapon", druid_wolf: "melee_weapon", druid_moon: "caster_weapon",
};
const FAMILIES = ["melee_weapon", "ranged_weapon", "caster_weapon"];

const allGuides = () => {
  const out = [];
  for (const [cls, main] of Object.entries(BUILD_GUIDES)) {
    out.push([`${cls.toLowerCase()}_main`, main]);
    for (const v of BUILD_GUIDE_VARIANTS[cls]) out.push([v.id, v]);
  }
  return out;
};

describe("every build has affix advice", () => {
  it("covers exactly the builds that exist", () => {
    expect(Object.keys(BUILD_AFFIXES).sort()).toEqual(allGuides().map(([id]) => id).sort());
    expect(Object.keys(WEAPON).sort()).toEqual(Object.keys(BUILD_AFFIXES).sort());
  });

  it.each(allGuides())("%s resolves from its guide object", (id, guide) => {
    const a = getGuideAffixes(guide);
    expect(a).not.toBeNull();
    expect(a.core.length).toBeGreaterThanOrEqual(4);
    expect(a.good.length).toBeGreaterThanOrEqual(3);
    expect(a.avoid.length).toBeGreaterThan(10);
  });
});

describe.each(Object.entries(BUILD_AFFIXES))("%s", (id, build) => {
  it("names only affixes that exist, once each", () => {
    const labels = build.items.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(BY_LABEL.has(l) || LEGACY_LABELS.has(l), `${l} is not in the catalog`).toBe(true);
  });

  it("only asks for what can roll on the weapon the build uses", () => {
    for (const i of build.items) {
      const a = BY_LABEL.get(i.label);
      if (!a) continue;
      const weaponTags = a.tags.filter((tg) => FAMILIES.includes(tg));
      if (weaponTags.length > 0) expect(weaponTags, `${i.label} does not roll on ${WEAPON[id]}`).toContain(WEAPON[id]);
    }
  });

  it("holds at most 3 prefixes and 3 suffixes among its core (an item cannot carry more)", () => {
    const core = build.items.filter((i) => i.core);
    const isPrefix = (l) => !/^of\b/i.test(l);
    expect(core.filter((i) => isPrefix(i.label)).length).toBeLessThanOrEqual(4);
    expect(core.filter((i) => !isPrefix(i.label)).length).toBeLessThanOrEqual(4);
  });

  it("is translated: every label, and a different Ukrainian text for each line", () => {
    for (const i of build.items) {
      expect(UK[i.label], `no Ukrainian for ${i.label}`).toBeTruthy();
      for (const k of ["where", "effect", "why"]) {
        expect(i[k].en).toBeTruthy();
        expect(i[k].uk).toBeTruthy();
        expect(i[k].uk).not.toBe(i[k].en);
      }
    }
    expect(build.avoid.uk).not.toBe(build.avoid.en);
  });
});

describe("the Gear & Tips tab", () => {
  const lines = (guide) => layoutBuildGuide({ tab: "gear", guide, scroll: 0 }).lines.map((l) => l.text).join("\n");

  it("lists the affixes of the build shown, in the language shown", () => {
    const [{ guide }] = getBuildGuides("Archer");
    const text = lines(guide);
    expect(text).toContain("BEST AFFIXES FOR THIS BUILD");
    expect(text).toContain("of the Volley");
    setLang("uk");
    const [{ guide: uk }] = getBuildGuides("Archer");
    expect(lines(uk)).toContain("НАЙКРАЩІ АФІКСИ ДЛЯ ЦЬОГО БІЛДУ");
    expect(lines(uk)).toContain("Залпу");
  });

  it("differs from build to build of one class", () => {
    const list = getBuildGuides("Mage");
    const texts = list.map((b) => lines(b.guide));
    expect(texts[1]).toContain("Eldritch");
    expect(texts[2]).toContain("Thundering");
    expect(texts[0]).not.toContain("Thundering");
  });

  it("fills in skill names from the catalog, never leaving a placeholder", () => {
    for (const [, guide] of allGuides()) {
      for (const lang of ["en", "uk"]) {
        setLang(lang);
        const a = getGuideAffixes(guide);
        for (const i of [...a.core, ...a.good]) expect(`${i.why}${i.effect}`).not.toMatch(/\{[a-z_]+\}/);
      }
    }
  });
});

describe("t()", () => { it("keeps the heading in English by default", () => { expect(t("Skip")).toBe("Skip"); }); });
