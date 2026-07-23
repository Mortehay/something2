import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";
import { RenderSystem } from "../systems/RenderSystem.js";
import { Player } from "../entities/Player.js";
import { ImageManager } from "../managers/ImageManager.js";
import { Camera } from "./Camera.js";
import { Map as GameMap } from "./Map.js";
import { ChunkedMap } from "./ChunkedMap.js";
import { ChunkStreamer } from "../net/ChunkStreamer.js";
import { makeChunkFetcher } from "../net/chunkFetcher.js";
import { CreatureManager } from "../entities/CreatureManager.js";
import { ProjectileManager } from "../entities/ProjectileManager.js";
import { GroundItemManager } from "../entities/GroundItemManager.js";
import { WorldAuthorityClient } from "../net/WorldAuthorityClient.js";
import { getStoredToken, parseJwt } from "../net/EngineClient.js";
import { reconcile } from "../net/reconcile.js";
import { inputVector } from "../entities/Player.js";
import { PLAYER_SPEED_EFFECTIVE } from "./constants.js";
import { aimVector } from "./aim.js";
import { createInventory, applyJoined, applyEquipment, canEquipClient, typeOf, addItem, removeItem } from "./inventory.js";
import { resolveAmmoHud, applyAmmoCount } from "./ammo.js";
import { addBlasts, pruneBlasts } from "./blasts.js";

// How long the "out of ammo" HUD flash stays up after the server's `noammo`
// frame arrives.
const NO_AMMO_FLASH_MS = 600;

// Fallback weapon name shown when nothing is equipped in main_hand yet
// (mirrors the server's DEFAULT_WEAPON_NAME in authority/items.js).
const DEFAULT_WEAPON_NAME = "dagger";

// Native Map shadowed by the world Map import above; alias to keep the
// distinction obvious at the call sites.
const NativeMap = globalThis.Map;

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

// Reconciliation tunables (pixel space). The local player runs prediction; on
// each engine tick we compare the server-authoritative position to ours.
//   diff <= SOFT  → ignore (trust local prediction)
//   diff <= HARD  → lerp toward server over a few frames
//   diff >  HARD  → snap (cheating / desync / teleport)
const RECONCILE_SOFT_PX = 20;
const RECONCILE_HARD_PX = 200;
const RECONCILE_LERP = 0.25;

export class Game {
    constructor() {
        console.log("Game constructor");
        this.canvas = null;
        this.ctx = null;
        this.imageManager = new ImageManager();

        this.player = new Player();
        this.camera = new Camera();
        this.map = new GameMap();

        this.chunked = false;
        this.chunkedMap = null;
        this.streamer = null;

        this.keys = {};
        this.lastTime = 0;
        this.state = 'menu';
        this.onStateChange = null;

        // Networking — set via setEngineClient before init().
        this.engine = null;
        this.localUserId = null;
        this.remotePlayers = new NativeMap(); // user_id -> {x, y, hp}
        this.lastServerTick = 0;

        // Combat (Slice 3b): local mana state from `state`, and the
        // projectile render store.
        this.localMana = null;
        this.localMaxMana = null;
        this.localStamina = null;
        this.localMaxStamina = null;
        this.projectiles = null;

        // AoE (Slice 3b-3b): active blast rings, and the "out of ammo" flash.
        // Detonations ride a single `state` frame and are never repeated, so
        // they are copied into this list on arrival and animated locally.
        this.blasts = [];
        this.noAmmoUntil = 0;

        // Inventory / paper-doll (Slice 3b-2a). `inventory` mirrors the
        // account-wide item catalog + owned items + equipment; the server is
        // authoritative for equip legality (see core/inventory.js).
        this.inventory = createInventory();
        this.inventoryOpen = false;
        this.inventorySelectedItemId = null;

        // Ground items (Slice 3b-2b): render-only store of items on the
        // ground, plus a local mirror of the server-owned auto-loot flag
        // (used only to render the toggle's current state).
        this.groundItems = new GroundItemManager();
        this.autoLoot = false;

        // Wallet balance (Slice C, gold economy): server-owned, set from
        // `joined.gold` and kept live by `wallet` messages on pickup. Gold
        // never enters the inventory (see onPicked/onWallet below).
        this.gold = 0;

        // Transient on-screen toast (Slice 3b fast-follow F3): the server's
        // rejection frames (equip/drop/etc "error" replies) previously only
        // hit console.error, so a rejected action produced no in-game
        // feedback at all. {message, expiresAt} in performance.now() units;
        // null when nothing is showing. See _showToast / onError below.
        this.toast = null;
    }

    // Show `message` for `durationMs`, then let it clear on its own — no
    // queueing; a newer toast simply replaces whatever was showing.
    _showToast(message, durationMs = 3000) {
        this.toast = { message, expiresAt: performance.now() + durationMs };
    }

    setEngineClient(engine, localUserId) {
        this.engine = engine;
        this.localUserId = localUserId;
        if (engine) {
            engine.onState = (msg) => this._onServerState(msg);
            engine.onCollision = (msg) => console.log("collision:", msg);
        }
    }

    setOnStateChange(callback) {
        this.onStateChange = callback;
    }

    setOnTransition(cb) {
        this.onTransition = cb;
    }

    setState(newState) {
        if (this.state !== newState) {
            this.state = newState;
            if (this.onStateChange) {
                this.onStateChange(newState);
            }
        }
    }

    // Load each sprited entity type's atlas image + manifest and attach the
    // manifest to the type's sprite descriptor. Because entity instances share
    // that descriptor object (Object.assign copies the ref), attaching here
    // also lights up already-created entities. Any failure leaves the manifest
    // unset, so rendering degrades to a rectangle.
    //
    // Assets go through the backend proxy (/api/assets/<key>), the same route
    // _preloadTileAssets uses — MinIO's own port is not reachable from the
    // browser in every deployment.
    async preloadSprites(entityTypes) {
        if (!entityTypes) return;
        const byAtlas = {};
        for (const name in entityTypes) {
            const def = entityTypes[name];
            if (!def) continue;
            // Entities approved through the object pipeline carry a plain
            // `image` and no atlas; RenderSystem's single-image fallback needs
            // it loaded under that same key to find it.
            if (def.image) {
                this.imageManager.load(def.image, `${API_URL}/api/assets/${def.image}`);
            }
            if (def.sprite && def.sprite.atlas_key) byAtlas[def.sprite.atlas_key] = def.sprite;
        }
        const manifests = {};
        await Promise.all(Object.values(byAtlas).map(async (spr) => {
            await this.imageManager.load(spr.atlas_key, `${API_URL}/api/assets/${spr.atlas_key}`);
            try {
                const res = await fetch(`${API_URL}/api/assets/${spr.manifest_key}`);
                if (res.ok) manifests[spr.atlas_key] = await res.json();
            } catch { /* leave unset -> rect fallback */ }
        }));
        for (const name in entityTypes) {
            const spr = entityTypes[name] && entityTypes[name].sprite;
            if (spr && spr.atlas_key && manifests[spr.atlas_key]) spr.manifest = manifests[spr.atlas_key];
        }
        // Also attach to any entities whose sprite is a distinct object. The
        // chunked world has no legacy Map entities, hence the guard.
        for (const ent of (this.map && this.map.entities) || []) {
            if (ent.sprite && ent.sprite.atlas_key && manifests[ent.sprite.atlas_key]) {
                ent.sprite.manifest = manifests[ent.sprite.atlas_key];
            }
        }
    }

    async init(tiles = null, mapTiles = null, loadedEntities = null, entityTypes = null){
        if (!this.canvas) {
            console.error("Canvas not found!");
            return;
        }
        this.ctx = this.canvas.getContext('2d');
        this.state = 'playing';

        this.renderSystem = new RenderSystem(this.canvas, this.imageManager);

        const initPromises = [this.imageManager.loadAll()];
        
        if (tiles) {
            this.map.init(tiles, mapTiles, loadedEntities, entityTypes);
            // Load generated sprite atlases + manifests for any sprited types.
            initPromises.push(this.preloadSprites(entityTypes));

            // Find a safe spawn point for the player
            const spawnPoint = this.map.findSafeSpawn();
            if (spawnPoint) {
                this.player.x = spawnPoint.x - this.player.width / 2;
                this.player.y = spawnPoint.y - this.player.height / 2;
                this.camera.update(this.player);
            }
        }

        await Promise.all(initPromises);

        this.resizeCanvas();
        this._resizeHandler = () => this.resizeCanvas();
        window.addEventListener('resize', this._resizeHandler);
        this.setupInput();

        //start game loop
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this.lastTime = performance.now();
        this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
        console.log(`game loop started`)        
    }

    setMap(tiles, mapTiles, loadedEntities, entityTypes = null) {
        this.map.init(tiles, mapTiles, loadedEntities, entityTypes);
    }

    async initChunked({ worldId, chunkSize, tileTypes, entityTypes = null, spawnX = 0, spawnY = 0 }) {
        if (!this.canvas) {
            console.error("Canvas not found!");
            return;
        }
        // Re-entry guard: if initChunked runs twice on the same Game instance
        // (double-click, retry after join timeout, StrictMode double-invoke),
        // tear down the previous run's leakable resources before starting a
        // new one. destroy() is not guaranteed to be called in between.
        if (this.authorityClient) {
            this.authorityClient.disconnect();
            this.authorityClient = null;
        }
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this.ctx = this.canvas.getContext("2d");
        this.state = "playing";
        this.chunked = true;
        this.renderSystem = new RenderSystem(this.canvas, this.imageManager);
        this.chunkedMap = new ChunkedMap(chunkSize, tileTypes);
        this._preloadTileAssets(tileTypes);
        // Approved entity images/atlases, so authority-driven creatures render
        // with their generated sprite rather than a colored box. Fire-and-forget
        // like the tile preload: until it resolves, rendering degrades to color.
        this.preloadSprites(entityTypes);
        this.streamer = new ChunkStreamer(this.chunkedMap, makeChunkFetcher(worldId, API_URL), 1);

        this.creatures = new CreatureManager(entityTypes);
        this.projectiles = new ProjectileManager();

        // Fresh inventory state per join (re-entry guard above tears down the
        // previous authority connection, so mirror that for the paper-doll).
        this.inventory = createInventory();
        this.inventoryOpen = false;
        this.inventorySelectedItemId = null;
        this.groundItems = new GroundItemManager();
        this.autoLoot = false;
        this.gold = 0;
        this.blasts = [];
        this.noAmmoUntil = 0;

        this._inputBuffer = [];
        // Connect to the authoritative sim; spawn comes from the server. The
        // token comes from the login the player already completed (stored in
        // localStorage + memory); user_id is read off the token's own claims.
        const token = getStoredToken();
        if (!token) throw new Error('not signed in');
        const claims = parseJwt(token);
        if (!claims || claims.user_id == null) throw new Error('invalid session token');
        this.localUserId = String(claims.user_id);
        const wsUrl = API_URL.replace(/^http/, 'ws') + '/authority';
        const spawn = await new Promise((resolve, reject) => {
            this.authorityClient = new WorldAuthorityClient({
                url: wsUrl,
                token,
                onJoined: (msg) => {
                    applyJoined(this.inventory, msg);
                    this.autoLoot = msg.autoLoot === true;
                    this.gold = Number(msg.gold) || 0;
                    resolve(msg.spawn);
                },
                onState: (msg) => this._onWorldState(msg),
                onCreatures: (msg) => this.creatures.applySnapshot(msg.creatures),
                onItems: (msg) => this.groundItems.applySnapshot(msg.items || []),
                onPicked: (msg) => { if (msg.item) addItem(this.inventory, msg.item); },
                // Gold pickup is out-of-band from the inventory: the server
                // never sends a `picked` frame for it, only this wallet
                // balance (see onPicked above — items only).
                onWallet: (msg) => { this.gold = Number(msg.gold) || 0; },
                onDropped: (msg) => {
                    removeItem(this.inventory, msg.itemId);
                    if (this.inventorySelectedItemId === msg.itemId) this.inventorySelectedItemId = null;
                },
                // A refusal is authoritative information, not just a cue to
                // flash: the server has stated it found no stack of this type
                // left, so the displayed count goes to 0 too. Flashing without
                // correcting the number left the HUD insisting "arrow: 1"
                // while every shot was being refused. The count comes from the
                // frame, never computed locally.
                onNoAmmo: (msg) => {
                    this.noAmmoUntil = performance.now() + NO_AMMO_FLASH_MS;
                    applyAmmoCount(this.inventory, msg && msg.item_type_id, 0);
                },
                onAmmo: (msg) => applyAmmoCount(this.inventory, msg.item_type_id, msg.count),
                onError: (e) => {
                    console.error('[authority]', e);
                    // Only a server-issued protocol rejection (type:'error' frame,
                    // e.g. "unequip it first") is worth surfacing to the player —
                    // a raw socket failure has no actionable server message and
                    // would just be noise (and may fire repeatedly).
                    if (e && e.isServerRejection && e.serverMessage) this._showToast(e.serverMessage);
                },
                onClose: () => { this.authorityJoined = false; },
                onKicked: () => {
                    console.warn('[authority] kicked: signed in elsewhere');
                    this.setState('kicked');
                    if (this.authorityClient) this.authorityClient.disconnect();
                },
                onTransition: (msg) => { if (this.onTransition) this.onTransition(msg); },
            });
            this.authorityClient.connect(worldId);
            setTimeout(() => reject(new Error('authority join timeout')), 5000);
        });
        this.authorityJoined = true;
        this.player.x = spawn.x;
        this.player.y = spawn.y;
        await this.imageManager.loadAll();
        // Load the initial neighborhood before the first frame so we don't render empty.
        await this.streamer.update(this.player.x + this.player.width / 2, this.player.y + this.player.height / 2);
        this.camera.update(this.player);

        this.resizeCanvas();
        this._resizeHandler = () => this.resizeCanvas();
        window.addEventListener("resize", this._resizeHandler);
        this.setupInput();

        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        this.lastTime = performance.now();
        this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
        console.log(`chunked game loop started (world ${worldId})`);
    }

    // Preload approved tile textures/atlases so the renderer can draw them.
    // Fire-and-forget image loads (the renderer falls back to color until they
    // arrive); animated tiles also need their atlas manifest, fetched inline
    // and attached to the shared def so RenderSystem can crop frames.
    async _preloadTileAssets(tileTypes) {
        if (!tileTypes) return;
        for (const def of Object.values(tileTypes)) {
            const mode = def.render_mode || def.renderMode;
            if (def.image) {
                this.imageManager.load(def.image, `${API_URL}/api/assets/${def.image}`);
            }
            if (mode === 'animated' && def.sprite) {
                if (def.sprite.atlas_key) {
                    this.imageManager.load(def.sprite.atlas_key, `${API_URL}/api/assets/${def.sprite.atlas_key}`);
                }
                if (def.sprite.manifest_key && !def._manifest) {
                    try {
                        const r = await fetch(`${API_URL}/api/assets/${def.sprite.manifest_key}`);
                        if (r.ok) def._manifest = await r.json();
                    } catch (_) { /* leave unset → renderer uses the static image or color */ }
                }
            }
        }
    }

    destroy() {
        if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
        if (this._keydownHandler) window.removeEventListener('keydown', this._keydownHandler);
        if (this._keyupHandler) window.removeEventListener('keyup', this._keyupHandler);
        if (this._contextMenuHandler) window.removeEventListener('contextmenu', this._contextMenuHandler);
        if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);
        if (this._mouseMoveHandler) this.canvas.removeEventListener('mousemove', this._mouseMoveHandler);
        if (this._mouseDownHandler) this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
        if (this.authorityClient) this.authorityClient.disconnect();

        cancelAnimationFrame(this.animationFrameId);
    }

    update(dt){
        if(this.state !== 'playing') return;
        if (this.chunked) {
            const cx = this.player.x + this.player.width / 2;
            const cy = this.player.y + this.player.height / 2;
            this.streamer.update(cx, cy); // fire-and-forget; wanted-guard makes it safe
            this.player.update(dt, this.keys, this.chunkedMap); // local prediction
            // Send input to the authority; buffer actual sends for reconciliation.
            if (this.authorityClient) {
                const { dx, dy } = inputVector(this.keys);
                const s = this.authorityClient.sendInput(dx, dy, dt);
                if (s.sent) this._inputBuffer.push({ seq: s.seq, dx: s.dx, dy: s.dy, dt: s.dt });
            }
            this.creatures.interpolate(dt);
            if (this.projectiles) this.projectiles.interpolate(dt);
            this.camera.update(this.player);
            return;
        }
        this.player.update(dt, this.keys, this.map);
        this.camera.update(this.player);

        // Push our (predicted) position to the engine. The client is
        // throttled internally to ~20Hz so spamming this every frame is fine.
        if (this.engine && this.engine.joined) {
            const cx = this.player.x + this.player.width / 2;
            const cy = this.player.y + this.player.height / 2;
            this.engine.sendMove(cx, cy);
        }
    }

    /**
     * Apply an authoritative tick from the engine. We reconcile our own
     * position softly (lerp / snap by distance) and overwrite remote players
     * directly — the renderer reads whatever's in `this.remotePlayers`.
     */
    _onServerState(msg) {
        this.lastServerTick = msg.tick || 0;
        const next = new NativeMap();
        for (const sp of msg.players || []) {
            if (sp.user_id === this.localUserId) {
                this._reconcileSelf(sp);
                continue;
            }
            const px = sp.x - this.player.width / 2;
            const py = sp.y - this.player.height / 2;
            next.set(sp.user_id, { x: px, y: py, hp: sp.hp });
        }
        this.remotePlayers = next;

        // Once per ~second, log a diagnostic snapshot so multiplayer is
        // visible in the console without opening devtools to the network tab.
        if (msg.tick && msg.tick % 60 === 0) {
            console.log(
                `[engine] tick=${msg.tick} map=${msg.map_id} self=${this.localUserId} ` +
                `local=(${Math.round(this.player.x)},${Math.round(this.player.y)}) ` +
                `remote=${this.remotePlayers.size} ids=[${[...this.remotePlayers.keys()].join(",")}]`
            );
        }
    }

    // Authoritative tick from the world authority. Reconcile the local player
    // (snap to server pos for the acked seq, replay un-acked inputs) and refresh
    // remote players for the renderer.
    _onWorldState(msg) {
        this.lastServerTick = msg.tick || 0;
        const next = new NativeMap();
        let mine = null;
        for (const p of (msg.players || [])) {
            if (p.id === this.localUserId) { mine = p; continue; }
            next.set(p.id, { x: p.x, y: p.y, facing: p.facing, hp: p.hp, maxHp: p.maxHp, effects: p.effects || null });
        }
        this.remotePlayers = next;
        if (mine) {
            this.player.hp = mine.hp;
            this.player.maxHp = mine.maxHp;
            // Assigned on EVERY frame, including the (common) one where the
            // server omits the field — otherwise a `if (mine.effects)` guard
            // would leave the HUD reading "Burning" long after the burn ended.
            this.player.effects = mine.effects || null;
            const out = reconcile(
                { x: mine.x, y: mine.y },
                msg.ackSeq || 0,
                this._inputBuffer,
                this.chunkedMap,
                { width: this.player.width, height: this.player.height, speed: PLAYER_SPEED_EFFECTIVE }
            );
            this.player.x = out.x;
            this.player.y = out.y;
            this._inputBuffer = out.buffer;
        }
        if (mine) {
            this.localMana = mine.mana;
            this.localMaxMana = mine.maxMana;
            this.localStamina = mine.stamina;
            this.localMaxStamina = mine.maxStamina;
            applyEquipment(this.inventory, mine.equipment || {});
            // Server wins: a click sets this.autoLoot optimistically (see
            // _handleInventoryClick), but every subsequent state frame
            // corrects it to whatever the server actually holds, so a lost
            // 'autoloot' send (e.g. socket closed silently) can't leave the
            // UI reading a value the server never agreed to.
            this.autoLoot = mine.autoLoot === true;
        }
        if (this.projectiles) this.projectiles.applySnapshot(msg.projectiles || []);
        // Detonations are present only on the tick they happened (the server
        // clears its stash after this broadcast), so they must be taken off
        // THIS frame — there is no snapshot to re-read them from later.
        if (msg.detonations && msg.detonations.length) {
            addBlasts(this.blasts, msg.detonations, performance.now());
        }
    }

    _reconcileSelf(serverPlayer) {
        // Server reports a center coordinate; convert back to top-left.
        const sx = serverPlayer.x - this.player.width / 2;
        const sy = serverPlayer.y - this.player.height / 2;
        const dx = sx - this.player.x;
        const dy = sy - this.player.y;
        const dist = Math.hypot(dx, dy);

        if (dist <= RECONCILE_SOFT_PX) return; // trust prediction
        if (dist > RECONCILE_HARD_PX) {
            this.player.x = sx;
            this.player.y = sy;
            return;
        }
        // Soft pull toward server.
        this.player.x += dx * RECONCILE_LERP;
        this.player.y += dy * RECONCILE_LERP;
    }

    // The HUD weapon name: whatever occupies main_hand, else the default
    // weapon (mirrors the server's DEFAULT_WEAPON_NAME fallback).
    _resolveWeaponName() {
        const mainHandId = this.inventory.equipment.main_hand;
        const equipped = mainHandId != null ? typeOf(this.inventory, mainHandId) : null;
        if (equipped) return equipped.name;
        for (const t of this.inventory.types.values()) {
            if (t.name === DEFAULT_WEAPON_NAME) return t.name;
        }
        return DEFAULT_WEAPON_NAME;
    }

    render(){
        if(this.state === 'menu'){
            this.ctx.fillStyle = '#0f3460';
            this.ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
        } else if (this.state === 'kicked') {
            // Freeze on the last frame's background and surface why input stopped
            // working; the authority socket is already gone (see onKicked).
            this.ctx.fillStyle = 'rgba(0,0,0,0.75)';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.save();
            this.ctx.fillStyle = '#ef4444';
            this.ctx.font = '24px sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText('Signed in elsewhere — this session was disconnected.', this.canvas.width / 2, this.canvas.height / 2);
            this.ctx.restore();
        } else if (this.chunked) {
            // Expire the toast here (once per frame) rather than on a timer,
            // consistent with how the rest of Game drives state off the loop.
            if (this.toast && performance.now() >= this.toast.expiresAt) this.toast = null;
            // Expire finished blasts once per frame, on the same clock the
            // ring animation reads.
            const nowMs = performance.now();
            this.blasts = pruneBlasts(this.blasts, nowMs);
            this.renderSystem.renderChunked({
                player: this.player,
                camera: this.camera,
                chunkedMap: this.chunkedMap,
                remotePlayers: this.remotePlayers,
                localUserId: this.localUserId,
                creatures: this.creatures.all(),
                projectiles: this.projectiles ? this.projectiles.all() : [],
                mana: this.localMana,
                maxMana: this.localMaxMana,
                stamina: this.localStamina,
                maxStamina: this.localMaxStamina,
                weaponName: this._resolveWeaponName(),
                inventory: this.inventory,
                inventoryOpen: this.inventoryOpen,
                selectedItemId: this.inventorySelectedItemId,
                groundItems: this.groundItems.all(),
                autoLoot: this.autoLoot,
                gold: this.gold,
                toast: this.toast,
                blasts: this.blasts,
                // null whenever the equipped weapon needs no ammo — the HUD
                // then draws no ammo line at all.
                ammo: resolveAmmoHud(this.inventory),
                noAmmoFlash: nowMs < this.noAmmoUntil,
                // The local player's own effects, for the HUD line. The rings
                // at their feet come from this.player.effects via drawCreature.
                effects: this.player.effects || null,
            });
        } else {
            this.renderSystem.render(this.player, this.camera, this.map, this.remotePlayers, this.localUserId);
        }
    }

    gameLoop(timestamp){
        if(this.lastTime === 0) this.lastTime = timestamp;
        const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
        this.lastTime = timestamp;
        
        this.update(dt);
        this.render();
        
        this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
    }

    // Hit-test the slot/item rects RenderSystem recorded while drawing the
    // open panel (canvas-px space, same as _cursorX/_cursorY). Clicking an
    // item selects it (click again to deselect); clicking a slot equips the
    // selected item there (if legal client-side) or unequips an occupied
    // slot when nothing is selected. Legality is re-checked server-side.
    _handleInventoryClick(cx, cy) {
        const hitAreas = (this.renderSystem && this.renderSystem._invHitAreas) || [];
        const hit = hitAreas.find((a) => cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h);
        if (!hit) return;

        if (hit.kind === 'item') {
            this.inventorySelectedItemId = (this.inventorySelectedItemId === hit.id) ? null : hit.id;
            return;
        }

        if (hit.kind === 'slot') {
            const slot = hit.id;
            if (this.inventorySelectedItemId != null) {
                if (canEquipClient(this.inventory, this.inventorySelectedItemId, slot)) {
                    this.authorityClient.sendEquip(this.inventorySelectedItemId, slot);
                }
                this.inventorySelectedItemId = null;
            } else if (this.inventory.equipment[slot]) {
                this.authorityClient.sendUnequip(slot);
            }
            return;
        }

        if (hit.kind === 'autoloot') {
            // Only mirror the flip if the intent actually reached the server.
            // On a dead socket the send is silently dropped and no later
            // `state` frame can correct us, so an unconditional flip would
            // leave the label lying — the exact failure this flag's wire
            // echo exists to prevent.
            if (!this.authorityClient) return;
            if (this.authorityClient.sendAutoLoot(!this.autoLoot)) {
                this.autoLoot = !this.autoLoot;
            }
            return;
        }
        if (hit.kind === 'drop') {
            if (this.authorityClient) this.authorityClient.sendDrop(hit.id);
            return;
        }
    }

    setupInput(){
        if (this._inputAttached) return;
        this._inputAttached = true;

        this._keydownHandler = (e) => {
            const key = e.key.toLowerCase();
            this.keys[key] = true;

            // Inventory / paper-doll toggle (replaces the retired number-key
            // weapon switch — equipping now goes through the panel).
            if (key === 'i' && this.state === 'playing' && this.chunked && !e.repeat) {
                this.inventoryOpen = !this.inventoryOpen;
                if (!this.inventoryOpen) this.inventorySelectedItemId = null;
            }

            if(key === 'escape'){
                console.log("Escape pressed, current state:", this.state);
                if(this.state === 'playing'){
                    this.pause();
                }else if(this.state === 'paused'){
                    this.resume();
                }
            }

            if (key === 'g' && this.state === 'playing') {
                // Chunked mode: g loots. Legacy single-map mode keeps the grid toggle.
                if (this.chunked) {
                    // Match the mouse handler's rule: no game-world intents
                    // fire while the inventory panel is open and consuming
                    // input.
                    if (!e.repeat && this.authorityClient && !this.inventoryOpen) this.authorityClient.sendPickup();
                } else {
                    this.map.toggleGrid();
                }
            }

            // Dev: cycle the global render-mode override (none -> rect -> static -> animated).
            if(key === 'm' && this.state === 'playing'){
                const mode = this.renderSystem.cycleRenderModeOverride();
                console.log(`Render-mode override: ${mode ?? 'off (per-entity)'}`);
            }

            // Dev: toggle tile textures on/off (falls back to flat color).
            if (key === 't' && this.renderSystem && this.chunked) {
                const on = this.renderSystem.toggleTileTextures();
                this._showToast(`Tile textures ${on ? 'on' : 'off'}`);
            }
        };

        this._keyupHandler = (e) => {
            this.keys[e.key.toLowerCase()] = false;
        };

        this._contextMenuHandler = () => {
            this.keys = {};
        };

        this._blurHandler = () => {
            this.keys = {};
        };

        // Mouse aim (Slice 3b): track cursor canvas-px position, and on
        // left-click compute the aim vector toward it and send an attack.
        this._mouseMoveHandler = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this._cursorX = (e.clientX - rect.left) * (this.canvas.width / rect.width);
            this._cursorY = (e.clientY - rect.top) * (this.canvas.height / rect.height);
        };
        this._mouseDownHandler = (e) => {
            if (e.button !== 0) return;
            if (this.state !== 'playing' || !this.chunked || !this.authorityClient) return;
            // While the panel is open, clicks hit-test it and must NOT also
            // fire an attack.
            if (this.inventoryOpen) {
                this._handleInventoryClick(this._cursorX ?? 0, this._cursorY ?? 0);
                return;
            }
            const pcx = this.player.x + this.player.width / 2;
            const pcy = this.player.y + this.player.height / 2;
            const { nx, ny } = aimVector(this._cursorX ?? this.canvas.width / 2, this._cursorY ?? this.canvas.height / 2, this.camera, pcx, pcy);
            this.authorityClient.sendAttack(nx, ny);
        };

        window.addEventListener('keydown', this._keydownHandler);
        window.addEventListener('keyup', this._keyupHandler);
        window.addEventListener('contextmenu', this._contextMenuHandler);
        window.addEventListener('blur', this._blurHandler);
        this.canvas.addEventListener('mousemove', this._mouseMoveHandler);
        this.canvas.addEventListener('mousedown', this._mouseDownHandler);
    }

    startGame(){
        this.setState('playing');
        this.player.reset();
        this.lastTime = performance.now();
    }

    pause(){
        this.setState('paused');
    }

    resume(){
        this.setState('playing');
    }

    returnToMenu(){
        this.setState('menu');
    }

    resizeCanvas(){
        if (!this.canvas) return;
        const ratio = 16/9;
        let h,w;
        const margin = 15;

        const availableWidth = window.innerWidth - 2 * margin;
        const availableHeight = window.innerHeight - 2 * margin;

        if(availableWidth/availableHeight > ratio){
            h = availableHeight;
            w = h * ratio;
        }else{
            w = availableWidth;
            h = w / ratio;
        }

        this.canvas.width = GAME_WIDTH;
        this.canvas.height = GAME_HEIGHT;

        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
        this.canvas.style.margin = `${margin}px`;
    }
}