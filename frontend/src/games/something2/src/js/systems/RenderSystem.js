import { GAME_WIDTH, GAME_HEIGHT, ISO_TILE_H, ISO_TILE_W, MAP_TILE_SIZE } from "../core/constants.js";
import { worldToScreen, depthKey } from "../core/iso.js";
import { compareDrawables, wallRevealed, drawWall } from "./wallRenderer.js";
import { drawLandmarks } from "./landmarkRenderer.js";
import { drawPlaceholder } from "./placeholderSprite.js";
import { frameRect, staticFrameKey, animatedFrameKey, facingToDir, tileFrameKey, resolveTileVisual } from "./spriteAtlas.js";
import { TileDiamondCache } from "./tileTexture.js";
import { chunkTileCells } from "../core/chunkTiles.js";
import { SLOTS, typeOf, canEquipClient } from "../core/inventory.js";
import { layoutInventory, drawInventory } from "./inventoryPanel.js";
import { blastProgress, blastScreenRadiusX, elementColor } from "../core/blasts.js";
import { effectProgress, effectAlpha, isoArcAngle, particlesAt } from "../core/vfx.js";
import { anchorY } from "../core/attackAnchor.js";
import { elementTint } from "../core/elements.js";
import { normalizeEffects, effectColor, effectHudLine } from "../core/statusEffects.js";
import {
  canvasToCameraPoint, pickDrawable, targetKey, describeTarget, layoutCard,
  drawableScreenRect, CARD,
} from "./inspect.js";
import { rarityGlowColor, withAlpha } from "../core/rarityColors.js";

// Read once from the layout module rather than restated, so the painter and
// the layout can never disagree about where the card's left edge is.
const CARD_PAD_X = CARD.padX;
const CARD_BAR_LABEL = CARD.barLabelSize;

// Mirrors PICKUP_RADIUS in backend/src/authority/groundItems.js — used here
// only to decide when a ground item's name label is shown (i.e. when the
// player is actually close enough to loot it). Keep the two in sync, or the
// label will appear at a different range than looting actually works.
const PICKUP_RADIUS = 80;

// SOMET-372: how close (world px) the player must be for a chest to show its
// "[f] open" hint. Approximates the authority's own INTERACT_RADIUS (120) and
// is deliberately a SEPARATE, slightly tighter number rather than an imported
// copy of it: this one decides whether a hint is drawn, the server one decides
// whether the chest opens. Being a little conservative here means the hint
// never appears for a press the server would refuse.
const WORLD_CHEST_PROMPT_R = 110;

// Radius (world px) around an actor within which an occluding wall fades to
// let the player see themselves/nearby creatures behind it.
const WALL_REVEAL_R = 150;

export class RenderSystem {
  constructor(canvas, imageManager) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.imageManager = imageManager;
    // Global render-mode override (dev toggle). null = use each entity's own
    // renderMode; a mode string forces every entity to that mode.
    this.renderModeOverride = null;
    this.tileTexturesOff = false;
    this._tileCache = new TileDiamondCache();
    // Hit-test rects for the inventory panel, recorded while drawing it and
    // read back by Game on click. Empty whenever the panel isn't open.
    this._invHitAreas = [];
    // Same contract as _invHitAreas, for the merchant shop panel.
    this._shopHitAreas = [];
    // ...and for the account chest panel (SOMET-310).
    this._bankHitAreas = [];
  }

  // Effective render mode for an entity: the global override wins, else the
  // entity type's own render_mode, else 'rect' (the safe default).
  static resolveRenderMode(entity, override = null) {
    return override || entity.renderMode || entity.render_mode || "rect";
  }

  // Dev cycle: none -> force rect -> force static -> force animated -> none.
  cycleRenderModeOverride() {
    const order = [null, "rect", "static", "animated"];
    const next = order[(order.indexOf(this.renderModeOverride) + 1) % order.length];
    this.renderModeOverride = next;
    return next;
  }

  // Dev toggle: textured tiles on/off (falls back to flat color when off).
  toggleTileTextures() {
    this.tileTexturesOff = !this.tileTexturesOff;
    return !this.tileTexturesOff;
  }

  // Pure, canvas-free: collect every world object into one list tagged with a
  // depth key, sorted back-to-front for the painter's algorithm.
  static buildDrawables(player, map, remotePlayers) {
    const out = [];
    const entities = (map && map.entities) || [];
    for (const e of entities) {
      out.push({ kind: "entity", ref: e, depth: depthKey(e.x, e.y) });
    }
    out.push({ kind: "player", ref: player, depth: depthKey(player.x, player.y) });
    if (remotePlayers) {
      for (const [userId, p] of remotePlayers) {
        out.push({ kind: "remote", ref: p, userId, depth: depthKey(p.x, p.y) });
      }
    }
    out.sort((a, b) => a.depth - b.depth);
    return out;
  }

  // Actor centres (world px) + iso depth, for the wall reveal check. Players
  // and creatures store TOP-LEFT x/y; add half-extents to reach the centre.
  static collectActors(player, remotePlayers, creatures = []) {
    const out = [];
    const push = (o) => {
      const cx = o.x + (o.width || 64) / 2, cy = o.y + (o.height || 64) / 2;
      out.push({ x: cx, y: cy, depth: depthKey(cx, cy) });
    };
    if (player) push(player);
    if (remotePlayers) for (const [, p] of remotePlayers) push(p);
    for (const c of creatures) push(c);
    return out;
  }

  // Decorations from every loaded chunk in view -> drawables. worldX/worldY are
  // the tile TOP-LEFT (drawEntity centers via +width/2), matching creatures.
  // Camera is accepted for interface symmetry with the other visible-chunk
  // collectors, but every currently-loaded chunk is iterated (same as
  // collectActors and the wall pass) rather than culled here — chunk
  // streaming already keeps `chunkedMap` limited to the camera's
  // neighborhood.
  static collectDecorations(chunkedMap, camera, decoTypes) {
    const out = [];
    const N = chunkedMap.chunkSize;
    for (const key of chunkedMap.loadedKeys()) {
      const [cx, cy] = key.split(",").map(Number);
      for (const d of chunkedMap.decorationsInChunk(cx, cy)) {
        const type = decoTypes && decoTypes.get(d.name);
        if (!type) continue; // type/sprite not loaded yet -> skip (no hole)
        const x = (cx * N + d.col) * MAP_TILE_SIZE;
        const y = (cy * N + d.row) * MAP_TILE_SIZE;
        // width/height = MAP_TILE_SIZE anchors drawEntity's centering math
        // (worldToScreen(e.x + (e.width||40)/2, ...)) on the tile CENTER.
        // Backend entity types only ever carry displayWidth/displayHeight
        // (see getEntityTypesMap) — never width/height — so without this,
        // drawEntity's `(e.width||40)/2` fallback anchors at x+20 instead of
        // the tile's true center (x+50 for a 100px tile), floating the
        // decoration ~19px above its tile. displayWidth/displayHeight (from
        // `type`, spread in first) still control the drawn sprite size.
        // Sort depth at the tile CENTER (matching walls/actors, e.g. line 67's
        // depthKey(e.x, e.y) where e.x/e.y are already center-anchored) even
        // though x/y above are top-left. Decorations are DRAWN centered (see
        // the width/height=MAP_TILE_SIZE comment above), so sorting at
        // top-left put a decoration's depth key one tile toward the back of
        // its actual drawn position — wrongly occluded by an actor/wall a
        // tile closer to the camera that should have been behind it.
        // `name` is spread in from `d`, not from `type`: getEntityTypesMap
        // keys the map BY name and does not repeat it inside the value, so a
        // decoration drawable carried no way to say what it was until the
        // inspect card needed one (SOMET-493).
        out.push({ kind: "decoration", ref: { ...type, name: d.name, x, y, width: MAP_TILE_SIZE, height: MAP_TILE_SIZE }, order: type.place_order || 0, depth: depthKey(x + MAP_TILE_SIZE / 2, y + MAP_TILE_SIZE / 2) });
      }
    }
    return out;
  }

  renderChunked({
    player, camera, chunkedMap, remotePlayers, localUserId,
    creatures = [], projectiles = [], mana = null, maxMana = null, showMana = true,
    stamina = null, maxStamina = null,
    weaponName = null, inventory = null, inventoryOpen = false, selectedItemId = null, inventoryView = null,
    groundItems = [], gold = null, toast = null,
    blasts = [], ammo = null, noAmmoFlash = false, effects = null, vfx = [],
    merchants = [], shop = null, shopOpen = false, shopView = null, decoTypes = null,
    // SOMET-310. Same join-frame fixed-world-point shape as `merchants`.
    banks = [], bank = null, bankOpen = false, bankView = null,
    // SOMET-372 -- WORLD chests (guarded, lootable), not the account chest
    // `banks` marks. These arrive on a live AOI frame rather than the join
    // payload, so the list changes as the player walks; each entry is
    // {id, x, y, kind, state} in world-pixel space, x/y a real stored
    // position (not a derived centre), so it depth-sorts on the point.
    worldChests = [],
    // SOMET-297. Fixed world points from the join frame, exactly like
    // `merchants` above -- not entities, so they carry no stored top-left
    // corner and need no half-extent adjustment.
    landmarks = [],
    doorways = [],
    // Slice D: the effect LIBRARY, needed by the projectile trail. Effects in
    // `vfx` already carry their own resolved `def`; a projectile is a
    // persistent object that only carries a NAME, so the lookup happens here.
    // Passed per frame rather than stashed at construction because the library
    // arrives asynchronously, after the renderer exists.
    vfxDefs = null,
    progression = null,
    // SOMET-493 — the inspect card. Shaped
    // { enabled, cursorX, cursorY, pinnedKey, entityDefs, localPlayer }.
    // Off by default, and `enabled: false` costs exactly one branch: the
    // hit-test runs over the drawables list only when the player asked for it.
    inspect = null,
  }) {
    if (vfxDefs) this.vfxDefs = vfxDefs;
    // While any full-screen panel is up the cursor is being used to click ITS
    // rows, so the inspect card must not follow it around over the top of the
    // panel — and, more importantly, must not hit-test the world hidden behind
    // one and let a click pin something the player cannot see.
    const panelOpen = (inventoryOpen && !!inventory) || (shopOpen && !!shop) || (bankOpen && !!bank);
    this.ctx.fillStyle = "#0f3460";
    this.ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    // Timestamp for this frame; animated tile textures advance off it (unlike
    // render(), renderChunked never set this before, so tile animation had no
    // time source).
    this.nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    camera.apply(this.ctx);

    const halfW = ISO_TILE_W / 2;
    const halfH = ISO_TILE_H / 2;
    const mapTiles = chunkedMap.mapTiles;
    const wallDrawables = [];
    for (const cell of chunkTileCells(chunkedMap, camera)) {
      const s = worldToScreen(cell.worldX, cell.worldY);
      const relX = s.x - camera.screenX;
      const relY = s.y - camera.screenY;
      if (relX < -camera.width || relX > camera.width || relY < -camera.height || relY > camera.height) continue;
      const def = mapTiles ? (mapTiles[cell.tile] || (Array.isArray(mapTiles) ? mapTiles.find(t => t.name === cell.tile || t.type === cell.tile) : null)) : null;
      const visual = this.tileTexturesOff ? null
        : resolveTileVisual(cell.tile, def, this.imageManager, this.nowMs);
      const H = def ? (def.wall_height || 0) : 0;
      const order = def ? (def.place_order || 0) : 0;
      if (H > 0 || order !== 0) {
        // Wall (or manually-layered) tile: defer to the depth-sorted Pass B.
        wallDrawables.push({
          kind: "wall", s, def, visual, H, order,
          x: cell.worldX, y: cell.worldY, depth: depthKey(cell.worldX, cell.worldY),
        });
        continue;
      }
      // Pass A: flat floor tile (unchanged).
      if (visual) {
        const cv = this._tileCache.get(visual.cacheKey, visual.img, visual.crop);
        this.ctx.drawImage(cv, s.x - halfW, s.y - halfH);
      } else {
        this.ctx.fillStyle = def ? def.color : "#123";
        this.ctx.beginPath();
        this.ctx.moveTo(s.x, s.y - halfH);
        this.ctx.lineTo(s.x + halfW, s.y);
        this.ctx.lineTo(s.x, s.y + halfH);
        this.ctx.lineTo(s.x - halfW, s.y);
        this.ctx.closePath();
        this.ctx.fill();
      }
    }

    // Landmark markers (SOMET-297) sit between the two passes on purpose: after
    // the flat floor so they are visible on it, before the depth-sorted pass so
    // a player or creature standing on the tile draws OVER the marker and stays
    // legible. The pulse phase is this frame's timestamp, set above -- the
    // renderer never reads a clock itself.
    drawLandmarks(this.ctx, { landmarks, phase: this.nowMs, halfW, halfH });
    this.drawDoorways(doorways, chunkedMap, player);

    // Players + creatures + ground items + walls, all depth-sorted together
    // (Pass B) — ground items must join the same sort rather than being
    // drawn in a later pass, or they would render on top of entities they
    // are actually behind; walls join it too so entities can occlude behind
    // them instead of always drawing on top.
    const drawables = RenderSystem.buildDrawables(player, { entities: creatures }, remotePlayers);
    for (const d of drawables) d.order = d.kind === "entity" ? (d.ref.place_order || 0) : 0;
    for (const gi of groundItems) {
      // Every other drawable's depth key is computed from its raw stored
      // x/y, which are TOP-LEFT corners (drawCreature/drawEntity add w/2,h/2
      // to reach the centre themselves). Ground items instead store their
      // x/y as the drop's CENTRE (see GroundItemManager), so to sort on the
      // same origin as everything else we have to subtract the half-extent
      // back out here. Do not "simplify" this to depthKey(gi.x, gi.y) —
      // that reintroduces up to a tile's worth of depth error against
      // players/creatures.
      drawables.push({ kind: "grounditem", ref: gi, order: 0, depth: depthKey(gi.x - gi.width / 2, gi.y - gi.height / 2) });
    }
    // Merchants are a fixed world point (village.merchantX/Y from the join
    // frame), not an entity with a stored top-left corner — depth-sort on
    // the point directly, the same origin ground items are adjusted back to
    // above.
    for (const m of merchants) {
      drawables.push({ kind: "merchant", ref: m, order: 0, depth: depthKey(m.x, m.y) });
    }
    // Bank posts are the same kind of fixed world point as merchants, and go
    // through the same depth sort — a chest one tile behind the merchant must
    // draw behind them, which a separate later pass would get wrong.
    for (const b of banks) {
      drawables.push({ kind: "bank", ref: b, order: 0, depth: depthKey(b.x, b.y) });
    }
    // Same fixed-world-point treatment as merchants and bank posts above. A
    // world chest is a thing a player walks around and behind, so it belongs
    // in the sort rather than in a flat pass over the top of everything.
    for (const c of worldChests) {
      drawables.push({ kind: "worldchest", ref: c, order: 0, depth: depthKey(c.x, c.y) });
    }
    for (const w of wallDrawables) drawables.push(w);
    for (const d of RenderSystem.collectDecorations(chunkedMap, camera, decoTypes)) drawables.push(d);
    drawables.sort(compareDrawables);

    const actors = RenderSystem.collectActors(player, remotePlayers, creatures);
    for (const d of drawables) {
      if (d.kind === "wall") {
        const alpha = wallRevealed(d, actors, WALL_REVEAL_R) ? 0.3 : 1;
        drawWall(this.ctx, { s: d.s, def: d.def, visual: d.visual, H: d.H, alpha, halfW, halfH, tileCache: this._tileCache });
      } else if (d.kind === "player") this.drawCreature(d.ref, "player", 1);
      else if (d.kind === "remote") this.drawCreature(d.ref, "player", 0.85, d.userId);
      else if (d.kind === "grounditem") this.drawGroundItem(d.ref, inventory, player);
      else if (d.kind === "merchant") this.drawMerchant(d.ref, player);
      else if (d.kind === "bank") this.drawBank(d.ref, player);
      else if (d.kind === "worldchest") this.drawWorldChest(d.ref, player);
      else if (d.kind === "decoration") this.drawEntity(d.ref);
      else this.drawEntity(d.ref);
    }

    // SOMET-493. Resolved against the SAME `drawables` list that was just
    // painted, in the same frame, so the card can never name something that is
    // not on screen or is buried under something else. Only the resolution
    // happens here; the card itself is drawn at the very end of this method,
    // in canvas pixel space, on top of the HUD.
    this._resolveInspect(inspect, drawables, panelOpen);

    // Projectiles render on top — small, fast, no depth-sort needed.
    for (const pr of projectiles) {
      // Slice D (SOMET-161): the trail retires the identical 6px dot every
      // ranged and magic weapon used to draw. `pr.v` is the trail effect name
      // the server resolved at launch; `vfxDefs` is the same library the
      // attack effects resolve against.
      //
      // The dot is KEPT as the fallback, deliberately. A weapon with no trail
      // binding -- or one whose binding names a row someone renamed, which
      // jsonb-with-no-FK makes possible -- must still show a visible
      // projectile. Drawing nothing would be indistinguishable from the shot
      // never having fired, which is the exact complaint this epic opened on.
      if (this._drawProjectileTrail(pr)) continue;
      const s = worldToScreen(pr.x, pr.y);
      this.ctx.beginPath();
      this.ctx.arc(s.x, anchorY(s.y, pr.o), 6, 0, Math.PI * 2);
      this.ctx.fillStyle = elementColor(pr.element);
      this.ctx.fill();
    }

    this.drawBlasts(blasts);
    this.drawVfx(vfx);

    camera.reset(this.ctx);
    this.renderHud({ player, remotePlayers, localUserId, mana, maxMana, showMana, stamina, maxStamina, weaponName, ammo, noAmmoFlash, effects, gold, progression });
    if (toast) this.renderToast(toast);

    // Inventory panel overlay (drawn last, on top of the HUD, in raw canvas
    // pixel space — same space Game hit-tests clicks against).
    this._invHitAreas = [];
    if (inventoryOpen && inventory) {
      this._invLayout = this.renderInventory(this.ctx, inventory, this._invHitAreas, selectedItemId, inventoryView);
    }

    // Shop panel overlay (Slice D) — same overlay convention as the
    // inventory panel above: raw canvas pixel space, hit areas rebuilt every
    // frame and only populated while the panel is actually open.
    this._shopHitAreas = [];
    if (shopOpen && shop) {
      // The item-type catalog lives on inventory.types (populated from the
      // `joined` frame's itemTypes — see applyJoined in core/inventory.js);
      // there is no separate itemTypes state to thread through.
      const itemTypes = inventory ? inventory.types : new Map();
      this.renderShop(this.ctx, shop, inventory, itemTypes, gold, this._shopHitAreas, shopView);
    }

    // Bank panel overlay (SOMET-310) — same convention again. Rebuilt every
    // frame and only populated while open, so a click can never hit a stale
    // rect from a panel that has since closed.
    this._bankHitAreas = [];
    if (bankOpen && bank) {
      const itemTypes = inventory ? inventory.types : new Map();
      this.renderBank(this.ctx, bank, inventory, itemTypes, this._bankHitAreas, bankView);
    }

    // SOMET-493 — last of all, so the card sits on top of the HUD orbs and the
    // toast rather than being half-covered by them. `_inspectLayout` was
    // computed in the same frame, from the drawables that were actually drawn.
    if (this._inspectLayout) this.drawInspectCard(this._inspectLayout);
  }

  // Decide what the inspect card is showing this frame, and lay it out.
  //
  // Split out of renderChunked so the pinned-target lookup and the "panel is
  // open" suppression are one readable block rather than another twenty lines
  // inside a 200-line method. Writes three fields:
  //   _inspectHoverKey  what a click would pin (read by Game's mousedown)
  //   _inspectTarget    the resolved drawable, or null
  //   _inspectLayout    the card geometry, or null
  _resolveInspect(inspect, drawables, panelOpen) {
    this._inspectHoverKey = null;
    this._inspectTarget = null;
    this._inspectLayout = null;
    if (!inspect || !inspect.enabled || panelOpen) return;
    const cx = inspect.cursorX, cy = inspect.cursorY;
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !inspect.camera) return;

    const point = canvasToCameraPoint(cx, cy, inspect.camera);
    const hover = pickDrawable(drawables, point);
    this._inspectHoverKey = targetKey(hover);

    // Hover wins over a pin: pointing at something new is an unambiguous
    // request to look at THAT, and making the player un-pin first would be a
    // mode nobody asked for.
    let target = hover;
    // A pinned target is re-found by key every frame rather than being held as
    // an object reference — CreatureManager replaces nothing but does DELETE a
    // creature that leaves the neighbourhood, and holding the reference would
    // keep drawing a card for something no longer in the world.
    if (!target && inspect.pinnedKey) {
      target = drawables.find((d) => targetKey(d) === inspect.pinnedKey) || null;
    }
    if (!target) return;

    const desc = describeTarget(target, {
      entityDefs: inspect.entityDefs,
      itemTypes: inspect.itemTypes,
      localPlayer: inspect.localPlayer,
    });
    if (!desc) return;

    // Anchor at the cursor while hovering; at the target itself when the card
    // is only up because it was pinned, so a pinned card does not trail the
    // pointer across the screen attached to nothing.
    let ax = cx, ay = cy;
    if (!hover) {
      const r = drawableScreenRect(target);
      if (r) {
        const off = canvasToCameraPoint(0, 0, inspect.camera);
        ax = r.x + r.w / 2 - off.x;
        ay = r.y - off.y;
      }
    }
    this._inspectTarget = target;
    this._inspectLayout = layoutCard(desc, ax, ay, GAME_WIDTH, GAME_HEIGHT);
  }

  // Paint the geometry inspect.layoutCard produced. Deliberately dumb: every
  // number it draws was decided by the pure module, so a layout bug is
  // reproducible in a unit test instead of only in a screenshot.
  drawInspectCard(layout) {
    const ctx = this.ctx;
    const { box } = layout;
    ctx.save();
    ctx.translate(box.x, box.y);

    ctx.fillStyle = "rgba(12,14,24,0.92)";
    ctx.strokeStyle = "rgba(150,160,200,0.45)";
    ctx.lineWidth = 1;
    ctx.fillRect(0, 0, box.w, box.h);
    ctx.strokeRect(0.5, 0.5, box.w - 1, box.h - 1);

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    // Title, clipped to the space left of the badge so a long creature name
    // cannot run under it.
    if (layout.title) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(CARD_PAD_X, 0, layout.titleMaxW, box.h);
      ctx.clip();
      ctx.font = `bold ${layout.title.size}px sans-serif`;
      ctx.fillStyle = "#f4f6ff";
      ctx.fillText(layout.title.text, CARD_PAD_X, layout.title.y);
      ctx.restore();
    }

    // The aggression badge: a filled pill in the TOP-RIGHT corner, coloured by
    // tier so it reads at a glance without being read.
    if (layout.badge) {
      const b = layout.badge;
      const bx = box.w - CARD_PAD_X - b.w;
      ctx.fillStyle = b.color;
      ctx.globalAlpha = 0.22;
      ctx.fillRect(bx, b.y, b.w, b.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = b.color;
      ctx.strokeRect(bx + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      ctx.font = `bold ${b.size}px sans-serif`;
      ctx.fillStyle = b.color;
      ctx.textAlign = "center";
      ctx.fillText(b.text, bx + b.w / 2, b.y + b.h - 5);
      ctx.textAlign = "left";
    }

    if (layout.subtitle) {
      ctx.font = `${layout.subtitle.size}px sans-serif`;
      ctx.fillStyle = "#9aa3c7";
      ctx.fillText(layout.subtitle.text, CARD_PAD_X, layout.subtitle.y);
    }

    for (const line of layout.lines) {
      ctx.font = `${line.size}px sans-serif`;
      ctx.fillStyle = "#c8cee8";
      ctx.fillText(line.text, CARD_PAD_X, line.y);
    }

    // HP on the upper row, MP on the lower one — thin labelled strips rather
    // than orbs, so both fit in a card this size.
    for (const bar of layout.bars) {
      ctx.font = `bold ${CARD_BAR_LABEL}px sans-serif`;
      ctx.fillStyle = "#8b93b5";
      ctx.fillText(bar.label, bar.x, bar.y + bar.h);
      const tx = bar.x + 18;
      const tw = bar.w - 18;
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.fillRect(tx, bar.y, tw, bar.h);
      if (bar.pct > 0) {
        ctx.fillStyle = bar.color;
        ctx.fillRect(tx, bar.y, Math.max(1, tw * bar.pct), bar.h);
      }
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeRect(tx + 0.5, bar.y + 0.5, tw - 1, bar.h - 1);
      ctx.font = `${CARD_BAR_LABEL}px sans-serif`;
      ctx.fillStyle = "#c8cee8";
      ctx.fillText(bar.text, tx + tw + 6, bar.y + bar.h);
    }

    ctx.restore();
  }

  // AoE detonation rings: each expands from nothing to its full world radius
  // and fades out over its lifetime. Drawn inside the camera transform, right
  // after the projectiles, so a blast sits where its shot ended.
  drawBlasts(blasts) {
    if (!blasts || blasts.length === 0) return;
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    this.ctx.save();
    for (const b of blasts) {
      const t = blastProgress(b, now);
      // Same conversion as the projectile draw above — worldToScreen returns
      // the tile diamond's CENTRE, and the anchor lift puts the ring at the
      // height its own shot was flying at (SOMET-326: inherited from the
      // projectile, no longer half a tile) rather than flat on the ground.
      // Do not add any further offset: doing so is what put markers a tile
      // away from their subject in an earlier slice.
      const s = worldToScreen(b.x, b.y);
      const cy = anchorY(s.y, b.o);
      // A world circle projects to a 2:1 ellipse, not a circle — drawing an
      // arc here would claim a blast reaches further north/south than it does.
      const rx = blastScreenRadiusX(b.radius) * t;
      if (rx <= 0) continue;
      this.ctx.globalAlpha = 1 - t;
      this.ctx.strokeStyle = elementColor(b.element);
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.ellipse(s.x, cy, rx, rx / 2, 0, 0, Math.PI * 2);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  // Attack effects. Slice A draws one shape — `arc`, the melee swing: a wedge
  // on the iso ground plane that sweeps open from one edge of the weapon's
  // cone to the other and fades out. Radius and angular width come from the
  // EVENT (the weapon's real reach/arc_width), which is what makes a halberd
  // and a knife look different while sharing one effect row.
  //
  // Slice B: the full vocabulary — arc, line, ring, burst, bolt. An unknown
  // shape is still skipped rather than drawn wrong.
  //
  // Every shape derives its screen geometry from the SAME two primitives the
  // arc already used: worldToScreen for a point, and blastScreenRadiusX for a
  // world radius. None of them re-derive the iso projection, so none of them
  // can disagree with the arc (or with the blast ring) about where a given
  // world offset lands.
  drawVfx(effects) {
    if (!effects || effects.length === 0) return;
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    this.ctx.save();
    for (const fx of effects) {
      if (!fx.def) continue;
      // Slice C: particles are drawn for ANY shape that carries them, before
      // the geometry, so the body of the effect sits on top of its own spray.
      this._drawVfxParticles(fx, now);
      if (fx.def.shape !== "arc") { this._drawVfxShape(fx, now); continue; }
      const t = effectProgress(fx, now);
      // Same conversion as drawBlasts above — worldToScreen gives the tile
      // diamond's CENTRE, and the anchor lift puts the swing at the height
      // this attacker's weapon launches from (SOMET-326) rather than flat on
      // the ground. Do not add a further offset.
      const s = worldToScreen(fx.x, fx.y);
      const cy = anchorY(s.y, fx.o);
      // A world circle projects to a 2:1 ellipse, not a circle — the same
      // ground-plane projection the blast ring uses, reused rather than
      // re-derived so the two can never disagree.
      const rx = blastScreenRadiusX(fx.reach);
      if (rx <= 0) continue;
      const half = (fx.arc || 0) / 2;
      // PARAMETRIC angle, not the world angle: see isoArcAngle.
      const phi = isoArcAngle(fx.nx, fx.ny);
      const from = phi - half;
      const to = from + (fx.arc || 0) * t;      // the sweep opens over the lifetime

      this.ctx.globalAlpha = effectAlpha(fx, now);
      this.ctx.strokeStyle = fx.def.color || "#dddddd";
      this.ctx.lineWidth = Number(fx.def.width) || 2;
      this.ctx.beginPath();
      this.ctx.ellipse(s.x, cy, rx, rx / 2, 0, from, to);
      this.ctx.stroke();
      // The leading radial edge (centre -> the sweeping edge). Without it a
      // narrow swing (a dagger: 0.6 rad at reach 80) is a short stub of arc
      // that barely reads as an attack; the spoke gives it a direction. The
      // trailing edge is intentionally omitted — an open wedge reads as a
      // moving swipe rather than a static pie slice (verified in a real world;
      // closing it into a filled wedge is deferred to the slice B polish).
      this.ctx.beginPath();
      this.ctx.moveTo(s.x, cy);
      this.ctx.lineTo(s.x + rx * Math.cos(to), cy + (rx / 2) * Math.sin(to));
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  // A projectile's trail (slice D). Returns true when it drew one, false to
  // tell the caller to fall back to the plain dot.
  //
  // The trail is drawn as a streak BEHIND the projectile's current position,
  // along its own direction of travel, rather than as a lifetime-animated
  // effect: a projectile is a persistent object that moves, not a one-shot
  // event, so there is no arrival time to animate against. That difference is
  // why this does not reuse drawVfx.
  _drawProjectileTrail(pr) {
    const def = pr && pr.v && this.vfxDefs ? this.vfxDefs[pr.v] : null;
    if (!def) return false;

    const s = worldToScreen(pr.x, pr.y);
    const cy = anchorY(s.y, pr.o);
    // Unit direction of travel, sent on the snapshot. Without it the streak
    // has no meaningful orientation, and a plain dot reads better than a
    // streak pointing the wrong way -- so that case falls back rather than
    // guessing.
    const nx = Number(pr.nx);
    const ny = Number(pr.ny);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || (nx === 0 && ny === 0)) return false;

    const TRAIL_WORLD_LEN = 34;
    const back = worldToScreen(pr.x - nx * TRAIL_WORLD_LEN, pr.y - ny * TRAIL_WORLD_LEN);
    this.ctx.save();
    this.ctx.strokeStyle = def.color || elementColor(pr.element);
    this.ctx.lineWidth = Number(def.width) || 3;
    this.ctx.globalAlpha = 0.9;
    this.ctx.beginPath();
    // The SAME anchor as the head of the streak — a trail whose two ends
    // lifted by different amounts would slope for no physical reason.
    this.ctx.moveTo(back.x, anchorY(back.y, pr.o));
    this.ctx.lineTo(s.x, cy);
    this.ctx.stroke();
    this.ctx.restore();
    return true;
  }

  // Element tints for an impact burst (slice C). The impact EFFECT rows are
  // already element-specific, so this is a second, cheaper lever: a generic
  // effect fired by an elemental weapon still reads as that element rather
  // than as a white spark. `el` rides the impact descriptor from the server.
  //
  // SOMET-329: the table itself moved to core/elements.js and is now fed by
  // the server's catalog. Kept as an accessor because it was a public-ish
  // surface on this class; it is a live view, not a snapshot, so a catalog
  // applied after construction is picked up.
  static tintFor(element) {
    return elementTint(element);
  }

  // Particles for one effect. Positions come from vfx.js's particlesAt, which
  // is PURE and seeded -- there is deliberately no Math.random() here, because
  // this runs every frame: a random call would make the same burst jitter
  // frame to frame and differ between two clients watching the same fight.
  _drawVfxParticles(fx, now) {
    const def = fx.def;
    const count = Math.floor(Number(def.particle_count) || 0);
    if (count <= 0) return;

    // RAW progress, not eased: easing is a display curve for the geometry, and
    // particles have their own lifetime. Reusing the eased value would make
    // gravity look wrong.
    const life = Number(def.particle_lifetime_ms) || 300;
    const t = (now - fx.startedAt) / life;
    if (t < 0 || t > 1) return;

    const parts = particlesAt(fx, t);
    if (parts.length === 0) return;

    const tint = RenderSystem.tintFor(fx.el);
    const size = Math.max(0, Number(def.particle_size) || 2);
    if (size === 0) return;

    this.ctx.fillStyle = tint || def.color || "#ffffff";
    for (const pt of parts) {
      // Each particle is a world-space offset from the impact point, so it
      // goes through the SAME projection as everything else rather than being
      // nudged in screen space.
      const s = worldToScreen(fx.x + pt.dx, fx.y + pt.dy);
      this.ctx.globalAlpha = pt.alpha;
      this.ctx.fillRect(s.x - size / 2, anchorY(s.y, fx.o) - size / 2, size, size);
    }
    this.ctx.globalAlpha = 1;
  }

  // The four non-arc shapes (slice B). Split out so drawVfx's arc branch --
  // which carries hard-won iso notes -- stays readable rather than growing a
  // five-way switch inline.
  //
  // DEGENERATE INPUT IS THE POINT OF THE EARLY RETURNS: a weapon may legally
  // have reach 0 (every projectile weapon does), and an author can save an
  // effect with width 0. Canvas silently draws nothing for a zero-length path
  // but THROWS on a negative radius, so anything feeding ellipse() is clamped
  // rather than trusted.
  _drawVfxShape(fx, now) {
    const shape = fx.def.shape;
    if (shape !== "line" && shape !== "ring" && shape !== "burst"
        && shape !== "bolt" && shape !== "block") return;

    const t = effectProgress(fx, now);
    const s = worldToScreen(fx.x, fx.y);
    const cy = anchorY(s.y, fx.o);           // the attacker's own launch height, as the arc uses
    const reach = Number(fx.reach) || 0;

    this.ctx.globalAlpha = effectAlpha(fx, now);
    this.ctx.strokeStyle = fx.def.color || "#dddddd";
    this.ctx.lineWidth = Number(fx.def.width) || 2;

    // A point `d` world-units along the aim vector, projected. Going through
    // worldToScreen rather than offsetting in screen space keeps a thrust
    // pointing where the player actually aimed on the iso ground plane.
    const along = (d) => {
      const p = worldToScreen(fx.x + fx.nx * d, fx.y + fx.ny * d);
      return { x: p.x, y: anchorY(p.y, fx.o) };
    };

    if (shape === "line") {
      // A thrust: centre outward to the full reach, extending over the
      // lifetime. Zero reach would be a zero-length path (invisible), so it is
      // skipped outright rather than left to the canvas.
      if (reach <= 0) return;
      const end = along(reach * t);
      this.ctx.beginPath();
      this.ctx.moveTo(s.x, cy);
      this.ctx.lineTo(end.x, end.y);
      this.ctx.stroke();
      return;
    }

    if (shape === "ring") {
      // An expanding ground-plane circle, same 2:1 projection as the blast
      // ring. Radius grows with progress, so it reads as a shockwave.
      const rx = blastScreenRadiusX(reach) * t;
      if (!(rx > 0)) return;                 // also rejects NaN
      this.ctx.beginPath();
      this.ctx.ellipse(s.x, cy, rx, rx / 2, 0, 0, Math.PI * 2);
      this.ctx.stroke();
      return;
    }

    if (shape === "burst") {
      // Radial spokes: an impact/detonation that reads as force leaving a
      // point in every direction. Spoke COUNT is fixed rather than read from
      // the effect row -- particle_count arrives in slice C and means
      // something else (real particles); borrowing it here would collide.
      const rx = blastScreenRadiusX(reach) * t;
      if (!(rx > 0)) return;
      const SPOKES = 8;
      for (let i = 0; i < SPOKES; i++) {
        const phi = (Math.PI * 2 * i) / SPOKES;
        this.ctx.beginPath();
        this.ctx.moveTo(s.x, cy);
        this.ctx.lineTo(s.x + rx * Math.cos(phi), cy + (rx / 2) * Math.sin(phi));
        this.ctx.stroke();
      }
      return;
    }

    if (shape === "block") {
      // SOMET-286: an attack a RULE refused (a village guard is immune to
      // player damage). Deliberately unlike every other shape in this file --
      // no ground-plane ellipse, no radial spray, no aim wedge: a billboarded
      // SHIELD standing between the target and the blow, plus two sparks
      // skidding off its face. Whatever weapon the player swings, a refusal
      // looks like this and a miss looks like the weapon's whiff, so the two
      // can no longer be confused, which is the entire ticket.
      //
      // Sized from a screen-space constant, NOT from `reach`: an impact
      // descriptor is a point on a target, not a swing, and carries reach 0 --
      // scaling by it would collapse the glyph to nothing (invisible, i.e. the
      // bug, restored).
      const BLOCK_PX = 15;
      const OFFSET_WORLD = 20;
      const dirOk = Number.isFinite(fx.nx) && Number.isFinite(fx.ny);
      // Offset toward where the blow came from (the server sends that
      // direction on every block), so the shield sits on the struck side
      // rather than floating on the guard's head.
      const o = dirOk
        ? worldToScreen(fx.x + fx.nx * OFFSET_WORLD, fx.y + fx.ny * OFFSET_WORLD)
        : s;
      const ox = o.x, oy = anchorY(o.y, fx.o);
      // Flares to full size early, then holds while the alpha fades: a glint,
      // not a growing bubble.
      const k = BLOCK_PX * (0.55 + 0.45 * t);
      this.ctx.beginPath();
      this.ctx.moveTo(ox - k * 0.62, oy - k);
      this.ctx.lineTo(ox + k * 0.62, oy - k);
      this.ctx.lineTo(ox + k * 0.62, oy + k * 0.1);
      this.ctx.quadraticCurveTo(ox + k * 0.62, oy + k * 0.95, ox, oy + k * 1.25);
      this.ctx.quadraticCurveTo(ox - k * 0.62, oy + k * 0.95, ox - k * 0.62, oy + k * 0.1);
      this.ctx.closePath();
      this.ctx.stroke();

      // The two deflection sparks, thrown back along the line the blow came
      // in on. Derived from the SAME screen offset the shield used, so they
      // always skid off its face and never off its back; when that offset is
      // degenerate (no direction sent) there is no line to throw them along
      // and the shield alone carries the cue.
      const dx = ox - s.x, dy = oy - anchorY(s.y, fx.o);
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const base = Math.atan2(dy, dx);
        const spark = k * (0.5 + 0.9 * t);
        for (const sgn of [-1, 1]) {
          const a2 = base + sgn * 0.7;
          this.ctx.beginPath();
          this.ctx.moveTo(ox, oy);
          this.ctx.lineTo(ox + spark * Math.cos(a2), oy + spark * Math.sin(a2));
          this.ctx.stroke();
        }
      }
      return;
    }

    // bolt: a short dash TRAVELLING outward along the aim, rather than growing
    // from the centre. The trailing end lags the leading one by a fixed
    // fraction of the lifetime, which is what makes it read as a moving object
    // instead of a stretching line.
    if (reach <= 0) return;
    const TAIL = 0.25;
    const head = reach * t;
    const tail = reach * Math.max(0, t - TAIL);
    const a = along(tail);
    const b = along(head);
    this.ctx.beginPath();
    this.ctx.moveTo(a.x, a.y);
    this.ctx.lineTo(b.x, b.y);
    this.ctx.stroke();
  }

  // A small transient toast for server-rejected actions (e.g. "unequip it
  // first") — the server previously only reached console.error, so a
  // rejected click produced no in-game feedback at all. Styled like the HUD
  // box (dark translucent panel, same monospace font); fades over its last
  // TOAST_FADE_MS rather than popping off abruptly. `toast` is
  // {message, expiresAt} in performance.now() units, or null/undefined to
  // draw nothing — the caller (Game) owns clearing it once expired.
  renderToast(toast) {
    const TOAST_FADE_MS = 500;
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    const remaining = toast.expiresAt - now;
    if (remaining <= 0) return;
    const alpha = Math.min(1, remaining / TOAST_FADE_MS);

    const text = String(toast.message);
    this.ctx.save();
    this.ctx.font = "13px monospace";
    const textW = this.ctx.measureText(text).width;
    const boxW = Math.min(GAME_WIDTH - 40, textW + 32);
    const boxH = 30;
    const boxX = (GAME_WIDTH - boxW) / 2;
    const boxY = GAME_HEIGHT - 56;

    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = "rgba(120,20,20,0.75)";
    this.ctx.fillRect(boxX, boxY, boxW, boxH);
    this.ctx.strokeStyle = "#ef4444";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(boxX, boxY, boxW, boxH);
    this.ctx.fillStyle = "#f5f5f5";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(text, GAME_WIDTH / 2, boxY + boxH / 2 + 1);
    this.ctx.restore();
  }

  // A small diamond, coloured by the item type's category. The name is drawn
  // only when the player is close enough to actually loot it, so a busy field
  // of drops does not become a wall of text.
  drawGroundItem(item, inventory, player) {
    // worldToScreen returns the diamond's CENTRE (see the tile draw above,
    // which draws its vertices at s.y +/- halfH / s.x +/- halfW around this
    // same point) — so no lift is needed to sit the marker on the tile.
    // Unlike here, the projectile draw intentionally lifts by its shot's own
    // anchor (SOMET-326: attackAnchor.js's anchorY, resolved from the
    // shooter's body — it used to be a flat ISO_TILE_H/2), because projectiles
    // fly at body height rather than resting on the ground.
    const s = worldToScreen(item.x, item.y);
    const dx = s.x, dy = s.y;
    const type = inventory && inventory.types ? inventory.types.get(item.typeId) : null;
    const color = type && type.category === "armor" ? "#7ec8e3" : "#e3c27e";
    const r = 9;
    this.ctx.save();
    // SOMET-490: the grade halo goes down FIRST, so the item marker below
    // draws over it rather than under it -- a glow painted after the diamond
    // would wash the item's own category colour out. Nothing here replaces the
    // canvas transform (translate/scale COMPOSE with whatever the camera has
    // already applied); the wall-side pass got that wrong once and silently
    // dropped everything drawn before it.
    this.drawRarityGlow(dx, dy, r, item.rarity);
    this.ctx.fillStyle = color;
    this.ctx.strokeStyle = "rgba(0,0,0,0.6)";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(dx, dy - r);
    this.ctx.lineTo(dx + r, dy);
    this.ctx.lineTo(dx, dy + r);
    this.ctx.lineTo(dx - r, dy);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    if (type && player) {
      const pdx = (player.x + player.width / 2) - item.x;
      const pdy = (player.y + player.height / 2) - item.y;
      if (pdx * pdx + pdy * pdy <= PICKUP_RADIUS * PICKUP_RADIUS) {
        this.ctx.fillStyle = "#fff";
        this.ctx.font = "12px sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.fillText(type.name, dx, dy - r - 6);
      }
    }
    this.ctx.restore();
  }

  // The rarity halo: an iso-flattened radial gradient under a ground item.
  //
  // Colour comes from core/rarityColors.js, the SAME module the inventory
  // panel tints its cells from -- the ground must never disagree with the
  // tooltip a player opens two seconds later.
  //
  // A white / absent / unrecognised grade draws NOTHING and returns early, so
  // an item that predates SOMET-480 renders exactly as it did before this
  // method existed.
  drawRarityGlow(dx, dy, r, rarity) {
    const base = rarityGlowColor(rarity);
    if (!base) return;
    const inner = withAlpha(base, 0.55);
    const outer = withAlpha(base, 0);
    if (!inner || !outer) return; // malformed palette entry: draw nothing, not a black blob
    const R = r * 2.4;
    this.ctx.save();
    // translate + scale, never setTransform: these MULTIPLY into the camera
    // transform already on the stack. The 0.5 y-scale is the isometric tile
    // ratio, so the halo reads as a pool of light lying on the ground rather
    // than a sphere floating in front of it.
    this.ctx.translate(dx, dy);
    this.ctx.scale(1, 0.5);
    const g = this.ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.arc(0, 0, R, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  // A village's merchant: a fixed marker (no facing/animation) at the
  // village's merchantX/Y from the join frame. Distinct color + always-on
  // label distinguish it from a transient ground-item drop at a glance.
  drawMerchant(m, player = null) {
    const s = worldToScreen(m.x, m.y);
    const dx = s.x, dy = s.y;
    const r = 11;
    this.ctx.save();
    this.ctx.fillStyle = "#c084fc";
    this.ctx.strokeStyle = "rgba(0,0,0,0.6)";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(dx, dy - r);
    this.ctx.lineTo(dx + r, dy);
    this.ctx.lineTo(dx, dy + r);
    this.ctx.lineTo(dx - r, dy);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.fillStyle = "#fff";
    this.ctx.font = "12px sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.fillText("Merchant", dx, dy - r - 6);

    // Show prompt when player is within interact range
    if (player) {
      const pcx = player.x + (player.width || 0) / 2;
      const pcy = player.y + (player.height || 0) / 2;
      const d = Math.hypot(m.x - pcx, m.y - pcy);
      if (d <= WORLD_CHEST_PROMPT_R) {
        this.ctx.font = "bold 11px sans-serif";
        this.ctx.fillStyle = "#c084fc";
        this.ctx.strokeStyle = "rgba(0,0,0,0.85)";
        this.ctx.lineWidth = 2;
        this.ctx.strokeText("[e] Trade", dx, dy + r + 14);
        this.ctx.fillText("[e] Trade", dx, dy + r + 14);
      }
    }

    this.ctx.restore();
  }

  // SOMET-310 — the account chest's world marker, drawn beside the merchant it
  // shares a village with. Same diamond footprint and label placement as
  // drawMerchant above so the two read as a matched pair of village services;
  // amber rather than violet, and squatter, so which one a player is walking
  // toward is legible at a glance without reading the label.
  drawBank(b, player = null) {
    const s = worldToScreen(b.x, b.y);
    const dx = s.x, dy = s.y;
    const r = 11;
    this.ctx.save();
    this.ctx.fillStyle = "#caa24a";
    this.ctx.strokeStyle = "rgba(0,0,0,0.6)";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(dx - r, dy - r * 0.55);
    this.ctx.lineTo(dx + r, dy - r * 0.55);
    this.ctx.lineTo(dx + r, dy + r * 0.55);
    this.ctx.lineTo(dx - r, dy + r * 0.55);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    // Lid seam, so the chest reads as a chest rather than a plain box.
    this.ctx.beginPath();
    this.ctx.moveTo(dx - r, dy - r * 0.1);
    this.ctx.lineTo(dx + r, dy - r * 0.1);
    this.ctx.stroke();
    this.ctx.fillStyle = "#fff";
    this.ctx.font = "12px sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.fillText("Chest", dx, dy - r - 6);

    // Show prompt when player is within interact range
    if (player) {
      const pcx = player.x + (player.width || 0) / 2;
      const pcy = player.y + (player.height || 0) / 2;
      const d = Math.hypot(b.x - pcx, b.y - pcy);
      if (d <= WORLD_CHEST_PROMPT_R) {
        this.ctx.font = "bold 11px sans-serif";
        this.ctx.fillStyle = "#fbbf24";
        this.ctx.strokeStyle = "rgba(0,0,0,0.85)";
        this.ctx.lineWidth = 2;
        this.ctx.strokeText("[b] Open", dx, dy + r + 14);
        this.ctx.fillText("[b] Open", dx, dy + r + 14);
      }
    }

    this.ctx.restore();
  }

  // SOMET-372 -- a WORLD chest: guarded, lootable, and a different object from
  // the account chest drawBank marks (that one is a village service and is
  // always amber; this one changes with its state, and a player must be able
  // to tell "still guarded" from "ready to open" from across a clearing).
  //
  // The three states come straight off the server frame and are never derived
  // here: `locked` means its guard is alive, `unlocked` means the guard is
  // dead and the loot is waiting, `opened` means it has been looted (a field
  // chest relocks later; a vault chest never does).
  //
  // `player` is passed only for the prompt distance, which is COSMETIC. Range
  // is the authority's decision -- it proximity-picks the nearest chest within
  // its own INTERACT_RADIUS and answers "no chest nearby" when there is none.
  // Deliberately not importing that constant: a second copy in the client is a
  // second thing to keep in step, and being wrong here costs a hint, not an
  // action.
  drawWorldChest(c, player) {
    const state = c.state || "locked";
    const s = worldToScreen(c.x, c.y);
    const dx = s.x, dy = s.y;
    const r = 13;
    const body = state === "opened" ? "#4a4033" : state === "unlocked" ? "#e0b64e" : "#8a8f98";
    this.ctx.save();
    this.ctx.fillStyle = body;
    this.ctx.strokeStyle = "rgba(0,0,0,0.65)";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(dx - r, dy - r * 0.6);
    this.ctx.lineTo(dx + r, dy - r * 0.6);
    this.ctx.lineTo(dx + r, dy + r * 0.6);
    this.ctx.lineTo(dx - r, dy + r * 0.6);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    // An opened chest gets its lid seam drawn ABOVE the body (a raised lid)
    // rather than across it, so a looted chest is distinguishable from an
    // unlooted one even in greyscale or at the edge of the screen.
    this.ctx.beginPath();
    if (state === "opened") {
      this.ctx.moveTo(dx - r, dy - r * 0.6);
      this.ctx.lineTo(dx + r * 0.2, dy - r * 1.25);
    } else {
      this.ctx.moveTo(dx - r, dy - r * 0.15);
      this.ctx.lineTo(dx + r, dy - r * 0.15);
    }
    this.ctx.stroke();
    // Keyhole, on a closed chest only -- it is what reads as "there is
    // something to open here" at a glance.
    if (state !== "opened") {
      this.ctx.fillStyle = "rgba(0,0,0,0.65)";
      this.ctx.beginPath();
      this.ctx.arc(dx, dy + r * 0.1, 2.5, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.fillStyle = "#fff";
    this.ctx.font = "12px sans-serif";
    this.ctx.textAlign = "center";
    const label = state === "opened" ? "Looted" : state === "unlocked" ? "Treasure" : "Treasure (guarded)";
    this.ctx.fillText(label, dx, dy - r - 6);
    // The hint, only when the player is plausibly close enough for the key to
    // do something, and never on a chest with nothing left in it.
    if (state !== "opened" && player) {
      const pxc = player.x + (player.width || 0) / 2;
      const pyc = player.y + (player.height || 0) / 2;
      if (Math.hypot(pxc - c.x, pyc - c.y) <= WORLD_CHEST_PROMPT_R) {
        this.ctx.fillStyle = "#ffe9a8";
        this.ctx.fillText("[f] open", dx, dy + r + 14);
      }
    }
    this.ctx.restore();
  }

  // Draw doorway map transitions with destination names so players see where edges lead
  drawDoorways(doorways, chunkedMap, player) {
    if (!Array.isArray(doorways) || doorways.length === 0 || !chunkedMap) return;
    const W = chunkedMap.width, H = chunkedMap.height;
    if (!W || !H) return;
    const midW = Math.floor(W / 2), midH = Math.floor(H / 2);
    const at = {
      N: { col: midW, row: 0, label: 'North' },
      S: { col: midW, row: H - 1, label: 'South' },
      W: { col: 0, row: midH, label: 'West' },
      E: { col: W - 1, row: midH, label: 'East' },
    };

    for (const d of doorways) {
      const edge = d.edge;
      const pos = at[edge];
      if (!pos) continue;
      const wx = (pos.col + 0.5) * 100;
      const wy = (pos.row + 0.5) * 100;
      const s = worldToScreen(wx, wy);

      const toName = d.toName || 'Next Map';
      const text = `🚪 To ${toName} (${pos.label})`;

      this.ctx.save();
      this.ctx.font = 'bold 12px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';

      const metrics = this.ctx.measureText ? this.ctx.measureText(text) : { width: text.length * 7.5 };
      const padX = 8;
      const boxW = (metrics.width || 80) + padX * 2;
      const boxH = 22;
      const labelY = s.y - 45;

      // Glow / border pill
      this.ctx.fillStyle = 'rgba(18, 18, 31, 0.88)';
      this.ctx.strokeStyle = '#c084fc';
      this.ctx.lineWidth = 2;

      if (this.ctx.roundRect) {
        this.ctx.beginPath();
        this.ctx.roundRect(s.x - boxW / 2, labelY - boxH / 2, boxW, boxH, 5);
        this.ctx.fill();
        this.ctx.stroke();
      } else if (this.ctx.strokeRect) {
        this.ctx.fillRect(s.x - boxW / 2, labelY - boxH / 2, boxW, boxH);
        this.ctx.strokeRect(s.x - boxW / 2, labelY - boxH / 2, boxW, boxH);
      } else {
        this.ctx.fillRect(s.x - boxW / 2, labelY - boxH / 2, boxW, boxH);
      }

      this.ctx.fillStyle = '#f3e8ff';
      if (this.ctx.fillText) {
        this.ctx.fillText(text, s.x, labelY);
      }
      this.ctx.restore();
    }
  }

  // Status-effect rings at an affected actor's feet, one per active effect,
  // coloured from the SAME element palette the projectiles and blast rings use
  // (see statusEffects.js) so a burn reads as belonging to the fire bolt that
  // caused it.
  //
  // COORDINATES: the caller passes (cx, feetY) taken straight off the values
  // it has ALREADY computed for its sprite — cx is worldToScreen's x, feetY is
  // `drawY + h`, which is the expression drawCreature/drawEntity already use to
  // put an actor's feet on the diamond. Nothing is re-derived here.
  //
  // Since SOMET-319 an actor's feet sit ON the diamond centre (drawY = s.y - h
  // => drawY + h = s.y), the same point drawGroundItem uses, so the ring and a
  // dropped item now agree about where the ground is. Keep taking feetY from
  // the caller's own `drawY + h` rather than reading s.y here: the sprite's
  // vertical anchor has moved once already, and a ring that derives it
  // independently is a ring that silently detaches the next time it moves.
  //
  // The 2:1 ellipse (rx, rx/2) is the same ground-plane projection blastScreen-
  // RadiusX documents. Rings are drawn OUTWARD (each successive effect larger)
  // rather than stacked, so two effects stay individually readable instead of
  // the second painting over the first.
  _drawEffectRings(cx, feetY, w, effects) {
    const active = normalizeEffects(effects);
    if (active.length === 0) return;
    this.ctx.save();
    this.ctx.lineWidth = 2;
    // A soft filled glow under the first (lowest-ordered) effect, so an
    // affected actor reads as tinted at a glance rather than only on close
    // inspection of a thin outline.
    const glow = effectColor(active[0]);
    if (glow) {
      this.ctx.globalAlpha = 0.22;
      this.ctx.fillStyle = glow;
      this.ctx.beginPath();
      this.ctx.ellipse(cx, feetY, w * 0.45, w * 0.225, 0, 0, Math.PI * 2);
      this.ctx.fill();
    }
    active.forEach((key, i) => {
      const color = effectColor(key);
      if (!color) return;
      const rx = w * 0.45 + i * 5;
      this.ctx.strokeStyle = color;
      this.ctx.globalAlpha = 0.9;
      this.ctx.beginPath();
      this.ctx.ellipse(cx, feetY, rx, rx / 2, 0, 0, Math.PI * 2);
      this.ctx.stroke();
    });
    this.ctx.restore();
  }

  // Colour pips above an affected actor, alongside the HP bar. The feet rings
  // can be occluded by a sprite standing in front; the pips sit above the head
  // where the HP bar already reads clearly, so an effect is never completely
  // hidden. (drawX, drawY) is the sprite rect's TOP-LEFT, the same origin
  // _drawHpBar takes.
  _drawEffectPips(drawX, drawY, effects) {
    const active = normalizeEffects(effects);
    if (active.length === 0) return;
    const size = 5, gap = 2;
    // Sits above the HP bar's row (drawY - 8, height 4) and below the level
    // tag's baseline (drawY - 18, ~drawY-26.5..drawY-18 for 12px bold
    // monospace), so all three rows -- level tag, pips, HP bar -- stack
    // without overlapping on an actor that is damaged, affected, AND leveled.
    const py = drawY - 16;
    this.ctx.save();
    active.forEach((key, i) => {
      const color = effectColor(key);
      if (!color) return;
      this.ctx.fillStyle = color;
      this.ctx.fillRect(drawX + i * (size + gap), py, size, size);
    });
    this.ctx.restore();
  }

  // Small red/yellow/green bar above a damaged actor (creature or player).
  // (drawX, drawY) is the actor's screen draw origin (top-left of its sprite
  // rect); the bar sits just above it, spanning the sprite's width.
  _drawHpBar(drawX, drawY, w, hp, maxHp) {
    const bx = drawX, by = drawY - 8, bw = w, bh = 4;
    const frac = Math.max(0, Math.min(1, hp / maxHp));
    this.ctx.fillStyle = "rgba(0,0,0,0.6)";
    this.ctx.fillRect(bx, by, bw, bh);
    this.ctx.fillStyle = frac > 0.5 ? "#4ade80" : frac > 0.25 ? "#facc15" : "#ef4444";
    this.ctx.fillRect(bx, by, bw * frac, bh);
  }

  // Draw a sprite so its feet sit on the tile center for its world (x,y).
  drawCreature(obj, imageKey, alpha = 1, tag = null) {
    const w = obj.width || 64;
    const h = obj.height || 64;
    // Anchor: project the actor's world box CENTER — the exact point movement
    // and collision resolve against (systems/movement.js resolveMove works on
    // that box) — and stand the sprite's feet on it. worldToScreen returns the
    // diamond's CENTRE, which is where a world point actually lands, so no
    // lift belongs here: it is the same convention drawGroundItem, drawWall
    // and the flat tile pass already use.
    //
    // SOMET-319: this used to add ISO_TILE_H/2. At ISO_TILE_W=128 /
    // MAP_TILE_SIZE=100 the iso scale is 0.64, so those 32px are exactly the
    // projection of a (+50,+50) world offset — half a tile toward the camera.
    // The sprite was drawn half a tile in FRONT of the actor, which put the
    // collision anchor at the sprite's waist: obstacles blocked mid-body and
    // dropped items landed at the player's belt. Do not reintroduce the lift.
    const s = worldToScreen(obj.x + w / 2, obj.y + h / 2);
    const drawX = s.x - w / 2;
    const drawY = s.y - h;
    // Effect rings go down FIRST, so the actor stands on top of its own aura
    // rather than being obscured by it. `drawY + h` is the feet line this same
    // method already computed — see _drawEffectRings on why not s.y.
    this._drawEffectRings(s.x, drawY + h, w, obj.effects);
    const img = this.imageManager.get(imageKey);
    this.ctx.globalAlpha = alpha;
    if (img) {
      this.ctx.drawImage(img, drawX, drawY, w, h);
    } else {
      // Mid-body of the box the image path draws (drawY .. drawY + h), so the
      // placeholder occupies the same footprint as a real sprite would.
      const cx = s.x;
      const cy = s.y - h / 2;
      drawPlaceholder(this.ctx, cx, cy, w / 2, tag !== null ? "#f59e0b" : "#4a9eff", obj.facing);
    }
    this.ctx.globalAlpha = 1;
    // HP bar for damaged actors (players carry hp/maxHp; see _onWorldState).
    if (obj.maxHp && obj.hp != null && obj.hp < obj.maxHp) {
      this._drawHpBar(drawX, drawY, w, obj.hp, obj.maxHp);
    }
    this._drawEffectPips(drawX, drawY, obj.effects);
    if (tag !== null) {
      this.ctx.fillStyle = "#fff";
      this.ctx.font = "12px sans-serif";
      this.ctx.fillText(`#${tag}`, drawX, drawY - 4);
    }
  }

  // Resolve the atlas image + source-crop rect for an entity in a sprite mode,
  // or null to fall through. Requires a loaded atlas and an attached manifest.
  // Animated mode cycles the facing's frames at timeMs; static shows one frame.
  static resolveSprite(entity, imageManager, mode, timeMs = 0) {
    if (mode === "rect" || !entity.sprite || !imageManager) return null;
    const atlas = imageManager.get(entity.sprite.atlas_key);
    const manifest = entity.sprite.manifest;
    if (!atlas || !manifest) return null;
    // Animated -> cycle the facing's frames; entity atlases generated through
    // the object/tile pipeline are FLAT (keys "0","1",… with no direction), so
    // fall back to the flat cycle before giving up on a single static frame.
    // Static -> a single representative frame.
    const key = mode === "animated"
      ? (animatedFrameKey(manifest, facingToDir(entity.facing), timeMs)
         || tileFrameKey(manifest, timeMs)
         || staticFrameKey(entity.sprite, manifest))
      : staticFrameKey(entity.sprite, manifest);
    const rect = frameRect(manifest, key);
    return rect ? { img: atlas, crop: rect } : null;
  }

  drawEntity(e) {
    const w = e.displayWidth || e.width || 40;
    const h = e.displayHeight || e.height || 40;
    const s = worldToScreen(e.x + (e.width || 40) / 2, e.y + (e.height || 40) / 2);
    const drawX = s.x - w / 2;
    // Feet/base on the projected anchor, exactly as drawCreature — see the
    // SOMET-319 note there for why there is no ISO_TILE_H/2 lift. Creatures
    // AND map decorations draw through here, so the two must share the
    // anchor: a tree keeps its trunk on its own tile centre, and a creature
    // stops against it where its feet are, not where its waist is.
    const drawY = s.y - h;

    // Creatures render through this path in renderChunked (buildDrawables'
    // "entity" kind), so their status rings belong here too. Map decorations
    // never carry `effects`, so this is a no-op for them.
    this._drawEffectRings(s.x, drawY + h, w, e.effects);

    const mode = RenderSystem.resolveRenderMode(e, this.renderModeOverride);
    // Preferred sprite path: crop a frame out of the generated atlas.
    const sprite = RenderSystem.resolveSprite(e, this.imageManager, mode, this.nowMs);
    if (sprite) {
      const [sx, sy, sw, sh] = sprite.crop;
      this.ctx.drawImage(sprite.img, sx, sy, sw, sh, drawX, drawY, w, h);
    } else {
      // Legacy single-image fallback (whole image) still honored in sprite modes;
      // then degrade to a rectangle so a missing asset never leaves a hole.
      const img = mode !== "rect" && e.image && this.imageManager
        ? this.imageManager.get(e.image)
        : null;
      if (img) {
        this.ctx.drawImage(img, drawX, drawY, w, h);
      } else {
        this.ctx.fillStyle = e.color || "#c0392b";
        this.ctx.fillRect(drawX, drawY, w, h);
      }
    }

    // HP bar for damaged actors. Map decorations never carry hp/maxHp, so
    // this only fires for creatures (which are rendered through this path
    // in renderChunked — see buildDrawables' "entity" kind).
    if (e.maxHp && e.hp != null && e.hp < e.maxHp) {
      this._drawHpBar(drawX, drawY, w, e.hp, e.maxHp);
    }
    // Level tag, above the sprite. Drawn for creatures only (decorations have
    // no level) and only above 1, so a starter world stays visually quiet.
    // Stroke-then-fill because the label sits over arbitrary terrain colours
    // and plain white text vanishes on snow.
    if (e.level > 1) {
      this.ctx.save();
      this.ctx.font = "bold 12px monospace";
      this.ctx.textAlign = "center";
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = "rgba(0,0,0,0.85)";
      this.ctx.fillStyle = "#ffd166";
      const label = `L${e.level}`;
      const lx = drawX + w / 2;
      const ly = drawY - 18;
      this.ctx.strokeText(label, lx, ly);
      this.ctx.fillText(label, lx, ly);
      this.ctx.restore();
    }
    this._drawEffectPips(drawX, drawY, e.effects);
  }

  _drawPoEOrb(cx, cy, radius, current, max, label, colorType) {
    const ctx = this.ctx;
    const curVal = current != null ? Number(current) : 0;
    const maxVal = max != null && Number(max) > 0 ? Number(max) : 100;
    const pct = Math.max(0, Math.min(1, curVal / maxVal));
    const rInner = radius - 4;

    ctx.save();

    // 1. Dark translucent backdrop for empty glass container (becomes transparent when empty)
    ctx.beginPath();
    ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10, 12, 22, 0.6)";
    ctx.fill();

    // 2. Liquid fill (bottom to top, clipped to inner circle)
    if (pct > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
      ctx.clip();

      const liquidHeight = 2 * rInner * pct;
      const liquidTopY = (cy + rInner) - liquidHeight;

      const grad = ctx.createLinearGradient(cx, liquidTopY, cx, cy + rInner);
      if (colorType === "life") {
        grad.addColorStop(0, "#ff3355");
        grad.addColorStop(0.2, "#e11d48");
        grad.addColorStop(0.6, "#991b1b");
        grad.addColorStop(1, "#450a0a");
      } else {
        grad.addColorStop(0, "#38bdf8");
        grad.addColorStop(0.2, "#2563eb");
        grad.addColorStop(0.6, "#1d4ed8");
        grad.addColorStop(1, "#0f172a");
      }

      ctx.fillStyle = grad;
      ctx.fillRect(cx - rInner - 2, liquidTopY, 2 * rInner + 4, liquidHeight + 4);

      // Glowing liquid surface edge (meniscus)
      if (pct > 0.02 && pct < 0.98) {
        const halfWidth = Math.sqrt(Math.max(0, rInner * rInner - Math.pow(liquidTopY - cy, 2)));
        ctx.beginPath();
        ctx.ellipse(cx, liquidTopY, halfWidth, 3, 0, 0, Math.PI * 2);
        ctx.fillStyle = colorType === "life" ? "rgba(255, 200, 210, 0.85)" : "rgba(200, 240, 255, 0.85)";
        ctx.fill();
      }

      // Inner orb depth vignette
      const vignette = ctx.createRadialGradient(cx, cy, rInner * 0.4, cx, cy, rInner);
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(0.8, "rgba(0, 0, 0, 0.15)");
      vignette.addColorStop(1, "rgba(0, 0, 0, 0.6)");
      ctx.fillStyle = vignette;
      ctx.fillRect(cx - rInner, cy - rInner, 2 * rInner, 2 * rInner);

      ctx.restore();
    }

    // 3. Glass specular reflection highlight (top-left 3D dome)
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
    ctx.clip();

    const specGrad = ctx.createLinearGradient(cx, cy - rInner, cx, cy);
    specGrad.addColorStop(0, "rgba(255, 255, 255, 0.45)");
    specGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.08)");
    specGrad.addColorStop(1, "rgba(255, 255, 255, 0)");

    ctx.beginPath();
    ctx.ellipse(cx, cy - rInner * 0.45, rInner * 0.6, rInner * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = specGrad;
    ctx.fill();
    ctx.restore();

    // 4. Outer metallic bezel ring
    const bezelGrad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    bezelGrad.addColorStop(0, "#94a3b8");
    bezelGrad.addColorStop(0.3, "#475569");
    bezelGrad.addColorStop(0.7, "#1e293b");
    bezelGrad.addColorStop(1, "#0f172a");

    ctx.beginPath();
    ctx.arc(cx, cy, radius - 2, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = bezelGrad;
    ctx.stroke();

    // Outer edge rim
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.stroke();

    // Inner rim
    ctx.beginPath();
    ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.stroke();

    // 5. Centered Label & Value readout
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Small category label
    ctx.font = "bold 11px sans-serif";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
    ctx.fillStyle = colorType === "life" ? "#fca5a5" : "#93c5fd";
    ctx.strokeText(label, cx, cy - 9);
    ctx.fillText(label, cx, cy - 9);

    // Number value "100/100"
    const displayCur = current != null ? Math.round(current) : "-";
    const displayMax = max != null ? Math.round(max) : "-";
    const valString = `${displayCur}/${displayMax}`;

    ctx.font = "bold 12px monospace";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(valString, cx, cy + 9);
    ctx.fillText(valString, cx, cy + 9);

    ctx.restore();
  }

  _drawXpBar(progression) {
    const ctx = this.ctx;
    const level = (progression && progression.level) ? Number(progression.level) : 1;
    const experience = (progression && progression.experience != null) ? Number(progression.experience) : 0;

    // XP curve calculations: base 100 per level
    const xpFloor = 100 * (level - 1) * level / 2;
    const xpToNext = 100 * level;
    const into = Math.max(0, experience - xpFloor);
    const pct = xpToNext > 0 ? Math.min(1, Math.max(0, into / xpToNext)) : 1;

    const orbRadius = 48;
    const barStartX = orbRadius * 2 + 36;
    const barEndX = GAME_WIDTH - (orbRadius * 2 + 36);
    const barW = barEndX - barStartX;
    const barH = 10;
    const barY = GAME_HEIGHT - 22;

    ctx.save();

    // 1. Dark background track
    ctx.fillStyle = "rgba(10, 12, 22, 0.85)";
    ctx.fillRect(barStartX, barY, barW, barH);
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(barStartX, barY, barW, barH);

    // 2. XP progress fill
    const fillW = Math.max(0, Math.min(barW - 2, (barW - 2) * pct));
    if (fillW > 0) {
      const grad = ctx.createLinearGradient(barStartX, barY, barStartX, barY + barH);
      grad.addColorStop(0, "#fbbf24");
      grad.addColorStop(0.5, "#f59e0b");
      grad.addColorStop(1, "#b45309");

      ctx.fillStyle = grad;
      ctx.fillRect(barStartX + 1, barY + 1, fillW, barH - 2);

      // Top specular glow line on the fill
      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.fillRect(barStartX + 1, barY + 1, fillW, 2);
    }

    // 3. Central Level Emblem Circle
    const centerX = barStartX + barW / 2;
    const centerY = barY + barH / 2;
    const levelR = 15;

    // Dark backdrop for the circle
    ctx.beginPath();
    ctx.arc(centerX, centerY, levelR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15, 17, 28, 0.95)";
    ctx.fill();

    // Golden / metallic bezel
    const lvlBezel = ctx.createLinearGradient(centerX - levelR, centerY - levelR, centerX + levelR, centerY + levelR);
    lvlBezel.addColorStop(0, "#fbbf24");
    lvlBezel.addColorStop(0.5, "#78350f");
    lvlBezel.addColorStop(1, "#f59e0b");

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = lvlBezel;
    ctx.stroke();

    // Subtle inner ring
    ctx.beginPath();
    ctx.arc(centerX, centerY, levelR - 2.5, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.stroke();

    // Level number inside circle
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 12px sans-serif";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(`${level}`, centerX, centerY);
    ctx.fillText(`${level}`, centerX, centerY);

    // 4. Subtle XP numbers readout above the bar
    ctx.font = "10px monospace";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
    ctx.fillStyle = "#cbd5e1";
    ctx.textBaseline = "bottom";

    const leftLabel = `${into} / ${xpToNext} XP (${Math.round(pct * 100)}%)`;
    ctx.strokeText(leftLabel, (barStartX + centerX) / 2, barY - 3);
    ctx.fillText(leftLabel, (barStartX + centerX) / 2, barY - 3);

    const rightLabel = `Level ${level}`;
    ctx.strokeText(rightLabel, (centerX + barEndX) / 2, barY - 3);
    ctx.fillText(rightLabel, (centerX + barEndX) / 2, barY - 3);

    ctx.restore();
  }

  renderHud({ player, remotePlayers, localUserId, mana = null, maxMana = null, showMana = true, stamina = null, maxStamina = null, weaponName = null, ammo = null, noAmmoFlash = false, effects = null, gold = null, progression = null }) {
    if (!player) return;

    const orbRadius = 48;

    // Bottom-left Life / HP Orb (Path of Exile style)
    const hpX = orbRadius + 16;
    const hpY = GAME_HEIGHT - orbRadius - 16;
    this._drawPoEOrb(hpX, hpY, orbRadius, player.hp, player.maxHp, "HP", "life");

    // Bottom-right Mana / MP Orb (Path of Exile style).
    //
    // SOMET-472: SKIPPED ENTIRELY for a life-cost class, not drawn with a null
    // pool. _drawPoEOrb treats a null `current` as 0 and a null `max` as 100,
    // so passing nulls would paint a permanently EMPTY mana orb -- which reads
    // as "you are out of mana" rather than "you have no mana bar". The Cultist
    // spends HP, and the HP orb to the left is the whole story.
    if (showMana) {
      const mpX = GAME_WIDTH - orbRadius - 16;
      const mpY = GAME_HEIGHT - orbRadius - 16;
      this._drawPoEOrb(mpX, mpY, orbRadius, mana, maxMana, "MP", "mana");
    }

    // Bottom XP bar connecting HP and MP orbs, with central level emblem
    this._drawXpBar(progression);
  }

  // Canvas-drawn inventory window. Delegates to systems/inventoryPanel.js:
  // the layout is pure and unit-tested there, and this method only forwards
  // state, republishes the hit areas the layout produced (so Game can
  // hit-test this same frame) and returns the layout for the drag handlers.
  renderInventory(ctx, inventory, hitAreas, selectedItemId = null, view = null) {
    const v = view || {};
    const state = {
      inventory,
      selectedItemId,
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

  // Canvas-drawn merchant shop overlay (Slice D) — same panel/hit-area
  // convention as renderInventory above: a centred translucent panel drawn
  // in raw canvas pixel space, with every clickable row pushed into
  // `hitAreas` as {x, y, w, h, kind, id} for Game to hit-test against this
  // same frame's layout. Three sections:
  //   - Catalog: the village's base stock (infinite — buying never removes
  //     the row), `kind:'buy'` keyed on the merchant_stock row id (`row.id`,
  //     i.e. the stockId `sendBuy` expects).
  //   - Buyback: items THIS player sold here, still reclaimable at the price
  //     they were paid, same `kind:'buy'` action but visually distinguished
  //     (amber) and finite — buying one deletes the row. The server sends
  //     only the viewer's own rows (SOMET-280) and refuses a buy of anyone
  //     else's, so this list is never another player's stock.
  //   - Your items: the player's own inventory, `kind:'sell'` keyed on the
  //     item instance id (the itemId `sendSell` expects). Names/stats are
  //     resolved the same way renderInventory's owned-item list does; the
  //     server, not this panel, is what actually blocks selling an equipped
  //     item.
  //
  // Catalog and Buyback share ONE tabbed, paginated column (SOMET-156). They
  // used to be stacked vertically in that column, which was unshippable at the
  // live stock size: a village carries 24 catalog rows, only ~10 of which fit,
  // so the Buyback heading was pushed past the panel's bottom edge and NOT ONE
  // buyback row was ever drawn or hit-tested — the buy-back-what-you-sold
  // feature was unreachable. Page size is derived from the measured row band
  // (`perPage` below) rather than a hand-tuned constant, so every row on the
  // active page fits by construction and needs no "stop when we run out of
  // room" break: a break is what silently swallowed rows before.
  //
  // `view` is the caller-owned {tab, page} selection (Game.shopView). It is
  // clamped here, so a stale page left over after stock shrinks (buying the
  // last buyback row on the last page) still renders a real page instead of a
  // blank one. Paging hit areas carry an ABSOLUTE target page, not a delta,
  // so a click can never walk the state outside the clamped range.
  renderShop(ctx, shop, inventory, itemTypes, gold, hitAreas, view = null) {
    const panelW = 760;
    const panelH = 560;
    const px = (GAME_WIDTH - panelW) / 2;
    const py = (GAME_HEIGHT - panelH) / 2;

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(px, py, panelW, panelH);
    ctx.strokeStyle = "#3a3a4e";
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, panelW, panelH);

    ctx.fillStyle = "#e5e7eb";
    ctx.font = "14px monospace";
    ctx.textBaseline = "top";
    ctx.fillText("Shop — [e] to close", px + 16, py + 14);

    // Close button — top-right of the header row, same position/sizing as
    // the inventory panel's own footer buttons.
    const closeW = 70, closeH = 26;
    const closeX = px + panelW - 16 - closeW;
    const closeY = py + 10;

    // Gold readout, right-aligned just left of the close button.
    ctx.font = "12px monospace";
    ctx.textAlign = "right";
    ctx.fillText(`Gold: ${gold ?? 0}`, closeX - 12, closeY + 7);
    ctx.textAlign = "left";

    ctx.fillStyle = "rgba(40,40,60,0.85)";
    ctx.fillRect(closeX, closeY, closeW, closeH);
    ctx.strokeStyle = "#4a9eff";
    ctx.strokeRect(closeX, closeY, closeW, closeH);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText("Close", closeX + 18, closeY + 7);
    hitAreas.push({ x: closeX, y: closeY, w: closeW, h: closeH, kind: "close", id: null });

    const leftX = px + 16;
    const colW = 340;
    const rightX = leftX + colW + 24;
    const rightW = px + panelW - 16 - rightX;
    const listTop = py + 50;
    const listBottom = py + panelH - 16;
    const rowH = 40;
    const rowGap = 6;
    const buyW = 60, buyH = 26;

    const resolveName = (typeId) => {
      const type = itemTypes && itemTypes.get ? itemTypes.get(typeId) : null;
      return type ? type.name : `#${typeId}`;
    };

    // Stock column (left): [Catalog][Buyback] tabs, one paginated row list.
    const catalog = (shop && shop.catalog) || [];
    const buyback = (shop && shop.buyback) || [];

    const tabH = 26, tabW = 150, tabGap = 8;
    const pageH = 24;
    const pageY = listBottom - pageH;      // paging strip, panel-bottom anchored
    const rowsTop = listTop + tabH + 10;
    const rowsBottom = pageY - 8;
    // How many whole rows fit the band between the tabs and the paging strip.
    // n rows span n*rowH + (n-1)*rowGap, hence the +rowGap on both sides.
    const perPage = Math.max(1, Math.floor((rowsBottom - rowsTop + rowGap) / (rowH + rowGap)));

    const isBuyback = !!(view && view.tab === "buyback");
    const rows = isBuyback ? buyback : catalog;
    const pageCount = Math.max(1, Math.ceil(rows.length / perPage));
    const rawPage = view && Number.isFinite(view.page) ? Math.floor(view.page) : 0;
    const page = Math.min(Math.max(rawPage, 0), pageCount - 1);
    const pageRows = rows.slice(page * perPage, page * perPage + perPage);

    // Tabs. Counts live in the labels so a player who just sold something can
    // see there is buyback stock without having to click the tab to find out.
    // The buyback count is the player's OWN reclaimable stock (SOMET-280), so
    // it changes only when they sell, buy back, or a row expires.
    const tabs = [
      { id: "catalog", label: `Catalog (${catalog.length})`, accent: "#4a9eff", on: "rgba(74,158,255,0.28)" },
      { id: "buyback", label: `Buyback (${buyback.length})`, accent: "#caa24a", on: "rgba(202,162,74,0.28)" },
    ];
    ctx.font = "12px monospace";
    tabs.forEach((t, i) => {
      const tx = leftX + i * (tabW + tabGap);
      const active = (t.id === "buyback") === isBuyback;
      ctx.fillStyle = active ? t.on : "rgba(40,40,60,0.85)";
      ctx.fillRect(tx, listTop, tabW, tabH);
      ctx.strokeStyle = active ? t.accent : "#3a3a4e";
      ctx.strokeRect(tx, listTop, tabW, tabH);
      ctx.fillStyle = active ? "#e5e7eb" : "#9ca3af";
      ctx.fillText(t.label, tx + 10, listTop + 7);
      hitAreas.push({ x: tx, y: listTop, w: tabW, h: tabH, kind: "shoptab", id: t.id });
    });

    // Rows of the active tab. Buyback keeps its amber treatment (finite stock:
    // the row is deleted on buy, unlike the catalog's infinite stock).
    let y = rowsTop;
    for (const row of pageRows) {
      ctx.fillStyle = isBuyback ? "rgba(80,60,20,0.55)" : "rgba(40,40,60,0.85)";
      ctx.fillRect(leftX, y, colW, rowH);
      ctx.strokeStyle = isBuyback ? "#caa24a" : "#3a3a4e";
      ctx.strokeRect(leftX, y, colW, rowH);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "12px monospace";
      ctx.fillText(resolveName(row.itemTypeId), leftX + 8, y + 6);
      ctx.fillStyle = isBuyback ? "#caa24a" : "#9ca3af";
      ctx.fillText(`${row.price} g`, leftX + 8, y + 22);

      const buyX = leftX + colW - 8 - buyW;
      const buyY = y + (rowH - buyH) / 2;
      ctx.fillStyle = isBuyback ? "rgba(202,162,74,0.28)" : "rgba(74,158,255,0.28)";
      ctx.fillRect(buyX, buyY, buyW, buyH);
      ctx.strokeStyle = isBuyback ? "#caa24a" : "#4a9eff";
      ctx.strokeRect(buyX, buyY, buyW, buyH);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText("Buy", buyX + 16, buyY + 7);
      hitAreas.push({ x: buyX, y: buyY, w: buyW, h: buyH, kind: "buy", id: row.id });

      y += rowH + rowGap;
    }
    if (rows.length === 0) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "12px monospace";
      ctx.fillText(isBuyback ? "No buyback stock." : "Nothing for sale.", leftX + 8, rowsTop + 6);
    }

    // Paging strip. Prev/Next are drawn only when they lead somewhere, so
    // there is never an inert-looking button, and never a page beyond range.
    if (pageCount > 1) {
      const pgW = 70;
      ctx.font = "12px monospace";
      const pageBtn = (bx, label, target) => {
        ctx.fillStyle = "rgba(74,158,255,0.28)";
        ctx.fillRect(bx, pageY, pgW, pageH);
        ctx.strokeStyle = "#4a9eff";
        ctx.strokeRect(bx, pageY, pgW, pageH);
        ctx.fillStyle = "#e5e7eb";
        ctx.fillText(label, bx + 10, pageY + 6);
        hitAreas.push({ x: bx, y: pageY, w: pgW, h: pageH, kind: "shoppage", id: target });
      };
      if (page > 0) pageBtn(leftX, "< Prev", page - 1);
      if (page < pageCount - 1) pageBtn(leftX + colW - pgW, "Next >", page + 1);
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = "center";
      ctx.fillText(`Page ${page + 1}/${pageCount}`, leftX + colW / 2, pageY + 6);
      ctx.textAlign = "left";
    }

    // Your items (right column) — sell action only.
    ctx.fillStyle = "#9ca3af";
    ctx.font = "13px monospace";
    ctx.fillText("Your items", rightX, listTop);
    let ry = listTop + 20;
    const items = (inventory && inventory.items) || [];
    const sellW = 60, sellH = 26;
    for (const item of items) {
      if (ry + rowH > listBottom) break;
      const type = inventory && inventory.types ? inventory.types.get(item.typeId) : null;
      if (!type) continue;

      ctx.fillStyle = "rgba(40,40,60,0.85)";
      ctx.fillRect(rightX, ry, rightW, rowH);
      ctx.strokeStyle = "#3a3a4e";
      ctx.strokeRect(rightX, ry, rightW, rowH);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "12px monospace";
      ctx.fillText(type.name, rightX + 8, ry + 6);

      // SOMET-317: bound instances refuse to sell (trade.js sellItem, the
      // SOMET-277 anti-faucet rule), and until now the only way to find that
      // out was to click Sell and read the rejection. Same amber `bound`
      // subline, in the same ry + 22 slot, that renderBank already draws — one
      // item must not read as two different states on two screens.
      //
      // THE SELL CONTROL BELOW IS DELIBERATELY LEFT ALONE. This is a label, not
      // a gate: withholding the hit area would move an authorization decision
      // into the client, so a stale or wrong flag would lock a player out of
      // selling an item they legitimately own, with nothing on screen
      // explaining why. Left live, a wrong flag costs a misleading word and the
      // server still answers correctly — the safe direction to fail. Same
      // division of labour as canEquipClient (affordance) vs items.js canEquip
      // (authority).
      if (item.soulbound === true) {
        ctx.fillStyle = "#caa24a";
        ctx.fillText("bound", rightX + 8, ry + 22);
      }

      const sellX = rightX + rightW - 8 - sellW;
      const sellY = ry + (rowH - sellH) / 2;
      ctx.fillStyle = "rgba(255,90,90,0.22)";
      ctx.fillRect(sellX, sellY, sellW, sellH);
      ctx.strokeStyle = "#e05a5a";
      ctx.strokeRect(sellX, sellY, sellW, sellH);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText("Sell", sellX + 14, sellY + 7);
      hitAreas.push({ x: sellX, y: sellY, w: sellW, h: sellH, kind: "sell", id: item.id });

      ry += rowH + rowGap;
    }
    if (items.length === 0) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "12px monospace";
      ctx.fillText("No items to sell.", rightX + 8, listTop + 20);
    }

    ctx.restore();
  }

  // SOMET-310 — the account chest panel. Same overlay/hit-area contract as
  // renderShop above, and deliberately the same visual grammar (centred
  // translucent panel, tab strip, row list, panel-bottom paging strip), because
  // it is the same interaction with a different counterparty and a player
  // should not have to learn a second one.
  //
  // ONE tabbed, paginated column rather than the shop's two:
  //   - Chest: what this ACCOUNT has stored. `kind:'take'` keyed on the
  //     account_items row id (the id `sendWithdraw` expects).
  //   - Carry: this CHARACTER's inventory. `kind:'store'` keyed on the
  //     player_items instance id (the id `sendDeposit` expects).
  // The two ids come from different tables and must never be interchanged;
  // that is why they are two `kind`s rather than one with a direction flag.
  //
  // BOTH LISTS ARE PAGED, unlike the shop's right-hand "Your items" column,
  // which breaks out of its loop when it runs out of vertical room and silently
  // drops the rest. That break is exactly the bug SOMET-156 fixed on the left
  // column, and a chest whose 40th item cannot be reached is a chest that ate
  // it -- so `perPage` is derived from the measured row band here too, and no
  // list in this panel has a "stop when we run out of room" escape.
  //
  // The header carries `n/capacity` because "your chest is full" is a refusal
  // the server can issue at any time, and a player who cannot see how close
  // they are to the cap has no way to anticipate it.
  renderBank(ctx, bank, inventory, itemTypes, hitAreas, view = null) {
    const panelW = 560;
    const panelH = 560;
    const px = (GAME_WIDTH - panelW) / 2;
    const py = (GAME_HEIGHT - panelH) / 2;

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(px, py, panelW, panelH);
    ctx.strokeStyle = "#3a3a4e";
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, panelW, panelH);

    ctx.fillStyle = "#e5e7eb";
    ctx.font = "14px monospace";
    ctx.textBaseline = "top";
    ctx.fillText("Account Chest — [b] or [esc] to close", px + 16, py + 14);

    const closeW = 70, closeH = 26;
    const closeX = px + panelW - 16 - closeW;
    const closeY = py + 10;

    const stored = (bank && bank.items) || [];
    const capacity = Number(bank && bank.capacity) || 0;

    // Occupancy readout, right-aligned just left of the close button (the shop
    // puts its gold total in the same spot). Amber at the cap so a full chest
    // is visible before a deposit is refused rather than only after.
    ctx.font = "12px monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = capacity > 0 && stored.length >= capacity ? "#caa24a" : "#e5e7eb";
    ctx.fillText(`${stored.length}/${capacity}`, closeX - 12, closeY + 7);
    ctx.textAlign = "left";

    ctx.fillStyle = "rgba(40,40,60,0.85)";
    ctx.fillRect(closeX, closeY, closeW, closeH);
    ctx.strokeStyle = "#4a9eff";
    ctx.strokeRect(closeX, closeY, closeW, closeH);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText("Close", closeX + 18, closeY + 7);
    hitAreas.push({ x: closeX, y: closeY, w: closeW, h: closeH, kind: "close", id: null });

    const leftX = px + 16;
    const colW = panelW - 32;
    const listTop = py + 50;
    const listBottom = py + panelH - 16;
    const rowH = 40;
    const rowGap = 6;
    const actW = 70, actH = 26;

    const resolveName = (typeId) => {
      const type = itemTypes && itemTypes.get ? itemTypes.get(typeId) : null;
      return type ? type.name : `#${typeId}`;
    };

    // The carry list mirrors the shop's: real server instances only, resolved
    // through inventory.types. An item whose type is unknown to this client is
    // skipped rather than drawn as "#12" — the same rule renderShop's sell
    // column follows.
    const carried = ((inventory && inventory.items) || [])
      .filter((it) => (inventory && inventory.types ? inventory.types.get(it.typeId) : null));

    const tabH = 26, tabW = 170, tabGap = 8;
    const pageH = 24;
    const pageY = listBottom - pageH;
    const rowsTop = listTop + tabH + 10;
    const rowsBottom = pageY - 8;
    const perPage = Math.max(1, Math.floor((rowsBottom - rowsTop + rowGap) / (rowH + rowGap)));

    const isCarry = !!(view && view.tab === "carry");
    const rows = isCarry ? carried : stored;
    const pageCount = Math.max(1, Math.ceil(rows.length / perPage));
    const rawPage = view && Number.isFinite(view.page) ? Math.floor(view.page) : 0;
    const page = Math.min(Math.max(rawPage, 0), pageCount - 1);
    const pageRows = rows.slice(page * perPage, page * perPage + perPage);

    const tabs = [
      { id: "chest", label: `Chest (${stored.length})`, accent: "#caa24a", on: "rgba(202,162,74,0.28)" },
      { id: "carry", label: `Carrying (${carried.length})`, accent: "#4a9eff", on: "rgba(74,158,255,0.28)" },
    ];
    ctx.font = "12px monospace";
    tabs.forEach((t, i) => {
      const tx = leftX + i * (tabW + tabGap);
      const active = (t.id === "carry") === isCarry;
      ctx.fillStyle = active ? t.on : "rgba(40,40,60,0.85)";
      ctx.fillRect(tx, listTop, tabW, tabH);
      ctx.strokeStyle = active ? t.accent : "#3a3a4e";
      ctx.strokeRect(tx, listTop, tabW, tabH);
      ctx.fillStyle = active ? "#e5e7eb" : "#9ca3af";
      ctx.fillText(t.label, tx + 10, listTop + 7);
      hitAreas.push({ x: tx, y: listTop, w: tabW, h: tabH, kind: "banktab", id: t.id });
    });

    let y = rowsTop;
    for (const row of pageRows) {
      ctx.fillStyle = isCarry ? "rgba(40,40,60,0.85)" : "rgba(80,60,20,0.55)";
      ctx.fillRect(leftX, y, colW, rowH);
      ctx.strokeStyle = isCarry ? "#3a3a4e" : "#caa24a";
      ctx.strokeRect(leftX, y, colW, rowH);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "12px monospace";
      ctx.fillText(resolveName(row.typeId), leftX + 8, y + 6);

      // Subline: quantity when a row is a real stack, and the bound marker.
      // Bound items are storable on purpose (they can never become gold, so
      // moving one between your own characters is not an exploit) — the label
      // is there so a player is not surprised when the same item refuses to
      // sell at the merchant one tile away.
      const qty = Number(row.quantity) || 1;
      const notes = [];
      if (qty > 1) notes.push(`x${qty}`);
      if (row.soulbound === true) notes.push("bound");
      ctx.fillStyle = isCarry ? "#9ca3af" : "#caa24a";
      if (notes.length) ctx.fillText(notes.join("  ·  "), leftX + 8, y + 22);

      const actX = leftX + colW - 8 - actW;
      const actY = y + (rowH - actH) / 2;
      ctx.fillStyle = isCarry ? "rgba(74,158,255,0.28)" : "rgba(202,162,74,0.28)";
      ctx.fillRect(actX, actY, actW, actH);
      ctx.strokeStyle = isCarry ? "#4a9eff" : "#caa24a";
      ctx.strokeRect(actX, actY, actW, actH);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText(isCarry ? "Store" : "Take", actX + 16, actY + 7);
      hitAreas.push({
        x: actX, y: actY, w: actW, h: actH, kind: isCarry ? "store" : "take", id: row.id,
      });

      y += rowH + rowGap;
    }
    if (rows.length === 0) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "12px monospace";
      ctx.fillText(
        isCarry ? "You are not carrying anything." : "Your chest is empty.",
        leftX + 8, rowsTop + 6,
      );
    }

    if (pageCount > 1) {
      const pgW = 70;
      ctx.font = "12px monospace";
      const pageBtn = (bx, label, target) => {
        ctx.fillStyle = "rgba(74,158,255,0.28)";
        ctx.fillRect(bx, pageY, pgW, pageH);
        ctx.strokeStyle = "#4a9eff";
        ctx.strokeRect(bx, pageY, pgW, pageH);
        ctx.fillStyle = "#e5e7eb";
        ctx.fillText(label, bx + 10, pageY + 6);
        hitAreas.push({ x: bx, y: pageY, w: pgW, h: pageH, kind: "bankpage", id: target });
      };
      if (page > 0) pageBtn(leftX, "< Prev", page - 1);
      if (page < pageCount - 1) pageBtn(leftX + colW - pgW, "Next >", page + 1);
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = "center";
      ctx.fillText(`Page ${page + 1}/${pageCount}`, leftX + colW / 2, pageY + 6);
      ctx.textAlign = "left";
    }

    ctx.restore();
  }
}
