# Chest and Merchant Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Account Chest and village merchant open as item-grid windows beside the full inventory, and items move between them by drag and drop.

**Architecture:** `shopOpen` and `bankOpen` stay the only open flags. The inventory is drawn beside them as a derived state, `Game._inventoryVisible()`, and `inventoryOpen` is never set for it, so `_otherPanelOpen` keeps accepting `bank` and `shop` refresh frames. New pure modules hold the window layouts and the drop rules; `Game` turns their results into the existing wire messages. The server gains sell quotes and `enchantLevel` on held items.

**Tech Stack:** Canvas 2D, Vitest (frontend), `node:test` with raw `pg` (backend), WebSocket authority.

**Spec:** [docs/superpowers/specs/2026-11-04-chest-merchant-windows-design.md](../specs/2026-11-04-chest-merchant-windows-design.md)

## Global Constraints

- Work in the worktree `/home/markunn/worker/coding/jsgame/s2-wt-chest-merchant`, branch `feat/chest-merchant-windows`. Never `checkout`, `stash`, `rebase` or `reset` in the main checkout. Link `backend/node_modules` and `frontend/node_modules` to the main checkout.
- Before Task 1, create a Plane work item for this feature with the `plane-workflow` skill. Use its number where commit messages below say `SOMET-NNN`. End each commit message with the `Co-Authored-By` trailer.
- Backend DB tests must set both `TEST_DATABASE_URL` and `DATABASE_URL` to a scratch database for this branch, `game_db_test_chest_merchant`: migrate it, then run `scripts/seed-catalogs.js`, each map's `scripts/seed-map.js`, and `FORCE=1 node scripts/seed-passive-tree.js`. Never run destructive experiments or tests against the shared dev DB. Judge the first run on a freshly seeded DB.
- Read test exit codes, not summary lines. Grep backend output for `^not ok` and `testTimeoutFailure` as well.
- Window sizes: chest or merchant window 408 x 480, gap 6, inventory 820 x 480. `windowX` = 23, `inventoryX` = 437, `y` = 120, on the 1280 x 720 canvas.
- Grids use cell 44 and gutter 4. Chest 8 x 5, capacity 40, no paging. Merchant 8 x 5 with paging above 40 rows.
- The server stays the authority. Client rules only choose hints and suppress sends for worn items and locked wares. Lists change only from server frames.
- No confirmation dialogs, no client-computed sell prices, no list price, no direct drop onto equipment slots from the windows.
- All new player-facing text goes through `t` and has a Ukrainian entry.
- Do not build anything for player-to-player trading.

## Review Focus

- A second drag of the same item before the server replies: the server refuses it, the player sees a toast, nothing duplicates, and later refresh frames still update the window. Owner: Task 6.
- The window closes (Esc, hotkey) while the button is held: the release sends nothing and does not act on whichever window opens next. Owner: Task 6.
- The player walks out of range with the window open and then drags: the server's refusal shows as a toast and the item stays where it was. Owner: Task 6.
- A chest item whose type this client doesn't know: it still occupies a cell and can be taken, because the chest is its only access path. Owner: Task 3.
- Dropping from the chest while the inventory shows page 2, a category tab or the Character tab: the move still happens, with hit areas following the 437 offset. Owner: Tasks 2 and 4.

---

### Task 1: Server sends sell quotes and enchant level

**Files:**
- Modify: `backend/src/services/heldInstance.js` (`HELD_INSTANCE_COLUMNS`, `heldInstanceJoin`, `withHeldInstance`)
- Modify: `backend/src/authority/trade.js` (`sellItem`, price lines around 372-374; exports)
- Modify: `backend/src/authority/server.js` (`interact` handler, the `type: 'shop'` send)
- Test: `backend/tests/merchant_buyback_instance_db.test.js`, `backend/tests/account_chest_instance_db.test.js`, and new `backend/tests/sell_quotes.test.js`

**Interfaces:**
- Produces: `quoteSellPrice(value: number, enchantLevel: number, priceMult: number, standing: number): number` in `trade.js`, the one formula `sellItem` also uses.
- Produces: `async sellQuotes(db, inv, priceMult: number, standing: number): Promise<Record<itemId, number>>` in `trade.js`.
- Produces on the wire: `shop` frame field `sellQuotes`; chest and buyback rows carry `enchantLevel: number` when they hold an instance.

- [ ] **Step 1: Write the failing tests**

In `sell_quotes.test.js`:
- `quoteSellPrice` equals `sellPriceFor(value + sellBonus(level), boostedSellFraction(priceMult, standing, SELL_FRACTION_MAX))` for levels 0 and 5.
- `sellQuotes` omits an item that is worn, `soulbound`, has `quantity !== 1`, or is a stone-category type; it includes a plain carried item.

In `merchant_buyback_instance_db.test.js`:
- `the quote equals what the sale pays`: for an enchanted item at non-zero standing, `sellQuotes(...)[id]` equals `sellItem(...).price`.
- `a buyback row carries the enchant level`: after selling a `+3` item, the `fetchShop` buyback row has `enchantLevel === 3`.

In `account_chest_instance_db.test.js`:
- `a chest row carries the enchant level`: after depositing a `+3` item, the `fetchChest` row has `enchantLevel === 3`.

- [ ] **Step 2: Run to verify they fail**

Run from `backend/`, with both DB variables set: `node --test tests/sell_quotes.test.js tests/merchant_buyback_instance_db.test.js tests/account_chest_instance_db.test.js; echo $?`
Expected: non-zero, with `quoteSellPrice is not a function` and `enchantLevel` undefined.

- [ ] **Step 3: Add `enchantLevel` to held items**

Select `pi.enchant_level` in the lateral join and add `held.enchant_level` to `HELD_INSTANCE_COLUMNS`; both must be in the join's `GROUP BY pi.id`, which already covers `pi` columns. `withHeldInstance` sets `enchantLevel: Number(row.enchant_level ?? 0)`.

- [ ] **Step 4: Implement `quoteSellPrice` and `sellQuotes`, and switch `sellItem` to `quoteSellPrice`**

`sellQuotes` reads values with `SELECT id, value, category FROM item_types WHERE id = ANY($1)`, the same source `sellItem` uses.

- [ ] **Step 5: Send quotes in the `shop` frame**

In `interact`, add `sellQuotes: await sellQuotes(pool, p.inv, p.stats.priceMult, standing)`, using the `standing` already loaded there. An item missing from the map shows no price.

- [ ] **Step 6: Run the tests again, plus every existing chest and merchant test**

Run from `backend/`: `node --test tests/sell_quotes.test.js tests/merchant_buyback_instance_db.test.js tests/account_chest_instance_db.test.js tests/account_chest.test.js tests/enchant_db.test.js; echo $?`
Expected: exit 0. An instance-less row keeps its existing wire shape.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/heldInstance.js backend/src/authority/trade.js backend/src/authority/server.js backend/tests
git commit -m "feat(authority): shop frame carries sell quotes, held items carry enchant level (SOMET-NNN)"
```

### Task 2: Inventory window can sit beside another window

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/inventory.js`
- Modify: `frontend/src/games/something2/src/js/systems/inventoryPanel.js` (`layoutInventory`, `drawInventory`)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js`, `inventoryPanelDraw.test.js`

**Interfaces:**
- Produces: `isWorn(inventory, itemId): boolean` in `core/inventory.js`.
- Produces: `layoutInventory` state gains `originX` (default centred) and `paired` (default `false`). Cells gain `worn: boolean`.
- Produces: `drawItemCell(ctx, cell, art, { selected, dimmed, enchantCfg })` where `cell` is `{ x, y, w, h, item, type, worn? }`, and `drawDragGhost(ctx, x, y, type, art)`, both exported from `inventoryPanel.js`.
- Produces: `inside(rect, x, y)` exported from `inventoryPanel.js`.

- [ ] **Step 1: Write the failing tests**

- `originX shifts every rect and hit area`: with `originX: 437`, `panel.x === 437`, and each hit area is the default layout's shifted by `437 - 230`.
- `page and tab areas follow the offset`: with two pages of items and `originX: 437`, the `invpage` and `invtab` areas lie inside `panel`.
- `paired hides Drop selected`: with `selectedItemId` set and `paired: true`, `footer.drop` is null and there is no `drop` hit area.
- `a worn item's cell is marked`: `worn` is true for the id in `equipment` and false for an identical spare.
- `draws the worn marker only on the worn cell`: the recording context sees `t("worn")` once. It also appears in an unpaired inventory.
- `paired skips the ghost`: an armed drag with `paired: true` draws no ghost.

- [ ] **Step 2: Run to verify they fail**

Run from `frontend/`: `npx vitest run src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js src/games/something2/src/js/systems/__tests__/inventoryPanelDraw.test.js; echo $?`
Expected: non-zero.

- [ ] **Step 3: Implement the offset, `paired`, `isWorn`, the marker, and extract `drawItemCell` and `drawDragGhost`**

The marker is the text `worn` in 9 px monospace at the cell's top-left, colour `#67e8f9`. The extraction must not change how an unpaired cell or ghost looks.

- [ ] **Step 4: Run the same tests, then `inventoryDrag.test.js` and `inventoryDragInput.test.js`**

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/inventory.js frontend/src/games/something2/src/js/systems
git commit -m "feat(inventory): offset layout, paired mode and worn marker (SOMET-NNN)"
```

### Task 3: Chest and merchant window layouts

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/storageWindows.js`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/storageWindows.test.js`

**Interfaces:**
- Consumes: `CELL`, `GUTTER`, `PANEL_H` from `inventoryPanel.js`; `buildShopRows`, `priceParts`, `bannerText` from `shopReputation.js`.
- Produces: `WINDOW_W = 408`, `WINDOW_X = 23`, `INVENTORY_X = 437`, `WINDOW_Y = 120`, `WINDOW_CELLS = 40`.
- Produces: `layoutChestWindow({ bank, types })` returns `{ kind: 'chest', panel, title, close, cells, occupancy: { used, capacity, full }, hitAreas }`.
- Produces: `layoutMerchantWindow({ shop, view, gold, types })` returns `{ kind: 'merchant', panel, title, close, banner, tabs, cells, pages, gold, hitAreas }`.
- Cells are `{ x, y, w, h, item, type, price?, locked? }`, with `item` normalised to `typeId`.
- Hit kinds: `winclose`; `chestitem` (`id`, `typeId`); `shoptab` (`id`); `shoppage` (`id`, an absolute page); `stockitem` (`id`, `typeId`, `price`); `lockedware` (`row`).

- [ ] **Step 1: Write the failing tests, carrying over the guarantees of the old panels**

Chest:
- `all 40 stored items have a cell and a hit area with no paging`, with each `chestitem` id equal to the stored row's id.
- `every rect stays inside the window`.
- `an item of unknown type still has a cell and a hit area`.
- `occupancy reports full at capacity`.

Merchant:
- `catalog rows then locked rows, with no header cell`.
- `a stale page clamps to a real page`.
- `61 rows are all reachable by paging, with no repeats or gaps`.
- `merchant rows normalise itemTypeId to typeId`.
- `the buyback tab's cells use the row's id and stored price`.
- `a locked cell's hit kind is lockedware and is never stockitem`.

- [ ] **Step 2: Run to verify they fail**

Run from `frontend/`: `npx vitest run src/games/something2/src/js/systems/__tests__/storageWindows.test.js; echo $?`
Expected: non-zero, module not found.

- [ ] **Step 3: Implement `layoutChestWindow` and `layoutMerchantWindow`**

Pure and in the style of `layoutInventory`. Grid at `x = WINDOW_X + 14`. Keep a tab-row-height "Stored" label in the chest so both windows' grids start at the same `y` when there is no reputation banner.

- [ ] **Step 4: Run the test**

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/storageWindows.js frontend/src/games/something2/src/js/systems/__tests__/storageWindows.test.js
git commit -m "feat(ui): chest and merchant window layouts (SOMET-NNN)"
```

### Task 4: Drop rules

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/pairedDrop.js`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/pairedDrop.test.js`

**Interfaces:**
- Consumes: `layoutChestWindow`, `layoutMerchantWindow` results; `layoutInventory` result; `isWorn`, `inside`, `capacityOf`, `usedSlotsClient`.
- Produces: `resolvePairedDrop({ drag, point, winLayout, invLayout, inventory, sellQuotes, gold })` returning `{ action, id?, slot?, message?, hint?, target? }`.
- `action` is one of `none`, `store`, `take`, `buy`, `sell`, `equip`, `unequip`, `refuse`.
- `hint` is present only when the drop is expected to succeed; `target` is `'window'` or `'inventory'` and accompanies `hint`.
- `drag.from.kind` is one of `item`, `slot`, `chestitem`, `stockitem`.

- [ ] **Step 1: Write the failing table test**

| From | Dropped on | Condition | Result |
|---|---|---|---|
| `item` | window, chest | | `store`, hint `Store in chest` |
| `item` | window, chest | chest full | `store`, no hint |
| `item` | window, merchant | has quote 40 | `sell`, hint `Sell for 40 g` |
| `item` | window, merchant | bound, stacked or no quote | `sell`, no hint |
| `item` | window, either | worn | `refuse`, message `unequip it first`, no hint |
| `slot` | window, either | occupied | `refuse`, message `unequip it first`, no hint |
| `slot` | inventory cell | occupied | `unequip` |
| `item` | equipment slot | can equip | `equip` |
| `item` | inventory cell or chrome | | `none` |
| `chestitem` | inventory, away from slots | | `take`, hint `Take` |
| `chestitem` | inventory | inventory full | `take`, no hint |
| `stockitem` | inventory, away from slots | price 120, gold 500 | `buy`, hint `Buy for 120 g` |
| `stockitem` | inventory | gold 50, or inventory full | `buy`, no hint |
| `chestitem` or `stockitem` | equipment slot | | `none` |
| `chestitem` or `stockitem` | own window | | `none` |
| any | outside both windows | | `none`, and never a ground drop |

Also: `chestitem` over an inventory whose Character tab is showing, and over a page-2 grid, still returns `take`.

- [ ] **Step 2: Run to verify it fails**

Run from `frontend/`: `npx vitest run src/games/something2/src/js/systems/__tests__/pairedDrop.test.js; echo $?`
Expected: non-zero, module not found.

- [ ] **Step 3: Implement `resolvePairedDrop`**

Pure. Hints are English keys passed through `t`, with `{n}` for prices. Export the keys as constants so Task 7 can test them.

- [ ] **Step 4: Run the test**

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/pairedDrop.js frontend/src/games/something2/src/js/systems/__tests__/pairedDrop.test.js
git commit -m "feat(ui): drop rules for the paired windows (SOMET-NNN)"
```

### Task 5: Draw the paired windows

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/storageWindows.js` (add drawing)
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` (draw blocks at lines 676 and 757-773; remove `renderShop`, `renderBank`; add `renderPairedWindows`)
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (render params near 2300 and 2339-2344; `_inventoryVisible`, `_pairedKind`)
- Test: new `systems/__tests__/storageWindowsDraw.test.js`; rewrite render parts of `bankPanel.test.js`, `shopPanel.test.js`, `shelfRarity.test.js`, `shopReputation.test.js`

**Interfaces:**
- Consumes: Task 2 cell and ghost helpers; Task 3 layouts; Task 4 `resolvePairedDrop` for the hint.
- Produces: `drawItemWindow(ctx, layout, state, art)`; `drawPairedOverlay(ctx, { winLayout, invLayout, drag, hover, drop, enchantCfg }, art)`, which draws the window tooltip, ghost, hint and green target outline.
- Produces: `RenderSystem._winLayout`, `_winHitAreas`, `_invLayout`, `_invHitAreas`, all rebuilt per frame. `_shopHitAreas` and `_bankHitAreas` are removed.
- Produces: `Game._pairedKind(): 'chest' | 'merchant' | null`; `Game._inventoryVisible(): boolean`, true when `inventoryOpen` or `_pairedKind()` is non-null.
- `inventoryView` gains `paired` and `originX` (`INVENTORY_X` when paired).

- [ ] **Step 1: Write the failing tests**

- `order is window, inventory, overlay`: an inventory tooltip extending left is not painted over, and a window tooltip paints over the inventory.
- `a merchant cell draws its price`.
- `chest and buyback cells draw the rarity border, enchant level and bound marker the inventory cell draws for the same item` (carries over `shelfRarity.test.js`).
- `a locked cell is dimmed with a lock`.
- `the chest title shows n/40 and turns amber when full`.
- `the merchant title shows gold, and the reputation banner shows when present`.
- `the tooltip suppresses during a drag`.
- `a window tooltip includes compare lines and a price line`.
- `no shop or bank frame leaves the hit areas stale after the window closes`: `_winHitAreas` is empty once `_pairedKind()` is null.

- [ ] **Step 2: Run to verify they fail**

Run from `frontend/`: `npx vitest run src/games/something2/src/js/systems/__tests__/storageWindowsDraw.test.js; echo $?`
Expected: non-zero.

- [ ] **Step 3: Implement the drawing and wiring, then remove `renderShop` and `renderBank`**

Replace the block at line 676 so a paired window draws first, the inventory second, and the overlay third. Keep `inventoryOpen` in the render parameters, passing `_inventoryVisible()` as its value. Drop imports left unused, and keep `itemDisplay.js` helpers only if something still calls them. Rewrite the old render tests against the new layouts, keeping each guarantee rather than deleting it.

- [ ] **Step 4: Run the whole game test folder**

Run from `frontend/`: `npx vitest run src/games/something2; echo $?`
Expected: the only failures are click-routing tests that Task 6 rewrites. List them in the task report.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js
git commit -m "feat(ui): draw chest and merchant windows beside the inventory (SOMET-NNN)"
```

### Task 6: Drag input

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (`_handleShopClick`, `_handleBankClick`, `_handleInventoryClick`, the mouse-down branches at 4425-4432, mouse-move at 3985, `_mouseUpHandler` at 4583-4610)
- Test: new `core/__tests__/pairedWindowInput.test.js`; rewrite click parts of `bankPanel.test.js`, `shopPanel.test.js`; extend `singleWindowMutualExclusion.test.js`

**Interfaces:**
- Consumes: `resolvePairedDrop`; `_pairedKind`; `_inventoryVisible`; `RenderSystem._winHitAreas`, `_winLayout`.
- Produces: `Game._handlePairedPress(x, y)`, which replaces `_handleShopClick` and `_handleBankClick`.
- `inventoryDrag` gains `typeId`, `price`, and `pairedWith` (the `_pairedKind()` value at press).

- [ ] **Step 1: Write the failing tests, driving the real handlers with the real layouts**

Use the setup from `inventoryDragInput.test.js`, with a stub `authorityClient`.

- `dragging an inventory item onto the chest sends sendDeposit(id)` and dropping a chest item on the inventory sends `sendWithdraw(accountItemId)`.
- `dragging onto and off the merchant sends sendSell(itemId) and sendBuy(stockId)`, for catalog and buyback.
- `a press with no travel on a window item sends nothing`.
- `a press on a locked ware shows lockedToastText and starts no drag`.
- `a worn item's drop shows the unequip toast and sends nothing`.
- `a drop outside both windows sends nothing, and never sendDrop`.
- `inventory slot and grid gestures still equip and unequip while paired`.
- `tabs and pages on both windows work and send nothing`.
- `either X closes both windows`.
- **Review focus:** `bank and shop frames still refresh while paired`: call `onBank` and `openShop(msg)` twice and confirm the second frame's contents replace the first.
- **Review focus:** `two drags of one item send two messages, and the server error reaches a toast`: the list changes only from frames.
- **Review focus:** `closing mid-drag makes the release do nothing`, including when the other window has opened since the press (`pairedWith` differs).
- **Review focus:** `a "no bank nearby" error frame shows a toast and leaves both lists unchanged`.

In `singleWindowMutualExclusion.test.js`: `opening the shop or chest does not set inventoryOpen`, and every other window still refuses to open over them.

- [ ] **Step 2: Run to verify they fail**

Run from `frontend/`: `npx vitest run src/games/something2/src/js/core/__tests__/pairedWindowInput.test.js; echo $?`
Expected: non-zero.

- [ ] **Step 3: Implement `_handlePairedPress` and route mouse-down to it when `_pairedKind()` is non-null**

Window hits: `winclose` closes, `shoptab` and `shoppage` update `shopView`, `chestitem` and `stockitem` start a candidate drag, and `lockedware` toasts. Otherwise use the existing inventory press path.

- [ ] **Step 4: Update `_mouseUpHandler`**

Replace the `!inventoryOpen` guard with `!_inventoryVisible()`, and return if `drag.pairedWith !== _pairedKind()`. When paired, resolve with `resolvePairedDrop` and map `store`, `take`, `buy`, `sell`, `equip`, `unequip` to `sendDeposit`, `sendWithdraw`, `sendBuy`, `sendSell`, `sendEquip`, `sendUnequip`; `refuse` toasts `t(message)`. Unpaired behaviour, including `resolveDrop`'s ground drop, stays as it is. An unarmed release on a window item does nothing.

- [ ] **Step 5: Make `invclose` also clear `shopOpen` and `bankOpen`, and pass the drop result to the render**

- [ ] **Step 6: Run the whole frontend suite**

Run from `frontend/`: `npx vitest run; echo $?`
Expected: exit 0. Any failure outside this feature must be compared against `origin/main` before it is called unrelated.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js
git commit -m "feat(ui): drag items between the inventory and chest or merchant windows (SOMET-NNN)"
```

### Task 7: Translations and browser verification

**Files:**
- Modify: `frontend/src/games/something2/src/js/i18n/uk/panels2.js`
- Test: `frontend/src/games/something2/src/js/i18n/__tests__/i18n.test.js`

**Interfaces:**
- Consumes: the hint constants from `pairedDrop.js`, and the new window text from `storageWindows.js`.

- [ ] **Step 1: Write the failing test**

`every paired-window string and trade refusal has a Ukrainian entry`, asserting `UK[key]` for the hint keys, `Stored`, `worn`, `Merchant`, the titles, and each of: `unequip it first`, `unsocket it first`, `unsocket the stone first`, `starting gear cannot be sold`, `cannot sell a stacked item`, `your chest is full`, `Inventory full`, `not enough gold`, `stones cannot be stored`, `chest was busy, try again`, `that item is not in your chest`, `that item cannot be withdrawn right now`, `that item is no longer for sale`, `you do not own that item`, `no merchant nearby`, `no bank nearby`.

- [ ] **Step 2: Run to verify it fails, add the missing entries, and run it again**

Run from `frontend/`: `npx vitest run src/games/something2/src/js/i18n; echo $?`
Expected: non-zero before, exit 0 after. Reuse existing keys, and remove strings only the old panels used if no other code calls them.

- [ ] **Step 3: Run both full suites on a freshly seeded scratch DB**

Run from `backend/`: `npm test; echo $?`, with both DB variables set. Run from `frontend/`: `npx vitest run; echo $?`
Expected: exit 0 for both. Compare any failure with `origin/main`.

- [ ] **Step 4: Verify in a real browser**

Start a stack for this worktree on its own ports and scratch DB, so it cannot affect the shared one, and use Chrome with `--mute-audio`. Work through every bullet of the spec's Verification section, in English and Ukrainian, windowed and fullscreen. Record a screenshot of each window. Confirm by reading the gold value that the change equals the price shown, for a buy and for a sale.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/i18n
git commit -m "feat(i18n): Ukrainian text for chest and merchant windows (SOMET-NNN)"
```
