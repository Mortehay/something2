import { GAME_WIDTH, GAME_HEIGHT, ISO_TILE_H, ISO_TILE_W } from "../core/constants.js";
import { worldToScreen, depthKey } from "../core/iso.js";
import { drawPlaceholder } from "./placeholderSprite.js";
import { frameRect, staticFrameKey, animatedFrameKey, facingToDir } from "./spriteAtlas.js";
import { chunkTileCells } from "../core/chunkTiles.js";
import { SLOTS, typeOf, canEquipClient } from "../core/inventory.js";
import { blastProgress, blastScreenRadiusX, elementColor } from "../core/blasts.js";
import { normalizeEffects, effectColor, effectHudLine } from "../core/statusEffects.js";

// Mirrors PICKUP_RADIUS in backend/src/authority/groundItems.js — used here
// only to decide when a ground item's name label is shown (i.e. when the
// player is actually close enough to loot it). Keep the two in sync, or the
// label will appear at a different range than looting actually works.
const PICKUP_RADIUS = 80;

export class RenderSystem {
  constructor(canvas, imageManager) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.imageManager = imageManager;
    // Global render-mode override (dev toggle). null = use each entity's own
    // renderMode; a mode string forces every entity to that mode.
    this.renderModeOverride = null;
    // Hit-test rects for the inventory panel, recorded while drawing it and
    // read back by Game on click. Empty whenever the panel isn't open.
    this._invHitAreas = [];
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

  render(player, camera, map, remotePlayers, localUserId) {
    // Timestamp for this frame; animated sprites advance off it.
    this.nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    // Background
    this.ctx.fillStyle = "#0f3460";
    this.ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    camera.apply(this.ctx);

    // Tiles (drawn first; they underlay all sprites).
    map.render(this.ctx, camera);

    // Depth-sorted sprites (entities + local + remote players interleaved).
    const drawables = RenderSystem.buildDrawables(player, map, remotePlayers);
    for (const d of drawables) {
      if (d.kind === "player") this.drawCreature(d.ref, "player", 1);
      else if (d.kind === "remote") this.drawCreature(d.ref, "player", 0.85, d.userId);
      else this.drawEntity(d.ref);
    }

    camera.reset(this.ctx);

    this.renderHud({ player, remotePlayers, localUserId });
  }

  renderChunked({
    player, camera, chunkedMap, remotePlayers, localUserId,
    creatures = [], projectiles = [], mana = null, maxMana = null,
    stamina = null, maxStamina = null,
    weaponName = null, inventory = null, inventoryOpen = false, selectedItemId = null,
    groundItems = [], autoLoot = false, toast = null,
    blasts = [], ammo = null, noAmmoFlash = false, effects = null,
  }) {
    this.ctx.fillStyle = "#0f3460";
    this.ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    camera.apply(this.ctx);

    const halfW = ISO_TILE_W / 2;
    const halfH = ISO_TILE_H / 2;
    const mapTiles = chunkedMap.mapTiles;
    for (const cell of chunkTileCells(chunkedMap, camera)) {
      const s = worldToScreen(cell.worldX, cell.worldY);
      const relX = s.x - camera.screenX;
      const relY = s.y - camera.screenY;
      if (relX < -camera.width || relX > camera.width || relY < -camera.height || relY > camera.height) continue;
      const def = mapTiles ? (mapTiles[cell.tile] || (Array.isArray(mapTiles) ? mapTiles.find(t => t.name === cell.tile || t.type === cell.tile) : null)) : null;
      this.ctx.fillStyle = def ? def.color : "#123";
      this.ctx.beginPath();
      this.ctx.moveTo(s.x, s.y - halfH);
      this.ctx.lineTo(s.x + halfW, s.y);
      this.ctx.lineTo(s.x, s.y + halfH);
      this.ctx.lineTo(s.x - halfW, s.y);
      this.ctx.closePath();
      this.ctx.fill();
    }

    // Players + creatures + ground items, all depth-sorted together — ground
    // items must join the same sort rather than being drawn in a later pass,
    // or they would render on top of entities they are actually behind.
    const drawables = RenderSystem.buildDrawables(player, { entities: creatures }, remotePlayers);
    for (const gi of groundItems) {
      // Every other drawable's depth key is computed from its raw stored
      // x/y, which are TOP-LEFT corners (drawCreature/drawEntity add w/2,h/2
      // to reach the centre themselves). Ground items instead store their
      // x/y as the drop's CENTRE (see GroundItemManager), so to sort on the
      // same origin as everything else we have to subtract the half-extent
      // back out here. Do not "simplify" this to depthKey(gi.x, gi.y) —
      // that reintroduces up to a tile's worth of depth error against
      // players/creatures.
      drawables.push({ kind: "grounditem", ref: gi, depth: depthKey(gi.x - gi.width / 2, gi.y - gi.height / 2) });
    }
    drawables.sort((a, b) => a.depth - b.depth);
    for (const d of drawables) {
      if (d.kind === "player") this.drawCreature(d.ref, "player", 1);
      else if (d.kind === "remote") this.drawCreature(d.ref, "player", 0.85, d.userId);
      else if (d.kind === "grounditem") this.drawGroundItem(d.ref, inventory, player);
      else this.drawEntity(d.ref);
    }

    // Projectiles render on top — small, fast, no depth-sort needed.
    for (const pr of projectiles) {
      const s = worldToScreen(pr.x, pr.y);
      this.ctx.beginPath();
      this.ctx.arc(s.x, s.y - ISO_TILE_H / 2, 6, 0, Math.PI * 2);
      this.ctx.fillStyle = elementColor(pr.element);
      this.ctx.fill();
    }

    this.drawBlasts(blasts);

    camera.reset(this.ctx);
    this.renderHud({ player, remotePlayers, localUserId, mana, maxMana, stamina, maxStamina, weaponName, ammo, noAmmoFlash, effects });
    if (toast) this.renderToast(toast);

    // Inventory panel overlay (drawn last, on top of the HUD, in raw canvas
    // pixel space — same space Game hit-tests clicks against).
    this._invHitAreas = [];
    if (inventoryOpen && inventory) {
      this.renderInventory(this.ctx, inventory, this._invHitAreas, selectedItemId, autoLoot);
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
    // Sits above the HP bar's row (drawY - 8, height 4), so the two never
    // overlap on an actor that is both damaged and affected.
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
    // Animated -> cycle the facing's frames, degrading to the static frame if
    // that direction has none; static -> a single representative frame.
    const key = mode === "animated"
      ? (animatedFrameKey(manifest, facingToDir(entity.facing), timeMs) || staticFrameKey(entity.sprite, manifest))
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
    this._drawEffectPips(drawX, drawY, e.effects);
  }

  renderHud({ player, remotePlayers, localUserId, mana = null, maxMana = null, stamina = null, maxStamina = null, weaponName = null, ammo = null, noAmmoFlash = false, effects = null }) {
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
}
