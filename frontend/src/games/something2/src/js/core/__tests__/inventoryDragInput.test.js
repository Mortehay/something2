import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Game } from "../Game.js";
import { layoutInventory } from "../../systems/inventoryPanel.js";

const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };

// The canvas is 1280x720 and getBoundingClientRect matches it, so client
// coordinates map 1:1 onto canvas pixels and the layout's own rects can be
// used as mouse targets directly.
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

  it("dragging an equipped slot into the grid unequips", () => {
    const { g, layout } = makeGame();
    g.inventory.equipment = { main_hand: "w" };
    const l = layoutInventory({ inventory: g.inventory });
    g.renderSystem._invHitAreas = l.hitAreas;
    g.renderSystem._invLayout = l;
    const slot = l.slots.find((s) => s.slot === "main_hand");
    g._mouseDownHandler(at(slot));
    g._mouseMoveHandler({ clientX: l.cells[3].x + 4, clientY: l.cells[3].y + 4 });
    g._mouseUpHandler(at(l.cells[3]));
    expect(g.authorityClient.sendUnequip).toHaveBeenCalledWith("main_hand");
  });

  it("a press with the panel shut still attacks", () => {
    const { g } = makeGame();
    g.inventoryOpen = false;
    g.player = { x: 0, y: 0, width: 64, height: 64 };
    g._mouseDownHandler({ clientX: 100, clientY: 100, button: 0 });
    expect(g.authorityClient.sendAttack).toHaveBeenCalled();
  });

  it("registers and tears down the mouseup listener with the other canvas listeners", () => {
    const { g } = makeGame();
    const kinds = g.canvas.addEventListener.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("mouseup");
  });
});
