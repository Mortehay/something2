// Drop rules for the paired windows (Account Chest / merchant beside the full
// inventory). PURE: Task 5 calls it each frame for the drag hint, Task 6 on
// release. The server stays the authority; client rules only pick a hint and
// suppress sends for worn items. `hint` appears only when success is expected.
import { isWorn, canEquipClient } from "../core/inventory.js";
import { inside, capacityOf, usedSlotsClient } from "./inventoryPanel.js";
import { t } from "../i18n/i18n.js";

export const HINT_STORE = "Store in chest";
export const HINT_TAKE = "Take";
export const HINT_SELL = "Sell for {n} g";
export const HINT_BUY = "Buy for {n} g";
export const REFUSE_WORN = "unequip it first";

const NONE = { action: "none" };

export function resolvePairedDrop({ drag, point, winLayout, invLayout, inventory, sellQuotes, gold }) {
  if (!drag || !drag.from || !point || !winLayout || !invLayout) return NONE;
  const { x, y } = point;
  if (typeof x !== "number" || typeof y !== "number") return NONE;

  const onSlot = invLayout.slots.find((s) => inside(s, x, y)) || null;
  const onInv = inside(invLayout.panel, x, y);
  const onWin = inside(winLayout.panel, x, y);
  const invFull = usedSlotsClient(inventory) >= capacityOf(inventory);
  const kind = drag.from.kind;

  if (kind === "item") {
    if (onSlot) {
      if (drag.itemId == null || !canEquipClient(inventory, drag.itemId, onSlot.slot)) return NONE;
      return { action: "equip", itemId: drag.itemId, slot: onSlot.slot };
    }
    if (!onWin) return NONE;
    if (isWorn(inventory, drag.itemId)) return { action: "refuse", message: REFUSE_WORN };
    const id = drag.from.id;
    if (winLayout.kind === "chest") {
      if (winLayout.occupancy && winLayout.occupancy.full) return { action: "store", id };
      return { action: "store", id, hint: t(HINT_STORE), target: "window" };
    }
    const quote = sellQuotes ? sellQuotes[drag.itemId] : undefined;
    if (typeof quote !== "number") return { action: "sell", id };
    return { action: "sell", id, hint: t(HINT_SELL, { n: quote }), target: "window" };
  }

  if (kind === "slot") {
    if (drag.itemId == null) return NONE;
    if (onWin) return { action: "refuse", message: REFUSE_WORN };
    if (!onSlot && invLayout.cells.some((c) => inside(c, x, y))) return { action: "unequip", slot: drag.from.id };
    return NONE;
  }

  if (kind === "chestitem" || kind === "stockitem") {
    // Anywhere on the inventory panel except an equipment slot, whatever tab or page.
    if (!onInv || onSlot || onWin) return NONE;
    const id = drag.from.id;
    if (kind === "chestitem") {
      if (invFull) return { action: "take", id };
      return { action: "take", id, hint: t(HINT_TAKE), target: "inventory" };
    }
    const price = drag.price;
    if (invFull || typeof price !== "number" || !(gold >= price)) return { action: "buy", id };
    return { action: "buy", id, hint: t(HINT_BUY, { n: price }), target: "inventory" };
  }

  return NONE;
}
