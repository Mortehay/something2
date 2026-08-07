import { describe, it, expect } from "vitest";
import { abilityToForm, abilityFormToPayload, ELEMENTS } from "../abilityForm.js";

describe("abilityForm", () => {
  it("round-trips an ability without drifting a value", () => {
    const row = {
      id: 7, name: "Slam", attack_kind: "melee", attack_range: 90,
      attack_cooldown: 1.2, projectile_speed: 0, projectile_radius: 0,
      element: "physical", damage_mult: 1.4, knockback: 120,
    };
    const back = abilityFormToPayload(abilityToForm(row), 0);
    expect(back.attack_range).toBe(90);
    expect(back.attack_cooldown).toBe(1.2);
    expect(back.element).toBe("physical");
    expect(back.damage_mult).toBe(1.4);
    expect(back.knockback).toBe(120);
  });

  // slot is implied by array position, never read from the stored row -- the
  // admin editor reorders by drag and the API renumbers 1..n anyway.
  it("derives slot from the array index, not from the row", () => {
    const row = { id: 1, name: "A", attack_kind: "melee", attack_range: 60,
      attack_cooldown: 1, slot: 9 };
    const payload = abilityFormToPayload(abilityToForm(row), 2);
    expect(payload.slot).toBe(3);
  });

  it("defaults a brand-new ability to the Line profile's attack, not to 0", () => {
    const form = abilityToForm(); // no argument -- exactly the Add-Ability call site
    expect(form.attack_range).toBe(60);
    expect(form.attack_cooldown).toBe(1);
    expect(form.projectile_speed).toBe(0);
    expect(form.projectile_radius).toBe(0);
    expect(form.damage_mult).toBe(1);
    expect(form.knockback).toBe(0);
    expect(form.attack_kind).toBe("melee");
  });

  it("still defaults a new ability passed as {} to the Line profile's attack", () => {
    const form = abilityToForm({});
    expect(form.attack_range).toBe(60);
    expect(form.damage_mult).toBe(1);
  });

  it("does NOT change how an EXISTING row maps -- a stored 0 must still round-trip as 0", () => {
    const form = abilityToForm({
      id: 4, name: "Rider", attack_kind: "cast", attack_range: 200, attack_cooldown: 2,
      projectile_speed: 400, projectile_radius: 4, damage_mult: 0, knockback: 0,
    });
    expect(form.damage_mult).toBe(0);
    expect(form.knockback).toBe(0);
  });

  // damage_mult 0 is a legitimate pure-rider ability (applies an element, no
  // damage) -- `Number(x) || 0` would happen to preserve a 0 here, but the
  // point is the guard must be an explicit finite check, not `||`, since a
  // hypothetical non-zero fallback elsewhere would silently rewrite it.
  it("keeps a damage_mult of 0 through the full form round trip", () => {
    const form = { ...abilityToForm({ name: "Rider", attack_kind: "cast", attack_range: 200, attack_cooldown: 2 }),
      damage_mult: 0 };
    expect(abilityFormToPayload(form, 0).damage_mult).toBe(0);
  });

  it("keeps a knockback of 0 and a real knockback both through the round trip", () => {
    const zero = { ...abilityToForm({ name: "A", attack_kind: "melee", attack_range: 60, attack_cooldown: 1 }),
      knockback: 0 };
    const real = { ...abilityToForm({ name: "B", attack_kind: "melee", attack_range: 60, attack_cooldown: 1 }),
      knockback: 140 };
    expect(abilityFormToPayload(zero, 0).knockback).toBe(0);
    expect(abilityFormToPayload(real, 0).knockback).toBe(140);
  });

  it("turns a blank element field into null, meaning 'inherit the type's element'", () => {
    const form = { ...abilityToForm({ name: "Z", attack_kind: "melee", attack_range: 60, attack_cooldown: 1 }),
      element: "" };
    expect(abilityFormToPayload(form, 0).element).toBe(null);
  });

  it("carries a real element through untouched", () => {
    const form = { ...abilityToForm({ name: "Z", attack_kind: "cast", attack_range: 60, attack_cooldown: 1 }),
      element: "fire" };
    expect(abilityFormToPayload(form, 0).element).toBe("fire");
  });

  it("coerces numeric text fields to numbers", () => {
    const form = { ...abilityToForm({ name: "Z", attack_kind: "melee", attack_range: 60, attack_cooldown: 1 }),
      attack_range: "72", attack_cooldown: "1.5" };
    const p = abilityFormToPayload(form, 0);
    expect(p.attack_range).toBe(72);
    expect(p.attack_cooldown).toBe(1.5);
  });

  it("exposes the same element set the backend enforces", () => {
    expect(ELEMENTS).toEqual(["physical", "fire", "ice", "lightning"]);
  });
});
