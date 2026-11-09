// What you can DO with an item from the inventory panel beyond equipping it: use a loot map,
// socket a magic stone into a weapon, take it out again. Pure (no canvas, no socket), so every
// rule is a unit test; the server re-checks all of it (authority/items.js socketStone and
// unsocketStone, server.js use), and nothing here authorizes anything -- it only decides which
// button to draw and which request is worth sending.
//
// The stone rules mirror backend/src/services/stones.js (stoneKind, isCompatible).
import { worldToScreen } from "../core/iso.js";
import { MAP_TILE_SIZE } from "../core/constants.js";

// The server's destroy chance when a stone is taken out of a weapon (STONE_DESTROY_CHANCE).
export const UNSOCKET_DESTROY_PERCENT = 10;
export const UNSOCKET_CONFIRM_LABEL = "Sure? 10% lost";
// A second click on the same item within this long is a double-click.
export const DOUBLE_CLICK_MS = 380;
// "Click again to confirm" stays armed this long.
export const CONFIRM_WINDOW_MS = 3000;

export function isLootMap(type) {
  return !!type && type.category === "consumable" && type.name === "loot_map";
}

export function isStone(type) {
  return !!type && type.category === "stone";
}

// 'augment' | 'spell' | 'buff', as the server classifies a stone.
export function stoneKind(type) {
  if (type.stone_mode === "augment") return "augment";
  return type.element != null ? "spell" : "buff";
}

// Whether a stone of this type fits a host of this type (weapon or armour), by the server's rule.
export function stoneFitsHost(stoneType, hostType) {
  if (!isStone(stoneType) || !hostType) return false;
  const kind = stoneKind(stoneType);
  if (kind === "augment" || kind === "spell") return hostType.category === "weapon";
  return hostType.category === "weapon" || hostType.category === "armor";
}

const itemOf = (inv, id) => (inv && inv.items ? inv.items.find((i) => i.id === id) || null : null);
const typeOfItem = (inv, item) => (item && inv.types ? inv.types.get(item.typeId) || null : null);

// The stone item sitting in this host, or null.
export function socketedStoneOf(inv, host) {
  if (!host || host.socketedStoneItemId == null) return null;
  return itemOf(inv, host.socketedStoneItemId);
}

// The item this stone is socketed into, or null.
export function hostOfStone(inv, stoneItem) {
  if (!stoneItem || !inv || !inv.items) return null;
  return inv.items.find((i) => i.socketedStoneItemId === stoneItem.id) || null;
}

export function hasStone(host) {
  return !!host && (host.socketedStoneItemId != null || host.socketedStoneTypeId != null);
}

// Can this stone go into this host right now? { ok: true } or { ok: false, reason } with a line
// fit for a toast. The client only suppresses requests the server would refuse; it decides nothing.
export function canSocket(inv, stoneItem, hostItem) {
  const stoneType = typeOfItem(inv, stoneItem);
  if (!stoneItem || !isStone(stoneType)) return { ok: false, reason: "That is not a magic stone" };
  if (!hostItem) return { ok: false, reason: "Drop the stone onto a weapon" };
  if (hostItem.id === stoneItem.id) return { ok: false, reason: "A stone cannot be socketed into itself" };
  if (hostOfStone(inv, stoneItem)) return { ok: false, reason: "That stone is already socketed" };
  const hostType = typeOfItem(inv, hostItem);
  if (!stoneFitsHost(stoneType, hostType)) {
    return { ok: false, reason: isStone(hostType) ? "Drop the stone onto a weapon" : "That stone does not fit this item" };
  }
  if (hasStone(hostItem)) return { ok: false, reason: "That item already has a stone: take it out first" };
  return { ok: true };
}

// Where a stone goes when there was no drag: the weapon in hand first, then the other hand. The
// first one that accepts it, or null.
export function defaultHostFor(inv, stoneItem) {
  for (const slot of ["main_hand", "off_hand"]) {
    const id = inv.equipment ? inv.equipment[slot] : null;
    const host = id != null ? itemOf(inv, id) : null;
    if (host && canSocket(inv, stoneItem, host).ok) return host;
  }
  return null;
}

// The ONE contextual button for the selected item: { act, label, itemId } or null.
//   use      a loot map: spawns a chest guarded in this world
//   socket   a stone not socketed anywhere: into the weapon in hand
//   unsocket an item that holds a stone: takes it out (it can be destroyed)
// `armedHostId` is the host whose take-out is waiting for its confirming click.
export function itemActionFor(inv, selectedItemId, armedHostId = null) {
  const item = selectedItemId != null ? itemOf(inv, selectedItemId) : null;
  if (!item) return null;
  const type = typeOfItem(inv, item);
  if (isLootMap(type)) return { act: "use", label: "Use", itemId: item.id };
  if (isStone(type) && !hostOfStone(inv, item)) return { act: "socket", label: "Socket", itemId: item.id };
  // Take-out is offered on the stone (once socketed) AND on the item holding it, whichever is
  // selected; the armed id is that selected item's.
  if ((isStone(type) && hostOfStone(inv, item)) || (hasStone(item) && item.socketedStoneItemId != null)) {
    const armed = armedHostId === item.id;
    return { act: "unsocket", label: armed ? UNSOCKET_CONFIRM_LABEL : "Take out", itemId: item.id, armed };
  }
  return null;
}

// The id of the STONE to send to the server for a take-out started from `item`, which is either
// the stone itself or the item holding it. null when there is nothing to take out.
export function stoneIdForUnsocket(inv, item) {
  if (!item) return null;
  if (isStone(typeOfItem(inv, item))) return hostOfStone(inv, item) ? item.id : null;
  return item.socketedStoneItemId != null ? item.socketedStoneItemId : null;
}

// Extra tooltip lines: what is socketed where, and how to use what you are looking at.
// [{ text, color }], appended to the item's own lines.
export function itemHintLines(inv, item, type) {
  const lines = [];
  if (!item || !type) return lines;
  const stone = socketedStoneOf(inv, item);
  if (stone) {
    const st = typeOfItem(inv, stone);
    lines.push({ text: "Socketed: {name}", params: { name: st ? st.name : "?" }, color: "#c4b5fd" });
  } else if (hasStone(item)) {
    const st = item.socketedStoneTypeId != null && inv.types ? inv.types.get(item.socketedStoneTypeId) : null;
    lines.push({ text: "Socketed: {name}", params: { name: st ? st.name : "?" }, color: "#c4b5fd" });
  }
  if (isStone(type)) {
    const host = hostOfStone(inv, item);
    if (host) {
      const ht = typeOfItem(inv, host);
      lines.push({ text: "Socketed into: {name}", params: { name: ht ? ht.name : "?" }, color: "#c4b5fd" });
    } else {
      lines.push({ text: "Drag onto a weapon to socket it", color: "#94a3b8" });
    }
  }
  if (isLootMap(type)) lines.push({ text: "Double-click to use: a guarded chest appears in this world", color: "#94a3b8" });
  return lines;
}

// A finished drag of a STONE, resolved against the panel: dropped on an equipped item or on a bag
// item it becomes a socket request. null when the drag is not a socketing gesture at all (the
// caller falls through to equip / drop); { action: 'none', reason } when it was one but cannot
// happen, so the player is told why instead of nothing.
export function resolveStoneDrop(layout, drag, point, inv) {
  const item = drag && drag.itemId != null ? itemOf(inv, drag.itemId) : null;
  const type = typeOfItem(inv, item);
  if (!isStone(type) || !point) return null;
  const hit = (r) => r && point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
  const slot = layout.slots.find((s) => s.equippedItem && hit(s)) || null;
  const cell = layout.cells.find((c) => c.item && hit(c)) || null;
  const host = slot ? slot.equippedItem : (cell ? cell.item : null);
  if (!host) return null;
  // Put back where it started, or dropped on itself: nothing to say.
  if (host.id === item.id) return { action: "none" };
  const r = canSocket(inv, item, host);
  return r.ok
    ? { action: "socket", stoneId: item.id, hostId: host.id }
    : { action: "none", reason: r.reason };
}

// "12 tiles to the north-east": where a point is from another, as the player sees the map (the
// view is isometric, so the compass is the screen's, not the world axes').
const DIRECTIONS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
export function describeWhere(from, to) {
  const a = worldToScreen(from.x, from.y);
  const b = worldToScreen(to.x, to.y);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const tiles = Math.round(Math.hypot(to.x - from.x, to.y - from.y) / MAP_TILE_SIZE);
  if (tiles < 1) return { tiles: 0, direction: null };
  const angle = Math.atan2(dy, dx); // screen y grows downward: 90deg is south
  const idx = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  return { tiles, direction: DIRECTIONS[idx] };
}
