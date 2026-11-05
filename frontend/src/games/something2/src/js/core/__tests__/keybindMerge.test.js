// Saved keybinds meet the default `trade: r` (SOMET-725). A player who saved
// pickup on R before the trade key existed must keep pickup on R; the trade key
// stays unbound for them until they assign one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../../net/WorldAuthorityClient.js", () => ({
  WorldAuthorityClient: class { connect() {} disconnect() {} },
}));

import { Game, DEFAULT_KEYBINDS, mergeKeybinds } from "../Game.js";
import { readKeybinds } from "../../../../GameSettings.jsx";

const KEY = "something2_keybinds";

describe("mergeKeybinds", () => {
  it("saved pickup on R leaves trade unbound", () => {
    const m = mergeKeybinds({ pickup: "r" });
    expect(m.pickup).toBe("r");
    expect(m.trade).toBe("");
  });

  it("a hotbar slot on R leaves trade unbound", () => {
    expect(mergeKeybinds({ slot3: "R" }).trade).toBe("");
  });

  it("no R conflict gets the default trade key", () => {
    expect(mergeKeybinds({ pickup: "x" }).trade).toBe("r");
    expect(mergeKeybinds(null).trade).toBe("r");
    expect(mergeKeybinds({}).trade).toBe("r");
  });

  it("a saved trade wins, even beside another R", () => {
    expect(mergeKeybinds({ pickup: "r", trade: "v" }).trade).toBe("v");
    expect(mergeKeybinds({ pickup: "r", trade: "r" }).trade).toBe("r");
    expect(mergeKeybinds({ trade: "" }).trade).toBe("");
  });

  it("the default binds themselves are untouched", () => {
    mergeKeybinds({ pickup: "r" });
    expect(DEFAULT_KEYBINDS.trade).toBe("r");
  });
});

describe("saved binds through both readers", () => {
  let store;
  beforeEach(() => {
    store = { [KEY]: JSON.stringify({ pickup: "r" }) };
    vi.stubGlobal("localStorage", {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Game._loadKeybinds keeps pickup on R and unbinds trade", () => {
    const b = Game.prototype._loadKeybinds.call({});
    expect(b.pickup).toBe("r");
    expect(b.trade).toBe("");
  });

  it("the Settings reader agrees", () => {
    const b = readKeybinds();
    expect(b.pickup).toBe("r");
    expect(b.trade).toBe("");
  });

  it("setKeybinds does not re-add the default trade key", () => {
    const g = Object.create(Game.prototype);
    g.setKeybinds({ pickup: "r" });
    expect(g.keybinds.trade).toBe("");
  });

  it("the Settings source calls the shared merge, not its own", () => {
    const src = readFileSync(new URL("../../../../GameSettings.jsx", import.meta.url), "utf8");
    expect(src).toMatch(/mergeKeybinds\(/);
    expect(src).not.toMatch(/\{ \.\.\.DEFAULT_KEYBINDS, \.\.\.JSON\.parse/);
  });
});
