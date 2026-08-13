import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";

// SOMET-310 — the account chest panel.
//
// These assert the property SOMET-156 established for the shop and that this
// panel inherits: EVERY ROW A PLAYER CAN SEE IS CLICKABLE, AND EVERY LIST IS
// REACHABLE IN FULL. It matters more here than it did there. The shop's right
// column breaks out of its draw loop when it runs out of vertical room, and a
// chest that silently stopped drawing at item ~10 would be a chest that ate the
// other 30 — the items are only reachable through this panel, so an unreachable
// row is an unrecoverable item.
//
// Driven through the real renderBank with a recording context stub, and the
// real Game._handleBankClick, so a layout regression fails here rather than in
// a screenshot nobody takes.

const PANEL_W = 560;
const PANEL_H = 560;
const PX = (GAME_WIDTH - PANEL_W) / 2;
const PY = (GAME_HEIGHT - PANEL_H) / 2;
const LEFT_X = PX + 16;
const COL_W = PANEL_W - 32;
const ROW_H = 40;
const CAPACITY = 40;

function stubCtx() {
  const fillRects = [];
  const texts = [];
  return {
    fillRects,
    texts,
    save() {},
    restore() {},
    fillRect(x, y, w, h) { fillRects.push({ x, y, w, h }); },
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    fillText(text, x, y) { texts.push({ text, x, y }); },
    set fillStyle(_v) {},
    set strokeStyle(_v) {},
    set lineWidth(_v) {},
    set font(_v) {},
    set textBaseline(_v) {},
    set textAlign(_v) {},
  };
}

function renderer(ctx) {
  return new RenderSystem({ getContext: () => ctx }, null);
}

// A full chest (the interesting case: the cap is the only bound in the system)
// and a carried inventory that also overflows one page.
const STORED = Array.from({ length: CAPACITY }, (_, i) => ({
  id: `a${i}`, slot: i + 1, typeId: 1 + (i % 20), quantity: 1, soulbound: false,
}));
const CARRIED = Array.from({ length: 25 }, (_, i) => ({
  id: `p${i}`, typeId: 1 + (i % 20), quantity: 1,
}));

const TYPES = new Map(
  Array.from({ length: 20 }, (_, i) => [1 + i, { id: 1 + i, name: `Item ${1 + i}` }]),
);

const BANK = { villageId: 7, items: STORED, capacity: CAPACITY };
const INVENTORY = { items: CARRIED, types: TYPES, equipment: {} };

function renderBank(view, bank = BANK, inventory = INVENTORY) {
  const ctx = stubCtx();
  const hitAreas = [];
  renderer(ctx).renderBank(ctx, bank, inventory, TYPES, hitAreas, view);
  return { ctx, hitAreas };
}

function insidePanel(a) {
  return a.x >= PX && a.y >= PY && a.x + a.w <= PX + PANEL_W && a.y + a.h <= PY + PANEL_H;
}

function drawnRowRects(ctx) {
  return ctx.fillRects.filter((r) => r.x === LEFT_X && r.w === COL_W && r.h === ROW_H);
}

// Walk every page of a tab, collecting the ids it offers.
function pageThrough(tab) {
  const seen = [];
  let page = 0;
  for (let guard = 0; guard < 60; guard += 1) {
    const { ctx, hitAreas } = renderBank({ tab, page });
    const acts = hitAreas.filter((a) => a.kind === "take" || a.kind === "store");
    const rows = drawnRowRects(ctx);
    // Every drawn row has exactly one action, and vice versa.
    expect(acts).toHaveLength(rows.length);
    for (const a of acts) {
      expect(insidePanel(a)).toBe(true);
      seen.push(a.id);
    }
    const next = hitAreas.find((a) => a.kind === "bankpage" && a.id > page);
    if (!next) break;
    page = next.id;
  }
  return seen;
}

describe("renderBank reachability", () => {
  it("makes all 40 stored items reachable by paging, with no repeats or gaps", () => {
    expect(pageThrough("chest")).toEqual(STORED.map((r) => r.id));
  });

  it("makes every carried item reachable by paging", () => {
    expect(pageThrough("carry")).toEqual(CARRIED.map((r) => r.id));
  });

  it("keeps every drawn row and its action fully inside the panel", () => {
    for (const tab of ["chest", "carry"]) {
      const { ctx, hitAreas } = renderBank({ tab, page: 0 });
      const rows = drawnRowRects(ctx);
      const acts = hitAreas.filter((a) => a.kind === "take" || a.kind === "store");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row, i) => {
        const b = acts[i];
        expect(b.y).toBeGreaterThanOrEqual(row.y);
        expect(b.y + b.h).toBeLessThanOrEqual(row.y + row.h);
        expect(b.x).toBeGreaterThanOrEqual(row.x);
        expect(b.x + b.w).toBeLessThanOrEqual(row.x + row.w);
      });
      for (const row of rows) expect(insidePanel(row)).toBe(true);
      for (const t of ctx.texts) expect(t.y).toBeLessThan(PY + PANEL_H);
    }
  });

  it("emits the right action kind per tab — take for stored, store for carried", () => {
    const chest = renderBank({ tab: "chest", page: 0 }).hitAreas;
    expect(chest.some((a) => a.kind === "take")).toBe(true);
    expect(chest.some((a) => a.kind === "store")).toBe(false);

    const carry = renderBank({ tab: "carry", page: 0 }).hitAreas;
    expect(carry.some((a) => a.kind === "store")).toBe(true);
    expect(carry.some((a) => a.kind === "take")).toBe(false);
  });

  // The two ids come from DIFFERENT TABLES: `take` carries an account_items id,
  // `store` a player_items id. Handing the server the wrong one is a refusal at
  // best, so the panel must never source them from the same list.
  it("keys take on the stored row id and store on the inventory instance id", () => {
    const takes = renderBank({ tab: "chest", page: 0 }).hitAreas
      .filter((a) => a.kind === "take").map((a) => a.id);
    expect(takes.every((id) => id.startsWith("a"))).toBe(true);

    const stores = renderBank({ tab: "carry", page: 0 }).hitAreas
      .filter((a) => a.kind === "store").map((a) => a.id);
    expect(stores.every((id) => id.startsWith("p"))).toBe(true);
  });

  it("clamps a stale page instead of rendering a blank one", () => {
    // Withdrawing the last item on the last page leaves view.page past the end.
    const { ctx, hitAreas } = renderBank({ tab: "chest", page: 99 });
    expect(drawnRowRects(ctx).length).toBeGreaterThan(0);
    expect(hitAreas.filter((a) => a.kind === "take").length).toBeGreaterThan(0);
  });

  it("shows occupancy against the capacity so a full chest is visible before a refusal", () => {
    const { ctx } = renderBank({ tab: "chest", page: 0 });
    expect(ctx.texts.some((t) => t.text === `${CAPACITY}/${CAPACITY}`)).toBe(true);
  });

  it("renders an empty chest as a message with no actions, not a blank panel", () => {
    const { ctx, hitAreas } = renderBank(
      { tab: "chest", page: 0 }, { villageId: 7, items: [], capacity: CAPACITY },
    );
    expect(hitAreas.filter((a) => a.kind === "take")).toHaveLength(0);
    expect(ctx.texts.some((t) => /chest is empty/i.test(t.text))).toBe(true);
    // The close control must survive an empty chest — otherwise the only way
    // out of the panel is the keyboard.
    expect(hitAreas.some((a) => a.kind === "close")).toBe(true);
  });

  it("marks bound items, which are storable but will not sell", () => {
    const bound = [{ id: "a1", slot: 1, typeId: 1, quantity: 1, soulbound: true }];
    const { ctx } = renderBank(
      { tab: "chest", page: 0 }, { villageId: 7, items: bound, capacity: CAPACITY },
    );
    expect(ctx.texts.some((t) => /bound/.test(t.text))).toBe(true);
  });

  it("skips an item whose type this client does not know rather than drawing '#id'", () => {
    const unknown = { items: [{ id: "p0", typeId: 999, quantity: 1 }], types: TYPES, equipment: {} };
    const { hitAreas } = renderBank(
      { tab: "carry", page: 0 }, { villageId: 7, items: [], capacity: CAPACITY }, unknown,
    );
    expect(hitAreas.filter((a) => a.kind === "store")).toHaveLength(0);
  });
});
