import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";

// The authority's creature snapshot carries simulation state only (position,
// hp, facing, colour) — no visuals. Without the entity-type decoration below,
// every creature renders as a flat colored box no matter what sprite an admin
// generated and approved for its type.

const ENTITY_TYPES = {
  Wolf: {
    render_mode: "animated",
    image: "sprites/objects/Wolf/static.png",
    sprite: { atlas_key: "sprites/objects/Wolf/atlas.png" },
    display_width: 72,
    display_height: 96,
  },
};

const snapshot = [{ id: "c1", type: "Wolf", x: 10, y: 20, facing: "S", hp: 5, maxHp: 12, mode: "idle", color: "#888" }];

describe("CreatureManager entity-type visuals", () => {
  it("copies render_mode, image and sprite from the creature's type", () => {
    const cm = new CreatureManager(ENTITY_TYPES);
    cm.applySnapshot(snapshot);

    const c = cm.all()[0];
    expect(c.render_mode).toBe("animated");
    expect(c.image).toBe("sprites/objects/Wolf/static.png");
    expect(c.sprite.atlas_key).toBe("sprites/objects/Wolf/atlas.png");
    expect(c.displayWidth).toBe(72);
    expect(c.displayHeight).toBe(96);
  });

  it("shares the sprite descriptor by reference so a late manifest attach lights up", () => {
    // Game.preloadSprites sets `manifest` on the type's sprite object after the
    // atlas download finishes — often after creatures already exist. A copy
    // here would leave those creatures permanently manifest-less.
    const types = JSON.parse(JSON.stringify(ENTITY_TYPES));
    const cm = new CreatureManager(types);
    cm.applySnapshot(snapshot);

    types.Wolf.sprite.manifest = { cell: [8, 8], frames: { 0: [0, 0, 8, 8] } };

    expect(cm.all()[0].sprite.manifest).toEqual({ cell: [8, 8], frames: { 0: [0, 0, 8, 8] } });
  });

  it("leaves creatures untouched when no entity types are supplied", () => {
    const cm = new CreatureManager();
    cm.applySnapshot(snapshot);

    const c = cm.all()[0];
    expect(c.render_mode).toBeUndefined();
    expect(c.sprite).toBeUndefined();
    expect(c.color).toBe("#888");
  });

  it("leaves a creature whose type is unknown as a colored box", () => {
    const cm = new CreatureManager(ENTITY_TYPES);
    cm.applySnapshot([{ ...snapshot[0], type: "Griffin" }]);

    expect(cm.all()[0].sprite).toBeUndefined();
  });

  it("does not clobber the AI `mode` field with the render mode", () => {
    const cm = new CreatureManager(ENTITY_TYPES);
    cm.applySnapshot(snapshot);

    expect(cm.all()[0].mode).toBe("idle");
  });
});
