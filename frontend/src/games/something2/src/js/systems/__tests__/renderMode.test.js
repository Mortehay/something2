import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";

describe("RenderSystem.resolveRenderMode", () => {
  it("defaults to rect when nothing is set", () => {
    expect(RenderSystem.resolveRenderMode({})).toBe("rect");
  });

  it("uses the entity's render_mode (snake) or renderMode (camel)", () => {
    expect(RenderSystem.resolveRenderMode({ render_mode: "static" })).toBe("static");
    expect(RenderSystem.resolveRenderMode({ renderMode: "animated" })).toBe("animated");
  });

  it("lets the global override win over the entity mode", () => {
    expect(RenderSystem.resolveRenderMode({ render_mode: "animated" }, "rect")).toBe("rect");
  });
});

describe("RenderSystem.cycleRenderModeOverride", () => {
  it("cycles none -> rect -> static -> animated -> none", () => {
    const rs = Object.create(RenderSystem.prototype);
    rs.renderModeOverride = null;
    expect(rs.cycleRenderModeOverride()).toBe("rect");
    expect(rs.cycleRenderModeOverride()).toBe("static");
    expect(rs.cycleRenderModeOverride()).toBe("animated");
    expect(rs.cycleRenderModeOverride()).toBe(null);
  });
});
