// SOMET-493 — the RenderSystem half of the inspect card: the gating rules
// (is it on? is a panel covering the world?), hover-vs-pin resolution, and the
// fact that the painter actually puts something on the canvas.
//
// The last one exists because of SOMET-488, where a HUD layer silently drew
// nothing while 1134 tests stayed green: "the layout was computed" is not the
// same claim as "pixels were written".
import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";
import { canvasToCameraPoint, drawableScreenRect } from "../inspect.js";
import { worldToScreen } from "../../core/iso.js";

function stubCtx() {
  const texts = [];
  const rects = [];
  return {
    texts, rects,
    save() {}, restore() {}, translate() {}, clip() {},
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {},
    rect(x, y, w, h) { rects.push({ x, y, w, h, kind: "path" }); },
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, kind: "fill", style: this._fillStyle }); },
    strokeRect() {}, fill() {}, stroke() {},
    fillText(text, x, y) { texts.push({ text, x, y }); },
    set fillStyle(v) { this._fillStyle = v; },
    get fillStyle() { return this._fillStyle; },
    set strokeStyle(_v) {}, set lineWidth(_v) {}, set font(_v) {},
    set textBaseline(_v) {}, set textAlign(_v) {}, set globalAlpha(_v) {},
  };
}

const CREATURE = {
  kind: "entity",
  ref: {
    id: "c1", type: "Beast Brute", x: 1200, y: 800,
    width: 48, height: 48, hp: 30, maxHp: 48, level: 7,
  },
};

// The camera LOOKS AT the creature, exactly as Camera.update points it at the
// player. Hand-picking screenX/screenY instead put the creature 768px outside
// a 1280-wide viewport, where layoutCard's off-screen clamp pins every card to
// the same edge and the anchoring assertions below could not fail.
const look = worldToScreen(CREATURE.ref.x + 24, CREATURE.ref.y + 24);
const camera = { screenX: look.x, screenY: look.y, width: GAME_WIDTH, height: GAME_HEIGHT };

const ENTITY_DEFS = {
  "Beast Brute": {
    prompt: "a hulking beast creature", mana: 0, maxMana: 0,
    faction: "hostile", chaseStyle: "charge", aggroRadius: 380,
  },
};

// Canvas pixel that lands on the middle of a drawable's painted rect.
function cursorOver(d) {
  const r = drawableScreenRect(d);
  const off = canvasToCameraPoint(0, 0, camera);
  return { x: r.x + r.w / 2 - off.x, y: r.y + r.h / 2 - off.y };
}

function resolve(inspect, drawables = [CREATURE], panelOpen = false) {
  const rs = new RenderSystem({ getContext: () => stubCtx() }, null);
  rs._resolveInspect(inspect, drawables, panelOpen);
  return rs;
}

const ON = (over = {}) => {
  const c = cursorOver(CREATURE);
  return {
    enabled: true, camera, cursorX: c.x, cursorY: c.y,
    pinnedKey: null, entityDefs: ENTITY_DEFS, itemTypes: null, localPlayer: null,
    ...over,
  };
};

describe("_resolveInspect gating", () => {
  it("produces a card for the drawable under the cursor when enabled", () => {
    const rs = resolve(ON());
    expect(rs._inspectHoverKey).toBe("entity:c1");
    expect(rs._inspectTarget).toBe(CREATURE);
    expect(rs._inspectLayout).not.toBeNull();
  });

  it("does nothing at all when the setting is off", () => {
    // Including the hover key: a player who never turned this on must not be
    // able to pin anything by clicking.
    const rs = resolve(ON({ enabled: false }));
    expect(rs._inspectHoverKey).toBeNull();
    expect(rs._inspectLayout).toBeNull();
  });

  it("does nothing while a full-screen panel is open", () => {
    // The cursor is being used on the panel's own rows; hit-testing the world
    // hidden behind it would let a click pin something invisible.
    const rs = resolve(ON(), [CREATURE], true);
    expect(rs._inspectHoverKey).toBeNull();
    expect(rs._inspectLayout).toBeNull();
  });

  it("does nothing before the first mousemove has given us a cursor", () => {
    const rs = resolve(ON({ cursorX: null, cursorY: null }));
    expect(rs._inspectLayout).toBeNull();
  });

  it("clears the card when the cursor moves to empty ground", () => {
    const rs = resolve(ON({ cursorX: 5, cursorY: 5 }));
    expect(rs._inspectHoverKey).toBeNull();
    expect(rs._inspectLayout).toBeNull();
  });
});

describe("_resolveInspect pinning", () => {
  it("keeps showing a pinned target after the cursor leaves it", () => {
    const rs = resolve(ON({ cursorX: 5, cursorY: 5, pinnedKey: "entity:c1" }));
    expect(rs._inspectHoverKey).toBeNull();     // not hovering it any more
    expect(rs._inspectTarget).toBe(CREATURE);   // still described
  });

  it("drops a pinned target that has left the world", () => {
    // CreatureManager DELETES a creature that leaves the neighbourhood. The
    // pin is re-found by key every frame precisely so the card goes with it,
    // rather than freezing on a stale object reference.
    const rs = resolve(ON({ cursorX: 5, cursorY: 5, pinnedKey: "entity:gone" }));
    expect(rs._inspectTarget).toBeNull();
    expect(rs._inspectLayout).toBeNull();
  });

  it("lets a fresh hover win over an older pin", () => {
    const other = { ...CREATURE, ref: { ...CREATURE.ref, id: "c2" } };
    const rs = resolve(ON({ pinnedKey: "entity:other" }), [other]);
    expect(rs._inspectTarget.ref.id).toBe("c2");
  });

  it("anchors a pinned card on the target, not on the far-away cursor", () => {
    // A pinned card that stayed glued to the pointer would trail across the
    // screen attached to nothing.
    const cornerCursor = { cursorX: 5, cursorY: 5 };
    const unpinnedElsewhere = resolve(ON({ ...cornerCursor, pinnedKey: null }));
    expect(unpinnedElsewhere._inspectLayout).toBeNull();

    const pinned = resolve(ON({ ...cornerCursor, pinnedKey: "entity:c1" }))._inspectLayout;
    const hovered = resolve(ON())._inspectLayout;
    // Anchored on the creature, which is mid-screen -- not in the corner the
    // cursor is sitting in.
    expect(pinned.box.x).toBeGreaterThan(GAME_WIDTH / 4);
    // ...and on the creature's TOP edge rather than the cursor's position on
    // its body, so the two anchors are genuinely different points.
    expect(pinned.box.y).not.toBe(hovered.box.y);
  });
});

describe("drawInspectCard", () => {
  function painted() {
    const ctx = stubCtx();
    const rs = new RenderSystem({ getContext: () => ctx }, null);
    rs._resolveInspect(ON(), [CREATURE], false);
    rs.drawInspectCard(rs._inspectLayout);
    return ctx;
  }

  it("writes the creature's name, level, description and both bar labels", () => {
    const t = painted().texts.map((x) => x.text);
    expect(t).toContain("Beast Brute");
    expect(t).toContain("Level 7 creature");
    expect(t).toContain("HP");
    expect(t).toContain("MP");
    expect(t).toContain("30/48");
    expect(t.join(" ")).toContain("hulking");
  });

  it("writes the aggression label", () => {
    expect(painted().texts.map((x) => x.text)).toContain("Aggressive");
  });

  it("fills a panel background and an HP bar of non-zero width", () => {
    // The "did it actually paint" check. A layout that resolves but writes no
    // rects is exactly the shape of the SOMET-488 defect.
    const fills = painted().rects.filter((r) => r.kind === "fill" && r.w > 0 && r.h > 0);
    expect(fills.length).toBeGreaterThan(3);
  });
});
