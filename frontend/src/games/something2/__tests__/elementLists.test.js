import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ELEMENTS } from "../abilityForm.js";
import { ENTITY_ELEMENTS, MAX_HITBOX_PX } from "../bossFields.js";

// SOMET-603: the frontend element list is a copy of the backend's. Pin it, so
// a new element cannot be accepted by one side and rejected by the other.
const require = createRequire(import.meta.url);
const backendRoot = path.resolve(__dirname, "../../../../../backend/src");

describe("element lists stay in step with the backend", () => {
  it("abilityForm ELEMENTS equals creatureBehaviors ELEMENTS", () => {
    const { ELEMENTS: backend } = require(path.join(backendRoot, "services/creatureBehaviors.js"));
    expect([...ELEMENTS]).toEqual([...backend]);
  });

  it("the entity editor uses that same single list", () => {
    expect(ENTITY_ELEMENTS).toBe(ELEMENTS);
  });

  it("hitbox ceiling equals MAX_ENTITY_DISPLAY_PX in index.js", () => {
    const src = readFileSync(path.join(backendRoot, "index.js"), "utf8");
    const m = src.match(/const MAX_ENTITY_DISPLAY_PX\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(MAX_HITBOX_PX).toBe(Number(m[1]));
  });
});
