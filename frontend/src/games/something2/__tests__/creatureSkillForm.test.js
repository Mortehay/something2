import { describe, it, expect } from "vitest";
import { creatureSkillToForm, creatureSkillFormToPayload, deleteSkillErrorMessage, paramsJsonError, KINDS, ELEMENTS } from "../creatureSkillForm.js";

describe("creatureSkillForm", () => {
  it("round-trips a skill without drifting a value", () => {
    const row = {
      id: 7, name: "Ground Slam", kind: "slam", telegraph_ms: 600, cooldown_ms: 5000,
      radius: 90, range: 220, damage_mult: 1.4, element: "fire",
      summon_entity: null, summon_count: 1, vfx: { telegraph: "a", cast: "b", impact: "c" },
    };
    const back = creatureSkillFormToPayload(creatureSkillToForm(row));
    expect(back.telegraph_ms).toBe(600);
    expect(back.cooldown_ms).toBe(5000);
    expect(back.radius).toBe(90);
    expect(back.range).toBe(220);
    expect(back.damage_mult).toBe(1.4);
    expect(back.element).toBe("fire");
    expect(back.vfx).toEqual({ telegraph: "a", cast: "b", impact: "c" });
  });

  it("defaults a brand-new skill to a usable telegraph/cooldown, not to 0", () => {
    const form = creatureSkillToForm(); // no argument -- the Add-Skill call site
    expect(form.telegraph_ms).toBe(500);
    expect(form.cooldown_ms).toBe(4000);
    expect(form.radius).toBe(80);
    expect(form.range).toBe(200);
    expect(form.damage_mult).toBe(1);
    expect(form.summon_count).toBe(1);
    expect(form.kind).toBe("slam");
  });

  it("still defaults a new skill passed as {} the same way", () => {
    const form = creatureSkillToForm({});
    expect(form.cooldown_ms).toBe(4000);
    expect(form.damage_mult).toBe(1);
  });

  it("does NOT change how an EXISTING row maps -- a stored 0 must still round-trip as 0", () => {
    // radius 0 is legitimate for a `projectile` (its own radius means
    // hit-size, not an AoE) and telegraph_ms 0 is legitimate for any kind
    // (an instant cast with no warning at all).
    const form = creatureSkillToForm({
      id: 4, name: "Snipe", kind: "projectile", telegraph_ms: 0, cooldown_ms: 3000,
      radius: 0, range: 400, damage_mult: 1,
    });
    expect(form.telegraph_ms).toBe(0);
    expect(form.radius).toBe(0);
  });

  it("turns a blank element field into null, meaning 'inherit the caster's element'", () => {
    const form = { ...creatureSkillToForm({ name: "Z", kind: "nova", cooldown_ms: 1000 }), element: "" };
    expect(creatureSkillFormToPayload(form).element).toBe(null);
  });

  it("carries a real element through untouched", () => {
    const form = { ...creatureSkillToForm({ name: "Z", kind: "nova", cooldown_ms: 1000 }), element: "lightning" };
    expect(creatureSkillFormToPayload(form).element).toBe("lightning");
  });

  it("turns a blank summon_entity into null", () => {
    const form = { ...creatureSkillToForm({ name: "Z", kind: "summon", cooldown_ms: 1000 }), summon_entity: "" };
    expect(creatureSkillFormToPayload(form).summon_entity).toBe(null);
  });

  it("carries a real summon_entity name through untouched", () => {
    const form = {
      ...creatureSkillToForm({ name: "Z", kind: "summon", cooldown_ms: 1000 }),
      summon_entity: "Fire Elemental Guard",
    };
    expect(creatureSkillFormToPayload(form).summon_entity).toBe("Fire Elemental Guard");
  });

  it("coerces numeric text fields to numbers", () => {
    const form = { ...creatureSkillToForm({ name: "Z", kind: "slam", cooldown_ms: 1000 }),
      radius: "120", telegraph_ms: "750" };
    const p = creatureSkillFormToPayload(form);
    expect(p.radius).toBe(120);
    expect(p.telegraph_ms).toBe(750);
  });

  it("vfx: only non-blank slots survive, and an all-blank vfx becomes null rather than {}", () => {
    const row = { name: "Z", kind: "slam", cooldown_ms: 1000, vfx: { telegraph: "warn", cast: "", impact: null } };
    const payload = creatureSkillFormToPayload(creatureSkillToForm(row));
    expect(payload.vfx).toEqual({ telegraph: "warn" });

    const blank = { name: "Z", kind: "slam", cooldown_ms: 1000, vfx: null };
    expect(creatureSkillFormToPayload(creatureSkillToForm(blank)).vfx).toBe(null);
  });

  it("deleteSkillErrorMessage names the blocking behaviors; falls back when there are none", () => {
    expect(deleteSkillErrorMessage("Slam", [{ id: 1, name: "Apex" }, { id: 2, name: "Brute" }], "fallback"))
      .toBe('Cannot delete "Slam": still bound by 2 behavior(s) (Apex, Brute)');
    expect(deleteSkillErrorMessage("Slam", [], "fallback")).toBe("fallback");
    expect(deleteSkillErrorMessage("Slam", null, "fallback")).toBe("fallback");
  });

  it("exposes the same kind/element sets the backend enforces", () => {
    expect(KINDS).toEqual(["slam", "nova", "summon", "projectile", "charge", "blink", "rain", "chain", "zone", "mark", "shelter"]);
    expect(ELEMENTS).toEqual(["physical", "arcane", "fire", "ice", "lightning"]);
  });

  it("offers every kind the backend resolves (an editor that knew fewer would turn a boss skill into a slam)", () => {
    const backend = require("../../../../../backend/src/services/creatureSkills.js");
    expect(KINDS).toEqual(backend.KINDS);
  });
});

describe("creatureSkillForm: a boss skill's mechanics survive an edit", () => {
  const boss = {
    id: 9, name: "Lava Pools", kind: "zone", telegraph_ms: 1400, cooldown_ms: 14000, radius: 110, range: 800,
    damage_mult: 0.35, element: "fire", summon_entity: null, summon_count: 1, vfx: null,
    params: { hazard: { pattern: "targets", count: 4, linger_ms: 9000, tick_ms: 500 } },
  };
  it("keeps the kind of every boss skill instead of falling back to slam", () => {
    for (const kind of ["charge", "blink", "rain", "chain", "zone", "mark", "shelter"]) {
      expect(creatureSkillToForm({ ...boss, kind }).kind).toBe(kind);
    }
  });
  it("round-trips params through the form without losing a key", () => {
    const back = creatureSkillFormToPayload(creatureSkillToForm(boss));
    expect(back.params).toEqual(boss.params);
    expect(back.kind).toBe("zone");
  });
  it("blank params mean none; a row with none shows a blank box", () => {
    expect(creatureSkillToForm({ ...boss, params: null }).params_json).toBe("");
    expect(creatureSkillFormToPayload({ ...creatureSkillToForm(boss), params_json: "  " }).params).toBeNull();
  });
  it("paramsJsonError accepts blank and an object, and explains anything else", () => {
    expect(paramsJsonError("")).toBeNull();
    expect(paramsJsonError(undefined)).toBeNull();
    expect(paramsJsonError('{"status":{"root_s":2}}')).toBeNull();
    expect(paramsJsonError("{oops")).toMatch(/valid JSON/);
    expect(paramsJsonError("[1,2]")).toMatch(/object/);
    expect(paramsJsonError("5")).toMatch(/object/);
    expect(paramsJsonError("null")).toMatch(/object/);
  });
  it("invalid text is never guessed at: the payload carries none", () => {
    expect(creatureSkillFormToPayload({ ...creatureSkillToForm(boss), params_json: "{oops" }).params).toBeNull();
  });
});
