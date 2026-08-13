import { GAME_WIDTH, GAME_HEIGHT, ISO_TILE_H, ISO_TILE_W, MAP_TILE_SIZE } from "../core/constants.js";
import { worldToScreen, depthKey } from "../core/iso.js";
import { compareDrawables, wallRevealed, drawWall } from "./wallRenderer.js";
import { drawLandmarks } from "./landmarkRenderer.js";
import { drawPlaceholder } from "./placeholderSprite.js";
import { frameRect, staticFrameKey, animatedFrameKey, facingToDir, tileFrameKey, resolveTileVisual } from "./spriteAtlas.js";
import { TileDiamondCache } from "./tileTexture.js";
import { chunkTileCells } from "../core/chunkTiles.js";
import { SLOTS, typeOf, canEquipClient } from "../core/inventory.js";
import { blastProgress, blastScreenRadiusX, elementColor } from "../core/blasts.js";
import { effectProgress, effectAlpha, isoArcAngle, particlesAt } from "../core/vfx.js";
import { normalizeEffects, effectColor, effectHudLine } from "../core/statusEffects.js";

// Mirrors PICKUP_RADIUS in backend/src/authority/groundItems.js — used here
// only to decide when a ground item's name label is shown (i.e. when the
// player is actually close enough to loot it). Keep the two in sync, or the
// label will appear at a different range than looting actually works.
const PICKUP_RADIUS = 80;

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
        out.push({ kind: "decoration", ref: { ...type, x, y, width: MAP_TILE_SIZE, height: MAP_TILE_SIZE }, order: type.place_order || 0, depth: depthKey(x + MAP_TILE_SIZE / 2, y + MAP_TILE_SIZE / 2) });
      }
    }
    return out;
  }

  renderChunked({
    player, camera, chunkedMap, remotePlayers, localUserId,
    creatures = [], projectiles = [], mana = null, maxMana = null,
    stamina = null, maxStamina = null,
    weaponName = null, inventory = null, inventoryOpen = false, selectedItemId = null,
    groundItems = [], autoLoot = false, gold = null, toast = null,
    blasts = [], ammo = null, noAmmoFlash = false, effects = null, vfx = [],
    merchants = [], shop = null, shopOpen = false, shopView = null, decoTypes = null,
    // SOMET-297. Fixed world points from the join frame, exactly like
    // `merchants` above -- not entities, so they carry no stored top-left
    // corner and need no half-extent adjustment.
    landmarks = [],
    // Slice D: the effect LIBRARY, needed by the projectile trail. Effects in
    // `vfx` already carry their own resolved `def`; a projectile is a
    // persistent object that only carries a NAME, so the lookup happens here.
    // Passed per frame rather than stashed at construction because the library
    // arrives asynchronously, after the renderer exists.
    vfxDefs = null,
  }) {
    if (vfxDefs) this.vfxDefs = vfxDefs;
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
      else if (d.kind === "merchant") this.drawMerchant(d.ref);
      else if (d.kind === "decoration") this.drawEntity(d.ref);
      else this.drawEntity(d.ref);
    }

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
      this.ctx.arc(s.x, s.y - ISO_TILE_H / 2, 6, 0, Math.PI * 2);
      this.ctx.fillStyle = elementColor(pr.element);
      this.ctx.fill();
    }

    this.drawBlasts(blasts);
    this.drawVfx(vfx);

    camera.reset(this.ctx);
    this.renderHud({ player, remotePlayers, localUserId, mana, maxMana, stamina, maxStamina, weaponName, ammo, noAmmoFlash, effects, gold });
    if (toast) this.renderToast(toast);

    // Inventory panel overlay (drawn last, on top of the HUD, in raw canvas
    // pixel space — same space Game hit-tests clicks against).
    this._invHitAreas = [];
    if (inventoryOpen && inventory) {
      this.renderInventory(this.ctx, inventory, this._invHitAreas, selectedItemId, autoLoot);
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
      // the tile diamond's CENTRE, and the ISO_TILE_H/2 lift puts the ring at
      // the chest height projectiles fly at rather than flat on the ground.
      // Do not add any further offset: doing so is what put markers a tile
      // away from their subject in an earlier slice.
      const s = worldToScreen(b.x, b.y);
      const cy = s.y - ISO_TILE_H / 2;
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
      // diamond's CENTRE, and the ISO_TILE_H/2 lift puts the swing at chest
      // height rather than flat on the ground. Do not add a further offset.
      const s = worldToScreen(fx.x, fx.y);
      const cy = s.y - ISO_TILE_H / 2;
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
    const cy = s.y - ISO_TILE_H / 2;
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
    this.ctx.moveTo(back.x, back.y - ISO_TILE_H / 2);
    this.ctx.lineTo(s.x, cy);
    this.ctx.stroke();
    this.ctx.restore();
    return true;
  }

  // Element tints for an impact burst (slice C). The impact EFFECT rows are
  // already element-specific, so this is a second, cheaper lever: a generic
  // effect fired by an elemental weapon still reads as that element rather
  // than as a white spark. `el` rides the impact descriptor from the server.
  static get ELEMENT_TINT() {
    return {
      fire: "#ff9a4d", ice: "#8fdcff", lightning: "#ffe66b", arcane: "#c08cff",
      physical: null,   // explicitly no tint -- the effect's own colour wins
    };
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

    const tint = RenderSystem.ELEMENT_TINT[fx.el] || null;
    const size = Math.max(0, Number(def.particle_size) || 2);
    if (size === 0) return;

    this.ctx.fillStyle = tint || def.color || "#ffffff";
    for (const pt of parts) {
      // Each particle is a world-space offset from the impact point, so it
      // goes through the SAME projection as everything else rather than being
      // nudged in screen space.
      const s = worldToScreen(fx.x + pt.dx, fx.y + pt.dy);
      this.ctx.globalAlpha = pt.alpha;
      this.ctx.fillRect(s.x - size / 2, s.y - ISO_TILE_H / 2 - size / 2, size, size);
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
    const cy = s.y - ISO_TILE_H / 2;         // chest height, as the arc uses
    const reach = Number(fx.reach) || 0;

    this.ctx.globalAlpha = effectAlpha(fx, now);
    this.ctx.strokeStyle = fx.def.color || "#dddddd";
    this.ctx.lineWidth = Number(fx.def.width) || 2;

    // A point `d` world-units along the aim vector, projected. Going through
    // worldToScreen rather than offsetting in screen space keeps a thrust
    // pointing where the player actually aimed on the iso ground plane.
    const along = (d) => {
      const p = worldToScreen(fx.x + fx.nx * d, fx.y + fx.ny * d);
      return { x: p.x, y: p.y - ISO_TILE_H / 2 };
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
      const ox = o.x, oy = o.y - ISO_TILE_H / 2;
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
      const dx = ox - s.x, dy = oy - (s.y - ISO_TILE_H / 2);
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
    // Unlike here, the projectile draw below intentionally lifts by
    // ISO_TILE_H/2, because projectiles fly at chest height rather than
    // resting on the ground.
    const s = worldToScreen(item.x, item.y);
    const dx = s.x, dy = s.y;
    const type = inventory && inventory.types ? inventory.types.get(item.typeId) : null;
    const color = type && type.category === "armor" ? "#7ec8e3" : "#e3c27e";
    const r = 9;
    this.ctx.save();
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

  // A village's merchant: a fixed marker (no facing/animation) at the
  // village's merchantX/Y from the join frame. Distinct color + always-on
  // label distinguish it from a transient ground-item drop at a glance.
  drawMerchant(m) {
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
    this.ctx.restore();
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
  // The trap this avoids: worldToScreen returns the tile diamond's CENTRE, and
  // an actor's feet sit ISO_TILE_H/2 BELOW that (drawY = s.y - h + ISO_TILE_H/2
  // => drawY + h = s.y + ISO_TILE_H/2). Drawing the aura at s.y instead — the
  // convention drawGroundItem uses, since a dropped item really does rest at
  // the diamond centre — puts the ring around the actor's waist rather than
  // under their feet. It was written that way first and the browser pass caught
  // it; do not "simplify" it back.
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
    // Anchor: project the feet (bottom-center of the world box).
    const s = worldToScreen(obj.x + w / 2, obj.y + h / 2);
    const drawX = s.x - w / 2;
    const drawY = s.y - h + ISO_TILE_H / 2; // lift so feet rest on the diamond
    // Effect rings go down FIRST, so the actor stands on top of its own aura
    // rather than being obscured by it. `drawY + h` is the feet line this same
    // method already computed — see _drawEffectRings on why not s.y.
    this._drawEffectRings(s.x, drawY + h, w, obj.effects);
    const img = this.imageManager.get(imageKey);
    this.ctx.globalAlpha = alpha;
    if (img) {
      this.ctx.drawImage(img, drawX, drawY, w, h);
    } else {
      const cx = s.x;
      const cy = s.y - h / 2 + ISO_TILE_H / 2;
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
    const drawY = s.y - h + ISO_TILE_H / 2;

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

  renderHud({ player, remotePlayers, localUserId, mana = null, maxMana = null, stamina = null, maxStamina = null, weaponName = null, ammo = null, noAmmoFlash = false, effects = null, gold = null }) {
    const remoteCount = remotePlayers ? remotePlayers.size : 0;
    const lines = [
      `Players online: ${1 + remoteCount}`,
      `You: #${localUserId ?? "?"}  pos=(${Math.round(player.x)}, ${Math.round(player.y)})`,
      // Rounded like MP/SP below. HP used to be integral in practice, so the raw
      // value read fine; resistances, shock's +25% vulnerability and AoE falloff
      // now all produce fractions, and the HUD was printing
      // `HP: 23.199992642145737 / 100`. Round for display only — the authority's
      // value stays exact.
      `HP: ${player.hp != null ? Math.round(player.hp) : "-"} / ${player.maxHp != null ? Math.round(player.maxHp) : "-"}`,
    ];
    if (mana != null && maxMana != null) {
      lines.push(`MP: ${Math.round(mana)} / ${Math.round(maxMana)}`);
    }
    if (stamina != null && maxStamina != null) {
      lines.push(`SP: ${Math.round(stamina)} / ${Math.round(maxStamina)}`);
    }
    if (gold != null) lines.push(`Gold: ${gold}`);
    if (weaponName) {
      lines.push(`Weapon: ${weaponName}`);
    }
    // The player's OWN active effects, right under the resource bars they
    // affect (chill slows, shock drains MP, burn drains HP). Drawn in its
    // effect colour rather than the HUD grey, matching the ring at their feet.
    // effectHudLine returns null when nothing is active, so no blank row is
    // pushed and the panel does not jump a row taller on every hit.
    const effectsLine = effectHudLine(effects);
    let effectsLineIdx = -1;
    if (effectsLine) {
      effectsLineIdx = lines.length;
      lines.push(effectsLine);
    }
    // Ammo line only when the equipped weapon actually consumes ammo — `ammo`
    // is null for every ammo-free weapon (the server's ammo_type_id == null),
    // and nothing at all should be drawn for those.
    let ammoLine = -1;
    if (ammo) {
      ammoLine = lines.length;
      lines.push(`${ammo.name}: ${ammo.count}${noAmmoFlash ? "  OUT OF AMMO" : ""}`);
    }
    lines.push(`[i] Inventory`);
    this.ctx.save();
    this.ctx.fillStyle = "rgba(0,0,0,0.55)";
    this.ctx.fillRect(10, 10, 260, 18 * lines.length + 12);
    this.ctx.font = "13px monospace";
    this.ctx.textBaseline = "top";
    lines.forEach((t, i) => {
      // The ammo line turns red while the flash is up, or whenever the stack
      // is empty, so the player sees why a shot did nothing.
      const alarm = i === ammoLine && (noAmmoFlash || ammo.count <= 0);
      const fx = i === effectsLineIdx ? effectColor(normalizeEffects(effects)[0]) : null;
      this.ctx.fillStyle = alarm ? "#ef4444" : (fx || "#e5e7eb");
      this.ctx.fillText(t, 18, 16 + i * 18);
    });
    this.ctx.restore();
  }

  // Canvas-drawn inventory / paper-doll overlay — styled consistently with
  // the HUD box above (same dark translucent panel, monospace HUD font).
  // Draws:
  //   - a paper-doll column: one labelled box per SLOTS entry showing the
  //     equipped item's type name, greyed out when `selectedItemId` cannot
  //     legally go there (per canEquipClient);
  //   - an item list: each owned item's type name + a stat line (weapon:
  //     damage/cooldown; armor: defense/resistances), highlighted when
  //     selected.
  // Every drawn slot/item box is pushed into `hitAreas` as
  // {x, y, w, h, kind: 'slot' | 'item', id} so Game can hit-test clicks
  // against this same frame's layout.
  renderInventory(ctx, inventory, hitAreas, selectedItemId = null, autoLoot = false) {
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
    ctx.fillText("Inventory — [i] to close", px + 16, py + 14);

    // Auto-loot toggle — top-right of the header row. Renders the server-
    // owned flag mirrored locally; clicking it only requests the flip.
    const alW = 150, alH = 26;
    const alX = px + panelW - 16 - alW;
    const alY = py + 10;
    ctx.fillStyle = autoLoot ? "rgba(74,158,255,0.28)" : "rgba(40,40,60,0.85)";
    ctx.fillRect(alX, alY, alW, alH);
    ctx.strokeStyle = "#4a9eff";
    ctx.strokeRect(alX, alY, alW, alH);
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "12px monospace";
    ctx.fillText(`Auto-loot: ${autoLoot ? "ON" : "OFF"}`, alX + 8, alY + 7);
    hitAreas.push({ x: alX, y: alY, w: alW, h: alH, kind: "autoloot", id: null });

    // Paper-doll column (left).
    const dollX = px + 16;
    const dollTop = py + 44;
    const slotW = 320;
    const slotH = 34;
    const slotGap = 6;
    ctx.font = "12px monospace";
    SLOTS.forEach((slot, i) => {
      const y = dollTop + i * (slotH + slotGap);
      const equippedId = inventory.equipment[slot];
      const equippedType = equippedId != null ? typeOf(inventory, equippedId) : null;
      const disabled = selectedItemId != null && !canEquipClient(inventory, selectedItemId, slot);

      ctx.fillStyle = disabled ? "rgba(60,60,70,0.5)" : "rgba(40,40,60,0.85)";
      ctx.fillRect(dollX, y, slotW, slotH);
      ctx.strokeStyle = disabled ? "#3a3a3a" : "#4a9eff";
      ctx.strokeRect(dollX, y, slotW, slotH);
      ctx.fillStyle = disabled ? "#6b7280" : "#e5e7eb";
      ctx.fillText(`${slot}: ${equippedType ? equippedType.name : "-"}`, dollX + 8, y + 11);

      hitAreas.push({ x: dollX, y, w: slotW, h: slotH, kind: "slot", id: slot });
    });

    // Drop button — only shown while an item is selected, directly below the
    // paper-doll column.
    if (selectedItemId) {
      const dropW = slotW, dropH = 40;
      const dropX = dollX;
      const dropY = dollTop + SLOTS.length * (slotH + slotGap) + 12;
      ctx.fillStyle = "rgba(74,158,255,0.28)";
      ctx.fillRect(dropX, dropY, dropW, dropH);
      ctx.strokeStyle = "#4a9eff";
      ctx.strokeRect(dropX, dropY, dropW, dropH);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "13px monospace";
      ctx.fillText("Drop selected item", dropX + 8, dropY + 13);
      hitAreas.push({ x: dropX, y: dropY, w: dropW, h: dropH, kind: "drop", id: selectedItemId });
    }

    // Owned-item list (right).
    const listX = dollX + slotW + 24;
    const listTop = py + 44;
    const listW = px + panelW - 16 - listX;
    const itemH = 40;
    const itemGap = 6;
    const listBottom = py + panelH - 16;
    ctx.font = "12px monospace";
    let y = listTop;
    for (const item of inventory.items) {
      if (y + itemH > listBottom) break; // no scrolling yet; loadouts fit today
      const type = inventory.types.get(item.typeId);
      if (!type) continue;
      const selected = item.id === selectedItemId;

      ctx.fillStyle = selected ? "rgba(74,158,255,0.28)" : "rgba(40,40,60,0.85)";
      ctx.fillRect(listX, y, listW, itemH);
      ctx.strokeStyle = selected ? "#4a9eff" : "#3a3a4e";
      ctx.strokeRect(listX, y, listW, itemH);

      ctx.fillStyle = "#e5e7eb";
      ctx.fillText(type.name, listX + 8, y + 6);

      const statLine = type.category === "weapon"
        ? `dmg ${type.damage}  cd ${type.cooldown}s${type.two_handed ? "  (2H)" : ""}`
        : `def ${type.defense}${
            Object.keys(type.resistances || {}).length
              ? "  " + Object.entries(type.resistances).map(([el, v]) => `${el} ${v}`).join(", ")
              : ""
          }`;
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(statLine, listX + 8, y + 22);

      hitAreas.push({ x: listX, y, w: listW, h: itemH, kind: "item", id: item.id });
      y += itemH + itemGap;
    }
    if (inventory.items.length === 0) {
      ctx.fillStyle = "#6b7280";
      ctx.fillText("No items owned.", listX + 8, listTop + 6);
    }

    ctx.restore();
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
    // the auto-loot toggle in renderInventory.
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
}
