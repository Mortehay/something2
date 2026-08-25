// SOMET-493 — the inspect card's three pure stages.
//
// These are written against the SHIPPED anchor math rather than against
// hand-copied numbers: every expected rect is derived from worldToScreen and
// the drawEntity/drawCreature rules, so if that anchor moves (as it did in
// SOMET-319, half a tile) these fail instead of silently agreeing with a
// stale constant. That is the failure shape memory records for this repo —
// fixtures pinned to constants the code no longer uses.
import { describe, it, expect } from "vitest";
import { worldToScreen } from "../../core/iso.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";
import {
  canvasToCameraPoint, entityScreenRect, actorScreenRect, markerScreenRect,
  drawableScreenRect, pickDrawable, targetKey, aggressionOf, describeTarget,
  layoutCard, wrapText, estimateTextWidth, AGGRESSION_TIERS, CARD, displayName,
} from "../inspect.js";

const camera = { screenX: 1000, screenY: 500, width: GAME_WIDTH, height: GAME_HEIGHT };

// The centre of a drawable's own painted rect, expressed as the canvas pixel a
// player would have to put the cursor on. Inverts canvasToCameraPoint.
function cursorOver(d) {
  const r = drawableScreenRect(d);
  const offX = Math.floor(GAME_WIDTH / 2 - camera.screenX);
  const offY = Math.floor(GAME_HEIGHT / 2 - camera.screenY);
  return { x: r.x + r.w / 2 + offX, y: r.y + r.h / 2 + offY };
}

const creature = (over = {}) => ({
  kind: "entity",
  ref: {
    id: "c1", type: "Beast Brute", x: 1200, y: 800,
    width: 48, height: 48, hp: 30, maxHp: 48, level: 7, ...over,
  },
});

describe("canvasToCameraPoint", () => {
  it("inverts Camera.apply, floor included", () => {
    // Camera.apply translates by floor(GAME_WIDTH/2 - screenX); a hit-test
    // that skipped the floor would be up to a pixel off what was painted.
    const p = canvasToCameraPoint(0, 0, { screenX: 100.7, screenY: 50.7 });
    expect(p.x).toBe(-Math.floor(GAME_WIDTH / 2 - 100.7));
    expect(p.y).toBe(-Math.floor(GAME_HEIGHT / 2 - 50.7));
  });
});

describe("screen rects match what the renderer paints", () => {
  it("entityScreenRect stands the sprite's feet on the projected box centre", () => {
    const e = { x: 500, y: 300, width: 100, height: 100, displayWidth: 64, displayHeight: 80 };
    const s = worldToScreen(e.x + 50, e.y + 50);
    expect(entityScreenRect(e)).toEqual({ x: s.x - 32, y: s.y - 80, w: 64, h: 80 });
  });

  it("entityScreenRect falls back to 40px like drawEntity does", () => {
    const s = worldToScreen(500 + 20, 300 + 20);
    expect(entityScreenRect({ x: 500, y: 300 })).toEqual({ x: s.x - 20, y: s.y - 40, w: 40, h: 40 });
  });

  it("actorScreenRect uses drawCreature's 64px fallback, not drawEntity's 40", () => {
    const s = worldToScreen(500 + 32, 300 + 32);
    expect(actorScreenRect({ x: 500, y: 300 })).toEqual({ x: s.x - 32, y: s.y - 64, w: 64, h: 64 });
  });

  it("markerScreenRect centres on the projected point", () => {
    const s = worldToScreen(700, 700);
    expect(markerScreenRect({ x: 700, y: 700 }, 9)).toEqual({ x: s.x - 9, y: s.y - 9, w: 18, h: 18 });
  });

  it("declines to describe terrain", () => {
    // Walls are in the same drawables list and must not pop a card over the
    // creature standing in front of them.
    expect(drawableScreenRect({ kind: "wall", ref: { x: 0, y: 0 } })).toBeNull();
  });
});

describe("pickDrawable", () => {
  it("finds the drawable under the cursor", () => {
    const c = creature();
    const point = canvasToCameraPoint(cursorOver(c).x, cursorOver(c).y, camera);
    expect(pickDrawable([c], point)).toBe(c);
  });

  it("returns null for empty ground", () => {
    const c = creature();
    expect(pickDrawable([c], { x: -9999, y: -9999 })).toBeNull();
  });

  it("returns the LAST drawable when two overlap — the one actually on top", () => {
    // renderChunked hands over its already-sorted, already-drawn list, so the
    // topmost thing is the last element. Picking the first would name whatever
    // is buried behind the sprite the player is pointing at.
    const back = creature({ id: "back" });
    const front = creature({ id: "front" });
    const point = canvasToCameraPoint(cursorOver(front).x, cursorOver(front).y, camera);
    expect(pickDrawable([back, front], point).ref.id).toBe("front");
  });

  it("skips kinds with no rect instead of throwing", () => {
    const c = creature();
    const point = canvasToCameraPoint(cursorOver(c).x, cursorOver(c).y, camera);
    expect(pickDrawable([c, { kind: "wall", ref: { x: 1200, y: 800 } }], point)).toBe(c);
  });
});

describe("targetKey", () => {
  it("uses the entity id when there is one", () => {
    expect(targetKey(creature())).toBe("entity:c1");
  });
  it("uses the user id for a remote player", () => {
    expect(targetKey({ kind: "remote", userId: 42, ref: { x: 1, y: 2 } })).toBe("remote:42");
  });
  it("falls back to position for the id-less kinds", () => {
    // Decorations and village posts have no id. Their position is fixed, so
    // it is a stable key for exactly the things that need this branch.
    expect(targetKey({ kind: "decoration", ref: { x: 100.4, y: 200.6 } })).toBe("decoration:100,201");
  });
});

describe("aggressionOf", () => {
  // The shipped catalog rows, so a tier that stops distinguishing them fails.
  const of = (o) => aggressionOf(o).label;

  it("reads a skittish creature as passive even at a wide aggro radius", () => {
    expect(of({ faction: "hostile", chaseStyle: "skittish", aggroRadius: 300 })).toBe("Passive");
  });

  it("reads a guard as defensive, by faction or by chase style", () => {
    expect(of({ faction: "guard", chaseStyle: "guard", aggroRadius: 400 })).toBe("Defensive");
    expect(of({ faction: "hostile", chaseStyle: "hold", aggroRadius: 400 })).toBe("Defensive");
  });

  it("reads an ambusher as wary", () => {
    expect(of({ faction: "hostile", chaseStyle: "ambush", aggroRadius: 180 })).toBe("Wary");
  });

  it("separates the charging rungs by aggro radius", () => {
    expect(of({ faction: "hostile", chaseStyle: "charge", aggroRadius: 300 })).toBe("Wary");
    expect(of({ faction: "hostile", chaseStyle: "charge", aggroRadius: 380 })).toBe("Aggressive");
    expect(of({ faction: "hostile", chaseStyle: "kite", aggroRadius: 460 })).toBe("Aggressive");
    expect(of({ faction: "hostile", chaseStyle: "charge", aggroRadius: 600 })).toBe("Ferocious");
  });

  it("still rates a type with no behaviour row at all", () => {
    // entity_types.behavior_id is nullable and several seeded types have none.
    // "unknown" is not something worth putting on a badge.
    expect(of({ faction: "hostile" })).toBe("Aggressive");
    expect(aggressionOf(null)).toBeNull();
  });

  it("orders the tiers least to most dangerous", () => {
    expect(AGGRESSION_TIERS.map((t) => t.tier)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("displayName", () => {
  it("turns a snake_case decoration key into something readable", () => {
    // The decoration rows really are authored this way (pine_tree, rose_bush,
    // dead_tree); showing the raw key made the card read like a database dump.
    expect(displayName("pine_tree")).toBe("Pine tree");
    expect(displayName("rose_bush")).toBe("Rose bush");
  });

  it("leaves a name that already reads as one alone", () => {
    expect(displayName("Beast Brute")).toBe("Beast Brute");
    expect(displayName("IceRock")).toBe("IceRock");
  });

  it("survives an absent name", () => {
    expect(displayName(null)).toBe("");
    expect(displayName("")).toBe("");
  });
});

describe("describeTarget", () => {
  const entityDefs = {
    "Beast Brute": {
      prompt: "a hulking beast creature", mana: 0, maxMana: 0,
      faction: "hostile", chaseStyle: "charge", aggroRadius: 380,
    },
    Tree: { prompt: "a tall pine tree", isCreature: false },
  };

  it("describes a creature with name, level, live HP and its aggression", () => {
    const d = describeTarget(creature(), { entityDefs });
    expect(d.kind).toBe("creature");
    expect(d.title).toBe("Beast Brute");
    expect(d.subtitle).toBe("Level 7 creature");
    expect(d.description).toBe("a hulking beast creature");
    expect(d.hp).toEqual({ cur: 30, max: 48 });
    expect(d.aggression.label).toBe("Aggressive");
  });

  it("gives a creature an MP row from the catalog, empty rather than faked", () => {
    // CreatureSim tracks no mana today; every entity_types row ships 0/0. The
    // row must exist (the player asked for HP over MP) and must read empty
    // rather than being invented as full.
    const d = describeTarget(creature(), { entityDefs });
    expect(d.mp).toEqual({ cur: 0, max: 0 });
    const withPool = describeTarget(creature(), {
      entityDefs: { "Beast Brute": { ...entityDefs["Beast Brute"], mana: 12, maxMana: 30 } },
    });
    expect(withPool.mp).toEqual({ cur: 12, max: 30 });
  });

  it("calls a guard a guard when its description column is empty", () => {
    // entity_types.prompt is NOT NULL DEFAULT '' and Village Guard ships
    // empty. A flat "a hostile creature" fallback would be an outright lie
    // about the one creature in the game that does not attack on sight.
    const d = describeTarget(
      { kind: "entity", ref: { id: "g", type: "Village Guard", x: 0, y: 0, level: 3, hp: 5, maxHp: 5 } },
      { entityDefs: { "Village Guard": { prompt: "", faction: "guard", chaseStyle: "guard", aggroRadius: 400 } } },
    );
    expect(d.subtitle).toBe("Level 3 guard");
    expect(d.description).toMatch(/guard/i);
    expect(d.description).not.toMatch(/hostile/i);
    expect(d.aggression.label).toBe("Defensive");
  });

  it("still describes a creature whose type definition has not loaded", () => {
    // entityDefs arrives from an async fetch. A card that vanishes until it
    // lands reads as a broken toggle.
    const d = describeTarget(creature(), { entityDefs: null });
    expect(d.title).toBe("Beast Brute");
    expect(d.hp).toEqual({ cur: 30, max: 48 });
    expect(d.aggression).toBeNull();
  });

  it("names a decoration from the drawable, since the type map is keyed by name", () => {
    const d = describeTarget(
      { kind: "decoration", ref: { name: "Tree", x: 0, y: 0, walkable: false } },
      { entityDefs },
    );
    expect(d.title).toBe("Tree");
    expect(d.description).toBe("a tall pine tree");
    expect(d.subtitle).toMatch(/blocks movement/);
    expect(d.hp).toBeNull();
  });

  it("names a ground item from the join frame's item types", () => {
    const itemTypes = new Map([[7, { id: 7, name: "Iron Sword", category: "weapon", kind: "melee", damage: 12 }]]);
    const d = describeTarget({ kind: "grounditem", ref: { id: "g", typeId: 7, x: 0, y: 0 } }, { itemTypes });
    expect(d.title).toBe("Iron Sword");
    expect(d.subtitle).toBe("Weapon");
    expect(d.description).toContain("12 damage");
  });

  it("gives the local player an MP row and a remote player none", () => {
    // The world-state frame carries hp/maxHp for remote players and nothing
    // else, so a mana bar for them would be an invention.
    const mine = describeTarget(
      { kind: "player", ref: { x: 0, y: 0, hp: 40, maxHp: 60 } },
      { localPlayer: { mana: 10, maxMana: 50 } },
    );
    expect(mine.mp).toEqual({ cur: 10, max: 50 });
    const theirs = describeTarget({ kind: "remote", userId: 9, ref: { x: 0, y: 0, hp: 1, maxHp: 2 } }, {});
    expect(theirs.mp).toBeNull();
  });

  it("returns null for a kind it has nothing to say about", () => {
    expect(describeTarget({ kind: "wall", ref: { x: 0, y: 0 } }, {})).toBeNull();
    expect(describeTarget(null, {})).toBeNull();
  });
});

describe("wrapText", () => {
  it("wraps to the pixel width", () => {
    const lines = wrapText("one two three four five six seven eight", 10, 60, 3);
    for (const l of lines) expect(estimateTextWidth(l, 10)).toBeLessThanOrEqual(60);
  });

  it("caps at maxLines and marks the truncation", () => {
    // Uncapped, a long generated sprite prompt would change the card's height
    // and make it jump around the screen.
    const lines = wrapText("aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp", 10, 40, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
  });

  it("handles empty input without producing a blank line", () => {
    expect(wrapText("", 10, 100)).toEqual([]);
    expect(wrapText(null, 10, 100)).toEqual([]);
  });
});

describe("layoutCard", () => {
  const desc = {
    kind: "creature", title: "Beast Brute", subtitle: "Level 7 creature",
    description: "a hulking beast creature",
    hp: { cur: 30, max: 48 }, mp: { cur: 0, max: 0 },
    aggression: AGGRESSION_TIERS[3],
  };

  it("puts HP on the upper line and MP on the lower one", () => {
    const l = layoutCard(desc, 100, 100);
    expect(l.bars.map((b) => b.label)).toEqual(["HP", "MP"]);
    expect(l.bars[0].y).toBeLessThan(l.bars[1].y);
  });

  it("fills the HP bar to the live fraction and leaves an empty pool empty", () => {
    const l = layoutCard(desc, 100, 100);
    expect(l.bars[0].pct).toBeCloseTo(30 / 48);
    expect(l.bars[0].text).toBe("30/48");
    expect(l.bars[1].pct).toBe(0);
    expect(l.bars[1].text).toBe("0/0");
  });

  it("clamps a bar that would overfill or underfill", () => {
    // hp can briefly exceed maxHp across a heal frame, and a >100% fill would
    // paint outside the card's border.
    const over = layoutCard({ ...desc, hp: { cur: 99, max: 48 } }, 100, 100);
    expect(over.bars[0].pct).toBe(1);
    const under = layoutCard({ ...desc, hp: { cur: -5, max: 48 } }, 100, 100);
    expect(under.bars[0].pct).toBe(0);
  });

  it("puts the aggression badge in the top-right corner and shortens the title for it", () => {
    const withBadge = layoutCard(desc, 100, 100);
    const without = layoutCard({ ...desc, aggression: null }, 100, 100);
    expect(withBadge.badge.text).toBe("Aggressive");
    expect(withBadge.badge.y).toBe(CARD.padY);           // top
    expect(withBadge.titleMaxW).toBeLessThan(without.titleMaxW); // ...right
    expect(without.badge).toBeNull();
  });

  it("keeps the card on screen at every corner", () => {
    // The first thing anyone hits is a card running off the right edge, so it
    // is covered by a test rather than by looking at it once.
    for (const [cx, cy] of [[0, 0], [GAME_WIDTH, 0], [0, GAME_HEIGHT], [GAME_WIDTH, GAME_HEIGHT]]) {
      const l = layoutCard(desc, cx, cy);
      expect(l.box.x).toBeGreaterThanOrEqual(0);
      expect(l.box.y).toBeGreaterThanOrEqual(0);
      expect(l.box.x + l.box.w).toBeLessThanOrEqual(GAME_WIDTH);
      expect(l.box.y + l.box.h).toBeLessThanOrEqual(GAME_HEIGHT);
    }
  });

  it("does not overlap the cursor it is anchored to", () => {
    const l = layoutCard(desc, 400, 300);
    expect(l.box.x).toBeGreaterThan(400);
  });

  it("shrinks for a target with no bars and no badge", () => {
    const bare = layoutCard(
      { kind: "merchant", title: "Merchant", subtitle: "Village trader", description: "Press E.", hp: null, mp: null, aggression: null },
      100, 100,
    );
    expect(bare.bars).toEqual([]);
    expect(bare.box.h).toBeLessThan(layoutCard(desc, 100, 100).box.h);
  });

  it("returns null for no descriptor", () => {
    expect(layoutCard(null, 0, 0)).toBeNull();
  });
});
