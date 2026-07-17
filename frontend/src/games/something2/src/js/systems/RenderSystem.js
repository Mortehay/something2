import { GAME_WIDTH, GAME_HEIGHT, ISO_TILE_H, ISO_TILE_W } from "../core/constants.js";
import { worldToScreen, depthKey } from "../core/iso.js";
import { drawPlaceholder } from "./placeholderSprite.js";
import { frameRect, staticFrameKey, animatedFrameKey, facingToDir } from "./spriteAtlas.js";
import { chunkTileCells } from "../core/chunkTiles.js";

export class RenderSystem {
  constructor(canvas, imageManager) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.imageManager = imageManager;
    // Global render-mode override (dev toggle). null = use each entity's own
    // renderMode; a mode string forces every entity to that mode.
    this.renderModeOverride = null;
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

    this.renderHud(player, remotePlayers, localUserId);
  }

  renderChunked(player, camera, chunkedMap, remotePlayers, localUserId, creatures = []) {
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

    // Players + creatures on top, depth-sorted together.
    const drawables = RenderSystem.buildDrawables(player, { entities: creatures }, remotePlayers);
    for (const d of drawables) {
      if (d.kind === "player") this.drawCreature(d.ref, "player", 1);
      else if (d.kind === "remote") this.drawCreature(d.ref, "player", 0.85, d.userId);
      else this.drawEntity(d.ref);
    }

    camera.reset(this.ctx);
    this.renderHud(player, remotePlayers, localUserId);
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
  }

  renderHud(player, remotePlayers, localUserId) {
    const remoteCount = remotePlayers ? remotePlayers.size : 0;
    const lines = [
      `Players online: ${1 + remoteCount}`,
      `You: #${localUserId ?? "?"}  pos=(${Math.round(player.x)}, ${Math.round(player.y)})`,
      `HP: ${player.hp ?? "-"} / ${player.maxHp ?? "-"}`,
    ];
    this.ctx.save();
    this.ctx.fillStyle = "rgba(0,0,0,0.55)";
    this.ctx.fillRect(10, 10, 260, 18 * lines.length + 12);
    this.ctx.fillStyle = "#e5e7eb";
    this.ctx.font = "13px monospace";
    this.ctx.textBaseline = "top";
    lines.forEach((t, i) => this.ctx.fillText(t, 18, 16 + i * 18));
    this.ctx.restore();
  }
}
