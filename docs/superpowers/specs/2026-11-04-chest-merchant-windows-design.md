# Account Chest and merchant windows: grids and drag and drop

Status: awaiting approval. Date: 2026-11-04.

## Why

The Account Chest and the village merchant are text lists with Store, Take, Buy and Sell buttons, while the inventory is an icon grid with drag and drop. Players manage the same items in two different visual languages.

The owner wants both windows to look like the inventory and to work by dragging items between the window and the inventory, in both directions.

The merchant list also has two defects this replaces:

- "Your items" stops drawing when it runs out of room (`renderShop`, the `break` at `ry + rowH > listBottom`). There is no paging, so anything past about 10 rows cannot be sold.
- It never shows what an item sells for.

## Goals

1. The Account Chest and the village merchant each open as an item-grid window beside the full inventory window, in the inventory's visual style.
2. Dragging moves items between the windows: store and take at the chest; sell, buy and buy back at the merchant.
3. A player sees the price before committing to a sale or purchase.

## Non-goals

- **Player-to-player trading and selling.** The owner wants it, as the next project with its own brainstorm. The game server has no player trade, chat, party or friends today. Do not build trade scaffolding here. Sharing a grid helper between the two windows is fine because this project needs it anyway.
- **World treasure chests.** They have no window: opening one puts the loot straight into the inventory (`core/worldChests.js`).
- **The gem merchant, skill trainer and blacksmith.** They do not buy or sell equipment, so their windows do not change.
- **Remembered cell positions.** `player_items` has no slot index.
- **Changes to server trade rules:** capacity, ownership, proximity, bound items, prices, and the 3-day buyback.

## Anti-goals

This fails, even if it technically works, if:

- a missed drag throws an item on the ground or loses it;
- the client decides what is allowed, or shows a move the server has not confirmed;
- the price shown differs from the price charged or paid;
- an item reads differently in the chest or on the merchant's shelf than in the inventory (grade, enchant level, bound state).

## Decided by the owner

### Layout

Option C from the mockups: a separate window beside the full inventory, not a merged window. The owner approved the look of the clickable prototype, [2026-11-04-chest-merchant-windows-prototype.html](2026-11-04-chest-merchant-windows-prototype.html). Treat it as a guide to look and feel only: its items, reputation text, inventory tabs and slot names are samples, and the rules in this document win.

```
+-- 408 wide --------+ 6 +-- 820 wide (existing inventory) ----------+
| Account Chest 5/40 |   | Inventory 7/48                          X |
| [tabs]             |   | character preview   | [tabs]              |
| 8 x 5 cell grid    |   | equipment slots     | 8 x 6 cell grid     |
+--------------------+   +---------------------+---------------------+
```

Both windows are 480 high, using the inventory's cell size (44), gutter (4), colours and fonts. Together they are 1234 wide, which leaves 23 on each side of the 1280 canvas. The inventory window keeps its current contents, including the equipment slots.

### Which merchants

The village merchant, which is the one window every village shares. Reputation wares are part of it.

### Behaviour

The following were proposed by the designer and accepted by the owner:

| Situation | Behaviour |
|---|---|
| Prices | Each merchant cell shows its price. Dragging shows a hint such as "Sell for 40 g" or "Buy for 120 g". Full item details appear on hover. |
| Confirmation | None. The action fires on drop. Buyback (3 days) covers mistaken sales. |
| Dropping outside both windows | Nothing happens, so an item can never be thrown on the ground while these windows are open. |
| Worn gear in the inventory grid | Worn items already appear in the grid (`visibleItems` does not filter them). They stay there and get a small "worn" marker, in the normal inventory window too. The owner chose this over hiding them. |
| Worn gear dragged to the chest or merchant | Refused with "unequip it first", from a grid cell or an equipment slot, with no sell or store hint. The player unequips it first, by dragging its slot onto the grid; the item then loses its marker and can be moved. |
| Equipping from the chest or merchant | Two steps: to the inventory grid, then onto an equipment slot. Dropping directly on a slot does nothing. |
| Stacks | At the chest, a drag moves the whole stack. Each purchase buys one item. Selling a stack stays refused by the server, as it is today (`trade.js sellItem`): no quote, no sell hint, and the refusal appears as a translated toast. Stacks do exist, for example enchant scrolls (`enchantOps.js`). |
| Old buttons | Store, Take, Buy and Sell are removed. Moving items is drag-only. |
| Item placement | A dropped item takes the next free cell, not the cell it was dropped on. |

## Constraints from the code

- **The server stays the authority.** Client checks only decide what to show. Update item lists only from server frames, as today (`onBank`, `onDeposited`, `onWithdrawn`, `onBought`, `onSold`, `onShop`).
- **Three different id spaces.** Store and Sell take a `player_items` id, Take takes an `account_items` id, and Buy takes a `merchant_stock` id. Catalog and Buyback both use the stock id.
- **Field names differ.** Inventory and chest items use `typeId`; merchant rows use `itemTypeId`.
- **Panel exclusivity is the main trap.** `openShop` and `openBank` both start with `_otherPanelOpen(...)` and `closeAllPanels(...)`, and they also run on every refresh frame. If the paired window simply sets `inventoryOpen = true`, the guard rejects every `bank` and `shop` refresh, and the window goes stale after the first move. Conversely, `_mouseUpHandler` drops the drag when `!inventoryOpen`, and the mouse-down branches for `shopOpen` and `bankOpen` return before the inventory's drag starts. `singleWindowMutualExclusion.test.js` covers this area.
- **`resolveDrop` returns `drop` for any point outside the inventory panel.** While paired, this must never fire.
- **`layoutInventory` and `drawInventory` assume a centred window.** The inventory needs an x offset while paired, and hit areas, hover and tooltips must all follow it.
- **The inventory's item-tab, character-tab and paging behaviour still applies while paired.** Dropping on its Character tab pane is treated as dropping on the inventory window only if the move would otherwise be valid; see "Left to the builder".
- **Translations.** The game ships English and Ukrainian (`i18n/uk/`). New player-facing text needs both, including server refusal messages shown to the player.
- **Tests that pin the old panels** (`bankPanel.test.js`, `shopPanel.test.js`, `shopReputation.test.js`, `inventoryDragInput.test.js`, `singleWindowMutualExclusion.test.js`) must be rewritten around the new behaviour, not deleted. Their guarantees still apply: rarity colour matching, bound labels, reputation prices and locked wares.

### Server additions needed

The windows are otherwise client-only, but two facts the design needs are not on the wire.

1. **Sell prices.** The real price depends on `priceMult`, the player's standing with that village, and the enchant level, computed in `trade.js sellItem`. The client cannot reproduce it, and must not try. The `shop` frame should carry a per-item sell quote (for example, a map of inventory item id to price) computed by the same code path `sellItem` uses, so that the two cannot drift. An item with no quote shows no price rather than a guessed one, and the server's sale remains the final word.
2. **Enchant level on held items.** `HELD_INSTANCE_COLUMNS` (`services/heldInstance.js`) carries rarity, item level and affixes but not `enchant_level`, so chest and buyback rows cannot show "+N" or the enchanted damage that the inventory shows. Add it to the held-instance wire shape as `enchantLevel`, the name `enchantLevelOf` reads.

## What each window contains

### Account Chest

- Title with occupancy `n/40`, shown amber when full, as it is today. Close control in the inventory's style.
- A single "Stored" label in the amber accent, in the tab row's position, so the two grids line up. It is not a real tab.
- 8 x 5 grid. The capacity is fixed at 40 (`CHEST_CAPACITY`), so it never pages.
- Cells draw exactly as inventory cells do: icon, rarity border, stack badge, enchant level, bound marker.

### Merchant

- Title with the merchant name and gold. Reputation line above the tabs when there is one (`repBannerText`).
- Catalog and Buyback tabs with counts, as today. Buyback keeps its amber accent.
- 8 x 5 grid with paging when a tab has more than 40 rows.
- Locked wares come after buyable wares, dimmed with a lock. They have no section header because a grid has no header row. Dragging or clicking one shows the existing explanation (`lockedToastText`) and sends nothing.
- A cell shows the price actually charged. The server does not send a list price (`priced` in `server.js` overwrites `price`), so no struck-through price is shown and none is added.

### Tooltips

Chest and merchant cells use the inventory's tooltip (`formatItemTooltipLines`) and its comparison against equipped gear (`compareLines`), plus price lines where relevant. They suppress during a drag, like the inventory's.

## Calls the designer made

The owner has not reviewed these separately. Each is easy to change.

- The drag hint, and a green outline on the window that would accept the drop, appear only when the drop would do something. These match the prototype.
- Any close action (either X, the opening key, Escape) closes both windows. The inventory does not stay open afterwards.
- While paired, the inventory's "Drop selected" button is hidden, for the same reason a missed drag does nothing.
- Dropping anywhere on the target window counts, not just on its grid.
- Selling a stack stays refused, because server trade rules are out of scope.
- The chest has a "Stored" label, as the prototype does, not a real tab.
- No list price is shown, because the only real discount (Act IV legacy) replaces the price before it reaches the client, and adding one would be a third server change for little value.
- The inventory's other hotkeys stay blocked while paired, as they are blocked for these windows today.
- When a server refusal reaches the player, it appears as the existing toast, translated.

## Left to the builder

- How to represent the paired state and resolve the exclusivity trap above. Any approach that keeps exclusivity for every other window is fine.
- Module structure. The inventory's split between pure layout and drawing, with the layouts unit-tested, is the pattern to follow. Moving chest and merchant drawing out of `RenderSystem.js` fits it.
- Whether a drop on the inventory's Character tab counts as a drop on the inventory (Take and Buy would still land in the item list).
- Exact drawing of price labels within a 44 px cell, including large prices.

## Verification

`AGENTS.md` defines done: backend `npm test`, frontend `npx vitest run` (read the exit code), plus browser verification. In a real browser, with the game running and Chrome muted:

- At a bank post: store and take by drag, including at a full chest and a full inventory, and with an enchanted, graded item whose appearance must survive the round trip.
- At a merchant: buy, sell and buy back, with more than 10 carried items, checking that gold changes by exactly the price shown. Include a locked ware, a bound item, worn gear and insufficient gold.
- A drop outside both windows leaves the item in place and sends nothing.
- A worn item and an identical spare: the marker tells them apart, the worn one is refused, and the spare moves.
- A move followed immediately by another move, to prove the refresh frames still arrive.
- Other windows still exclude each other, and each window closes cleanly.
- Ukrainian as well as English.
- Both windows at the 1280 x 720 canvas size, windowed as well as fullscreen.
