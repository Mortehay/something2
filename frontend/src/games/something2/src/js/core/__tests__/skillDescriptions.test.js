// The client side of the generated skill descriptions: the card's damage line comes
// from the catalog's own numbers (units / hits), the description is shown in the
// player's language, HP costs show a percent sign, and nothing on the client parses
// the description text for damage any more.
import { describe, it, expect, afterEach } from "vitest";
import { SKILLS, getSkillById, resolveSkillDamage, skillDescription } from "../skillsData.js";
import { setLang } from "../../i18n/i18n.js";

afterEach(() => setLang("en"));

describe("generated catalog", () => {
  it("every skill carries both generated descriptions and its original lore", () => {
    for (const s of SKILLS) {
      expect(s.descEn?.length, s.id).toBeGreaterThan(10);
      expect(s.descUk?.length, s.id).toBeGreaterThan(10);
      expect(s.loreEn, s.id).toBeTruthy();
    }
  });
  it("damaging skills carry the numbers the card prints", () => {
    for (const s of SKILLS.filter((x) => x.type !== "buff")) {
      expect(s.units, s.id).toBeGreaterThan(0);
      expect(s.hits, s.id).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("resolveSkillDamage", () => {
  it("prints a single hit in weapon-hit units from the catalog, not from the text", () => {
    const s = getSkillById("war_crushing_blow");
    const info = resolveSkillDamage(s);
    expect(info.base).toBe(s.units);
    expect(info.hits).toBe(1);
    expect(info.text).toBe(`${Math.round(s.units * 10) / 10}x weapon damage`);
    // the old regex path read "180%" out of the description; the lore still says 180%
    expect(resolveSkillDamage({ ...s, descEn: "180% 999%" }).text).toBe(info.text);
  });
  it("splits a multi-hit skill and gives a channel per second", () => {
    const rain = getSkillById("arc_rain_of_arrows");
    expect(resolveSkillDamage(rain).hits).toBe(10);
    expect(resolveSkillDamage(rain).text).toMatch(/^10 x [\d.]+x weapon damage$/);
    const whirl = getSkillById("war_whirlwind");
    expect(resolveSkillDamage(whirl).text).toMatch(/weapon damage per second$/);
  });
  it("uses the live pools only for instant heals and mana restores", () => {
    expect(resolveSkillDamage(getSkillById("war_unstoppable"), { maxHp: 400 }).text).toBe("Heal +25% HP (+100 HP)");
    expect(resolveSkillDamage(getSkillById("war_battle_shout")).text).toBe("Buff / Utility");
  });
});

describe("skillDescription", () => {
  it("returns the description in the active language", () => {
    const s = getSkillById("war_crushing_blow");
    expect(skillDescription(s)).toBe(s.descEn);
    setLang("uk");
    expect(skillDescription(s)).toBe(s.descUk);
    expect(skillDescription(null)).toBe("");
  });
});

describe("HP costs are a percent of max life", () => {
  it("the catalog marks them and the cost texts print a percent sign", async () => {
    const hp = SKILLS.filter((s) => s.costType === "hp");
    expect(hp.length).toBeGreaterThan(30);
    for (const s of hp) expect(s.costPct, s.id).toBe(true);
    for (const s of SKILLS.filter((x) => x.costType !== "hp")) expect(s.costPct, s.id).toBeFalsy();
    // the two places that print a cost (read as source: they are canvas panels)
    const fs = await import("node:fs");
    const render = fs.readFileSync(new URL("../../systems/RenderSystem.js", import.meta.url), "utf8");
    const shop = fs.readFileSync(new URL("../../systems/gemShopPanel.js", import.meta.url), "utf8");
    expect(render).toMatch(/skill\.costPct \? '%' : ''/);
    expect(shop).toMatch(/s\.costPct \? "%" : ""/);
  });
});
