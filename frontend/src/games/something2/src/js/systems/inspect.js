// SOMET-493 — the inspect card: what is under the cursor, and how to describe it.
//
// Everything here is PURE (no canvas, no DOM, no clock). RenderSystem draws
// the geometry this file produces and nothing else, for the reason SOMET-488
// paid for: a marker layer whose record shape drifted silently deleted itself
// while 1134 tests stayed green, because there was no seam between "decide
// what to draw" and "draw it". This is that seam.
//
// Three stages, each independently testable:
//   1. pickDrawable    — which drawable is under the cursor (topmost wins)
//   2. describeTarget  — that drawable -> a display descriptor
//   3. layoutCard      — that descriptor -> rects and text, clamped on screen
import { worldToScreen } from "../core/iso.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";

// ---------------------------------------------------------------------------
// 1. Hit-testing
// ---------------------------------------------------------------------------

// Canvas pixel -> the translated space every world drawable is drawn in.
//
// Camera.apply translates by floor(GAME_WIDTH/2 - screenX) before anything
// world-space is drawn, so a rect computed from worldToScreen is NOT in canvas
// coordinates. The floor() is reproduced deliberately: dropping it puts the
// hit-test up to a pixel off the pixels actually painted, which is exactly the
// kind of "works, mostly" drift that never gets diagnosed.
export function canvasToCameraPoint(canvasX, canvasY, camera) {
  return {
    x: canvasX - Math.floor(GAME_WIDTH / 2 - camera.screenX),
    y: canvasY - Math.floor(GAME_HEIGHT / 2 - camera.screenY),
  };
}

// The screen box RenderSystem.drawEntity paints an entity into. Creatures AND
// map decorations both render through drawEntity in renderChunked, so both are
// hit-tested with this one rule; if drawEntity's anchor ever changes, this must
// change with it or the card will name whatever used to be there.
export function entityScreenRect(e) {
  const w = e.displayWidth || e.width || 40;
  const h = e.displayHeight || e.height || 40;
  const s = worldToScreen(e.x + (e.width || 40) / 2, e.y + (e.height || 40) / 2);
  return { x: s.x - w / 2, y: s.y - h, w, h };
}

// The screen box RenderSystem.drawCreature paints an actor into (the local
// player and remote players). Different fallback extents from drawEntity, so
// it is a second function rather than a shared one with a flag.
export function actorScreenRect(o) {
  const w = o.width || 64;
  const h = o.height || 64;
  const s = worldToScreen(o.x + w / 2, o.y + h / 2);
  return { x: s.x - w / 2, y: s.y - h, w, h };
}

// Ground items, merchant posts, bank posts and world chests are all drawn as a
// small diamond CENTRED on a projected world point. The diamond is hit-tested
// as its bounding square: a pointer-sized target does not deserve a
// point-in-diamond test, and being slightly generous is the friendlier error.
export function markerScreenRect(p, radius) {
  const s = worldToScreen(p.x, p.y);
  return { x: s.x - radius, y: s.y - radius, w: radius * 2, h: radius * 2 };
}

const MARKER_RADII = { grounditem: 9, merchant: 11, bank: 11, worldchest: 12 };

// The screen rect for any drawable renderChunked built, or null for kinds the
// card does not describe (walls and floor tiles: hovering terrain should not
// pop a card over the thing you are actually trying to look at).
export function drawableScreenRect(d) {
  if (!d || !d.ref) return null;
  if (d.kind === "entity" || d.kind === "decoration") return entityScreenRect(d.ref);
  if (d.kind === "player" || d.kind === "remote") return actorScreenRect(d.ref);
  const r = MARKER_RADII[d.kind];
  return r ? markerScreenRect(d.ref, r) : null;
}

// Topmost drawable under `point`, or null.
//
// `drawables` is the list renderChunked has ALREADY sorted back-to-front and
// drawn — not a re-derived copy — so the card can never name something the
// player cannot see. Iterated in reverse because the last thing drawn is the
// thing on top, which is the one the cursor is pointing at.
export function pickDrawable(drawables, point) {
  if (!Array.isArray(drawables) || !point) return null;
  for (let i = drawables.length - 1; i >= 0; i--) {
    const d = drawables[i];
    const r = drawableScreenRect(d);
    if (!r) continue;
    if (point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h) return d;
  }
  return null;
}

// A stable identity for a picked drawable, so a click can pin "this creature"
// and keep pinning it while it walks. Markers and decorations have no id of
// their own, so they fall back to their kind + world position — which is fixed
// for exactly the kinds that have no id.
export function targetKey(d) {
  if (!d || !d.ref) return null;
  const ref = d.ref;
  if (ref.id != null) return `${d.kind}:${ref.id}`;
  if (d.userId != null) return `${d.kind}:${d.userId}`;
  return `${d.kind}:${Math.round(ref.x)},${Math.round(ref.y)}`;
}

// ---------------------------------------------------------------------------
// 2. Aggression
// ---------------------------------------------------------------------------

// Five tiers, ordered least to most dangerous to walk past. Derived from the
// creature's CATALOG behaviour (entity_types.faction + creature_behaviors'
// chase_style/aggro_radius), not from its current mode: "how eagerly does this
// thing come for me" is a property of the creature, and a mode-derived badge
// would read Passive for anything that happens to be idle at that instant.
export const AGGRESSION_TIERS = [
  { tier: 0, label: "Passive", color: "#4ade80" },
  { tier: 1, label: "Defensive", color: "#38bdf8" },
  { tier: 2, label: "Wary", color: "#facc15" },
  { tier: 3, label: "Aggressive", color: "#fb923c" },
  { tier: 4, label: "Ferocious", color: "#f87171" },
];

// The radius bands for a creature that simply charges. Chosen off the shipped
// catalog (Heavy 300, Brute 380, Swarm/Line/Guard 400, Skirmisher 450,
// Ranged/Caster 460, Champion 480, Apex 600) so every rung is distinguishable
// rather than every creature landing in one bucket.
const AGGRO_HIGH = 470;
const AGGRO_MED = 340;

// `def` is an entity-type definition: { faction, chaseStyle, aggroRadius }.
// A creature whose type carries no behaviour row at all (behavior_id NULL —
// legal, and true of several seeded types) still gets a tier from its faction,
// because "we don't know" is not something worth putting on a badge.
export function aggressionOf(def) {
  if (!def) return null;
  const style = def.chaseStyle || null;
  const aggro = Number.isFinite(def.aggroRadius) ? def.aggroRadius : null;
  if (style === "skittish") return AGGRESSION_TIERS[0];
  if (def.faction === "guard" || style === "guard") return AGGRESSION_TIERS[1];
  if (style === "hold") return AGGRESSION_TIERS[1];
  if (style === "ambush") return AGGRESSION_TIERS[2];
  if (aggro == null) return AGGRESSION_TIERS[3];
  if (aggro >= AGGRO_HIGH) return AGGRESSION_TIERS[4];
  if (aggro >= AGGRO_MED) return AGGRESSION_TIERS[3];
  return AGGRESSION_TIERS[2];
}

// ---------------------------------------------------------------------------
// 3. Describing a target
// ---------------------------------------------------------------------------

// entity_types.name is the catalog KEY as well as the display name, and the
// decoration rows are authored in snake_case (`pine_tree`, `rose_bush`,
// `dead_tree`) while creature rows are authored in Title Case (`Beast Brute`).
// Only the first is touched: underscores become spaces and the first letter is
// capitalised, so `pine_tree` reads as "Pine tree" while `Beast Brute` and
// `IceRock` pass through untouched. Nothing is invented -- a name that already
// reads as a name is left exactly as the catalog spells it.
export function displayName(name) {
  const n = String(name == null ? "" : name).trim();
  if (!n) return "";
  const spaced = n.replace(/_+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const CATEGORY_WORDS = {
  weapon: "Weapon", armor: "Armour", consumable: "Consumable",
  ammo: "Ammunition", currency: "Currency", stone: "Socket stone",
};

function itemDescription(type) {
  if (!type) return "An item lying on the ground.";
  const bits = [];
  if (type.kind) bits.push(String(type.kind));
  if (type.element && type.element !== "physical") bits.push(String(type.element));
  if (type.damage) bits.push(`${type.damage} damage`);
  if (type.defense) bits.push(`${type.defense} defence`);
  return bits.length ? bits.join(" · ") : "An item lying on the ground.";
}

// A drawable + the catalogs the client already holds -> what the card shows.
//
// `entityDefs` is Game.entityDefs: the /api/map/config entityTypes map keyed by
// name. `itemTypes` is inventory.types (id -> item type) from the join frame.
// Both may be absent (they load asynchronously); every field below degrades to
// a still-useful card rather than throwing, because a card that disappears on
// a slow connection reads as a broken toggle.
export function describeTarget(d, { entityDefs = null, itemTypes = null, localPlayer = null } = {}) {
  if (!d || !d.ref) return null;
  const ref = d.ref;

  if (d.kind === "entity") {
    // A creature. `type` is its entity-type NAME (CreatureManager keeps the
    // wire field verbatim), which is also its display name.
    const def = entityDefs ? entityDefs[ref.type] : null;
    // entity_types.prompt is the human description the sprite generator is
    // built from, and it is the only free-text field on the row -- but it is
    // NOT NULL DEFAULT '' and several seeded rows (Village Guard among them)
    // are still empty. The fallback is faction-aware rather than a flat "a
    // hostile creature", which would be an outright lie on a guard.
    const guard = !!def && def.faction === "guard";
    const noun = guard ? "guard" : "creature";
    return {
      kind: "creature",
      title: displayName(ref.type) || "Creature",
      subtitle: ref.level != null ? `Level ${ref.level} ${noun}` : (guard ? "Guard" : "Creature"),
      description: (def && def.prompt)
        || (guard ? "A village guard. It will not attack unless provoked."
                  : "A hostile creature."),
      hp: ref.maxHp ? { cur: ref.hp != null ? ref.hp : ref.maxHp, max: ref.maxHp } : null,
      // Catalog values, NOT a simulated pool: CreatureSim tracks no mana at
      // all today (every entity_types row ships mana = max_mana = 0 and no
      // creature ability costs any). Reading the catalog is the honest wiring
      // — the row lights up the moment a creature type is given a pool, and
      // until then it truthfully reads empty instead of being faked full.
      mp: { cur: (def && def.mana) || 0, max: (def && def.maxMana) || 0 },
      aggression: aggressionOf(def),
    };
  }

  if (d.kind === "player" || d.kind === "remote") {
    const mine = d.kind === "player";
    return {
      kind: "player",
      title: mine ? "You" : `Player #${d.userId}`,
      subtitle: mine ? "Your character" : "Another player",
      description: mine
        ? "Your own character."
        : "Another player exploring this world.",
      hp: ref.maxHp ? { cur: ref.hp != null ? ref.hp : ref.maxHp, max: ref.maxHp } : null,
      // Only the local player's mana is known to this client — the world-state
      // frame carries hp/maxHp for remote players and nothing else, so a bar
      // for them would be an invention.
      mp: mine && localPlayer && localPlayer.maxMana
        ? { cur: localPlayer.mana || 0, max: localPlayer.maxMana }
        : null,
      aggression: null,
    };
  }

  if (d.kind === "decoration") {
    const def = entityDefs ? entityDefs[ref.name] : null;
    return {
      kind: "decoration",
      title: displayName(ref.name) || "Scenery",
      subtitle: ref.walkable === false ? "Scenery · blocks movement" : "Scenery",
      description: (def && def.prompt) || (ref.prompt) || "Part of the landscape.",
      hp: null, mp: null, aggression: null,
    };
  }

  if (d.kind === "grounditem") {
    const type = itemTypes ? itemTypes.get(ref.typeId) : null;
    return {
      kind: "grounditem",
      title: (type && type.name) || "Unknown item",
      subtitle: (type && CATEGORY_WORDS[type.category]) || "Dropped item",
      description: itemDescription(type),
      hp: null, mp: null, aggression: null,
    };
  }

  if (d.kind === "merchant") {
    return {
      kind: "merchant", title: "Merchant", subtitle: "Village trader",
      description: "Stand next to them and press E to buy and sell.",
      hp: null, mp: null, aggression: null,
    };
  }

  if (d.kind === "bank") {
    return {
      kind: "bank", title: "Bank", subtitle: "Village storage",
      description: "Stand next to it to stash items and gold across characters.",
      hp: null, mp: null, aggression: null,
    };
  }

  if (d.kind === "worldchest") {
    const opened = ref.state === "open" || ref.state === "opened";
    return {
      kind: "worldchest", title: "Chest", subtitle: opened ? "Already opened" : "Unopened",
      description: opened
        ? "This chest has already been looted."
        : "Stand next to it and click to open it.",
      hp: null, mp: null, aggression: null,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 4. Card layout
// ---------------------------------------------------------------------------

export const CARD = {
  padX: 9, padY: 8, width: 232,
  titleSize: 13, badgeSize: 10, subSize: 10, descSize: 10,
  barH: 7, barLabelSize: 9, barGap: 4,
  gap: 5, cursorGap: 16,
};

// Canvas has measureText; this module must not. Sans-serif digits and
// lowercase average close to 0.52em, which is accurate enough to wrap a
// description and to size a badge — both of which only need to not overlap.
export function estimateTextWidth(text, fontPx) {
  return String(text == null ? "" : text).length * fontPx * 0.52;
}

// Greedy word wrap to a pixel width, capped at `maxLines` with an ellipsis on
// the last kept line. Capped rather than growing: a card that changes height
// with the length of a generated sprite prompt would jump around the screen.
export function wrapText(text, fontPx, maxWidth, maxLines = 3) {
  const words = String(text == null ? "" : text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && estimateTextWidth(next, fontPx) > maxWidth) {
      lines.push(cur);
      cur = word;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && cur && lines[maxLines - 1] !== cur) {
    lines[maxLines - 1] = `${lines[maxLines - 1]}…`;
  }
  return lines;
}

function barSpec(label, pool, color, x, y, w) {
  const max = pool && pool.max > 0 ? pool.max : 0;
  const cur = pool ? Math.max(0, Math.min(pool.cur, max)) : 0;
  return {
    label, x, y, w, h: CARD.barH, color,
    pct: max > 0 ? cur / max : 0,
    text: max > 0 ? `${Math.round(cur)}/${Math.round(max)}` : "0/0",
  };
}

// Descriptor + cursor -> every rect and string the renderer needs.
//
// Nothing here reads a canvas: `canvasW`/`canvasH` are passed in so the card
// can be clamped on screen, and the clamp is the whole reason this returns a
// box rather than the renderer positioning itself — a card that runs off the
// right edge is the first thing anyone hits, and it must be covered by a test
// rather than by looking at it once.
export function layoutCard(desc, cursorX, cursorY, canvasW = GAME_WIDTH, canvasH = GAME_HEIGHT) {
  if (!desc) return null;
  const innerW = CARD.width - CARD.padX * 2;
  // The badge sits in the card's TOP-RIGHT corner, so the title must stop
  // before it rather than running underneath.
  const badgeW = desc.aggression
    ? Math.ceil(estimateTextWidth(desc.aggression.label, CARD.badgeSize)) + 12
    : 0;
  const badgeH = desc.aggression ? CARD.badgeSize + 6 : 0;

  const descLines = wrapText(desc.description, CARD.descSize, innerW, 3);

  let y = CARD.padY;
  const title = { y: y + CARD.titleSize, size: CARD.titleSize, text: desc.title };
  const badge = desc.aggression
    ? { y, w: badgeW, h: badgeH, size: CARD.badgeSize, text: desc.aggression.label, color: desc.aggression.color }
    : null;
  y += Math.max(CARD.titleSize, badgeH) + CARD.gap;

  const subtitle = desc.subtitle
    ? { y: y + CARD.subSize, size: CARD.subSize, text: desc.subtitle }
    : null;
  if (subtitle) y += CARD.subSize + CARD.gap;

  const lines = descLines.map((text, i) => ({
    y: y + CARD.descSize + i * (CARD.descSize + 3), size: CARD.descSize, text,
  }));
  if (lines.length) y += lines.length * (CARD.descSize + 3) + CARD.gap - 3;

  // HP on the upper line, MP on the lower one. Reserved space to the right of
  // each track holds its "cur/max" string, so the numbers never sit on top of
  // the fill.
  const bars = [];
  const barTextW = 54;
  const trackW = innerW - barTextW;
  if (desc.hp) {
    bars.push(barSpec("HP", desc.hp, "#e5484d", CARD.padX, y, trackW));
    y += CARD.barH + CARD.barGap;
  }
  if (desc.mp) {
    bars.push(barSpec("MP", desc.mp, "#4a9eff", CARD.padX, y, trackW));
    y += CARD.barH + CARD.barGap;
  }
  if (bars.length) y -= CARD.barGap;

  const h = y + CARD.padY;
  // Prefer down-right of the cursor; flip to the other side of the pointer
  // when that would leave the canvas, then clamp. Flipping first keeps the
  // card off the thing being inspected instead of pinning it to the edge.
  let x = cursorX + CARD.cursorGap;
  if (x + CARD.width > canvasW) x = cursorX - CARD.cursorGap - CARD.width;
  x = Math.max(4, Math.min(x, canvasW - CARD.width - 4));
  let top = cursorY + CARD.cursorGap;
  if (top + h > canvasH) top = cursorY - CARD.cursorGap - h;
  top = Math.max(4, Math.min(top, canvasH - h - 4));

  return {
    box: { x, y: top, w: CARD.width, h },
    // Every child rect is stored RELATIVE to the box, so the renderer
    // translates once and the clamp above cannot desync a single row.
    title, badge, subtitle, lines, bars,
    titleMaxW: innerW - (badgeW ? badgeW + 6 : 0),
  };
}
