# Inventory Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the canvas inventory's text list with a slot-grid window (chrome, character preview, paperdoll, category tabs, quantity badges, tooltip, gold footer), add drag-and-drop equipping, and enforce a real per-character carry limit.

**Architecture:** A new `systems/inventoryPanel.js` splits the panel into a **pure** `layoutInventory(state)` that computes every rect and hit area, and a `drawInventory(ctx, layout, state)` that only paints them; `RenderSystem.renderInventory` becomes a delegate. Drag resolution is a second pure function, `resolveDrop(layout, drag, point)`, so the only untestable part is the pointer plumbing. Capacity is enforced server-side in `authority/items.js` and called by every path that inserts into `player_items`.

**Tech Stack:** Vanilla ES modules + Canvas 2D (frontend, vitest), Node/Express + raw `pg` (backend, `node --test`), node-pg-migrate.

**Spec:** `docs/superpowers/specs/2026-08-23-inventory-redesign-design.md`

## Global Constraints

- **Never run destructive SQL against the shared dev database.** Backend DB tests run against a scratch database: set BOTH `DATABASE_URL` and `TEST_DATABASE_URL` to it, and seed both map specs (vale-region LAST) before running.
- Frontend tests: `cd frontend && npx vitest run <path>`. Backend tests: `cd backend && node --test --test-timeout=420000 tests/<file>.test.js`.
- Migration timestamps collide in this repo. The highest on main today is `1714440410000_invite_codes.js`; the new migration MUST use a strictly higher timestamp, verified with `ls backend/migrations | sort | tail -3` at the moment it is written.
- Panel geometry constants: panel `820x580`, centred via `GAME_WIDTH`/`GAME_HEIGHT` from `core/constants.js`. Grid `8` cols x `6` rows, cell `44`px, gutter `4`px.
- Hit-area records keep the existing shape `{x, y, w, h, kind, id}`. Existing kinds `slot`, `item`, `drop`, `autoloot` keep their exact meaning and their handlers in `Game._handleInventoryClick`. New kinds: `invclose`, `invtab`, `invpage`.
- Categories are the live `item_types.category` set: `weapon`, `armor`, `ammo`, `currency`, `consumable`, `stone`. `currency` never appears in the grid.
- Capacity counts **rows** in `player_items` (stacks), not summed quantity, and excludes `currency`.
- The server stays authoritative for equip legality. `canEquipClient` only tints the cursor and suppresses a doomed request.
- Do not `git checkout` / `stash` / branch in the shared working directory. Stage by explicit path.

---

### Task 1: One close path for the inventory panel

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js:1014-1030`
- Test: `frontend/src/games/something2/src/js/core/__tests__/escapeKey.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `Game.closeInventory()` — clears `inventoryOpen`, `inventorySelectedItemId` and `inventoryDrag`. Tasks 9 and 10 rely on it clearing the drag.

- [ ] **Step 1: Verify the reported Escape failure in a real browser before changing anything**

The unit test for Escape is already green, so if Escape genuinely fails in play the cause is outside `_keydownHandler`. Run the stack (`make dev`), open the game at `http://localhost:15173`, log in, press `i` to open the inventory, press `Escape`, and read the console.

Record the outcome in the task's Plane comment, one of:
- Panel closes and `Escape pressed, current state: playing` is logged → the reported bug does not reproduce; this task is the refactor below only.
- Nothing is logged → the keydown never reached `Game`; the suspect is the fullscreen keyboard lock at `frontend/src/games/something2/GameShell.jsx:237`. Add the fix to this task and cover it.
- Logged but the panel stays open → something re-opens it; bisect with the `i` handler.

- [ ] **Step 2: Write the failing test**

Add to `escapeKey.test.js`:

```js
  it('closeInventory clears the panel, the selection and any in-flight drag', () => {
    const g = makeGame();
    g.inventoryOpen = true;
    g.inventorySelectedItemId = 'item-123';
    g.inventoryDrag = { itemId: 'item-123', from: { kind: 'item', id: 'item-123' }, x: 10, y: 10 };

    g.closeInventory();

    expect(g.inventoryOpen).toBe(false);
    expect(g.inventorySelectedItemId).toBeNull();
    expect(g.inventoryDrag).toBeNull();
  });

  it('Escape closes through closeInventory, dropping an in-flight drag', () => {
    const g = makeGame();
    g.inventoryOpen = true;
    g.inventoryDrag = { itemId: 'item-9', from: { kind: 'item', id: 'item-9' }, x: 1, y: 2 };

    g._keydownHandler({ key: 'Escape', code: 'Escape', preventDefault: () => {} });

    expect(g.inventoryOpen).toBe(false);
    expect(g.inventoryDrag).toBeNull();
  });

  it('the i toggle closes through the same path', () => {
    const g = makeGame();
    g.inventoryOpen = true;
    g.inventorySelectedItemId = 'item-5';
    g.inventoryDrag = { itemId: 'item-5', from: { kind: 'item', id: 'item-5' }, x: 0, y: 0 };

    g._keydownHandler({ key: 'i', code: 'KeyI', preventDefault: () => {} });

    expect(g.inventoryOpen).toBe(false);
    expect(g.inventorySelectedItemId).toBeNull();
    expect(g.inventoryDrag).toBeNull();
  });
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/escapeKey.test.js`
Expected: FAIL — `g.closeInventory is not a function`.

- [ ] **Step 4: Add the method and route both closers through it**

In `Game.js`, next to `_handleInventoryClick`, add:

```js
    // The ONE way the inventory panel closes. Escape, the panel's [X] and the
    // 'i' toggle all land here so they cannot drift: an in-flight drag that
    // outlived its panel would otherwise resolve against a layout that is no
    // longer on screen.
    closeInventory() {
        this.inventoryOpen = false;
        this.inventorySelectedItemId = null;
        this.inventoryDrag = null;
    }
```

In the constructor (`Game.js:89`) and in the per-join reset (`Game.js:353`), add `this.inventoryDrag = null;` directly after the `inventorySelectedItemId` line in each.

Replace the `i` handler body:

```js
            if (isKey('i') && this.state === 'playing' && this.chunked && !e.repeat && !this.shopOpen && !this.bankOpen) {
                if (this.inventoryOpen) this.closeInventory();
                else this.inventoryOpen = true;
            }
```

Replace the inventory arm of the Escape handler:

```js
                } else if (this.inventoryOpen) {
                    this.closeInventory();
                }
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/escapeKey.test.js`
Expected: PASS, all seven tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/core/__tests__/escapeKey.test.js
git commit -m "refactor(inventory): one close path for panel, selection and drag"
```

---

### Task 2: Panel layout — chrome, preview, paperdoll, footer

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/inventoryPanel.js`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js`

**Interfaces:**
- Consumes: `GAME_WIDTH`, `GAME_HEIGHT` from `core/constants.js`; `SLOTS`, `typeOf`, `canEquipClient` from `core/inventory.js`.
- Produces:
  - `PANEL_W = 820`, `PANEL_H = 580`, `GRID_COLS = 8`, `GRID_ROWS = 6`, `CELL = 44`, `GUTTER = 4`, `CELLS_PER_PAGE = 48`
  - `layoutInventory(state) -> layout` where `state` is `{ inventory, tab = 'all', page = 0, selectedItemId = null, gold = 0, autoLoot = false, drag = null }` and `layout` is `{ panel, close, title, preview, slots, tabs, cells, pages, footer, used, capacity, hitAreas }`
  - `usedSlotsClient(inventory) -> number`, `capacityOf(inventory) -> number`
  - Tasks 3, 4, 9 and 10 all consume `layoutInventory` and its `hitAreas`.

- [ ] **Step 1: Write the failing test**

Create `inventoryPanel.test.js`:

```js
import { describe, it, expect } from "vitest";
import { layoutInventory, usedSlotsClient, capacityOf, PANEL_W, PANEL_H } from "../inventoryPanel.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";

// Minimal inventory in the shape core/inventory.js builds.
function inv({ items = [], equipment = {}, types = [], capacity = null } = {}) {
  return {
    types: new Map(types.map((t) => [t.id, t])),
    items,
    equipment,
    ammoCounts: new Map(),
    capacity,
  };
}

const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };
const HELM = { id: 2, name: "iron helm", category: "armor", slot: "head", defense: 3, resistances: {} };
const COIN = { id: 3, name: "gold", category: "currency" };

describe("layoutInventory geometry", () => {
  it("centres the panel on the canvas", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.panel).toEqual({
      x: (GAME_WIDTH - PANEL_W) / 2,
      y: (GAME_HEIGHT - PANEL_H) / 2,
      w: PANEL_W,
      h: PANEL_H,
    });
  });

  it("puts the close button inside the title bar, at its right edge", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.close.x + l.close.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
    expect(l.close.y).toBeGreaterThanOrEqual(l.panel.y);
    expect(l.close.y + l.close.h).toBeLessThanOrEqual(l.title.y + l.title.h);
    expect(l.hitAreas).toContainEqual({ ...l.close, kind: "invclose", id: null });
  });

  it("lays out one box per equipment slot, all inside the panel", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.slots).toHaveLength(8);
    for (const s of l.slots) {
      expect(s.x).toBeGreaterThanOrEqual(l.panel.x);
      expect(s.y).toBeGreaterThanOrEqual(l.panel.y);
      expect(s.x + s.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
      expect(s.y + s.h).toBeLessThanOrEqual(l.panel.y + l.panel.h);
      expect(l.hitAreas).toContainEqual({ x: s.x, y: s.y, w: s.w, h: s.h, kind: "slot", id: s.slot });
    }
  });

  it("does not overlap the character preview with any paperdoll box", () => {
    const l = layoutInventory({ inventory: inv() });
    const overlaps = (a, b) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (const s of l.slots) expect(overlaps(l.preview, s)).toBe(false);
  });

  it("names the equipped type and marks a slot disabled when the selection cannot go there", () => {
    const l = layoutInventory({
      inventory: inv({
        types: [SWORD, HELM],
        items: [{ id: "a", typeId: 1, quantity: 1 }, { id: "b", typeId: 2, quantity: 1 }],
        equipment: { head: "b" },
      }),
      selectedItemId: "a",
    });
    const head = l.slots.find((s) => s.slot === "head");
    const mainHand = l.slots.find((s) => s.slot === "main_hand");
    expect(head.equippedName).toBe("iron helm");
    expect(head.disabled).toBe(true);   // a sword cannot go on the head
    expect(mainHand.disabled).toBe(false);
  });

  it("shows the drop control only while an item is selected", () => {
    const items = [{ id: "a", typeId: 1, quantity: 1 }];
    const withSel = layoutInventory({ inventory: inv({ types: [SWORD], items }), selectedItemId: "a" });
    const noSel = layoutInventory({ inventory: inv({ types: [SWORD], items }) });
    expect(withSel.footer.drop).not.toBeNull();
    expect(withSel.hitAreas).toContainEqual({ ...withSel.footer.drop, kind: "drop", id: "a" });
    expect(noSel.footer.drop).toBeNull();
    expect(noSel.hitAreas.some((a) => a.kind === "drop")).toBe(false);
  });

  it("always offers the auto-loot toggle and reports gold", () => {
    const l = layoutInventory({ inventory: inv(), gold: 2439242, autoLoot: true });
    expect(l.footer.gold).toBe(2439242);
    expect(l.footer.autoLootOn).toBe(true);
    expect(l.hitAreas).toContainEqual({ ...l.footer.autoLoot, kind: "autoloot", id: null });
  });
});

describe("capacity accounting", () => {
  it("counts stacks, not quantities, and ignores currency", () => {
    const i = inv({
      types: [SWORD, COIN],
      items: [
        { id: "a", typeId: 1, quantity: 1 },
        { id: "b", typeId: 1, quantity: 40 },
        { id: "c", typeId: 3, quantity: 999 },
      ],
    });
    expect(usedSlotsClient(i)).toBe(2);
  });

  it("counts an item whose type this client does not know", () => {
    expect(usedSlotsClient(inv({ items: [{ id: "a", typeId: 77, quantity: 1 }] }))).toBe(1);
  });

  it("falls back to the page size when the server sent no capacity", () => {
    expect(capacityOf(inv())).toBe(48);
    expect(capacityOf(inv({ capacity: 96 }))).toBe(96);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js`
Expected: FAIL — cannot resolve `../inventoryPanel.js`.

- [ ] **Step 3: Write the module**

Create `frontend/src/games/something2/src/js/systems/inventoryPanel.js`:

```js
// Layout for the canvas inventory window. PURE: this module computes rects
// and never touches a canvas, which is what makes the grid maths, the tab
// filter and the paging testable without a rendering context. drawInventory
// (Task 4) paints exactly what this returns and decides nothing itself.
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { SLOTS, typeOf, canEquipClient } from "../core/inventory.js";

export const PANEL_W = 820;
export const PANEL_H = 580;
export const GRID_COLS = 8;
export const GRID_ROWS = 6;
export const CELL = 44;
export const GUTTER = 4;
export const CELLS_PER_PAGE = GRID_COLS * GRID_ROWS;

const TITLE_H = 30;
const PAD = 14;
const LEFT_W = 250;
const PREVIEW_H = 190;
const SLOT_W = 122;   // two columns of these plus one 6px gap == LEFT_W
const SLOT_H = 30;
const FOOTER_H = 40;

// A stack of gold is a wallet number, never a grid cell — see the footer.
const HIDDEN_CATEGORIES = new Set(["currency"]);

export function capacityOf(inventory) {
  const c = Number(inventory && inventory.capacity);
  return Number.isInteger(c) && c > 0 ? c : CELLS_PER_PAGE;
}

// Counts STACKS, mirroring the server rule in authority/items.js usedSlots.
// An item whose type is unknown to this client still occupies a slot: the
// server counted it, and a client that quietly skipped it would render a
// used count lower than the one the server enforces against.
export function usedSlotsClient(inventory) {
  const items = (inventory && inventory.items) || [];
  const types = (inventory && inventory.types) || new Map();
  let n = 0;
  for (const it of items) {
    const t = types.get(it.typeId);
    if (t && HIDDEN_CATEGORIES.has(t.category)) continue;
    n += 1;
  }
  return n;
}

export function layoutInventory(state) {
  const {
    inventory,
    selectedItemId = null,
    gold = 0,
    autoLoot = false,
  } = state;

  const px = (GAME_WIDTH - PANEL_W) / 2;
  const py = (GAME_HEIGHT - PANEL_H) / 2;
  const panel = { x: px, y: py, w: PANEL_W, h: PANEL_H };
  const title = { x: px, y: py, w: PANEL_W, h: TITLE_H };
  const close = { x: px + PANEL_W - 8 - 20, y: py + 5, w: 20, h: 20 };

  const hitAreas = [{ ...close, kind: "invclose", id: null }];

  // Left column: the character preview on top, the eight paperdoll boxes in
  // two columns of four beneath it. Flanking the preview with the boxes (the
  // arrangement the reference screenshot uses) does not fit: two 112px boxes
  // plus gutters leave the sprite 14px of the 250px column.
  const colX = px + PAD;
  const colTop = py + TITLE_H + PAD;
  const preview = { x: colX, y: colTop, w: LEFT_W, h: PREVIEW_H };
  const slotsTop = colTop + PREVIEW_H + 10;
  const slots = SLOTS.map((slot, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = colX + col * (SLOT_W + 6);
    const y = slotsTop + row * (SLOT_H + 6);
    const equippedId = inventory.equipment[slot];
    const equippedType = equippedId != null ? typeOf(inventory, equippedId) : null;
    const disabled = selectedItemId != null && !canEquipClient(inventory, selectedItemId, slot);
    return {
      slot, x, y, w: SLOT_W, h: SLOT_H,
      equippedName: equippedType ? equippedType.name : null,
      disabled,
    };
  });
  for (const s of slots) hitAreas.push({ x: s.x, y: s.y, w: s.w, h: s.h, kind: "slot", id: s.slot });

  const footerY = py + PANEL_H - PAD - FOOTER_H;
  const autoLootRect = { x: colX, y: footerY, w: 150, h: 26 };
  hitAreas.push({ ...autoLootRect, kind: "autoloot", id: null });
  let drop = null;
  if (selectedItemId != null) {
    drop = { x: colX + 160, y: footerY, w: 150, h: 26 };
    hitAreas.push({ ...drop, kind: "drop", id: selectedItemId });
  }

  return {
    panel, title, close, preview, slots,
    tabs: [],
    cells: [],
    pages: { count: 1, page: 0, prev: null, next: null },
    footer: { gold, autoLoot: autoLootRect, autoLootOn: autoLoot === true, drop },
    used: usedSlotsClient(inventory),
    capacity: capacityOf(inventory),
    hitAreas,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js`
Expected: PASS. If the preview/slot overlap assertion fails, adjust `SLOT_W` / `preview` maths until the two columns sit either side of the preview — the test is the specification, not the constants.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/inventoryPanel.js frontend/src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js
git commit -m "feat(inventory): pure layout for the panel chrome, preview and paperdoll"
```

---

### Task 3: Tabs, grid cells and paging

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/inventoryPanel.js`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js`

**Interfaces:**
- Consumes: `layoutInventory` from Task 2.
- Produces:
  - `TABS = [{key,label,categories}]` with keys `all`, `equip`, `supply`, `stones`
  - `visibleItems(inventory, tabKey) -> item[]`
  - `layout.cells = [{x, y, w, h, item, type, selected}]` (`item`/`type` are `null` for an empty cell)
  - `layout.tabs = [{key, label, x, y, w, h, active}]`
  - `layout.pages = {count, page, prev, next, arrowY, x}` (`prev`/`next` are rects or `null`; `arrowY`/`x` anchor the page label)
  - Task 9's `resolveDrop` hit-tests `layout.cells`.

- [ ] **Step 1: Write the failing test**

Append to `inventoryPanel.test.js`:

```js
import { visibleItems, TABS, CELLS_PER_PAGE, GRID_COLS } from "../inventoryPanel.js";

const ARROW = { id: 4, name: "arrow", category: "ammo" };
const STONE = { id: 5, name: "flame stone", category: "stone" };
const WEIRD = { id: 6, name: "mystery", category: "relic" };

function bigInv(count) {
  const items = [];
  for (let i = 0; i < count; i += 1) items.push({ id: `i${i}`, typeId: 1, quantity: 1 });
  return inv({ types: [SWORD], items });
}

describe("tabs", () => {
  it("offers exactly the four tabs, All first and active by default", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.tabs.map((t) => t.key)).toEqual(["all", "equip", "supply", "stones"]);
    expect(l.tabs[0].active).toBe(true);
    for (const t of l.tabs) expect(l.hitAreas).toContainEqual({ x: t.x, y: t.y, w: t.w, h: t.h, kind: "invtab", id: t.key });
  });

  it("filters by category and never shows currency", () => {
    const i = inv({
      types: [SWORD, HELM, ARROW, STONE, COIN],
      items: [
        { id: "w", typeId: 1, quantity: 1 },
        { id: "h", typeId: 2, quantity: 1 },
        { id: "a", typeId: 4, quantity: 30 },
        { id: "s", typeId: 5, quantity: 1 },
        { id: "g", typeId: 3, quantity: 900 },
      ],
    });
    expect(visibleItems(i, "all").map((x) => x.id)).toEqual(["w", "h", "a", "s"]);
    expect(visibleItems(i, "equip").map((x) => x.id)).toEqual(["w", "h"]);
    expect(visibleItems(i, "supply").map((x) => x.id)).toEqual(["a"]);
    expect(visibleItems(i, "stones").map((x) => x.id)).toEqual(["s"]);
  });

  it("shows an item whose category matches no tab under All", () => {
    const i = inv({ types: [WEIRD], items: [{ id: "x", typeId: 6, quantity: 1 }] });
    expect(visibleItems(i, "all").map((x) => x.id)).toEqual(["x"]);
    expect(visibleItems(i, "equip")).toEqual([]);
  });

  it("marks the requested tab active", () => {
    const l = layoutInventory({ inventory: inv(), tab: "stones" });
    expect(l.tabs.find((t) => t.key === "stones").active).toBe(true);
    expect(l.tabs.find((t) => t.key === "all").active).toBe(false);
  });
});

describe("grid", () => {
  it("always lays out a full page of cells in a rectangle", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.cells).toHaveLength(CELLS_PER_PAGE);
    const row0 = l.cells.slice(0, GRID_COLS);
    expect(new Set(row0.map((c) => c.y)).size).toBe(1);
    expect(row0[1].x - row0[0].x).toBe(l.cells[0].w + 4);
    for (const c of l.cells) {
      expect(c.x + c.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
      expect(c.y + c.h).toBeLessThanOrEqual(l.panel.y + l.panel.h);
    }
  });

  it("fills cells in order and leaves the rest empty", () => {
    const l = layoutInventory({
      inventory: inv({ types: [SWORD, HELM], items: [{ id: "w", typeId: 1, quantity: 1 }, { id: "h", typeId: 2, quantity: 3 }] }),
    });
    expect(l.cells[0].item.id).toBe("w");
    expect(l.cells[0].type.name).toBe("short sword");
    expect(l.cells[1].item.quantity).toBe(3);
    expect(l.cells[2].item).toBeNull();
    expect(l.cells[2].type).toBeNull();
  });

  it("registers a hit area for a filled cell and none for an empty one", () => {
    const l = layoutInventory({ inventory: inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }] }) });
    expect(l.hitAreas).toContainEqual({ x: l.cells[0].x, y: l.cells[0].y, w: l.cells[0].w, h: l.cells[0].h, kind: "item", id: "w" });
    expect(l.hitAreas.filter((a) => a.kind === "item")).toHaveLength(1);
  });

  it("marks the selected cell", () => {
    const l = layoutInventory({
      inventory: inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }] }),
      selectedItemId: "w",
    });
    expect(l.cells[0].selected).toBe(true);
  });
});

describe("paging", () => {
  it("reports one page and no arrows when everything fits", () => {
    const l = layoutInventory({ inventory: bigInv(CELLS_PER_PAGE) });
    expect(l.pages.count).toBe(1);
    expect(l.pages.prev).toBeNull();
    expect(l.pages.next).toBeNull();
  });

  it("pages the overflow and offers arrows", () => {
    const l = layoutInventory({ inventory: bigInv(CELLS_PER_PAGE + 1) });
    expect(l.pages.count).toBe(2);
    expect(l.pages.next).not.toBeNull();
    expect(l.hitAreas).toContainEqual({ ...l.pages.next, kind: "invpage", id: 1 });
    expect(l.pages.prev).toBeNull(); // on page 0 there is nowhere back to go
  });

  it("shows the tail of the list on the last page", () => {
    const l = layoutInventory({ inventory: bigInv(CELLS_PER_PAGE + 2), page: 1 });
    expect(l.cells[0].item.id).toBe(`i${CELLS_PER_PAGE}`);
    expect(l.cells[1].item.id).toBe(`i${CELLS_PER_PAGE + 1}`);
    expect(l.cells[2].item).toBeNull();
    expect(l.pages.prev).not.toBeNull();
    expect(l.pages.next).toBeNull();
  });

  it("clamps a page that is past the end", () => {
    const l = layoutInventory({ inventory: bigInv(3), page: 7 });
    expect(l.pages.page).toBe(0);
    expect(l.cells[0].item.id).toBe("i0");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js`
Expected: FAIL — `visibleItems` is not exported; `l.tabs` is empty; `l.cells` is empty.

- [ ] **Step 3: Implement tabs, cells and paging**

In `inventoryPanel.js`, add above `layoutInventory`:

```js
// `categories: null` means "everything not hidden" — an item whose category
// is new server-side lands under All rather than becoming invisible.
export const TABS = [
  { key: "all", label: "All", categories: null },
  { key: "equip", label: "Equip", categories: ["weapon", "armor"] },
  { key: "supply", label: "Supply", categories: ["ammo", "consumable"] },
  { key: "stones", label: "Stones", categories: ["stone"] },
];

export function visibleItems(inventory, tabKey) {
  const tab = TABS.find((t) => t.key === tabKey) || TABS[0];
  const types = (inventory && inventory.types) || new Map();
  return ((inventory && inventory.items) || []).filter((it) => {
    const t = types.get(it.typeId);
    const category = t ? t.category : null;
    if (category != null && HIDDEN_CATEGORIES.has(category)) return false;
    if (tab.categories === null) return true;
    return category != null && tab.categories.includes(category);
  });
}
```

Then, inside `layoutInventory`, replace the `tabs`, `cells` and `pages` placeholders. Destructure `tab = "all"` and `page = 0` from `state`, and insert before the `return`:

```js
  const rightX = px + PAD + LEFT_W + PAD;
  const tabsY = py + TITLE_H + PAD;
  const tabW = 84, tabH = 24;
  const tabs = TABS.map((t, i) => ({
    key: t.key, label: t.label,
    x: rightX + i * (tabW + 6), y: tabsY, w: tabW, h: tabH,
    active: t.key === (TABS.some((x) => x.key === tab) ? tab : "all"),
  }));
  for (const t of tabs) hitAreas.push({ x: t.x, y: t.y, w: t.w, h: t.h, kind: "invtab", id: t.key });

  const shown = visibleItems(inventory, tab);
  const pageCount = Math.max(1, Math.ceil(shown.length / CELLS_PER_PAGE));
  // Clamped rather than trusted: the page survives a tab switch and an item
  // list that shrank under it (sold, dropped, stored), and an unclamped index
  // would render a blank grid the player cannot page back out of.
  const pageIdx = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pageCount - 1);
  const gridTop = tabsY + tabH + 10;
  const cells = [];
  for (let i = 0; i < CELLS_PER_PAGE; i += 1) {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    const item = shown[pageIdx * CELLS_PER_PAGE + i] || null;
    const type = item ? inventory.types.get(item.typeId) || null : null;
    const cell = {
      x: rightX + col * (CELL + GUTTER),
      y: gridTop + row * (CELL + GUTTER),
      w: CELL, h: CELL,
      item, type,
      selected: item != null && item.id === selectedItemId,
    };
    cells.push(cell);
    if (item) hitAreas.push({ x: cell.x, y: cell.y, w: cell.w, h: cell.h, kind: "item", id: item.id });
  }

  const arrowY = gridTop + GRID_ROWS * (CELL + GUTTER) + 8;   // returned as pages.arrowY
  const prev = pageIdx > 0 ? { x: rightX, y: arrowY, w: 32, h: 24 } : null;
  const next = pageIdx < pageCount - 1 ? { x: rightX + 40, y: arrowY, w: 32, h: 24 } : null;
  if (prev) hitAreas.push({ ...prev, kind: "invpage", id: pageIdx - 1 });
  if (next) hitAreas.push({ ...next, kind: "invpage", id: pageIdx + 1 });
```

Return `tabs`, `cells` and `pages: { count: pageCount, page: pageIdx, prev, next, arrowY, x: rightX }` instead of the placeholders.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/inventoryPanel.js frontend/src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js
git commit -m "feat(inventory): category tabs, icon grid and paging in the layout"
```

---

### Task 4: Draw the panel and delegate from RenderSystem

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/inventoryPanel.js`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js:1208-1330`
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (`_handleInventoryClick`, render state)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/inventoryPanelDraw.test.js`

**Interfaces:**
- Consumes: `layoutInventory` (Tasks 2-3).
- Produces:
  - `drawInventory(ctx, layout, state)` — `state` additionally carries `{ playerImage = null, hoverX = null, hoverY = null }`
  - `RenderSystem.renderInventory(ctx, inventory, hitAreas, selectedItemId, autoLoot, view)` where `view` is `{ tab, page, gold, drag, hoverX, hoverY }`
  - `Game.inventoryTab` (string, default `'all'`) and `Game.inventoryPage` (number, default `0`)

- [ ] **Step 1: Write the failing test**

Create `inventoryPanelDraw.test.js`:

```js
import { describe, it, expect } from "vitest";
import { layoutInventory, drawInventory } from "../inventoryPanel.js";
import { RenderSystem } from "../RenderSystem.js";
import { Game } from "../../core/Game.js";

function stubCtx() {
  const fillRects = [], texts = [], images = [];
  return {
    fillRects, texts, images,
    save() {}, restore() {},
    fillRect(x, y, w, h) { fillRects.push({ x, y, w, h }); },
    strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    fillText(text, x, y) { texts.push({ text, x, y }); },
    drawImage(img, x, y, w, h) { images.push({ x, y, w, h }); },
    measureText(t) { return { width: t.length * 6 }; },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set font(_v) {},
    set lineWidth(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
    set globalAlpha(_v) {},
  };
}

function inv({ items = [], equipment = {}, types = [], capacity = null } = {}) {
  return { types: new Map(types.map((t) => [t.id, t])), items, equipment, ammoCounts: new Map(), capacity };
}
const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };

describe("drawInventory", () => {
  it("writes the used/capacity counter into the title bar", () => {
    const i = inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }], capacity: 48 });
    const ctx = stubCtx();
    const layout = layoutInventory({ inventory: i });
    drawInventory(ctx, layout, { inventory: i });
    expect(ctx.texts.some((t) => t.text.includes("(1/48)"))).toBe(true);
  });

  it("badges a stack and not a single item", () => {
    const i = inv({ types: [SWORD], items: [{ id: "a", typeId: 1, quantity: 12 }, { id: "b", typeId: 1, quantity: 1 }] });
    const ctx = stubCtx();
    drawInventory(ctx, layoutInventory({ inventory: i }), { inventory: i });
    expect(ctx.texts.some((t) => t.text === "12")).toBe(true);
    expect(ctx.texts.some((t) => t.text === "1")).toBe(false);
  });

  it("draws a tooltip for a hovered cell and none when the cursor is elsewhere", () => {
    const i = inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }] });
    const layout = layoutInventory({ inventory: i });
    const cell = layout.cells[0];

    const hot = stubCtx();
    drawInventory(hot, layout, { inventory: i, hoverX: cell.x + 2, hoverY: cell.y + 2 });
    expect(hot.texts.some((t) => t.text === "short sword")).toBe(true);
    expect(hot.texts.some((t) => t.text.includes("dmg 5"))).toBe(true);

    const cold = stubCtx();
    drawInventory(cold, layout, { inventory: i, hoverX: layout.panel.x + 1, hoverY: layout.panel.y + 1 });
    expect(cold.texts.some((t) => t.text.includes("dmg 5"))).toBe(false);
  });

  it("keeps the tooltip inside the canvas for a cell at the right edge", () => {
    const items = [];
    for (let n = 0; n < 8; n += 1) items.push({ id: `i${n}`, typeId: 1, quantity: 1 });
    const i = inv({ types: [SWORD], items });
    const layout = layoutInventory({ inventory: i });
    const last = layout.cells[7];
    const ctx = stubCtx();
    drawInventory(ctx, layout, { inventory: i, hoverX: last.x + 2, hoverY: last.y + 2 });
    const tip = ctx.fillRects[ctx.fillRects.length - 1];
    expect(tip.x + tip.w).toBeLessThanOrEqual(1280);
  });
});

describe("RenderSystem delegation", () => {
  it("records the layout's hit areas so clicks still route", () => {
    const rs = Object.create(RenderSystem.prototype);
    rs.imageManager = { get: () => null };
    const i = inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }] });
    const hits = [];
    rs.renderInventory(stubCtx(), i, hits, null, false, { tab: "all", page: 0, gold: 0 });
    expect(hits.some((a) => a.kind === "item" && a.id === "w")).toBe(true);
    expect(hits.some((a) => a.kind === "slot" && a.id === "main_hand")).toBe(true);
    expect(hits.some((a) => a.kind === "invclose")).toBe(true);
  });
});

describe("Game click routing for the new controls", () => {
  function makeGame() {
    globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
    const g = new Game();
    g.state = "playing";
    g.chunked = true;
    g.inventoryOpen = true;
    g.renderSystem = { _invHitAreas: [] };
    return g;
  }

  it("switches tab and resets the page", () => {
    const g = makeGame();
    g.inventoryPage = 3;
    g.renderSystem._invHitAreas = [{ x: 0, y: 0, w: 10, h: 10, kind: "invtab", id: "stones" }];
    g._handleInventoryClick(1, 1);
    expect(g.inventoryTab).toBe("stones");
    expect(g.inventoryPage).toBe(0);
  });

  it("turns the page", () => {
    const g = makeGame();
    g.renderSystem._invHitAreas = [{ x: 0, y: 0, w: 10, h: 10, kind: "invpage", id: 2 }];
    g._handleInventoryClick(1, 1);
    expect(g.inventoryPage).toBe(2);
  });

  it("closes the panel from the title bar X", () => {
    const g = makeGame();
    g.inventorySelectedItemId = "w";
    g.renderSystem._invHitAreas = [{ x: 0, y: 0, w: 10, h: 10, kind: "invclose", id: null }];
    g._handleInventoryClick(1, 1);
    expect(g.inventoryOpen).toBe(false);
    expect(g.inventorySelectedItemId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/inventoryPanelDraw.test.js`
Expected: FAIL — `drawInventory` is not exported.

- [ ] **Step 3: Write drawInventory**

Append to `inventoryPanel.js`:

```js
// Category tints. A cell has no artwork to draw (item_types carries no icon),
// so the tint plus the name's initials is the whole "icon" today.
const CATEGORY_TINT = {
  weapon: "#7f1d1d",
  armor: "#1e3a5f",
  ammo: "#78350f",
  consumable: "#14532d",
  stone: "#4c1d95",
};

function initials(name) {
  return String(name || "?").trim().slice(0, 2).toUpperCase();
}

export function statLine(type) {
  if (!type) return "";
  if (type.category === "weapon") {
    return `dmg ${type.damage}  cd ${type.cooldown}s${type.two_handed ? "  (2H)" : ""}`;
  }
  const res = Object.entries(type.resistances || {});
  return `def ${type.defense ?? 0}${res.length ? "  " + res.map(([el, v]) => `${el} ${v}`).join(", ") : ""}`;
}

function inside(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export function drawInventory(ctx, layout, state) {
  const { playerImage = null, hoverX = null, hoverY = null, drag = null } = state || {};
  const { panel, title, close } = layout;

  ctx.save();
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#3a3a4e";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  // Title bar.
  ctx.fillStyle = "rgba(30,30,45,0.95)";
  ctx.fillRect(title.x, title.y, title.w, title.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "14px monospace";
  ctx.fillText(`Inventory  (${layout.used}/${layout.capacity})`, title.x + 12, title.y + 8);
  ctx.fillStyle = "rgba(120,40,40,0.9)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText("X", close.x + 6, close.y + 3);

  // Character preview: the player sprite scaled into its box, or the same
  // placeholder the world draws when the image has not loaded.
  const p = layout.preview;
  ctx.fillStyle = "rgba(20,20,32,0.9)";
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.strokeStyle = "#3a3a4e";
  ctx.strokeRect(p.x, p.y, p.w, p.h);
  if (playerImage) ctx.drawImage(playerImage, p.x + 8, p.y + 8, p.w - 16, p.h - 16);

  // Paperdoll.
  ctx.font = "11px monospace";
  for (const s of layout.slots) {
    ctx.fillStyle = s.disabled ? "rgba(60,60,70,0.5)" : "rgba(40,40,60,0.85)";
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = s.disabled ? "#3a3a3a" : "#4a9eff";
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = s.disabled ? "#6b7280" : "#e5e7eb";
    ctx.fillText(s.slot, s.x + 5, s.y + 4);
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(s.equippedName || "-", s.x + 5, s.y + 16);
  }

  // Tabs.
  ctx.font = "12px monospace";
  for (const t of layout.tabs) {
    ctx.fillStyle = t.active ? "rgba(74,158,255,0.32)" : "rgba(40,40,60,0.85)";
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.strokeStyle = t.active ? "#4a9eff" : "#3a3a4e";
    ctx.strokeRect(t.x, t.y, t.w, t.h);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(t.label, t.x + 8, t.y + 6);
  }

  // Grid.
  for (const c of layout.cells) {
    const dragged = drag && c.item && drag.itemId === c.item.id;
    ctx.fillStyle = c.item ? (CATEGORY_TINT[c.type && c.type.category] || "rgba(55,55,70,0.9)") : "rgba(25,25,38,0.9)";
    ctx.globalAlpha = dragged ? 0.3 : 1;
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = c.selected ? "#4a9eff" : "#2a2a3a";
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    if (c.item) {
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "14px monospace";
      ctx.fillText(initials(c.type && c.type.name), c.x + 8, c.y + 14);
      if (c.item.quantity > 1) {
        ctx.font = "10px monospace";
        ctx.fillStyle = "#fde68a";
        ctx.fillText(String(c.item.quantity), c.x + c.w - 16, c.y + c.h - 12);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Page arrows.
  ctx.font = "12px monospace";
  for (const [rect, label] of [[layout.pages.prev, "<"], [layout.pages.next, ">"]]) {
    if (!rect) continue;
    ctx.fillStyle = "rgba(40,40,60,0.85)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = "#4a9eff";
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(label, rect.x + 12, rect.y + 6);
  }
  if (layout.pages.count > 1) {
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(`page ${layout.pages.page + 1}/${layout.pages.count}`, layout.pages.x + 84, layout.pages.arrowY + 6);
  }

  // Footer.
  const f = layout.footer;
  ctx.fillStyle = f.autoLootOn ? "rgba(74,158,255,0.28)" : "rgba(40,40,60,0.85)";
  ctx.fillRect(f.autoLoot.x, f.autoLoot.y, f.autoLoot.w, f.autoLoot.h);
  ctx.strokeStyle = "#4a9eff";
  ctx.strokeRect(f.autoLoot.x, f.autoLoot.y, f.autoLoot.w, f.autoLoot.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText(`Auto-loot: ${f.autoLootOn ? "ON" : "OFF"}`, f.autoLoot.x + 8, f.autoLoot.y + 7);
  if (f.drop) {
    ctx.fillStyle = "rgba(120,40,40,0.85)";
    ctx.fillRect(f.drop.x, f.drop.y, f.drop.w, f.drop.h);
    ctx.strokeStyle = "#ef4444";
    ctx.strokeRect(f.drop.x, f.drop.y, f.drop.w, f.drop.h);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText("Drop selected", f.drop.x + 8, f.drop.y + 7);
  }
  ctx.fillStyle = "#fde68a";
  ctx.fillText(`Gold: ${f.gold ?? 0}`, layout.panel.x + layout.panel.w - 200, f.autoLoot.y + 7);

  // Tooltip last, so nothing paints over it. Suppressed mid-drag: the ghost
  // is already following the cursor and two floating boxes read as a glitch.
  if (!drag && hoverX != null && hoverY != null) {
    const cell = layout.cells.find((c) => c.item && inside(c, hoverX, hoverY));
    if (cell) {
      const name = (cell.type && cell.type.name) || "unknown item";
      const stats = statLine(cell.type);
      const w = Math.max(ctx.measureText(name).width, ctx.measureText(stats).width) + 16;
      const h = 38;
      // Clamped to the canvas: a cell on the right-hand column would otherwise
      // push its tooltip off-screen, which is exactly where the last column is.
      const tx = Math.min(hoverX + 12, GAME_WIDTH - w - 4);
      const ty = Math.min(hoverY + 12, GAME_HEIGHT - h - 4);
      ctx.fillStyle = "rgba(10,10,18,0.95)";
      ctx.fillRect(tx, ty, w, h);
      ctx.strokeStyle = "#4a9eff";
      ctx.strokeRect(tx, ty, w, h);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText(name, tx + 8, ty + 5);
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(stats, tx + 8, ty + 20);
    }
  }

  ctx.restore();
}
```

- [ ] **Step 4: Replace RenderSystem.renderInventory with a delegate**

In `RenderSystem.js`, add to the imports at the top:

```js
import { layoutInventory, drawInventory } from "./inventoryPanel.js";
```

Replace the whole body of `renderInventory` (the method starting at line 1220) with:

```js
  // Delegates to systems/inventoryPanel.js: layout is pure and unit-tested
  // there, this method only forwards state and republishes the hit areas the
  // layout produced so Game can hit-test this same frame.
  renderInventory(ctx, inventory, hitAreas, selectedItemId = null, autoLoot = false, view = null) {
    const v = view || {};
    const state = {
      inventory,
      selectedItemId,
      autoLoot,
      tab: v.tab || "all",
      page: v.page || 0,
      gold: v.gold ?? 0,
      drag: v.drag || null,
      hoverX: v.hoverX ?? null,
      hoverY: v.hoverY ?? null,
      playerImage: this.imageManager ? this.imageManager.get("player") : null,
    };
    const layout = layoutInventory(state);
    for (const a of layout.hitAreas) hitAreas.push(a);
    drawInventory(ctx, layout, state);
    return layout;
  }
```

Update the call site at `RenderSystem.js:314`:

```js
      this._invLayout = this.renderInventory(this.ctx, inventory, this._invHitAreas, selectedItemId, autoLoot, inventoryView);
```

and add `inventoryView = null` to the destructured render arguments alongside `inventoryOpen` (line 148).

- [ ] **Step 5: Wire Game's new view state and click routing**

In `Game.js`, beside `this.inventoryDrag = null;` in both the constructor and the join reset, add:

```js
        this.inventoryTab = 'all';
        this.inventoryPage = 0;
```

In the render state object (`Game.js:866`), add after `selectedItemId`:

```js
                inventoryView: {
                    tab: this.inventoryTab,
                    page: this.inventoryPage,
                    gold: this.gold,
                    drag: this.inventoryDrag,
                    hoverX: this._cursorX ?? null,
                    hoverY: this._cursorY ?? null,
                },
```

In `_handleInventoryClick`, add before the `autoloot` arm:

```js
        if (hit.kind === 'invclose') { this.closeInventory(); return; }
        if (hit.kind === 'invtab') {
            // Page resets with the tab: page 3 of All is very likely past the
            // end of Stones, and the layout would clamp it to 0 anyway — doing
            // it here keeps the state and the render agreeing.
            this.inventoryTab = hit.id;
            this.inventoryPage = 0;
            return;
        }
        if (hit.kind === 'invpage') { this.inventoryPage = hit.id; return; }
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/inventoryPanelDraw.test.js`
Expected: PASS.

- [ ] **Step 7: Run the whole frontend game suite for regressions**

Run: `cd frontend && npx vitest run src/games/something2`
Expected: PASS. The old inventory rendering had no dedicated test file, but `escapeKey`, `shopPanel`, `bankPanel` and `movementKeys` all construct `Game`/`RenderSystem` and must stay green.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/inventoryPanel.js frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/systems/__tests__/inventoryPanelDraw.test.js
git commit -m "feat(inventory): draw the grid panel and delegate from RenderSystem"
```

---

### Task 5: Per-character capacity column and wire field

**Files:**
- Create: `backend/migrations/<timestamp>_inventory_slots.js`
- Modify: `backend/src/services/characters.js:77-85`
- Modify: `backend/src/authority/server.js:1415`, `:1512-1521`
- Modify: `frontend/src/games/something2/src/js/core/inventory.js` (`applyJoined`)
- Test: `backend/tests/inventory_capacity_db.test.js`, `frontend/src/games/something2/src/js/core/__tests__/inventory.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `characters.inventory_slots INT NOT NULL DEFAULT 48`
  - `ownedCharacter(...)` resolves `{ id, entityTypeId, inventorySlots }`
  - `joined` frame carries `inventorySlots`
  - client `inventory.capacity` (number or `null`)
  - Tasks 6-8 read the capacity through `inv.capacity`, which server.js sets on the loaded inventory.

- [ ] **Step 1: Pick a free migration timestamp**

Run: `ls backend/migrations | sort | tail -3`
Take a timestamp strictly greater than the highest shown (today that means greater than `1714440410000`) and use it for the filename below. Do not reuse a timestamp that already exists on another branch — see `docs/` on the migration-order repair script if `migrate:up` complains.

- [ ] **Step 2: Write the failing test**

Create `backend/tests/inventory_capacity_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { ownedCharacter } = require('../src/services/characters');

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });

test.after(async () => { await pool.end(); });

test('characters carry an inventory_slots capacity defaulting to 48', async () => {
  const col = await pool.query(
    `SELECT column_default, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_name = 'characters' AND column_name = 'inventory_slots'`,
  );
  assert.strictEqual(col.rowCount, 1, 'characters.inventory_slots must exist');
  assert.strictEqual(col.rows[0].is_nullable, 'NO');
  assert.match(String(col.rows[0].column_default), /48/);
});

test('ownedCharacter resolves the capacity for the owning user only', async () => {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`cap_test_${Date.now()}`],
  );
  const userId = u.rows[0].id;
  const et = await pool.query(`SELECT id FROM entity_types WHERE is_playable = true LIMIT 1`);
  const c = await pool.query(
    `INSERT INTO characters (user_id, name, entity_type_id, slot) VALUES ($1,'CapTest',$2,1) RETURNING id`,
    [userId, et.rows[0].id],
  );
  const characterId = c.rows[0].id;
  try {
    const mine = await ownedCharacter(pool, userId, characterId);
    assert.strictEqual(mine.inventorySlots, 48);
    assert.strictEqual(await ownedCharacter(pool, userId + 999999, characterId), null);
  } finally {
    await pool.query('DELETE FROM characters WHERE id = $1', [characterId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});
```

Add to `frontend/.../core/__tests__/inventory.test.js`:

```js
  it('mirrors the server capacity from the join frame', () => {
    const inv = createInventory();
    applyJoined(inv, { itemTypes: [], items: [], equipment: {}, inventorySlots: 96 });
    expect(inv.capacity).toBe(96);
  });

  it('leaves capacity null when the server sends none, rather than inventing one', () => {
    const inv = createInventory();
    applyJoined(inv, { itemTypes: [], items: [], equipment: {} });
    expect(inv.capacity).toBeNull();
  });
```

- [ ] **Step 3: Run both tests and confirm they fail**

Run: `cd backend && node --test --test-timeout=420000 tests/inventory_capacity_db.test.js`
Expected: FAIL — `characters.inventory_slots must exist`.

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/inventory.test.js`
Expected: FAIL — `inv.capacity` is `undefined`.

- [ ] **Step 4: Write the migration**

Create `backend/migrations/<timestamp>_inventory_slots.js`:

```js
// Per-CHARACTER carry limit. A column rather than a constant because the cap
// is meant to grow (bags, class perks) without a schema change and without a
// second source of truth: authority/items.js reads this value and nothing
// else. 48 matches the panel's page size, so a default-capacity inventory is
// exactly one page.
exports.up = (pgm) => {
  pgm.addColumn('characters', {
    inventory_slots: { type: 'integer', notNull: true, default: 48 },
  });
  pgm.addConstraint('characters', 'characters_inventory_slots_positive',
    'CHECK (inventory_slots > 0)');
};

exports.down = (pgm) => {
  pgm.dropConstraint('characters', 'characters_inventory_slots_positive');
  pgm.dropColumn('characters', 'inventory_slots');
};
```

- [ ] **Step 5: Apply it to the scratch database**

Run: `cd backend && DATABASE_URL=$TEST_DATABASE_URL npm run migrate:up`
Expected: the new migration applies. If it reports "Not run migration X is preceding Y", the ledger needs `backend/scripts/repair-migration-order.js` — never `--no-check-order`.

- [ ] **Step 6: Carry the value through the join path**

In `backend/src/services/characters.js`, widen `ownedCharacter`:

```js
  const r = await pool.query(
    'SELECT id, entity_type_id, inventory_slots FROM characters WHERE id = $1 AND user_id = $2',
    [id, userId]);
  if (!r.rows.length) return null;
  return {
    id: r.rows[0].id,
    entityTypeId: r.rows[0].entity_type_id,
    inventorySlots: Number(r.rows[0].inventory_slots),
  };
```

In `backend/src/authority/server.js`, immediately after each `loadInventory` result is assigned (line 1415 and the re-load at 1422), attach the capacity so every downstream rule reads it off the inventory it is already holding:

```js
        inv.capacity = character.inventorySlots;
```

(place it after the `if (granted) inv = await loadInventory(...)` line as well, or once after that block — the value must survive the re-load.)

Add to the `joined` frame beside `equipment` (line 1521):

```js
          // The client renders used/capacity in the panel title. Nothing in
          // play changes the cap, so it rides the join frame only; a client
          // that receives no value shows the used count alone rather than
          // inventing a limit.
          inventorySlots: inv.capacity,
```

In `frontend/.../core/inventory.js` `applyJoined`, add before the `return inv;`:

```js
  // Mirrors the server cap for display and for nothing else: every rejection
  // is the server's, and a forged value here can authorize no extra item.
  // Null (not a default) when absent, so the panel can tell "no cap known"
  // apart from a real one.
  inv.capacity = Number.isInteger(msg.inventorySlots) && msg.inventorySlots > 0
    ? msg.inventorySlots : null;
```

- [ ] **Step 7: Run both tests and confirm they pass**

Run: `cd backend && node --test --test-timeout=420000 tests/inventory_capacity_db.test.js`
Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/inventory.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/migrations backend/src/services/characters.js backend/src/authority/server.js backend/tests/inventory_capacity_db.test.js frontend/src/games/something2/src/js/core/inventory.js frontend/src/games/something2/src/js/core/__tests__/inventory.test.js
git commit -m "feat(inventory): per-character carry capacity, carried to the client"
```

---

### Task 6: The capacity rule and the pickup path

**Files:**
- Modify: `backend/src/authority/items.js` (helpers + exports)
- Modify: `backend/src/authority/loot.js:260-313` (`claimItem`)
- Modify: `backend/src/authority/server.js:1847-1863` (`pickup`), `:2495-2535` (auto-loot sweep)
- Test: `backend/tests/inventory_capacity.test.js`

**Interfaces:**
- Consumes: `inv.capacity` (Task 5).
- Produces:
  - `DEFAULT_INVENTORY_SLOTS = 48`
  - `usedSlots(inv, itemTypes) -> number`
  - `capacityOf(inv) -> number`
  - `freeSlots(inv, itemTypes) -> number`
  - `hasFreeSlot(inv, itemTypes) -> boolean`
  - `claimItem(...)` resolves `{ full: true }` when the inventory is full (instead of `{id, typeId, quantity}`), having touched no row.
  - Tasks 7 and 8 call `freeSlots` / `hasFreeSlot`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/inventory_capacity.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { usedSlots, capacityOf, freeSlots, hasFreeSlot, DEFAULT_INVENTORY_SLOTS } = require('../src/authority/items');
const { claimItem } = require('../src/authority/loot');

const TYPES = new Map([
  [1, { id: 1, name: 'short sword', category: 'weapon' }],
  [2, { id: 2, name: 'arrow', category: 'ammo' }],
  [3, { id: 3, name: 'gold', category: 'currency' }],
]);

function inv(items, capacity) {
  return { items, equipment: {}, capacity };
}

test('usedSlots counts stacks, not quantities', () => {
  const i = inv([{ id: 'a', typeId: 2, quantity: 40 }, { id: 'b', typeId: 2, quantity: 40 }], 48);
  assert.strictEqual(usedSlots(i, TYPES), 2);
});

test('usedSlots ignores currency', () => {
  const i = inv([{ id: 'g', typeId: 3, quantity: 9999 }, { id: 'a', typeId: 1, quantity: 1 }], 48);
  assert.strictEqual(usedSlots(i, TYPES), 1);
});

test('usedSlots counts an item whose type is not in the catalog', () => {
  assert.strictEqual(usedSlots(inv([{ id: 'x', typeId: 99, quantity: 1 }], 48), TYPES), 1);
});

test('capacityOf falls back to the default for a missing or nonsense value', () => {
  assert.strictEqual(capacityOf(inv([], null)), DEFAULT_INVENTORY_SLOTS);
  assert.strictEqual(capacityOf(inv([], 0)), DEFAULT_INVENTORY_SLOTS);
  assert.strictEqual(capacityOf(inv([], -3)), DEFAULT_INVENTORY_SLOTS);
  assert.strictEqual(capacityOf(inv([], 96)), 96);
});

test('freeSlots never goes negative', () => {
  const items = [];
  for (let n = 0; n < 5; n += 1) items.push({ id: `i${n}`, typeId: 1, quantity: 1 });
  assert.strictEqual(freeSlots(inv(items, 2), TYPES), 0);
  assert.strictEqual(hasFreeSlot(inv(items, 2), TYPES), false);
  assert.strictEqual(hasFreeSlot(inv(items, 6), TYPES), true);
});

// claimItem with a stub pool: a full inventory must not reach the database at
// all, because the claim statement DELETEs the world row as it grants.
function stubEntry(items, capacity) {
  const player = { userId: 'u1', characterId: 7, inv: inv(items, capacity) };
  return {
    claiming: new Set(),
    claimRetryAt: new Map(),
    world: {
      getPlayer: () => player,
      groundItems: { remove() {} },
    },
    _player: player,
  };
}

test('claimItem refuses a full inventory without querying', async () => {
  const items = [];
  for (let n = 0; n < 3; n += 1) items.push({ id: `i${n}`, typeId: 1, quantity: 1 });
  const entry = stubEntry(items, 3);
  entry.world.weapons = TYPES;
  let queried = false;
  const pool = { query: async () => { queried = true; throw new Error('must not query'); } };

  const r = await claimItem(pool, entry, 'u1', 7, 'ground-1');

  assert.deepStrictEqual(r, { full: true });
  assert.strictEqual(queried, false);
  assert.strictEqual(entry._player.inv.items.length, 3);
});

test('claimItem grants when there is room', async () => {
  const entry = stubEntry([], 3);
  entry.world.weapons = TYPES;
  const pool = { query: async () => ({ rowCount: 1, rows: [{ id: 'new-1', item_type_id: 1, quantity: 1 }] }) };

  const r = await claimItem(pool, entry, 'u1', 7, 'ground-1');

  assert.strictEqual(r.id, 'new-1');
  assert.strictEqual(entry._player.inv.items.length, 1);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && node --test --test-timeout=420000 tests/inventory_capacity.test.js`
Expected: FAIL — `usedSlots is not a function`.

- [ ] **Step 3: Add the helpers**

In `backend/src/authority/items.js`, next to `canEquip`:

```js
// Carry limit. ONE definition of "how full is this inventory", called by every
// path that inserts into player_items; a second implementation is how two
// paths end up disagreeing about whether a player is full.
//
// Counts ROWS (stacks), not summed quantity: a stack of 40 arrows occupies one
// slot, which is what the panel draws. Currency is excluded — gold is a wallet
// number, not a carried stack. An item whose type is missing from the catalog
// still counts: it exists in the database, and skipping it would let an
// unknown type become free carrying capacity.
const DEFAULT_INVENTORY_SLOTS = 48;

function usedSlots(inv, itemTypes) {
  let n = 0;
  for (const it of (inv && inv.items) || []) {
    const t = itemTypes ? itemTypes.get(it.typeId) : null;
    if (t && t.category === 'currency') continue;
    n += 1;
  }
  return n;
}

function capacityOf(inv) {
  const c = Number(inv && inv.capacity);
  return Number.isInteger(c) && c > 0 ? c : DEFAULT_INVENTORY_SLOTS;
}

function freeSlots(inv, itemTypes) {
  return Math.max(0, capacityOf(inv) - usedSlots(inv, itemTypes));
}

function hasFreeSlot(inv, itemTypes) {
  return freeSlots(inv, itemTypes) > 0;
}
```

Add all five names to `module.exports`.

- [ ] **Step 4: Enforce it in claimItem**

In `backend/src/authority/loot.js`, add to the top-of-file requires:

```js
const { hasFreeSlot } = require('./items');
```

and insert at the very start of `claimItem`'s body, before the `claimRetryAt` bookkeeping:

```js
  // Checked BEFORE the claim statement, which DELETEs the world row in the
  // same breath as it grants: a post-hoc check would have to put the item
  // back. The item stays on the ground and the caller decides what the player
  // sees — a toast for a deliberate pickup, silence for the auto-loot sweep.
  const holder = entry.world.getPlayer(userId);
  if (holder && holder.inv && !hasFreeSlot(holder.inv, entry.world.weapons)) {
    return { full: true };
  }
```

- [ ] **Step 5: Surface it on the two callers**

In `server.js`'s `pickup` handler, replace the claim arm:

```js
          const got = await claimItem(pool, entry, ws.userId, ws.characterId, target.id);
          if (got && got.full) send(ws, { type: 'error', message: 'Inventory full' });
          else if (got) send(ws, { type: 'picked', item: got });
```

In the auto-loot sweep's result loop, skip the sentinel before the `'gold' in r.value` test:

```js
            if (r.status === 'fulfilled' && r.value) {
              // A full inventory is SILENT here. The sweep re-runs at 20Hz for
              // as long as the player stands near the item, so a toast per
              // result would be a stream of them; the panel's used/capacity
              // counter is where a player learns they are full.
              if (r.value.full) continue;
              if ('gold' in r.value) send(sock, { type: 'wallet', gold: r.value.gold });
              else send(sock, { type: 'picked', item: r.value });
            }
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd backend && node --test --test-timeout=420000 tests/inventory_capacity.test.js`
Expected: PASS, all seven tests.

- [ ] **Step 7: Run the neighbouring loot/items suites**

Run: `cd backend && node --test --test-timeout=420000 tests/authority_items_equip.test.js tests/authority_loot*.test.js`
Expected: PASS. (If no `authority_loot*` file exists, run the item/pickup files that `ls backend/tests | grep -i -e loot -e item` reports.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/authority/items.js backend/src/authority/loot.js backend/src/authority/server.js backend/tests/inventory_capacity.test.js
git commit -m "feat(inventory): enforce the carry limit on pickup and auto-loot"
```

---

### Task 7: Capacity on the buy and withdraw paths

**Files:**
- Modify: `backend/src/authority/trade.js:30-95` (`buyItem`)
- Modify: `backend/src/services/accountChest.js:200-250` (`withdrawItem`)
- Test: `backend/tests/inventory_capacity_paths.test.js`

**Interfaces:**
- Consumes: `hasFreeSlot`, `freeSlots` from Task 6.
- Produces: both functions return `{ ok: false, reason: 'Inventory full' }` when the character has no free slot, before any write.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/inventory_capacity_paths.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { buyItem } = require('../src/authority/trade');
const { withdrawItem } = require('../src/services/accountChest');

const TYPES = new Map([[1, { id: 1, name: 'short sword', category: 'weapon' }]]);

function fullEntry(capacity) {
  const items = [];
  for (let n = 0; n < capacity; n += 1) items.push({ id: `i${n}`, typeId: 1, quantity: 1 });
  const player = { userId: 'u1', characterId: 7, gold: 10000, inv: { items, equipment: {}, capacity } };
  return { world: { getPlayer: () => player, weapons: TYPES }, _player: player };
}

// A pool that fails loudly: a full inventory must be rejected before any
// statement runs, so reaching the database at all is the bug.
const forbiddenPool = {
  connect: async () => { throw new Error('must not open a transaction'); },
  query: async () => { throw new Error('must not query'); },
};

test('buying into a full inventory is refused without touching gold', async () => {
  const entry = fullEntry(3);
  const r = await buyItem(forbiddenPool, entry, 'u1', 7, 'stock-1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'Inventory full');
  assert.strictEqual(entry._player.gold, 10000);
});

test('withdrawing into a full inventory is refused without touching the chest', async () => {
  const entry = fullEntry(3);
  const r = await withdrawItem(forbiddenPool, entry, 'u1', 7, 'acct-1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'Inventory full');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && node --test --test-timeout=420000 tests/inventory_capacity_paths.test.js`
Expected: FAIL — `must not open a transaction` (both functions currently connect first).

- [ ] **Step 3: Guard both paths**

In `backend/src/authority/trade.js`, require the helper and add the check immediately after the player is resolved and before `pool.connect()`:

```js
const { hasFreeSlot } = require('./items');
```

```js
  // Before the transaction, so a full inventory never debits gold and never
  // consumes a buyback row. The ROLLBACK would undo both, but a check that
  // relies on rollback to stay correct is one refactor away from not being.
  if (!hasFreeSlot(p.inv, entry.world.weapons)) {
    return { ok: false, reason: 'Inventory full' };
  }
```

In `backend/src/services/accountChest.js` `withdrawItem`, after the `if (!p || !p.inv)` guard and before `pool.connect()`:

```js
  if (!hasFreeSlot(p.inv, entry.world.weapons)) {
    return { ok: false, reason: 'Inventory full' };
  }
```

with `const { hasFreeSlot } = require('../authority/items');` added to that file's requires. Update the stale comment at `accountChest.js:204` ("There is no capacity check either: player_items has no cap today") — it is now false; say the cap exists and is checked above.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd backend && node --test --test-timeout=420000 tests/inventory_capacity_paths.test.js`
Expected: PASS.

- [ ] **Step 5: Run the trade and chest suites**

Run: `cd backend && node --test --test-timeout=420000 $(ls tests/*.test.js | grep -E 'trade|shop|chest|bank')`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/trade.js backend/src/services/accountChest.js backend/tests/inventory_capacity_paths.test.js
git commit -m "feat(inventory): refuse buys and withdrawals into a full inventory"
```

---

### Task 8: Capacity on the chest-open and admin-grant paths

**Files:**
- Modify: `backend/src/authority/chestLoot.js:43-125` (`openChest`)
- Modify: `backend/src/authority/server.js` (`openchest` handler)
- Modify: `backend/src/index.js:1353-1365` (admin grant)
- Test: `backend/tests/inventory_capacity_chest.test.js`

**Interfaces:**
- Consumes: `freeSlots` (Task 6), `spawnDrops` from `authority/loot.js`.
- Produces:
  - `openChest(pool, chestId, characterId, { rng, freeSlots })` — grants at most `freeSlots` items and returns `overflowTypeIds: number[]` for the remainder.
  - The `openchest` handler spawns `overflowTypeIds` on the ground at the chest and toasts once when non-empty.
  - `POST /api/players/:characterId/items` returns `409 {error: 'inventory full'}` at capacity.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/inventory_capacity_chest.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { openChest } = require('../src/authority/chestLoot');

// Records every statement so the test can assert how many grants were issued
// without a database. The queries openChest runs in order are stubbed by
// matching on the leading keyword of each SQL string.
function stubPool({ rolled }) {
  const inserts = [];
  const client = {
    inserts,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rowCount: 1, rows: [] };
      if (s.startsWith('SELECT id, state, kind')) {
        return { rowCount: 1, rows: [{ id: 'chest-1', state: 'unlocked', kind: 'vault', guard_creature_ids: [], guard_level: 1 }] };
      }
      if (s.startsWith('UPDATE world_chests SET state')) return { rowCount: 1, rows: [{ id: 'chest-1', opened_at: new Date() }] };
      if (s.startsWith('SELECT item_type_id, chance')) {
        return { rowCount: rolled.length, rows: rolled.map((id) => ({ item_type_id: id, chance: 1, min_qty: 1, max_qty: 1 })) };
      }
      if (s.startsWith('INSERT INTO player_items')) {
        inserts.push(params[1]);
        return { rowCount: 1, rows: [{ id: `new-${inserts.length}`, item_type_id: params[1], quantity: 1 }] };
      }
      if (s.startsWith('SELECT') && s.includes('player_progression')) return { rowCount: 1, rows: [{ level: 1, xp: 0 }] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { connect: async () => client, _client: client };
}

test('a chest grants only what fits and reports the overflow', async () => {
  const pool = stubPool({ rolled: [11, 12, 13, 14] });
  const r = await openChest(pool, 'chest-1', 7, { rng: () => 0, freeSlots: 2 });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(pool._client.inserts, [11, 12]);
  assert.deepStrictEqual(r.overflowTypeIds, [13, 14]);
});

test('a chest with room grants everything and overflows nothing', async () => {
  const pool = stubPool({ rolled: [11, 12] });
  const r = await openChest(pool, 'chest-1', 7, { rng: () => 0, freeSlots: 48 });
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(r.overflowTypeIds, []);
});

test('an omitted freeSlots grants everything, so existing callers are unchanged', async () => {
  const pool = stubPool({ rolled: [11, 12, 13] });
  const r = await openChest(pool, 'chest-1', 7, { rng: () => 0 });
  assert.strictEqual(r.items.length, 3);
  assert.deepStrictEqual(r.overflowTypeIds, []);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && node --test --test-timeout=420000 tests/inventory_capacity_chest.test.js`
Expected: FAIL — all four items are inserted; `overflowTypeIds` is `undefined`.

- [ ] **Step 3: Bound the grant loop and report the overflow**

In `backend/src/authority/chestLoot.js`, change the signature:

```js
async function openChest(pool, chestId, characterId, { rng = Math.random, freeSlots = Infinity } = {}) {
```

and replace the grant loop:

```js
    const itemTypeIds = await rollChestLoot(client, chest.guard_level, rng);
    const items = [];
    // The chest is already CAS'd open and cannot be re-opened, so refusing
    // here would destroy the loot. Grant what fits and hand the rest back to
    // the caller to spawn on the ground: the player keeps everything they
    // rolled, and a full inventory costs them a walk, not the reward.
    const overflowTypeIds = [];
    for (const itemTypeId of itemTypeIds) {
      if (items.length >= freeSlots) { overflowTypeIds.push(itemTypeId); continue; }
      const ins = await client.query(
        `INSERT INTO player_items (character_id, item_type_id, quantity)
         VALUES ($1,$2,1) RETURNING id, item_type_id, quantity`,
        [characterId, itemTypeId],
      );
      items.push(ins.rows[0]);
    }
```

Add `overflowTypeIds` to the returned object.

- [ ] **Step 4: Pass the free-slot count in and spawn the overflow**

In `backend/src/authority/server.js`'s `openchest` handler, require `freeSlots` from `./items` alongside the existing item imports, compute it from the opening player, pass it, and spawn what did not fit:

```js
        const room = freeSlots(p.inv, entry.world.weapons);
        const r = await openChest(pool, msg.chestId, ws.characterId, { freeSlots: room });
        // ... existing success handling, then:
        if (r.ok && r.overflowTypeIds && r.overflowTypeIds.length) {
          await spawnDrops(pool, entry, r.overflowTypeIds, chest.x, chest.y, { ttlMs: groundItemTtlMs });
          send(ws, { type: 'error', message: 'Inventory full — some loot dropped on the ground' });
        }
```

Match the surrounding code for how `p`, `chest.x/chest.y` and `spawnDrops`'s exact parameters are named at that call site; `spawnDrops` is already imported in `server.js` for creature death. If its signature does not accept a bare type-id list at a position, adapt the call to whatever `commitCreatureDeath` passes it — do not change `spawnDrops`.

- [ ] **Step 5: Guard the admin grant endpoint**

In `backend/src/index.js`, replace the INSERT in `POST /api/players/:characterId/items` with a capacity-aware version:

```js
    // Admin grants obey the same cap as gameplay. Counted in SQL because this
    // route has no in-memory player to read: it can be called for a character
    // that is offline. Currency is excluded exactly as authority/items.js
    // usedSlots excludes it.
    const room = await pool.query(
      `SELECT c.inventory_slots - COUNT(pi.id) AS free
         FROM characters c
         LEFT JOIN player_items pi ON pi.character_id = c.id
         LEFT JOIN item_types it ON it.id = pi.item_type_id
        WHERE c.id = $1 AND (it.category IS DISTINCT FROM 'currency' OR pi.id IS NULL)
        GROUP BY c.inventory_slots`,
      [req.params.characterId],
    );
    if (room.rowCount === 1 && Number(room.rows[0].free) <= 0) {
      return res.status(409).json({ error: 'inventory full' });
    }
    const result = await pool.query(
      'INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING *',
      [req.params.characterId, item_type_id],
    );
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `cd backend && node --test --test-timeout=420000 tests/inventory_capacity_chest.test.js`
Expected: PASS.

- [ ] **Step 7: Re-grep for any grant path this plan missed**

Run: `grep -rn "INSERT INTO player_items" backend/src --include=*.js`
Expected: exactly six sites — `loot.js` (guarded, Task 6), `chestLoot.js` (bounded, this task), `trade.js` and `accountChest.js` (guarded, Task 7), `index.js` (guarded, this task), and `items.js` `grantStartingLoadout` (deliberately exempt: it runs once at character creation, before anything can be carried, and must never fail).

If a seventh site exists, stop and add a step for it here rather than leaving capacity bypassable.

- [ ] **Step 8: Run the chest and API suites**

Run: `cd backend && node --test --test-timeout=420000 $(ls tests/*.test.js | grep -E 'chest|api|item')`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/authority/chestLoot.js backend/src/authority/server.js backend/src/index.js backend/tests/inventory_capacity_chest.test.js
git commit -m "feat(inventory): chest overflow drops to the ground, admin grants respect the cap"
```

---

### Task 9: Drag resolution

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/inventoryPanel.js`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/inventoryDrag.test.js`

**Interfaces:**
- Consumes: `layoutInventory` (Tasks 2-3), `canEquipClient` from `core/inventory.js`.
- Produces: `resolveDrop(layout, drag, point, inventory) -> {action}` where `action` is one of:
  - `{ action: 'equip', itemId, slot }`
  - `{ action: 'unequip', slot }`
  - `{ action: 'drop', itemId }`
  - `{ action: 'none' }`
  `drag` is `{ itemId, from: {kind: 'item'|'slot', id} }`; `point` is `{x, y}` in canvas pixels.
- Task 10 calls it from the mouseup handler.

- [ ] **Step 1: Write the failing test**

Create `inventoryDrag.test.js`:

```js
import { describe, it, expect } from "vitest";
import { layoutInventory, resolveDrop } from "../inventoryPanel.js";

const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };
const HELM = { id: 2, name: "iron helm", category: "armor", slot: "head", defense: 3, resistances: {} };

function inv({ items = [], equipment = {}, types = [SWORD, HELM] } = {}) {
  return { types: new Map(types.map((t) => [t.id, t])), items, equipment, ammoCounts: new Map(), capacity: 48 };
}

function centre(rect) { return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }

describe("resolveDrop", () => {
  const i = inv({ items: [{ id: "w", typeId: 1, quantity: 1 }, { id: "h", typeId: 2, quantity: 1 }] });
  const layout = layoutInventory({ inventory: i });
  const mainHand = layout.slots.find((s) => s.slot === "main_hand");
  const head = layout.slots.find((s) => s.slot === "head");

  it("equips a cell dropped on a legal slot", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, centre(mainHand), i);
    expect(r).toEqual({ action: "equip", itemId: "w", slot: "main_hand" });
  });

  it("refuses a cell dropped on an illegal slot", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, centre(head), i);
    expect(r).toEqual({ action: "none" });
  });

  it("unequips a slot dragged into the grid", () => {
    const equipped = inv({ items: [{ id: "h", typeId: 2, quantity: 1 }], equipment: { head: "h" } });
    const l = layoutInventory({ inventory: equipped });
    const r = resolveDrop(l, { itemId: "h", from: { kind: "slot", id: "head" } }, centre(l.cells[10]), equipped);
    expect(r).toEqual({ action: "unequip", slot: "head" });
  });

  it("refuses dragging an empty slot", () => {
    const r = resolveDrop(layout, { itemId: null, from: { kind: "slot", id: "feet" } }, centre(layout.cells[0]), i);
    expect(r).toEqual({ action: "none" });
  });

  it("drops an item dragged outside the panel", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, { x: 5, y: 5 }, i);
    expect(r).toEqual({ action: "drop", itemId: "w" });
  });

  it("refuses a cell dropped on another cell — there is no persisted order to change", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, centre(layout.cells[5]), i);
    expect(r).toEqual({ action: "none" });
  });

  it("refuses a drop onto the panel's own chrome", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, centre(layout.close), i);
    expect(r).toEqual({ action: "none" });
  });

  it("refuses when there is no drag", () => {
    expect(resolveDrop(layout, null, { x: 5, y: 5 }, i)).toEqual({ action: "none" });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/inventoryDrag.test.js`
Expected: FAIL — `resolveDrop` is not exported.

- [ ] **Step 3: Implement resolveDrop**

Append to `inventoryPanel.js`:

```js
// Resolve a finished drag against the layout it started on. PURE, so every
// outcome is a unit test rather than a mouse gesture. The caller (Game) turns
// the returned action into a wire message; nothing here talks to the server,
// and `canEquipClient` here only suppresses a request the server would
// refuse anyway.
export function resolveDrop(layout, drag, point, inventory) {
  if (!drag || !drag.from) return { action: "none" };
  const { x, y } = point || {};
  if (typeof x !== "number" || typeof y !== "number") return { action: "none" };

  const onSlot = layout.slots.find((s) => inside(s, x, y)) || null;
  const onCell = layout.cells.find((c) => inside(c, x, y)) || null;
  const onPanel = inside(layout.panel, x, y);

  if (drag.from.kind === "item") {
    if (onSlot) {
      if (drag.itemId == null) return { action: "none" };
      if (!canEquipClient(inventory, drag.itemId, onSlot.slot)) return { action: "none" };
      return { action: "equip", itemId: drag.itemId, slot: onSlot.slot };
    }
    // Cell-to-cell is deliberately inert: player_items carries no slot index,
    // so a rearrangement would vanish on the next join. Better to refuse than
    // to animate a change the server will forget.
    if (onCell || onPanel) return { action: "none" };
    return { action: "drop", itemId: drag.itemId };
  }

  if (drag.from.kind === "slot") {
    if (drag.itemId == null) return { action: "none" };  // dragging an empty slot
    if (onCell) return { action: "unequip", slot: drag.from.id };
    return { action: "none" };
  }

  return { action: "none" };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/inventoryDrag.test.js`
Expected: PASS, all eight tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/inventoryPanel.js frontend/src/games/something2/src/js/systems/__tests__/inventoryDrag.test.js
git commit -m "feat(inventory): pure drag resolution for equip, unequip and drop"
```

---

### Task 10: Mouse plumbing for drag and drop

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (`_mouseDownHandler`, `_mouseMoveHandler`, new `_mouseUpHandler`, `destroy`/teardown at `:704`)
- Modify: `frontend/src/games/something2/src/js/systems/inventoryPanel.js` (ghost drawing)
- Test: `frontend/src/games/something2/src/js/core/__tests__/inventoryDragInput.test.js`

**Interfaces:**
- Consumes: `resolveDrop` (Task 9), `Game.closeInventory` (Task 1), `authorityClient.sendEquip/sendUnequip/sendDrop`.
- Produces: `Game.inventoryDrag = { itemId, from, x, y, startX, startY, armed } | null`, and a `mouseup` listener registered and torn down beside the existing `mousemove`/`mousedown`.

- [ ] **Step 1: Write the failing test**

Create `inventoryDragInput.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Game } from "../Game.js";
import { layoutInventory } from "../../systems/inventoryPanel.js";

const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };

function makeGame() {
  const g = new Game();
  g.canvas = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    width: 1280,
    height: 720,
  };
  g.state = "playing";
  g.chunked = true;
  g.inventory = {
    types: new Map([[1, SWORD]]),
    items: [{ id: "w", typeId: 1, quantity: 1 }],
    equipment: {},
    ammoCounts: new Map(),
    capacity: 48,
  };
  g.inventoryOpen = true;
  g.authorityClient = { sendEquip: vi.fn(), sendUnequip: vi.fn(), sendDrop: vi.fn(), sendAttack: vi.fn() };
  const layout = layoutInventory({ inventory: g.inventory });
  g.renderSystem = { _invHitAreas: layout.hitAreas, _invLayout: layout };
  g.setupInput();
  return { g, layout };
}

function at(rect) { return { clientX: rect.x + rect.w / 2, clientY: rect.y + rect.h / 2, button: 0 }; }

describe("inventory drag input", () => {
  let originalWindow;
  beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  });
  afterEach(() => { globalThis.window = originalWindow; });

  it("a press with no movement still selects, and starts no drag", () => {
    const { g, layout } = makeGame();
    const cell = layout.cells[0];
    g._mouseDownHandler(at(cell));
    g._mouseUpHandler(at(cell));
    expect(g.inventorySelectedItemId).toBe("w");
    expect(g.inventoryDrag).toBeNull();
    expect(g.authorityClient.sendEquip).not.toHaveBeenCalled();
  });

  it("a press, a move past the threshold and a release on a slot equips", () => {
    const { g, layout } = makeGame();
    const cell = layout.cells[0];
    const slot = layout.slots.find((s) => s.slot === "main_hand");
    g._mouseDownHandler(at(cell));
    g._mouseMoveHandler({ clientX: cell.x + cell.w / 2 + 20, clientY: cell.y + cell.h / 2 + 20 });
    expect(g.inventoryDrag.armed).toBe(true);
    g._mouseUpHandler(at(slot));
    expect(g.authorityClient.sendEquip).toHaveBeenCalledWith("w", "main_hand");
    expect(g.inventoryDrag).toBeNull();
  });

  it("a drag released outside the panel drops the item", () => {
    const { g, layout } = makeGame();
    const cell = layout.cells[0];
    g._mouseDownHandler(at(cell));
    g._mouseMoveHandler({ clientX: 10, clientY: 10 });
    g._mouseUpHandler({ clientX: 10, clientY: 10, button: 0 });
    expect(g.authorityClient.sendDrop).toHaveBeenCalledWith("w");
  });

  it("a drag that moved less than the threshold does not arm", () => {
    const { g, layout } = makeGame();
    const cell = layout.cells[0];
    g._mouseDownHandler(at(cell));
    g._mouseMoveHandler({ clientX: cell.x + cell.w / 2 + 2, clientY: cell.y + cell.h / 2 + 1 });
    expect(g.inventoryDrag.armed).toBe(false);
  });

  it("closing the panel mid-drag resolves nothing", () => {
    const { g, layout } = makeGame();
    const cell = layout.cells[0];
    g._mouseDownHandler(at(cell));
    g._mouseMoveHandler({ clientX: 10, clientY: 10 });
    g.closeInventory();
    g._mouseUpHandler({ clientX: 10, clientY: 10, button: 0 });
    expect(g.authorityClient.sendDrop).not.toHaveBeenCalled();
  });

  it("a press with the panel shut still attacks", () => {
    const { g } = makeGame();
    g.inventoryOpen = false;
    g.player = { x: 0, y: 0, width: 64, height: 64 };
    g._mouseDownHandler({ clientX: 100, clientY: 100, button: 0 });
    expect(g.authorityClient.sendAttack).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/inventoryDragInput.test.js`
Expected: FAIL — `g._mouseUpHandler is not a function`.

- [ ] **Step 3: Rework the mouse handlers**

In `Game.js`, add the import:

```js
import { resolveDrop } from '../systems/inventoryPanel.js';
```

Add the threshold constant near the top of the file, beside the other module constants:

```js
// A press that never travels this far is a CLICK, not a drag. Without the
// threshold every click on a cell would arm a drag and the old select-then-
// click-a-slot flow would stop working.
const DRAG_THRESHOLD_PX = 4;
```

Replace the inventory arm of `_mouseDownHandler`:

```js
            if (this.inventoryOpen) {
                const x = this._cursorX ?? 0, y = this._cursorY ?? 0;
                const areas = (this.renderSystem && this.renderSystem._invHitAreas) || [];
                const hit = areas.find((a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h);
                // A press on a cell or an occupied slot is a drag CANDIDATE:
                // it arms only once the pointer travels, and the click it
                // would otherwise have been is issued on mouseup instead.
                if (hit && (hit.kind === 'item' || hit.kind === 'slot')) {
                    const itemId = hit.kind === 'item' ? hit.id : (this.inventory.equipment[hit.id] ?? null);
                    this.inventoryDrag = {
                        itemId, from: { kind: hit.kind, id: hit.id },
                        x, y, startX: x, startY: y, armed: false,
                    };
                    return;
                }
                this._handleInventoryClick(x, y);
                return;
            }
```

Extend `_mouseMoveHandler`, after it updates `_cursorX`/`_cursorY`:

```js
            if (this.inventoryDrag) {
                this.inventoryDrag.x = this._cursorX;
                this.inventoryDrag.y = this._cursorY;
                const dx = this._cursorX - this.inventoryDrag.startX;
                const dy = this._cursorY - this.inventoryDrag.startY;
                if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) this.inventoryDrag.armed = true;
            }
```

Add the new handler beside the others:

```js
        this._mouseUpHandler = (e) => {
            if (e.button !== 0) return;
            const drag = this.inventoryDrag;
            if (!drag) return;
            this.inventoryDrag = null;
            // The panel closed while the button was down (Escape, or the
            // world changed under us): there is no layout left to resolve
            // against, so the gesture is simply dropped.
            if (!this.inventoryOpen) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
            const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);

            if (!drag.armed) {
                // Never travelled: this was a click all along.
                this._handleInventoryClick(drag.startX, drag.startY);
                return;
            }
            const layout = this.renderSystem && this.renderSystem._invLayout;
            if (!layout || !this.authorityClient) return;
            const r = resolveDrop(layout, drag, { x, y }, this.inventory);
            if (r.action === 'equip') { this.authorityClient.sendEquip(r.itemId, r.slot); this.inventorySelectedItemId = null; }
            else if (r.action === 'unequip') this.authorityClient.sendUnequip(r.slot);
            else if (r.action === 'drop') { this.authorityClient.sendDrop(r.itemId); this.inventorySelectedItemId = null; }
        };
```

Register and tear it down alongside the existing canvas listeners (`setupInput`'s tail and the teardown at `Game.js:704`):

```js
        this.canvas.addEventListener('mouseup', this._mouseUpHandler);
```
```js
        if (this._mouseUpHandler) this.canvas.removeEventListener('mouseup', this._mouseUpHandler);
```

- [ ] **Step 4: Draw the drag ghost**

At the very end of `drawInventory` in `inventoryPanel.js` (after the tooltip block, before `ctx.restore()`):

```js
  // Ghost last so it rides above every panel element it passes over.
  if (drag && drag.armed && drag.itemId != null) {
    const src = layout.cells.find((c) => c.item && c.item.id === drag.itemId);
    const label = src && src.type ? initials(src.type.name) : "??";
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = src && src.type ? (CATEGORY_TINT[src.type.category] || "rgba(55,55,70,0.9)") : "rgba(55,55,70,0.9)";
    ctx.fillRect(drag.x - CELL / 2, drag.y - CELL / 2, CELL, CELL);
    ctx.strokeStyle = "#4a9eff";
    ctx.strokeRect(drag.x - CELL / 2, drag.y - CELL / 2, CELL, CELL);
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "14px monospace";
    ctx.fillText(label, drag.x - CELL / 2 + 8, drag.y - 8);
    ctx.globalAlpha = 1;
  }
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/inventoryDragInput.test.js`
Expected: PASS, all six tests.

- [ ] **Step 6: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/systems/inventoryPanel.js frontend/src/games/something2/src/js/core/__tests__/inventoryDragInput.test.js
git commit -m "feat(inventory): drag items onto slots, off slots and out of the panel"
```

---

### Task 11: Browser verification

**Files:**
- No source files by default. Any defect this task finds is fixed here, with a regression test added to the file that should have caught it.

**Interfaces:**
- Consumes: everything above.
- Produces: a verification record in the Plane epic's closing comment.

- [ ] **Step 1: Run the stack against a scratch database and log in**

`make dev`, then open `http://localhost:15173`, register or log in, and enter the world. Confirm the bundle is fresh — a stale vite module is the classic false pass here; if the panel looks unchanged, re-run `make dev` rather than assuming the code is wrong.

- [ ] **Step 2: Walk the flows and record each outcome**

1. Press `i` — the window renders with chrome, preview, paperdoll, tabs, grid, gold and an `(n/48)` counter.
2. Hover a filled cell — the tooltip shows the name and stat line, and a cell in the rightmost column keeps its tooltip on screen.
3. Click each tab — the grid filters; gold never appears as a cell.
4. Drag a weapon onto `main_hand` — it equips; the HUD's weapon name changes.
5. Drag it back off the slot into the grid — it unequips.
6. Drag an item outside the panel — it drops on the ground and can be picked back up.
7. Click a cell without moving — it still selects, and the Drop control appears.
8. Click the title-bar `X` — the panel closes.
9. Press `i`, then `Escape` — the panel closes.
10. Fill the inventory to 48 stacks (drop and re-take, or grant via the admin route) and walk over an item — the counter reads `48/48`, manual pickup toasts `Inventory full`, and auto-loot toasts nothing while standing on the item.
11. Open a chest while full — the loot lands on the ground and one toast explains why.

- [ ] **Step 3: Fix anything the walk found**

For each defect: write the failing test in the file that should have caught it, fix, re-run that file. Do not fix a browser defect without a test — a defect a green suite missed is exactly the kind that comes back.

- [ ] **Step 4: Run both suites once, at the end**

Run: `cd frontend && npx vitest run`
Run: `cd backend && node --test --test-timeout=420000 $(ls tests/*.test.js)` with `DATABASE_URL` and `TEST_DATABASE_URL` both pointing at the scratch database, both map specs seeded (vale-region LAST).
Expected: PASS.

- [ ] **Step 5: Commit anything the fixes touched**

```bash
git add -A -- frontend backend
git commit -m "fix(inventory): defects found in browser verification"
```

---

## Notes for the executor

- The panel geometry constants in Task 2 are a starting point, not a specification. The tests assert relationships (nothing overlaps, everything is inside the panel, columns are evenly spaced); tune the numbers until those hold and the panel reads well in the browser.
- `RenderSystem._invLayout` is the bridge between rendering and the mouse handlers. It is written once per frame while the panel is open; a handler that runs when the panel is shut must not trust it (Task 10 guards this).
- Capacity is a server rule. The client's counter is decoration; every test that proves the rule lives in `backend/tests`.
