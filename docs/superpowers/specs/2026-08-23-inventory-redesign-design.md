# Inventory panel redesign — design

Date: 2026-08-23
Status: approved (design), plan pending

## Goal

Replace the canvas inventory panel's text list with a slot-grid window in the
style of a classic MMO inventory: window chrome with a close button, a
character preview ringed by paperdoll slots, category tabs, a grid of icon
cells with quantity badges, a used/capacity counter and a gold footer. Add
drag-and-drop equipping, a hover tooltip, and a real server-enforced carry
limit. Confirm (and fix, if live behaviour disagrees with the green test) that
Escape closes the panel.

Reference: an MMO inventory screenshot supplied by the user — 8-wide icon
grid, `(72/98)` counter in the title bar, tab strip, gold in the footer,
paperdoll + character render on the left.

## Non-goals

- Real item artwork. `item_types` has no icon column; cells render a
  category-tinted tile with two-letter initials. Generated item sprites are a
  separate epic.
- Equipment shown on the character preview. Player sprites do not carry gear.
- Persisted slot ordering / rearranging. There is no server-side slot index
  for `player_items`, so a drag that "reorders" would not survive a rejoin.
- Any change to the shop or bank panels beyond what capacity enforcement
  forces.

## Current state

- `RenderSystem.renderInventory` (frontend/src/games/something2/src/js/systems/RenderSystem.js:1220)
  draws a labelled slot column plus a text list, pushing
  `{x, y, w, h, kind, id}` records into `this._invHitAreas`; `Game.js`
  hit-tests clicks against that same frame's records.
- Kinds in use today: `slot`, `item`, `drop`, `autoloot`.
- `RenderSystem.js` is 1761 lines. The new panel roughly triples the
  inventory portion, so it moves out.
- No carry limit exists anywhere in the codebase.
- Escape already closes the panel (`Game.js:1019-1030`) and is covered by
  `core/__tests__/escapeKey.test.js`.

## Architecture

### New module: `systems/inventoryPanel.js`

Two exports, split so that every decision is testable without a canvas:

- `layoutInventory(state) -> layout` — **pure**. Given
  `{ inventory, tab, page, selectedItemId, gold, autoLoot, capacity, drag }`
  it returns the panel rect, the chrome buttons, the paperdoll boxes, the tab
  rects, the visible cells (each carrying its item or `null`), the page
  arrows, the footer controls, and a flat `hitAreas` array using the existing
  `{x, y, w, h, kind, id}` record shape.
- `drawInventory(ctx, layout, state)` — draws the returned layout. Decides
  nothing; every rect it paints came from `layoutInventory`.

`RenderSystem.renderInventory` becomes a delegate: call `layoutInventory`,
push `layout.hitAreas` into the caller's array, call `drawInventory`. The
hit-area contract Game.js consumes does not change shape.

New hit-area kinds: `invclose` (title-bar X), `invtab` (id = tab key),
`invpage` (id = page index). Existing kinds keep their meaning and their
handlers.

### Layout

Panel 820x580, centred as today.

- **Title bar**: `Inventory` on the left, `(used/capacity)` centred, `[X]`
  right (`kind:'invclose'`).
- **Left column** (~250px): the local player's idle sprite drawn at 3x in the
  middle, with the eight `SLOTS` boxes arranged around it. A slot box shows
  the equipped type's name, greys out when `canEquipClient` rejects the
  current selection or drag payload, and stays `kind:'slot'`.
- **Right column**: tab strip, then the grid, then the footer.
- **Tabs**: `All`, `Equip` (`weapon`, `armor`), `Supply` (`ammo`,
  `consumable`), `Stones` (`stone`). Category `currency` never appears in the
  grid — gold is the footer number. An item whose category matches no tab
  still appears under `All`, so a category added server-side is visible
  rather than invisible.
- **Grid**: 8 columns x 6 rows = 48 cells, 44px cells, 4px gutter. A cell
  draws a category-tinted tile, the type name's first two letters, a quantity
  badge in the bottom-right when `quantity > 1`, and a selection ring when
  `item.id === selectedItemId`. Empty cells draw the empty-slot tile.
- **Paging**: when a tab's filtered items exceed 48, page arrows appear under
  the grid (`kind:'invpage'`). Page resets to 0 on tab change and clamps when
  the item list shrinks under it.
- **Footer**: `Gold: N`, the auto-loot toggle (unchanged `kind:'autoloot'`),
  and the Drop button (unchanged `kind:'drop'`, still only while an item is
  selected).
- **Tooltip**: hovering a filled cell while not dragging draws a floating box
  with the type name and the same stat line the old list rendered (weapon:
  `dmg/cd/2H`; armor: `def` + resistances). Tooltip is clamped to the canvas
  so it never draws off-screen.

### Drag and drop

State lives on `Game` as `this.inventoryDrag = { itemId, from, x, y } | null`,
passed into the render state.

- `mousedown` on a cell records a candidate; the drag arms only after the
  pointer moves more than 4px, so a plain click still selects exactly as it
  does today.
- `mousemove` updates the ghost position; `drawInventory` paints the dragged
  cell under the cursor at 70% alpha.
- `mouseup` resolves through a second pure function,
  `resolveDrop(layout, drag, point) -> {action, ...}`:
  - cell -> paperdoll slot => `{action:'equip', itemId, slot}`
  - paperdoll slot -> anywhere in the grid => `{action:'unequip', slot}`
  - cell -> outside the panel rect => `{action:'drop', itemId}`
  - cell -> cell, or any target that `canEquipClient` rejects =>
    `{action:'none'}`
- `Game` maps those actions onto the existing `sendEquip` / `sendUnequip` /
  `sendDrop` calls. `canEquipClient` only tints the cursor and suppresses a
  doomed request; the server remains authoritative for equip legality.
- A drag that ends while the panel closed (Escape mid-drag) resolves to
  `{action:'none'}`.

### Capacity (server-enforced)

- **Migration**: `characters.inventory_slots INT NOT NULL DEFAULT 48`.
  Per-character rather than a constant so a later bag/upgrade feature has
  somewhere to write. Timestamp must be higher than every migration already
  on main — check the ledger before choosing it.
- **Rule**: capacity counts **rows in `player_items`**, not summed quantity.
  Items whose type category is `currency` are excluded (gold is a counter,
  not a stack).
- **Helper** in `backend/src/authority/items.js`:
  `usedSlots(inv, itemTypes)` and `hasFreeSlot(inv, itemTypes, capacity)`.
  Every grant path calls the helper; none reimplements the count.
- **Enforced grant paths** — all five sites that insert into `player_items`
  for a live character:
  1. `authority/loot.js:276` — ground pickup and auto-loot
  2. `authority/chestLoot.js:117` — world chest take
  3. `authority/trade.js:73` — merchant buy
  4. `services/accountChest.js:234` — bank withdraw
  5. `backend/src/index.js:1358` — the REST grant endpoint
  `authority/items.js:282` (starting loadout, at character creation) is
  exempt: it runs before a character can carry anything and must never fail.
  The implementation re-greps for `INSERT INTO player_items` rather than
  trusting this list.
- **Rejection**: a `type:'error'` frame with `"Inventory full"`, which the
  client already surfaces via `_showToast` (`Game.js:525`). Auto-loot skips a
  full inventory **silently** — no toast per item walked over. Merchant buy
  must reject *before* debiting gold.
- **Wire**: `inventorySlots` rides the `joined` frame and any frame that can
  change it; the client mirrors it on `inventory` and the title bar renders
  `used/capacity`. A client that receives no value falls back to showing the
  used count alone rather than inventing a cap.

### Escape / close

Escape, the new `[X]`, and the `i` toggle all route through one
`Game.closeInventory()` that clears `inventoryOpen`, `inventorySelectedItemId`
and `inventoryDrag`. The existing Escape ordering (shop, then bank, then
inventory) is preserved.

Before any fix is written, the live behaviour is checked in a real browser —
the unit test is green, so if Escape genuinely fails in play the cause is
outside `_keydownHandler`. First suspect: the fullscreen keyboard lock at
`GameShell.jsx:237` / canvas focus. Whatever the browser shows decides
whether this item is a fix or a confirmation.

## Testing

Unit (vitest, no canvas needed):
- `layoutInventory`: cell count and geometry, tab filtering per category,
  currency excluded, unknown category falls into `All`, paging boundaries and
  clamping, hit-area records for every drawn control.
- `resolveDrop`: each of the four outcomes, the reject cases, and the
  closed-panel case.
- Capacity: `usedSlots` ignores currency and counts stacks; each of the five
  grant paths rejects at capacity and succeeds at capacity-1; buy does not
  debit gold on rejection; auto-loot emits no toast when full.
- Escape/close: one `closeInventory` path clears all three fields.

Browser verification (per project practice, a green suite is not acceptance):
open the panel, drag a weapon onto `main_hand`, drag it back off, drag an
item outside to drop it, fill to the cap and confirm the toast and the
counter, press Escape and confirm it closes.

Backend DB tests run against a **scratch database** with both map specs
seeded — never the shared dev database.

## Work split (Plane)

Epic: Inventory panel redesign.

- **D** Escape/close path — browser-verify, then fix or confirm; single
  `closeInventory()`. Independent, goes first.
- **A** Panel skeleton — `inventoryPanel.js`, layout + draw + chrome + tabs +
  grid + tooltip + paging, delegate from `RenderSystem`, click behaviour
  unchanged.
- **B** Capacity backend — migration, helper, five grant paths, wire field,
  client counter.
- **C** Drag and drop — drag state, `resolveDrop`, ghost rendering, Game
  wiring.
- **E** Browser verification and polish — the flows above, plus any defect
  they surface.

Order: D, A, B, C, E. A must land before C (C drags against A's layout); B is
independent of A and C apart from the counter it feeds.

## Risks

- A sixth grant path exists that this design has not found; capacity would
  then be bypassable. Mitigated by re-grepping every `player_items` insert
  during B rather than working from the list above.
- Migration timestamp collisions have bitten this repo repeatedly; check the
  ledger before choosing one.
- Drag input on canvas is the least testable part; `resolveDrop` being pure
  is what keeps it honest, but the pointer plumbing itself only proves out in
  the browser (task E).
