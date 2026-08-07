import { describe, it, expect } from "vitest";
import {
  behaviorToForm, behaviorFormToPayload, ATTACK_KINDS, CHASE_STYLES,
  formatReferencingEntityTypes, deleteBehaviorErrorMessage,
} from "../behaviorForm.js";

describe("behaviorForm", () => {
  it("round-trips a profile without drifting a value", () => {
    const row = {
      id: 3, name: "Ranged", attack_kind: "ranged", attack_range: 340,
      attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,
      aggro_radius: 460, leash_radius: 800, chase_style: "kite",
      preferred_range: 240, move_speed_mult: 1, damage_override: null,
    };
    const back = behaviorFormToPayload(behaviorToForm(row));
    expect(back.attack_range).toBe(340);
    expect(back.chase_style).toBe("kite");
    expect(back.preferred_range).toBe(240);
    expect(back.damage_override).toBe(null);
  });

  it("keeps a damage_override of 0 rather than dropping it to null", () => {
    const form = behaviorToForm({ name: "Z", attack_kind: "melee", chase_style: "charge",
      damage_override: 0 });
    expect(behaviorFormToPayload(form).damage_override).toBe(0);
  });

  it("turns a blank damage_override field into null, not 0", () => {
    const form = { ...behaviorToForm({ name: "Z", attack_kind: "melee", chase_style: "charge" }),
      damage_override: "" };
    expect(behaviorFormToPayload(form).damage_override).toBe(null);
  });

  it("coerces numeric text fields to numbers", () => {
    const form = { ...behaviorToForm({ name: "Z", attack_kind: "melee", chase_style: "charge" }),
      attack_range: "72", move_speed_mult: "1.25" };
    const p = behaviorFormToPayload(form);
    expect(p.attack_range).toBe(72);
    expect(p.move_speed_mult).toBe(1.25);
  });

  it("exposes the same value sets the backend enforces", () => {
    expect(ATTACK_KINDS).toEqual(["melee", "ranged", "cast"]);
    expect(CHASE_STYLES).toEqual(["charge", "kite", "skirmish", "hold", "ambush", "guard"]);
  });
});

describe("formatReferencingEntityTypes", () => {
  it("returns an empty string for zero references", () => {
    expect(formatReferencingEntityTypes([])).toBe("");
    expect(formatReferencingEntityTypes(null)).toBe("");
    expect(formatReferencingEntityTypes(undefined)).toBe("");
  });

  it("names a single reference with no 'and N more' tail", () => {
    expect(formatReferencingEntityTypes([{ id: 1, name: "Ember Archer" }]))
      .toBe("Ember Archer");
  });

  it("lists several references in full when at or under the cap", () => {
    const refs = [{ id: 1, name: "Ember Archer" }, { id: 2, name: "Frost Adept" }, { id: 3, name: "Goblin" }];
    expect(formatReferencingEntityTypes(refs, 3)).toBe("Ember Archer, Frost Adept, Goblin");
  });

  it("truncates and counts the rest when over the cap", () => {
    const refs = [
      { id: 1, name: "Ember Archer" }, { id: 2, name: "Frost Adept" }, { id: 3, name: "Goblin" },
      { id: 4, name: "Skeleton" }, { id: 5, name: "Wraith" },
    ];
    expect(formatReferencingEntityTypes(refs, 3)).toBe("Ember Archer, Frost Adept, Goblin and 2 more");
  });
});

describe("deleteBehaviorErrorMessage", () => {
  it("falls back to the generic message when there are no references", () => {
    expect(deleteBehaviorErrorMessage("Ranged", [], "Failed to delete behavior"))
      .toBe("Failed to delete behavior");
    expect(deleteBehaviorErrorMessage("Ranged", undefined, "Failed to delete behavior"))
      .toBe("Failed to delete behavior");
  });

  it("names the profile and its blockers when references are present", () => {
    const refs = [{ id: 1, name: "Ember Archer" }, { id: 2, name: "Frost Adept" }];
    expect(deleteBehaviorErrorMessage("Ranged", refs, "Failed to delete behavior"))
      .toBe('Cannot delete "Ranged": still used by Ember Archer, Frost Adept');
  });

  it("still names blockers when the deleted profile's own name is unknown", () => {
    const refs = [{ id: 1, name: "Ember Archer" }];
    expect(deleteBehaviorErrorMessage(undefined, refs, "Failed to delete behavior"))
      .toBe("Cannot delete this profile: still used by Ember Archer");
  });
});
