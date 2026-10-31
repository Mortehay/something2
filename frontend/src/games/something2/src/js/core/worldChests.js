// World chests (SOMET-372) — the client half of the authority's chest
// protocol. Kept out of Game.js so the two rules that actually matter can be
// tested without a canvas: what a `chests` snapshot replaces, and what a
// `chestOpened` reply does to the inventory mirror.
//
// NOT the account chest / bank (SOMET-310). That is a different frame, a
// different table, and account-scoped; these are world objects with positions.
import { addItem } from "./inventory.js";

// The AOI snapshot. Whole-list replacement, exactly like creatures and ground
// items: the server sends every chest in the player's 3x3 chunk neighbourhood
// on each tick, so a chest that is no longer in the list is out of range, not
// gone. Anything malformed collapses to an empty list rather than throwing in
// the socket handler, where a throw would take the frame loop with it.
//
// A vault chest is looted per character: the server marks it "opened" in THIS
// player's frame with `reopenInMs` (the time left on their cooldown). It becomes
// `reopenAt`, an absolute time on this client's own clock, so the countdown does
// not depend on the two clocks agreeing.
export function chestsFromFrame(msg, nowMs = clockNow()) {
  const list = Array.isArray(msg && msg.chests) ? msg.chests : [];
  return list.map((c) => (Number.isFinite(c && c.reopenInMs) ? { ...c, reopenAt: nowMs + c.reopenInMs } : c));
}

function clockNow() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

// "14:32" for 872000 ms.
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// What to draw for a chest right now: its state, the label above it, and
// whether the open hint applies. A looted vault chest counts down and flips back
// to "Treasure" by itself when the cooldown runs out (the server re-checks).
export function chestView(c, nowMs = clockNow()) {
  const state = (c && c.state) || "locked";
  if (state === "opened" && Number.isFinite(c.reopenAt)) {
    const left = c.reopenAt - nowMs;
    if (left <= 0) return { state: "unlocked", label: "Treasure", openable: true };
    return { state: "opened", label: `Looted — opens again in ${formatCountdown(left)}`, openable: false };
  }
  if (state === "opened") return { state, label: "Looted", openable: false };
  return {
    state,
    label: state === "unlocked" ? "Treasure" : "Treasure (guarded)",
    openable: true,
  };
}

// The reply to `openchest`. Returns the toast line; mutates `inventory` and
// the matching entry of `chests`.
//
// THE FIELD-NAME TRAP: `picked` carries claimItem's NORMALIZED item
// ({id, typeId, quantity}), but openChest reports the RAW player_items row
// (chestLoot.js: `RETURNING id, item_type_id, quantity`). addItem reads
// item.typeId, so handing it the row unmapped stores `typeId: undefined` — an
// item the server says you own, that the panel cannot resolve a type for and
// that can never be equipped, dropped or sold. The mapping below is the whole
// reason this file is not a one-liner in Game.js.
export function applyChestOpened(inventory, chests, msg, nowMs = clockNow()) {
  const items = Array.isArray(msg && msg.items) ? msg.items : [];
  for (const it of items) {
    addItem(inventory, { id: it.id, typeId: it.item_type_id, quantity: it.quantity });
  }
  // Optimistic, and only until the next snapshot: the server's own `state`
  // arrives on the following `chests` frame and overwrites this. It exists so
  // the lid opens on the same frame as the toast rather than a tick later.
  const opened = chests.find((c) => c.id === (msg && msg.chestId));
  if (opened) {
    opened.state = "opened";
    // A vault chest reports this character's cooldown; start the countdown now.
    if (Number.isFinite(msg && msg.reopenInMs)) opened.reopenAt = nowMs + msg.reopenInMs;
  }

  if (items.length === 0) return "The chest is empty";
  const xp = Number(msg && msg.awarded) || 0;
  const what = items.length === 1 ? "1 item" : `${items.length} items`;
  return `Chest opened — ${what}${xp ? `, ${xp} XP` : ""}`;
}
