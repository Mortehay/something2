import { describe, it, expect, afterEach } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { Game } from "../../core/Game.js";
import {
  layoutChestWindow, layoutMerchantWindow, drawItemWindow, drawPairedOverlay, priceLabel,
  WINDOW_X, WINDOW_Y, INVENTORY_X,
} from "../storageWindows.js";
import { layoutInventory, drawInventory, drawItemCell, formatItemTooltipLines } from "../inventoryPanel.js";
import { setLang } from "../../i18n/i18n.js";
import { UK } from "../../i18n/uk/index.js";
import { bannerText } from "../shopReputation.js";
import { RARITY_COLORS } from "../../core/rarityColors.js";

const NativeMap = globalThis.Map;
const TYPES = new NativeMap([
  [1, { id: 1, name: "Iron Helm", category: "armor", defense: 3 }],
  [2, { id: 2, name: "Iron Sword", category: "weapon", damage: 5, cooldown: 1 }],
  [3, { id: 3, name: "Steel Sword", category: "weapon", damage: 9, cooldown: 1 }],
]);

// Recording context: every fillText / strokeRect keeps the style, alpha and
// sequence number in force at that call, so ordering and colour are assertable.
function stubCtx() {
  const ops = [];
  let fillStyle = null, strokeStyle = null, alpha = 1, font = null;
  const ctx = {
    ops,
    save() {}, restore() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, arc() {}, ellipse() {}, clip() {}, rect() {}, translate() {}, scale() {}, rotate() {}, setTransform() {}, createRadialGradient() { return { addColorStop() {} }; }, createLinearGradient() { return { addColorStop() {} }; },
    fillRect(x, y, w, h) { ops.push({ op: "fillRect", x, y, w, h, fillStyle, alpha }); },
    strokeRect(x, y, w, h) { ops.push({ op: "strokeRect", x, y, w, h, strokeStyle, alpha }); },
    fillText(text, x, y) { ops.push({ op: "text", text: String(text), x, y, fillStyle, alpha, font }); },
    measureText(s) { return { width: String(s).length * 6 }; },
    set fillStyle(v) { fillStyle = v; }, get fillStyle() { return fillStyle; },
    set strokeStyle(v) { strokeStyle = v; }, get strokeStyle() { return strokeStyle; },
    set globalAlpha(v) { alpha = v; }, get globalAlpha() { return alpha; },
    set font(v) { font = v; }, get font() { return font; },
    set lineWidth(_v) {}, set textBaseline(_v) {}, set textAlign(_v) {},
  };
  return ctx;
}
const texts = (ctx) => ctx.ops.filter((o) => o.op === "text");
const textIdx = (ctx, re) => ctx.ops.findIndex((o) => o.op === "text" && re.test(o.text));
const strokeAt = (ctx, cell) => ctx.ops.filter((o) => o.op === "strokeRect" && o.x === cell.x && o.y === cell.y && o.w === cell.w);

const ROLLED = { rarity: "yellow", itemLevel: 30, affixes: [] };
const stored = (over = {}) => ({ id: 1, slot: 1, typeId: 1, quantity: 1, soulbound: false, ...over });
const chestLayout = (items, capacity = 40) => layoutChestWindow({ bank: { items, capacity }, types: TYPES });
const merchantLayout = (shop, view = { tab: "catalog", page: 0 }, gold = 120) =>
  layoutMerchantWindow({ shop: { catalog: [], buyback: [], lockedCatalog: [], reputation: null, ...shop }, view, gold, types: TYPES });
const row = (id, over = {}) => ({ id, itemTypeId: 1, price: 40, quantity: 1, sellerUserId: null, ...over });

describe("window cells", () => {
  it("a merchant cell draws its price", () => {
    const l = merchantLayout({ catalog: [row(5, { price: 95 })] });
    const ctx = stubCtx();
    drawItemWindow(ctx, l, {}, null);
    expect(texts(ctx).some((o) => o.text === "95" && o.x >= l.cells[0].x && o.x < l.cells[0].x + 44)).toBe(true);
  });

  it("long prices are abbreviated so they fit a 44 px cell at 10 px monospace", () => {
    expect(priceLabel(9999)).toBe("9999");
    expect(priceLabel(10000)).toBe("10k");
    expect(priceLabel(125000)).toBe("125k");
    expect(priceLabel(1250000)).toBe("1.2M");
    for (const n of [0, 5, 9999, 10000, 99999, 999999, 12345678]) {
      expect(priceLabel(n).length * 10 * 0.6).toBeLessThanOrEqual(44);
    }
  });

  it("chest and buyback cells draw the rarity border, enchant level and bound marker the inventory cell draws", () => {
    const item = { ...ROLLED, enchantLevel: 4 };
    const chest = chestLayout([stored({ ...item, soulbound: true })]);
    const buy = merchantLayout({ buyback: [row(7, item)] }, { tab: "buyback", page: 0 });
    const inv = layoutInventory({ inventory: { items: [{ id: 9, typeId: 1, quantity: 1, ...item }], types: TYPES, equipment: {} }, gold: 0, tab: "all", page: 0 });
    const invCtx = stubCtx();
    drawInventory(invCtx, inv, {});
    const invStroke = strokeAt(invCtx, inv.cells[0])[0].strokeStyle;
    expect(invStroke).toBe(RARITY_COLORS.yellow);
    const invEnchant = texts(invCtx).find((o) => o.text === "+4");
    expect(invEnchant).toBeTruthy();

    for (const l of [chest, buy]) {
      const ctx = stubCtx();
      drawItemWindow(ctx, l, {}, null);
      expect(strokeAt(ctx, l.cells[0]).map((s) => s.strokeStyle)).toContain(invStroke);
      expect(strokeAt(ctx, l.cells[0]).some((s) => s.strokeStyle === "#caa24a")).toBe(false);
      const e = texts(ctx).find((o) => o.text === "+4");
      expect(e).toMatchObject({ fillStyle: invEnchant.fillStyle, font: invEnchant.font });
    }
  });

  it("one bound item draws the marker on the inventory, the chest and the buyback shelf; an unbound twin draws none", () => {
    const surfaces = (extra) => {
      const item = { ...ROLLED, ...extra };
      const inv = layoutInventory({ inventory: { items: [{ id: 9, typeId: 1, quantity: 1, ...item }], types: TYPES, equipment: {} }, gold: 0, tab: "all", page: 0 });
      const ic = stubCtx(); drawInventory(ic, inv, {});
      const ch = stubCtx(); drawItemWindow(ch, chestLayout([stored(item)]), {}, null);
      const bb = stubCtx(); drawItemWindow(bb, merchantLayout({ buyback: [row(7, item)] }, { tab: "buyback", page: 0 }), {}, null);
      return [ic, ch, bb].map((c) => texts(c).filter((o) => o.text === "bound"));
    };
    for (const marks of surfaces({ soulbound: true })) expect(marks).toHaveLength(1);
    for (const marks of surfaces({ soulbound: false })) expect(marks).toHaveLength(0);
  });

  describe("the worn and bound markers fit their cell", () => {
    afterEach(() => setLang("en"));
    const FONT_ADVANCE = 0.6; // monospace, the factor the price label's test measures with

    for (const lang of ["en", "uk"]) {
      it(`${lang}: both markers end inside a 44 px cell at the font they are drawn in`, () => {
        setLang(lang);
        const ctx = stubCtx();
        const cell = { x: 10, y: 20, w: 44, h: 44, item: { id: 1, typeId: 1, quantity: 1, soulbound: true }, type: TYPES.get(1), worn: true };
        drawItemCell(ctx, cell, null, {});
        const markers = texts(ctx).filter((o) => /^9px /.test(o.font));
        expect(markers).toHaveLength(2);
        for (const m of markers) {
          const end = m.x + m.text.length * 9 * FONT_ADVANCE;
          expect(end, `"${m.text}" runs past the cell`).toBeLessThanOrEqual(cell.x + cell.w);
        }
      });
    }

    for (const lang of ["en", "uk"]) {
      it(`${lang}: each marker has a dark backdrop, drawn first, sized to its text and inside the cell`, () => {
        setLang(lang);
        const ctx = stubCtx();
        const cell = { x: 10, y: 20, w: 44, h: 44, item: { id: 1, typeId: 1, quantity: 1, soulbound: true }, type: TYPES.get(1), worn: true };
        drawItemCell(ctx, cell, null, {});
        const markers = texts(ctx).filter((o) => /^9px /.test(o.font));
        expect(markers).toHaveLength(2);
        for (const m of markers) {
          const textAt = ctx.ops.indexOf(m);
          const before = ctx.ops[textAt - 1];
          const textW = ctx.measureText(m.text).width;
          expect(before.op).toBe("fillRect");
          expect(before.fillStyle).toMatch(/^rgba\(10,\s*10,\s*18/);
          expect(before.x).toBeLessThanOrEqual(m.x);
          expect(before.x + before.w).toBeGreaterThanOrEqual(m.x + textW);
          expect(before.w).toBeLessThanOrEqual(textW + 2); // sized to the text, not the cell
          expect(before.y).toBeLessThanOrEqual(m.y);
          expect(before.h).toBeGreaterThanOrEqual(9);
          expect(before.x).toBeGreaterThanOrEqual(cell.x);
          expect(before.x + before.w).toBeLessThanOrEqual(cell.x + cell.w);
        }
        // The second line's backdrop must not eat the first line's text.
        const [first, second] = markers;
        expect(ctx.ops[ctx.ops.indexOf(second) - 1].y).toBeGreaterThanOrEqual(first.y + 9);
      });
    }

    it("the Ukrainian tooltip keeps the full word", () => {
      setLang("uk");
      expect(UK.bound).toBe("прив.");
      const lines = formatItemTooltipLines({ id: 1, typeId: 1, soulbound: true }, TYPES.get(1));
      expect(lines.map((l) => l.text)).toContain(UK.Soulbound);
      expect(UK.Soulbound.length).toBeGreaterThan(UK.bound.length);
    });
  });

  it("a worn and bound cell stacks the two markers on separate lines", () => {
    const ctx = stubCtx();
    const cell = { x: 10, y: 20, w: 44, h: 44, item: { id: 1, typeId: 1, quantity: 1, soulbound: true }, type: TYPES.get(1), worn: true };
    drawItemCell(ctx, cell, null, {});
    const w = texts(ctx).find((o) => o.text === "worn");
    const b = texts(ctx).find((o) => o.text === "bound");
    expect(w.y).toBe(23);
    expect(b.y).toBe(32);
  });

  it("price strip never covers the +N or stack badge of a priced cell", () => {
    const l = merchantLayout({ buyback: [row(7, { enchantLevel: 4, quantity: 5, price: 60 })] }, { tab: "buyback", page: 0 });
    const ctx = stubCtx();
    drawItemWindow(ctx, l, {}, null);
    const c = l.cells[0];
    const inCell = (o) => o.x >= c.x && o.x < c.x + c.w && o.y >= c.y && o.y < c.y + c.h;
    const ench = ctx.ops.findIndex((o) => o.op === "text" && o.text === "+4");
    const qty = ctx.ops.findIndex((o) => o.op === "text" && o.text === "5");
    const price = ctx.ops.findIndex((o) => o.op === "text" && o.text === "60");
    expect(ench).toBeGreaterThan(-1);
    expect(qty).toBeGreaterThan(-1);
    expect(price).toBeGreaterThan(-1);
    for (const idx of [ench, qty]) {
      const badge = ctx.ops[idx];
      const bRect = { x: badge.x, y: badge.y, w: badge.text.length * 6, h: 10 };
      const strips = ctx.ops.slice(idx + 1).filter((o) => o.op === "fillRect" && inCell(o) && o.h < c.h);
      for (const r of strips) {
        const overlap = r.x < bRect.x + bRect.w && r.x + r.w > bRect.x && r.y < bRect.y + bRect.h && r.y + r.h > bRect.y;
        expect(overlap).toBe(false);
      }
    }
    expect(ctx.ops[price].y).not.toBe(ctx.ops[ench].y);
  });

  it("an ungraded buyback cell is outlined amber, a graded one keeps its rarity colour", () => {
    const l = merchantLayout({ buyback: [row(7)] }, { tab: "buyback", page: 0 });
    const ctx = stubCtx();
    drawItemWindow(ctx, l, {}, null);
    expect(strokeAt(ctx, l.cells[0]).pop().strokeStyle).toBe("#caa24a");
    const cat = merchantLayout({ catalog: [row(7)] });
    const c2 = stubCtx();
    drawItemWindow(c2, cat, {}, null);
    expect(strokeAt(c2, cat.cells[0]).some((s) => s.strokeStyle === "#caa24a")).toBe(false);
  });

  it("a locked cell is dimmed with a lock", () => {
    const l = merchantLayout({ catalog: [row(1)], lockedCatalog: [row(50, { minReputation: 5, requiredTier: "Honored" })] });
    const ctx = stubCtx();
    drawItemWindow(ctx, l, {}, null);
    const locked = l.cells[1];
    const open = l.cells[0];
    const bg = (c) => ctx.ops.find((o) => o.op === "fillRect" && o.x === c.x && o.y === c.y && o.w === c.w);
    expect(bg(locked).alpha).toBe(0.55);
    expect(bg(open).alpha).toBe(1);
    const lock = texts(ctx).filter((o) => o.text === "\u{1F512}");
    expect(lock).toHaveLength(1);
    expect(lock[0].x).toBeGreaterThanOrEqual(locked.x);
    expect(lock[0].x).toBeLessThan(locked.x + locked.w);
  });

  it("a cell dims while its own item is dragged out of the window", () => {
    const l = chestLayout([stored({ id: 11 }), stored({ id: 12, slot: 2 })]);
    const ctx = stubCtx();
    drawItemWindow(ctx, l, { drag: { from: { kind: "chestitem", id: 11 } } }, null);
    const bg = (c) => ctx.ops.find((o) => o.op === "fillRect" && o.x === c.x && o.y === c.y && o.w === c.w);
    expect(bg(l.cells[0]).alpha).toBe(0.3);
    expect(bg(l.cells[1]).alpha).toBe(1);
    // An inventory drag with the same id dims nothing in the window.
    const other = stubCtx();
    drawItemWindow(other, l, { drag: { from: { kind: "item", id: 11 } } }, null);
    expect(other.ops.find((o) => o.op === "fillRect" && o.x === l.cells[0].x && o.y === l.cells[0].y && o.w === 44).alpha).toBe(1);
  });
});

describe("window frame", () => {
  it("the chest title shows n/40 and turns amber when full", () => {
    const rows = Array.from({ length: 40 }, (_, i) => stored({ id: 100 + i, slot: i + 1 }));
    const full = stubCtx();
    drawItemWindow(full, chestLayout(rows), {}, null);
    const title = texts(full).find((o) => /Account Chest/.test(o.text));
    expect(title.text).toContain("40/40");
    expect(title.fillStyle).toBe("#caa24a");
    const some = stubCtx();
    drawItemWindow(some, chestLayout(rows.slice(0, 3)), {}, null);
    const t3 = texts(some).find((o) => /Account Chest/.test(o.text));
    expect(t3.text).toContain("3/40");
    expect(t3.fillStyle).toBe("#e5e7eb");
  });

  it("the merchant title shows gold, and the reputation banner shows when present", () => {
    const rep = { villageKey: "sunspire", points: 35, tier: "Friend", discountPct: 5, sellBonusPct: 5, nextTier: { name: "Honored", at: 100 } };
    const l = merchantLayout({ catalog: [row(1)], reputation: rep }, undefined, 777);
    const ctx = stubCtx();
    drawItemWindow(ctx, l, {}, null);
    expect(texts(ctx).some((o) => o.text.includes("777"))).toBe(true);
    const lines = texts(ctx).filter((o) => o.x === l.bannerPos.x && o.y >= l.bannerPos.y && o.y < l.bannerPos.y + 2 * l.bannerLineH);
    expect(lines.map((o) => o.text).join(" ")).toBe(bannerText(rep));
    expect(lines[0].y).toBe(l.bannerPos.y);
    const none = stubCtx();
    drawItemWindow(none, merchantLayout({ catalog: [row(1)] }), {}, null);
    expect(texts(none).some((o) => /rep\)/.test(o.text))).toBe(false);
  });

  it("empty states are drawn inside the grid area", () => {
    const cases = [
      [chestLayout([]), "Your chest is empty."],
      [merchantLayout({}), "Nothing for sale."],
      [merchantLayout({}, { tab: "buyback", page: 0 }), "No buyback stock."],
    ];
    for (const [l, msg] of cases) {
      const ctx = stubCtx();
      drawItemWindow(ctx, l, {}, null);
      const m = texts(ctx).find((o) => o.text === msg);
      expect(m).toBeTruthy();
      expect(m.x).toBeGreaterThanOrEqual(l.cells[0].x);
      expect(m.y).toBeGreaterThanOrEqual(l.cells[0].y);
      expect(m.y).toBeLessThan(l.cells[39].y + 44);
    }
    const filled = stubCtx();
    drawItemWindow(filled, chestLayout([stored()]), {}, null);
    expect(texts(filled).some((o) => /chest is empty/.test(o.text))).toBe(false);
  });

  it("draws the item icon when art exists for the type", () => {
    const icon = { naturalWidth: 256, naturalHeight: 256 };
    const images = [];
    const ctx = stubCtx();
    ctx.drawImage = (img) => images.push(img);
    const art = { icon: (kind, key) => (kind === "item" && Number(key) === 1 ? icon : null) };
    drawItemWindow(ctx, chestLayout([stored()]), {}, art);
    expect(images).toContain(icon);
    const none = stubCtx();
    const imgs2 = [];
    none.drawImage = (i) => imgs2.push(i);
    drawItemWindow(none, chestLayout([stored()]), {}, null);
    expect(imgs2).toHaveLength(0);
  });
});

describe("reputation banner", () => {
  const rep = { villageKey: "sunspire", points: 35, tier: "Friend", discountPct: 5, sellBonusPct: 5, nextTier: { name: "Honored", at: 100 } };
  const inWindow = (l, o, w) => o.x >= l.panel.x && o.x + w <= l.panel.x + l.panel.w;

  it("wraps so every drawn line fits inside the window, and the grid and arrows stay inside it", () => {
    const long = { ...rep, villageKey: "a-very-long-village-name-indeed", tier: "Дуже поважний друг", nextTier: { name: "Найвищий почесний статус", at: 100000 } };
    for (const r of [rep, long]) {
      const l = merchantLayout({ catalog: Array.from({ length: 61 }, (_, i) => row(i + 1)), reputation: r });
      const ctx = stubCtx();
      drawItemWindow(ctx, l, {}, null);
      const lines = texts(ctx).filter((o) => o.x === l.bannerPos.x && o.y >= l.bannerPos.y && o.y < l.bannerPos.y + 3 * l.bannerLineH);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const o of lines) expect(inWindow(l, o, o.text.length * 12 * 0.6)).toBe(true);
      const bottom = l.panel.y + l.panel.h;
      for (const c of l.cells) expect(c.y + c.h).toBeLessThanOrEqual(bottom);
      for (const a of [l.pages.prev, l.pages.next]) if (a) expect(a.y + a.h).toBeLessThanOrEqual(bottom);
      // The last banner line sits clear of the tab row.
      expect(l.bannerPos.y + 2 * l.bannerLineH).toBeLessThanOrEqual(l.tabs[0].y);
    }
  });
});

describe("overlay", () => {
  const win = merchantLayout({ catalog: [row(5, { price: 95 })] });
  const inv = layoutInventory({ inventory: { items: [], types: TYPES, equipment: {} }, gold: 0, tab: "all", page: 0, originX: INVENTORY_X, paired: true });
  const cell = win.cells[0];
  const hover = { x: cell.x + 10, y: cell.y + 10 };

  it("a window tooltip includes compare lines and a price line", () => {
    const sword = merchantLayout({ catalog: [row(6, { itemTypeId: 2, price: 30 })] });
    const c0 = sword.cells[0];
    const at = { x: c0.x + 5, y: c0.y + 5 };
    const equippedInv = layoutInventory({
      inventory: { items: [{ id: 77, typeId: 3, quantity: 1 }], types: TYPES, equipment: { main_hand: 77 }, capacity: 48 },
      gold: 0, tab: "all", page: 0, originX: INVENTORY_X, paired: true,
    });
    const ctx = stubCtx();
    drawPairedOverlay(ctx, { winLayout: sword, invLayout: equippedInv, hover: at }, null);
    const all = texts(ctx).map((o) => o.text);
    expect(all.some((x) => /Iron Sword/.test(x))).toBe(true);
    expect(all).toContain("30 g");
    // 5 vs the worn 9 damage: a comparison line exists only when a slot is worn.
    const bare = stubCtx();
    drawPairedOverlay(bare, { winLayout: sword, invLayout: inv, hover: at }, null);
    expect(all.some((x) => /-4/.test(x))).toBe(true);
    expect(texts(bare).some((o) => /-4/.test(o.text))).toBe(false);
  });

  it("a chest tooltip has no price line", () => {
    const c = chestLayout([stored()]);
    const ctx = stubCtx();
    drawPairedOverlay(ctx, { winLayout: c, invLayout: inv, hover: { x: c.cells[0].x + 5, y: c.cells[0].y + 5 } }, null);
    expect(texts(ctx).length).toBeGreaterThan(0);
    expect(texts(ctx).some((o) => / g$/.test(o.text))).toBe(false);
  });

  it("the tooltip suppresses during a drag", () => {
    const ctx = stubCtx();
    drawPairedOverlay(ctx, { winLayout: win, invLayout: inv, hover, drag: { armed: false, from: { kind: "stockitem", id: 5 } } }, null);
    expect(texts(ctx)).toHaveLength(0);
    expect(ctx.ops.filter((o) => o.op === "fillRect")).toHaveLength(0);
  });

  it("an armed window drag draws a ghost of drag.typeId, the hint and a green outline on drop.target", () => {
    const icon = { naturalWidth: 256, naturalHeight: 256 };
    const art = { icon: (kind, key) => (kind === "item" && Number(key) === 2 ? icon : null) };
    const images = [];
    const ctx = stubCtx();
    ctx.drawImage = (img) => images.push(img);
    const drag = { armed: true, x: 700, y: 300, typeId: 2, price: 95, from: { kind: "stockitem", id: 5 } };
    drawPairedOverlay(ctx, { winLayout: win, invLayout: inv, drag, hover, types: TYPES, drop: { action: "buy", id: 5, hint: "Buy for 95 g", target: "inventory" } }, art);
    expect(images).toContain(icon);
    expect(texts(ctx).some((o) => o.text === "Buy for 95 g" && o.fillStyle === "#4ade80")).toBe(true);
    const outline = ctx.ops.filter((o) => o.op === "strokeRect" && o.strokeStyle === "#4ade80");
    expect(outline.some((o) => o.x === inv.panel.x && o.y === inv.panel.y && o.w === inv.panel.w)).toBe(true);
    expect(outline.some((o) => o.x === win.panel.x && o.w === win.panel.w)).toBe(false);

    const toWin = stubCtx();
    drawPairedOverlay(toWin, { winLayout: win, invLayout: inv, drag: { ...drag, from: { kind: "item", id: 3 }, itemId: 3, typeId: undefined }, drop: { action: "sell", hint: "Sell for 5 g", target: "window" } }, null);
    expect(toWin.ops.some((o) => o.op === "strokeRect" && o.strokeStyle === "#4ade80" && o.x === win.panel.x && o.w === win.panel.w)).toBe(true);
  });

  it("no hint means no outline and no hint text, but the ghost still follows", () => {
    const ctx = stubCtx();
    const drag = { armed: true, x: 700, y: 300, typeId: 2, from: { kind: "stockitem", id: 5 } };
    drawPairedOverlay(ctx, { winLayout: win, invLayout: inv, drag, types: TYPES, drop: { action: "buy", id: 5 } }, null);
    expect(ctx.ops.some((o) => o.strokeStyle === "#4ade80")).toBe(false);
    expect(ctx.ops.some((o) => o.op === "fillRect" && o.alpha === 0.7)).toBe(true);
  });

  it("an inventory drag's ghost is resolved from the inventory", () => {
    const icon = { naturalWidth: 256, naturalHeight: 256 };
    const art = { icon: (kind, key) => (kind === "item" && Number(key) === 1 ? icon : null) };
    const withItem = layoutInventory({
      inventory: { items: [{ id: 3, typeId: 1, quantity: 1 }], types: TYPES, equipment: {}, capacity: 48 }, gold: 0, tab: "all", page: 0, originX: INVENTORY_X, paired: true,
    });
    const images = [];
    const ctx = stubCtx();
    ctx.drawImage = (i) => images.push(i);
    drawPairedOverlay(ctx, { winLayout: win, invLayout: withItem, drag: { armed: true, x: 600, y: 300, itemId: 3, from: { kind: "item", id: 3 } } }, art);
    expect(images).toContain(icon);
  });
});

describe("tooltips explain locked wares and rolled affixes", () => {
  const inv = layoutInventory({ inventory: { items: [], types: TYPES, equipment: {} }, gold: 0, tab: "all", page: 0, originX: INVENTORY_X, paired: true });
  const AFFIX = { affixTypeId: 1, key: "of_might", label: "of Might", value: 3.13, effect: { type: "stat", stat: "strength" } };
  const tip = (layout, i) => {
    const c = layout.cells[i];
    const ctx = stubCtx();
    drawPairedOverlay(ctx, { winLayout: layout, invLayout: inv, hover: { x: c.x + 5, y: c.y + 5 } }, null);
    return texts(ctx).map((o) => o.text);
  };

  it("a locked ware's tooltip says what standing it needs", () => {
    const l = merchantLayout({ lockedCatalog: [row(50, { minReputation: 100, requiredTier: "Honored", price: 500 })] });
    const lines = tip(l, 0);
    expect(lines).toContain("Requires Honored (100)");
    expect(lines).not.toContain("500 g");
  });

  it("a chest and a buyback tooltip show the rolled affix with its value", () => {
    const item = { rarity: "yellow", itemLevel: 30, affixes: [AFFIX] };
    const chest = tip(chestLayout([stored(item)]), 0);
    const buy = tip(merchantLayout({ buyback: [row(7, item)] }, { tab: "buyback", page: 0 }), 0);
    for (const lines of [chest, buy]) expect(lines.some((x) => x.includes("of Might") && x.includes("3.13"))).toBe(true);
    expect(tip(chestLayout([stored()]), 0).some((x) => x.includes("of Might"))).toBe(false);
  });
});

// ----------------------------------------------------------- real frames

describe("RenderSystem frames", () => {
  function renderFrame(over = {}, rs = null) {
    rs = rs || Object.create(RenderSystem.prototype);
    rs.ctx = stubCtx();
    rs.canvas = { width: 1280, height: 720 };
    rs.imageManager = { get: () => null };
    rs.renderHud = () => {};
    rs.renderChunked({
      player: { x: 0, y: 0, width: 32, height: 32, hp: 10, maxHp: 10, facing: "down", effects: null },
      camera: { apply() {}, reset() {}, screenX: 0, screenY: 0, width: 1280, height: 720, x: 0, y: 0 },
      chunkedMap: { mapTiles: [], chunks: new NativeMap(), chunkSize: 16, tileSize: 32, loadedKeys: () => [] },
      remotePlayers: new NativeMap(),
      localUserId: 1,
      ...over,
    });
    return rs;
  }
  const inventory = { items: [{ id: 3, typeId: 1, quantity: 1 }], types: TYPES, equipment: {}, capacity: 48 };
  const shop = { villageId: 1, catalog: [row(5, { price: 95 })], buyback: [], lockedCatalog: [], reputation: null, sellQuotes: { 3: 12 } };
  const bank = { villageId: 1, items: [stored({ id: 21 })], capacity: 40 };
  const base = {
    inventory, inventoryOpen: true, gold: 500, shop, shopOpen: true, shopView: { tab: "catalog", page: 0 }, pairedKind: "merchant",
    inventoryView: { tab: "all", page: 0, paired: true, originX: INVENTORY_X },
  };

  it("order is window, inventory, overlay", () => {
    const drag = { armed: true, x: 200, y: 300, itemId: 3, from: { kind: "item", id: 3 }, typeId: 1 };
    const rs = renderFrame({ ...base, inventoryView: { ...base.inventoryView, drag } });
    const ctx = rs.ctx;
    const win = textIdx(ctx, /^Merchant$/);
    const inv = textIdx(ctx, /^Inventory/);
    const hint = textIdx(ctx, /^Sell for 12 g$/);
    expect(win).toBeGreaterThanOrEqual(0);
    expect(inv).toBeGreaterThan(win);
    expect(hint).toBeGreaterThan(inv);
  });

  it("the overlay resolves the drop from this frame's layouts (sell over the window)", () => {
    const w = layoutMerchantWindow({ shop, view: { tab: "catalog", page: 0 }, gold: 500, types: TYPES });
    const drag = { armed: true, x: w.panel.x + 100, y: w.panel.y + 200, itemId: 3, from: { kind: "item", id: 3 } };
    const rs = renderFrame({ ...base, inventoryView: { ...base.inventoryView, drag } });
    expect(texts(rs.ctx).some((o) => o.text === "Sell for 12 g")).toBe(true);
    expect(rs.ctx.ops.some((o) => o.op === "strokeRect" && o.strokeStyle === "#4ade80" && o.x === WINDOW_X && o.y === WINDOW_Y)).toBe(true);
  });

  it("a window tooltip paints after the inventory, an inventory tooltip stays inside its own pass", () => {
    const w = layoutMerchantWindow({ shop, view: { tab: "catalog", page: 0 }, gold: 500, types: TYPES });
    const rs = renderFrame({ ...base, inventoryView: { ...base.inventoryView, hoverX: w.cells[0].x + 5, hoverY: w.cells[0].y + 5 } });
    const inv = textIdx(rs.ctx, /^Inventory/);
    const tip = rs.ctx.ops.findIndex((o) => o.op === "text" && o.text === "95 g");
    expect(tip).toBeGreaterThan(inv);
  });

  it("a paired chest draws the chest window and publishes its hit areas", () => {
    const rs = renderFrame({ ...base, shopOpen: false, bankOpen: true, bank, pairedKind: "chest" });
    expect(textIdx(rs.ctx, /Account Chest/)).toBeGreaterThanOrEqual(0);
    expect(rs._winLayout.kind).toBe("chest");
    expect(rs._winHitAreas.some((a) => a.kind === "chestitem" && a.id === 21)).toBe(true);
    expect(rs._invLayout.panel.x).toBe(INVENTORY_X);
    expect(rs._invHitAreas.length).toBeGreaterThan(0);
  });

  it("no shop or bank frame leaves the hit areas stale after the window closes", () => {
    const rs = renderFrame(base);
    expect(rs._winHitAreas.length).toBeGreaterThan(0);
    renderFrame({ ...base, shopOpen: false, bankOpen: false, pairedKind: null, inventoryOpen: false, inventoryView: null }, rs);
    expect(rs._winHitAreas).toEqual([]);
    expect(rs._winLayout).toBeNull();
    expect(rs._invLayout).toBeNull();
    expect(rs._invHitAreas).toEqual([]);
    expect(rs._shopHitAreas).toBeUndefined();
    expect(rs._bankHitAreas).toBeUndefined();
  });

  it("a lone inventory still draws centred and unpaired", () => {
    const rs = renderFrame({ ...base, shopOpen: false, pairedKind: null, inventoryView: { tab: "all", page: 0 } });
    expect(rs._winLayout).toBeNull();
    expect(rs._invLayout.panel.x).toBe((1280 - 820) / 2);
  });
});

// ------------------------------------------------------------ Game wiring

describe("Game paired state", () => {
  const fake = (over = {}) => ({
    inventoryOpen: false, shopOpen: false, bankOpen: false, shop: null, bank: null, ...over,
    _pairedKind: Game.prototype._pairedKind,
  });

  it("_pairedKind names the open window; _inventoryVisible follows it", () => {
    expect(fake()._pairedKind()).toBeNull();
    expect(fake({ bankOpen: true, bank: {} })._pairedKind()).toBe("chest");
    expect(fake({ shopOpen: true, shop: {} })._pairedKind()).toBe("merchant");
    expect(fake({ shopOpen: true })._pairedKind()).toBeNull();
    const vis = (o) => Game.prototype._inventoryVisible.call(fake(o));
    expect(vis({})).toBe(false);
    expect(vis({ inventoryOpen: true })).toBe(true);
    expect(vis({ bankOpen: true, bank: {} })).toBe(true);
    expect(vis({ shopOpen: true, shop: {} })).toBe(true);
  });

  it("openShop keeps sellQuotes and never sets inventoryOpen", () => {
    const g = Object.assign(Object.create(Game.prototype), {
      inventoryOpen: false, passiveTreeOpen: false, questLogOpen: false, achievementsOpen: false, buildGuideOpen: false,
      skillsOpen: false, gemShopOpen: false, forgeOpen: false, shopOpen: false, bankOpen: false, closeAllPanels() {},
    });
    g.openShop({ villageId: 1, catalog: [], buyback: [], sellQuotes: { 3: 12 } });
    expect(g.shop.sellQuotes).toEqual({ 3: 12 });
    expect(g.inventoryOpen).toBe(false);
    expect(g._pairedKind()).toBe("merchant");
    g.shopOpen = false;
    g.openShop({ villageId: 1, catalog: [], buyback: [] });
    expect(g.shop.sellQuotes).toEqual({});
  });
});
