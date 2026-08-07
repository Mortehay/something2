import { describe, it, expect } from "vitest";
import {
  behaviorToForm, behaviorFormToPayload, ATTACK_KINDS, CHASE_STYLES,
  formatReferencingEntityTypes, deleteBehaviorErrorMessage,
} from "../behaviorForm.js";

describe("behaviorForm", () => {
  it("round-trips a profile without drifting a value", () => {
    const row = {
      id: 3, name: "Ranged", aggro_radius: 460, leash_radius: 800, chase_style: "kite",
      preferred_range: 240, move_speed_mult: 1, damage_override: null,
    };
    const back = behaviorFormToPayload(behaviorToForm(row));
    expect(back.chase_style).toBe("kite");
    expect(back.preferred_range).toBe(240);
    expect(back.damage_override).toBe(null);
  });

  it("keeps a damage_override of 0 rather than dropping it to null", () => {
    const form = behaviorToForm({ name: "Z", chase_style: "charge", damage_override: 0 });
    expect(behaviorFormToPayload(form).damage_override).toBe(0);
  });

  it("turns a blank damage_override field into null, not 0", () => {
    const form = { ...behaviorToForm({ name: "Z", chase_style: "charge" }),
      damage_override: "" };
    expect(behaviorFormToPayload(form).damage_override).toBe(null);
  });

  it("coerces numeric text fields to numbers", () => {
    const form = { ...behaviorToForm({ name: "Z", chase_style: "charge" }),
      aggro_radius: "420", move_speed_mult: "1.25" };
    const p = behaviorFormToPayload(form);
    expect(p.aggro_radius).toBe(420);
    expect(p.move_speed_mult).toBe(1.25);
  });

  it("exposes the same value sets the backend enforces", () => {
    expect(ATTACK_KINDS).toEqual(["melee", "ranged", "cast"]);
    expect(CHASE_STYLES).toEqual(["charge", "kite", "skirmish", "hold", "ambush", "guard"]);
  });

  // SOMET-249 fix-wave I4: a brand-new profile (no row, or the Add-Behavior
  // modal's `editingBehavior || {}`) used to default every numeric to 0 --
  // an admin who typed a name and saved got a creature that never moves and
  // never aggroes, with no error anywhere.
  it("defaults a brand-new profile to the Line profile's numbers, not to 0", () => {
    const form = behaviorToForm(); // no argument -- exactly the Add-Behavior call site
    expect(form.aggro_radius).toBe(400);
    expect(form.leash_radius).toBe(800);
    expect(form.move_speed_mult).toBe(1);
    // Legitimately 0 even on Line (no preferred standoff distance) -- still 0
    // for a new row, not a typo.
    expect(form.preferred_range).toBe(0);
  });

  it("still defaults a new profile passed as {} (editingBehavior || {}) to Line's numbers", () => {
    const form = behaviorToForm({});
    expect(form.aggro_radius).toBe(400);
    expect(form.leash_radius).toBe(800);
  });

  it("does NOT change how an EXISTING row maps -- a stored 0 must still round-trip as 0", () => {
    const form = behaviorToForm({
      id: 9, name: "Zero Range", chase_style: "charge",
      aggro_radius: 0, leash_radius: 0, move_speed_mult: 0,
      preferred_range: 0, damage_override: null,
    });
    expect(form.aggro_radius).toBe(0);
    expect(form.leash_radius).toBe(0);
    expect(form.move_speed_mult).toBe(0);
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
