import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";
import { RenderSystem } from "../systems/RenderSystem.js";
import { Player } from "../entities/Player.js";
import { ImageManager } from "../managers/ImageManager.js";
import { Camera } from "./Camera.js";
import { ChunkedMap } from "./ChunkedMap.js";
import { ChunkStreamer } from "../net/ChunkStreamer.js";
import { makeChunkFetcher } from "../net/chunkFetcher.js";
import { CreatureManager } from "../entities/CreatureManager.js";
import { ProjectileManager } from "../entities/ProjectileManager.js";
import { GroundItemManager } from "../entities/GroundItemManager.js";
import { WorldAuthorityClient } from "../net/WorldAuthorityClient.js";
import { getStoredToken, parseJwt } from "../net/auth.js";
import { reconcile } from "../net/reconcile.js";
import { inputVector, movementKeys } from "../entities/Player.js";
import { PLAYER_SPEED_EFFECTIVE } from "./constants.js";
import { aimVector } from "./aim.js";
import { createInventory, applyJoined, applyEquipment, canEquipClient, typeOf, addItem, removeItem } from "./inventory.js";
import { resolveAmmoHud, applyAmmoCount } from "./ammo.js";
import { addBlasts, pruneBlasts } from "./blasts.js";
import { indexEffects, addEffects, pruneEffects, capParticles } from "./vfx.js";
import { assetUrl } from "../net/assets.js";

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

export class Game {
    constructor() {
        console.log("Game constructor");
        this.canvas = null;
        this.ctx = null;
        this.imageManager = new ImageManager();

        this.player = new Player();
        this.camera = new Camera();

        this.chunked = false;
        this.chunkedMap = null;
        this.streamer = null;

        this.keys = {};
        this.lastTime = 0;
        this.state = 'menu';
        this.onStateChange = null;

        // Networking — set via setEngineClient. Something2.jsx only ever
        // calls this with (null, null) as teardown (the live path is
        // initChunked's WorldAuthorityClient below); kept only so that
        // teardown call has something to no-op against.
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

        // Live attack effects, and the library their names resolve against.
        this.vfx = [];
        this.vfxDefs = {};

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

        // Progression (SOMET-242): the raw player_progression row (level,
        // experience, stat_points, six stats) -- set from `joined.progression`
        // and refreshed by `progression` push messages (kill XP, level-up,
        // death). null until the first join lands. Nothing here derives HUD
        // numbers from it directly; CharacterSheet.jsx is the sole reader.
        this.progression = null;

        // Merchant + shop (Slice D): `merchants` is the join-time list of
        // village merchant markers to render; `shop` is the catalog/buyback
        // snapshot from the last `shop` message (null when no shop is open),
        // and `shopOpen` gates the panel render/input independently of
        // `shop` itself staying populated across a close/reopen.
        this.merchants = [];
        // SOMET-297. Empty until a `joined` frame arrives, and reset here on
        // the same line merchants is -- both are per-world join payload.
        this.landmarks = [];
        this.shop = null;
        this.shopOpen = false;
        // Which stock list the shop panel shows and which page of it. The
        // panel's catalog/buyback lists are longer than one panel-height (a
        // village carries 24 catalog rows), so the tab/page selection has to
        // live somewhere across frames — RenderSystem re-derives the layout
        // every frame and owns no state. Clamped at render time; clicks only
        // ever set a page the last rendered frame offered.
        this.shopView = { tab: 'catalog', page: 0 };

        // Account chest (SOMET-310). Same three-field shape as the shop above,
        // and for the same reasons: `banks` is the join-time marker list,
        // `bank` is the last server snapshot, `bankOpen` gates render/input
        // independently so the snapshot survives a close/reopen.
        //
        // The chest is ACCOUNT-scoped server-side, so this state is NOT reset
        // per world join the way `shop` is -- but it is reset anyway (see the
        // reset block below), because the panel must never show one world's
        // stale snapshot after a transition; the server re-sends the whole
        // chest on the next open regardless.
        this.banks = [];
        this.bank = null;
        this.bankOpen = false;
        // 'chest' lists what is stored, 'carry' lists this character's
        // inventory so it can be deposited. Same clamped-at-render contract as
        // shopView: clicks only ever set a page the last rendered frame
        // offered.
        this.bankView = { tab: 'chest', page: 0 };

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
    }

    setOnStateChange(callback) {
        this.onStateChange = callback;
    }

    setOnTransition(cb) {
        this.onTransition = cb;
    }

    // SOMET-293. WaypointTravel.jsx registers this so it can refetch its list
    // the moment a waypoint lights up. Without it the player walks onto a
    // waypoint, the server writes the row, and the popup keeps calling that
    // place undiscovered until the page is reloaded -- the feature would look
    // broken at exactly the moment it worked.
    setOnWaypointActivated(cb) {
        this.onWaypointActivated = cb;
    }

    // Ask the authority to move this character to a waypoint. Returns whether
    // the frame went out at all; the ANSWER arrives asynchronously as either an
    // `error` toast or a `transition`, so a `true` here means "asked", never
    // "arrived". The server re-derives where the player is standing from its own
    // copy of the position, so nothing about the origin is sent.
    travelToWaypoint(waypointId) {
        if (!this.authorityClient) return false;
        return this.authorityClient.sendTravel(waypointId) !== false;
    }

    setState(newState) {
        if (this.state !== newState) {
            // SOMET-79: snapshot the last live frame on the way into a frozen
            // state. Both frozen states claim to "freeze on the last frame's
            // background" and dim it, but they redrew a 0.75-alpha black over
            // whatever was already on the canvas EVERY frame -- and since
            // nothing clears in between, the alpha compounds: ~1-p^n toward
            // opaque, i.e. solid black within a second or so. The scene the
            // dimming exists to keep visible was destroyed by the dimming.
            // Capturing once here means each frame can restore the frozen
            // pixels and apply exactly one veil over them.
            if ((newState === 'kicked' || newState === 'disconnected') && this.canvas) {
                this._frozenFrame = this._captureFrame();
            }
            if (newState === 'playing') this._frozenFrame = null;
            this.state = newState;
            if (this.onStateChange) {
                this.onStateChange(newState);
            }
        }
    }

    // Best-effort: a tainted or zero-sized canvas must not break the state
    // transition, so a failure just means no frozen backdrop (the veil still
    // draws, over black) rather than a throw on the way into an error state.
    _captureFrame() {
        try {
            if (!this.ctx || !this.canvas.width || !this.canvas.height) return null;
            return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        } catch { return null; }
    }

    // One veil over the frozen frame, not a fresh veil over the last veil.
    _drawFrozenBackdrop() {
        if (this._frozenFrame) this.ctx.putImageData(this._frozenFrame, 0, 0);
        else { this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); }
        this.ctx.fillStyle = 'rgba(0,0,0,0.75)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // WorldAuthorityClient's onClose fires for every close, including ones
    // Game itself triggered on purpose (a doorway transition's re-entry
    // guard, the 'kicked' flow's own disconnect(), destroy() on unmount).
    // `wasIntentional` (WorldAuthorityClient's _closed, set synchronously
    // before it calls ws.close()) tells those apart from the socket simply
    // dying under us (backend restart/crash/network blip). Only the latter
    // is fatal: it leaves state=='playing' with input handlers silently
    // dropping every send against a dead socket (F-028) unless we surface
    // it. Mirrors the existing 'kicked' state transition/render branch.
    _onAuthorityClose(wasIntentional) {
        if (!wasIntentional && this.state === 'playing') {
            console.warn('[authority] connection lost — no reconnect attempted, reload to resume');
            this.setState('disconnected');
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
            // URLs carry the row's updated_at so an approved regeneration is
            // actually fetched (see assetUrl) — but the imageManager CACHE KEY
            // stays the bare asset key, because RenderSystem looks entities up
            // by `e.image` / `sprite.atlas_key`.
            const v = def.updated_at;
            // Entities approved through the object pipeline carry a plain
            // `image` and no atlas; RenderSystem's single-image fallback needs
            // it loaded under that same key to find it.
            if (def.image) {
                this.imageManager.load(def.image, assetUrl(API_URL, def.image, v));
            }
            if (def.sprite && def.sprite.atlas_key) {
                byAtlas[def.sprite.atlas_key] = { spr: def.sprite, v };
            }
        }
        const manifests = {};
        await Promise.all(Object.values(byAtlas).map(async ({ spr, v }) => {
            await this.imageManager.load(spr.atlas_key, assetUrl(API_URL, spr.atlas_key, v));
            try {
                const res = await fetch(assetUrl(API_URL, spr.manifest_key, v));
                if (res.ok) manifests[spr.atlas_key] = await res.json();
            } catch { /* leave unset -> rect fallback */ }
        }));
        for (const name in entityTypes) {
            const spr = entityTypes[name] && entityTypes[name].sprite;
            if (spr && spr.atlas_key && manifests[spr.atlas_key]) spr.manifest = manifests[spr.atlas_key];
        }
    }

    async initChunked({ worldId, characterId, chunkSize, tileTypes, vfxEffects = null, entityTypes = null, spawnX = 0, spawnY = 0 }) {
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
        this.worldId = worldId;
        this.renderSystem = new RenderSystem(this.canvas, this.imageManager);
        this.chunkedMap = new ChunkedMap(chunkSize, tileTypes);
        this._preloadTileAssets(tileTypes);
        // Names arrive on the wire already resolved; this is the only lookup
        // the client does. Empty until the fetch lands — effects then simply
        // do not draw, rather than throwing.
        this.vfxDefs = indexEffects(vfxEffects);
        // Approved entity images/atlases, so authority-driven creatures render
        // with their generated sprite rather than a colored box. Fire-and-forget
        // like the tile preload: until it resolves, rendering degrades to color.
        this.preloadSprites(entityTypes);
        this.streamer = new ChunkStreamer(this.chunkedMap, makeChunkFetcher(worldId, API_URL), 1);

        this.creatures = new CreatureManager(entityTypes);
        this.projectiles = new ProjectileManager();
        // Non-creature entity types (map decorations: rocks, bushes, ...),
        // keyed by name for RenderSystem.collectDecorations. Built once here
        // rather than re-filtered every frame in render().
        this.decoTypes = new Map();
        for (const name in (entityTypes || {})) {
            const def = entityTypes[name];
            if (def && def.isCreature === false) this.decoTypes.set(name, def);
        }

        // Fresh inventory state per join (re-entry guard above tears down the
        // previous authority connection, so mirror that for the paper-doll).
        this.inventory = createInventory();
        this.inventoryOpen = false;
        this.inventorySelectedItemId = null;
        this.groundItems = new GroundItemManager();
        this.autoLoot = false;
        this.gold = 0;
        this.progression = null;
        this.merchants = [];
        // SOMET-297. Empty until a `joined` frame arrives, and reset here on
        // the same line merchants is -- both are per-world join payload.
        this.landmarks = [];
        this.shop = null;
        this.shopOpen = false;
        this.shopView = { tab: 'catalog', page: 0 };
        // SOMET-310. Reset alongside the shop even though the chest's CONTENTS
        // are account-scoped and survive the world change: what is being
        // cleared is the client's snapshot and which bank it was read at, both
        // of which belong to the world being left. The next `openbank` refills
        // them from the server.
        this.banks = [];
        this.bank = null;
        this.bankOpen = false;
        this.bankView = { tab: 'chest', page: 0 };
        this.blasts = [];
        this.vfx = [];
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
            // Scoped to THIS join attempt. There used to be an
            // `authorityJoined` field here; it was set on join and cleared on
            // close and NEVER READ (SOMET-96), and it could not have served
            // this purpose anyway -- on a second initChunked (map travel while
            // already playing) it was still true from the previous world, so
            // an "is this a refused join" test written against it would answer
            // no. It has been removed rather than wired in: the consequence it
            // was filed for (the loop running on after a silent disconnect) is
            // handled by the 'disconnected' state, and a maintained-but-unread
            // flag is something a later reader will eventually trust.
            let settled = false;
            this.authorityClient = new WorldAuthorityClient({
                url: wsUrl,
                token,
                onJoined: (msg) => {
                    settled = true;
                    applyJoined(this.inventory, msg);
                    this.autoLoot = msg.autoLoot === true;
                    this.gold = Number(msg.gold) || 0;
                    this.merchants = Array.isArray(msg.merchants) ? msg.merchants : [];
                    // SOMET-297. Same shape as merchants above. Replaced whole
                    // on every join, so a world change cannot leave the previous
                    // world's markers on the ground -- transitions re-join
                    // (GameShell routes onTransition into enterWorld), so this
                    // assignment is the only thing that has to be right.
                    this.landmarks = Array.isArray(msg.landmarks) ? msg.landmarks : [];
                    // SOMET-310. Same whole-replacement rule as merchants and
                    // landmarks: bank posts are static village geometry, so the
                    // join frame is their only delivery and a stale list from
                    // the previous world must not survive the transition.
                    this.banks = Array.isArray(msg.banks) ? msg.banks : [];
                    this.progression = msg.progression || null;
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
                // Interacting near a merchant opens the panel with its
                // current stock; the server is the sole source of truth for
                // catalog/buyback/prices, so this simply mirrors the frame.
                // A `shop` frame also arrives after every buy/sell to refresh
                // the stock, so the tab/page selection is reset only on a real
                // open (panel currently closed) — otherwise buying row 3 of
                // buyback page 2 would bounce the player back to catalog p1.
                onShop: (msg) => {
                    this.shop = { villageId: msg.villageId, catalog: msg.catalog || [], buyback: msg.buyback || [] };
                    if (!this.shopOpen) this.shopView = { tab: 'catalog', page: 0 };
                    this.shopOpen = true;
                },
                // Kill XP / level-up / death pushes. Always the server's raw
                // row; CharacterSheet.jsx decides what changed and whether
                // that's worth a re-render (a zero-XP kill still pushes a
                // frame with unchanged values -- see its progressionChanged).
                // SOMET-310. The server sends the WHOLE chest on open and again
                // after every deposit/withdraw, so this mirrors the frame and
                // never reconciles a delta -- the same rule onShop follows, and
                // for the same reason: capacity and slot occupancy are server
                // facts the client has no business recomputing.
                //
                // The tab/page reset is gated on "panel currently closed" for
                // exactly the reason onShop's is: a deposit made from page 2 of
                // the carry tab must not bounce the player back to chest page 1
                // on the refresh frame that follows it.
                onBank: (msg) => {
                    this.bank = {
                        villageId: msg.villageId,
                        items: Array.isArray(msg.items) ? msg.items : [],
                        capacity: Number(msg.capacity) || 0,
                    };
                    if (!this.bankOpen) this.bankView = { tab: 'chest', page: 0 };
                    this.bankOpen = true;
                },
                // The chest half of a move arrives as the `bank` frame above;
                // these two carry the INVENTORY half. Deliberately not folded
                // into onBank: the inventory mirror must be corrected whether
                // or not the panel is open, and a withdrawn instance carries a
                // NEW player_items id (the server deletes and re-creates it),
                // so this must add the server's item rather than resurrect a
                // remembered one.
                onDeposited: (msg) => {
                    removeItem(this.inventory, msg.itemId);
                    if (this.inventorySelectedItemId === msg.itemId) this.inventorySelectedItemId = null;
                },
                onWithdrawn: (msg) => { if (msg.item) addItem(this.inventory, msg.item); },
                onProgression: (msg) => { if (msg && msg.progression) this.progression = msg.progression; },
                // A trade lands its inventory/wallet effect via the existing
                // item/gold plumbing (addItem/removeItem, wallet frame); what
                // 'bought'/'sold' add on top is re-issuing `interact` so the
                // now-stale catalog/buyback the panel is showing gets
                // refreshed from the server rather than guessed locally.
                onBought: (msg) => { if (msg.item) addItem(this.inventory, msg.item); if (this.authorityClient) this.authorityClient.sendInteract(); },
                onSold: (msg) => { removeItem(this.inventory, msg.itemId); if (this.authorityClient) this.authorityClient.sendInteract(); },
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
                    // A server rejection that arrives BEFORE `joined` is a
                    // refused join, not an in-game rejection: the authority's
                    // join policy can say no (an unreachable world, a character
                    // that is not yours). Fail the join promise with the
                    // server's own words instead of letting it sit until the
                    // 5s timeout below and then reporting the useless
                    // "authority join timeout" -- with the real reason already
                    // gone past in a toast.
                    if (!settled && e && e.isServerRejection && e.serverMessage) {
                        settled = true;
                        reject(new Error(e.serverMessage));
                        return;
                    }
                    // Only a server-issued protocol rejection (type:'error' frame,
                    // e.g. "unequip it first") is worth surfacing to the player —
                    // a raw socket failure has no actionable server message and
                    // would just be noise (and may fire repeatedly).
                    if (e && e.isServerRejection && e.serverMessage) this._showToast(e.serverMessage);
                },
                onClose: (ev, wasIntentional) => this._onAuthorityClose(wasIntentional),
                onKicked: () => {
                    console.warn('[authority] kicked: signed in elsewhere');
                    this.setState('kicked');
                    if (this.authorityClient) this.authorityClient.disconnect();
                },
                onTransition: (msg) => { if (this.onTransition) this.onTransition(msg); },
                onWaypointActivated: (msg) => {
                    // Light the marker on the ground the moment the server says
                    // so (SOMET-297). Without this the outline only becomes a
                    // filled diamond on the NEXT join, so the player walks onto
                    // a waypoint, the popup gains an entry, and the tile they
                    // are standing on still looks unvisited.
                    //
                    // Matched by tile, not by id: a landmark carries no id (the
                    // wire shape is kind/x/y/name/activated) and only one
                    // waypoint can occupy a tile -- waypoints_world_tile_unique
                    // and the tick loop's single-entry Map both say so.
                    const wp = msg && msg.waypoint;
                    if (wp && Array.isArray(this.landmarks)) {
                        for (const l of this.landmarks) {
                            if (l.kind === 'waypoint' && l.x === wp.x && l.y === wp.y) l.activated = true;
                        }
                    }
                    if (this.onWaypointActivated) this.onWaypointActivated(msg);
                },
            });
            this.authorityClient.connect(worldId, characterId);
            setTimeout(() => reject(new Error('authority join timeout')), 5000);
        });
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
            // Versioned for the same reason as preloadSprites (imageManager
            // caches by bare asset key). SOMET-235: a re-approved tile texture
            // now lands under a brand-new job-id-scoped key rather than
            // overwriting the old one in place, so this `v` is
            // redundant-but-harmless insurance, not what makes the swap visible.
            const v = def.updated_at;
            if (def.image) {
                this.imageManager.load(def.image, assetUrl(API_URL, def.image, v));
            }
            if (mode === 'animated' && def.sprite) {
                if (def.sprite.atlas_key) {
                    this.imageManager.load(def.sprite.atlas_key, assetUrl(API_URL, def.sprite.atlas_key, v));
                }
                if (def.sprite.manifest_key && !def._manifest) {
                    try {
                        const r = await fetch(assetUrl(API_URL, def.sprite.manifest_key, v));
                        if (r.ok) def._manifest = await r.json();
                    } catch (_) { /* leave unset → renderer uses the static image or color */ }
                }
            }
        }
    }

    // Read-only live snapshot for the minimap HUD. Keeps Game the single source of
    // truth so the React component never reaches into engine internals. Returns
    // null unless we're actually in a playing chunked world.
    getMinimapSnapshot() {
        if (this.state !== 'playing' || !this.chunked || !this.player) return null;
        // movementKeys, not this.keys: the minimap's heading arrow would
        // otherwise keep pointing wherever a held key says while the player is
        // standing still with a panel open.
        const { dx, dy } = inputVector(movementKeys(this));
        if (dx !== 0 || dy !== 0) {
            const m = Math.hypot(dx, dy) || 1;
            this._minimapDir = { dx: dx / m, dy: dy / m };
        }
        return {
            worldId: this.worldId ?? null,
            chunkSize: this.chunkedMap ? this.chunkedMap.chunkSize : null,
            // SOMET-298. The same array the ground renderer draws, handed over
            // by reference on purpose: when onWaypointActivated flips a marker
            // to lit, the minimap changes on the very next frame with no
            // refetch and no second copy to keep in step.
            landmarks: this.landmarks || [],
            player: {
                x: this.player.x + (this.player.width || 0) / 2,
                y: this.player.y + (this.player.height || 0) / 2,
                dir: this._minimapDir || { dx: 0, dy: 1 },
            },
            creatures: (this.creatures ? this.creatures.all() : []).map((c) => ({ x: c.x, y: c.y, color: c.color })),
        };
    }

    // Read-only live snapshot for the travel popup (SOMET-293), same convention
    // as getMinimapSnapshot above. Its own method rather than a reuse of the
    // minimap's: that one maps every visible creature on each call, and the
    // popup needs exactly two facts. The player's CENTRE, because that is the
    // point the authority derives the player's tile from -- a snapshot handing
    // over the top-left corner would light the wrong tile near a boundary.
    getWaypointSnapshot() {
        if (this.state !== 'playing' || !this.chunked || !this.player) return null;
        return {
            worldId: this.worldId ?? null,
            playerX: this.player.x + (this.player.width || 0) / 2,
            playerY: this.player.y + (this.player.height || 0) / 2,
        };
    }

    // Read-only live snapshot for the character sheet HUD (SOMET-242), same
    // convention as getMinimapSnapshot above: Game stays the single source of
    // truth so the React component never reaches into engine internals. null
    // unless we're actually in a playing chunked world with a joined
    // progression row.
    getProgressionSnapshot() {
        if (this.state !== 'playing' || !this.chunked || !this.progression) return null;
        return { progression: this.progression, gold: this.gold };
    }

    // Write-through cache update for gold ONLY (SOMET-242 D1 fix, narrowed by
    // the F1 fix below). CharacterSheet.jsx calls this right after a
    // successful respec HTTP response so the canvas-drawn gold HUD
    // (RenderSystem reads this.gold directly) reflects the payment
    // immediately, the same way D1 originally fixed the sheet's own stale
    // display.
    //
    // This used to also accept and apply `progression` the same way -- that
    // was D1's fix. F1 (a later browser pass) found it was racy: the HTTP
    // response and a concurrent kill/death websocket push travel on two
    // independent connections with no ordering guarantee between them, so a
    // late allocate/respec response could overwrite a NEWER kill/death push
    // with a stale pre-mutation snapshot, silently undoing a level-up in the
    // display. Fixed by removing progression from this method entirely:
    // this.progression now has exactly one writer, the onProgression
    // websocket handler above, which is the only channel with a genuine
    // ordering guarantee (a single WebSocket connection preserves send
    // order, and server.js's refreshPlayerStats -- e77d929/bbab966 -- now
    // pushes a 'progression' frame after every successful allocate/respec
    // too, through that same ordered channel). See CharacterSheet.jsx's
    // module header for the full reasoning, including why a naive
    // "only apply if experience increased" guard was considered and
    // rejected (death decreases experience, so that check is not a valid
    // total order either).
    //
    // gold has no equivalent websocket echo for a respec (refreshPlayerStats
    // does not carry gold, and a respec never sends a 'wallet' message), so
    // it keeps being written through directly here -- a real, narrower
    // version of the same race remains possible against a concurrent
    // 'wallet' push (e.g. an item pickup mid-respec), left as a documented,
    // out-of-scope residual risk in the task report rather than silently
    // ignored.
    applyGoldResult(gold) {
        if (typeof gold === 'number') this.gold = gold;
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
            const keys = movementKeys(this);
            this.player.update(dt, keys, this.chunkedMap); // local prediction
            // Send input to the authority; buffer actual sends for reconciliation.
            if (this.authorityClient) {
                const { dx, dy } = inputVector(keys);
                const s = this.authorityClient.sendInput(dx, dy, dt);
                if (s.sent) this._inputBuffer.push({ seq: s.seq, dx: s.dx, dy: s.dy, dt: s.dt });
            }
            this.creatures.interpolate(dt);
            if (this.projectiles) this.projectiles.interpolate(dt);
            this.camera.update(this.player);
            return;
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
        // Attacks are present only on the tick they happened (the server
        // clears its stash after this broadcast), so they must be taken off
        // THIS frame — there is no snapshot to re-read them from later.
        if (msg.attacks && msg.attacks.length) {
            addEffects(this.vfx, msg.attacks, performance.now(), this.vfxDefs);
        }
        // Slice C: impacts ride the same frame and are equally single-shot.
        // They go through addEffects too -- an impact IS an effect, just one
        // positioned on the target rather than the attacker -- so pruning,
        // easing and the particle cap all apply to them for free rather than
        // needing a parallel list that could drift.
        if (msg.impacts && msg.impacts.length) {
            addEffects(this.vfx, msg.impacts, performance.now(), this.vfxDefs);
            // Enforce the live-particle budget the moment the list grows,
            // which is exactly when a crowded fight would blow it.
            this.vfx = capParticles(this.vfx);
        }
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
            // _drawFrozenBackdrop restores the captured frame before veiling it,
            // so the veil is applied once rather than compounding per frame.
            this._drawFrozenBackdrop();
            this.ctx.save();
            this.ctx.fillStyle = '#ef4444';
            this.ctx.font = '24px sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText('Signed in elsewhere — this session was disconnected.', this.canvas.width / 2, this.canvas.height / 2);
            this.ctx.restore();
        } else if (this.state === 'disconnected') {
            // Same freeze-and-explain treatment as 'kicked' above, for the
            // other way the authority socket dies: it just closed on us
            // (server restart/crash/network), rather than the server
            // deliberately kicking this session (see _onAuthorityClose).
            this._drawFrozenBackdrop();
            this.ctx.save();
            this.ctx.fillStyle = '#ef4444';
            this.ctx.font = '24px sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText('Connection lost — reload to reconnect.', this.canvas.width / 2, this.canvas.height / 2);
            this.ctx.restore();
        } else if (this.chunked) {
            // Expire the toast here (once per frame) rather than on a timer,
            // consistent with how the rest of Game drives state off the loop.
            if (this.toast && performance.now() >= this.toast.expiresAt) this.toast = null;
            // Expire finished blasts once per frame, on the same clock the
            // ring animation reads.
            const nowMs = performance.now();
            this.blasts = pruneBlasts(this.blasts, nowMs);
            this.vfx = pruneEffects(this.vfx, nowMs);
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
                merchants: this.merchants,
                landmarks: this.landmarks,
                shop: this.shop,
                shopOpen: this.shopOpen,
                shopView: this.shopView,
                banks: this.banks,
                bank: this.bank,
                bankOpen: this.bankOpen,
                bankView: this.bankView,
                decoTypes: this.decoTypes,
                toast: this.toast,
                blasts: this.blasts,
                vfx: this.vfx, vfxDefs: this.vfxDefs,
                // null whenever the equipped weapon needs no ammo — the HUD
                // then draws no ammo line at all.
                ammo: resolveAmmoHud(this.inventory),
                noAmmoFlash: nowMs < this.noAmmoUntil,
                // The local player's own effects, for the HUD line. The rings
                // at their feet come from this.player.effects via drawCreature.
                effects: this.player.effects || null,
            });
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

    // Hit-test the shop panel's buy/sell/close rects RenderSystem recorded
    // while drawing it (same convention as _handleInventoryClick above, read
    // from _shopHitAreas instead of _invHitAreas). Buy/sell just forward the
    // stock/item id to the server — the server re-validates gold, proximity,
    // and ownership; this click only expresses intent.
    _handleShopClick(cx, cy) {
        const hitAreas = (this.renderSystem && this.renderSystem._shopHitAreas) || [];
        const hit = hitAreas.find((a) => cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h);
        if (!hit) return;
        if (hit.kind === 'close') { this.shopOpen = false; return; }
        if (hit.kind === 'buy') { if (this.authorityClient) this.authorityClient.sendBuy(hit.id); return; }
        if (hit.kind === 'sell') { if (this.authorityClient) this.authorityClient.sendSell(hit.id); return; }
        // Pure view state — no server round-trip. `shoppage` carries the
        // absolute target page the rendered strip offered (never a delta), so
        // the selection cannot walk out of range.
        if (hit.kind === 'shoptab') { this.shopView = { tab: hit.id, page: 0 }; return; }
        if (hit.kind === 'shoppage') { this.shopView = { tab: this.shopView.tab, page: hit.id }; return; }
    }

    // SOMET-310 — the bank panel's counterpart to _handleShopClick, reading
    // _bankHitAreas. Deposit/withdraw forward an id and nothing else: the
    // server re-checks proximity, ownership and capacity, so this click
    // expresses intent only. `store` carries a player_items id, `take` an
    // account_items id -- different tables, hence two kinds rather than one
    // with a direction flag.
    _handleBankClick(cx, cy) {
        const hitAreas = (this.renderSystem && this.renderSystem._bankHitAreas) || [];
        const hit = hitAreas.find((a) => cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h);
        if (!hit) return;
        if (hit.kind === 'close') { this.bankOpen = false; return; }
        if (hit.kind === 'store') { if (this.authorityClient) this.authorityClient.sendDeposit(hit.id); return; }
        if (hit.kind === 'take') { if (this.authorityClient) this.authorityClient.sendWithdraw(hit.id); return; }
        if (hit.kind === 'banktab') { this.bankView = { tab: hit.id, page: 0 }; return; }
        if (hit.kind === 'bankpage') { this.bankView = { tab: this.bankView.tab, page: hit.id }; return; }
    }

    setupInput(){
        if (this._inputAttached) return;
        this._inputAttached = true;

        const CODE_TO_KEY = {
            KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
            KeyI: 'i', KeyE: 'e', KeyB: 'b', KeyG: 'g',
            KeyM: 'm', KeyT: 't', KeyC: 'c',
            ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright',
            Escape: 'escape',
        };

        this._keydownHandler = (e) => {
            const key = (e.key || '').toLowerCase();
            const codeKey = CODE_TO_KEY[e.code] || key;
            this.keys[key] = true;
            if (codeKey) this.keys[codeKey] = true;

            const isKey = (target) => key === target || codeKey === target;

            // Inventory / paper-doll toggle (replaces the retired number-key
            // weapon switch — equipping now goes through the panel). Gated on
            // !shopOpen so the two centred panels can never stack (the shop is
            // closed with 'e' or Escape first).
            if (isKey('i') && this.state === 'playing' && this.chunked && !e.repeat && !this.shopOpen && !this.bankOpen) {
                this.inventoryOpen = !this.inventoryOpen;
                if (!this.inventoryOpen) this.inventorySelectedItemId = null;
            }

            if (isKey('escape')) {
                console.log("Escape pressed, current state:", this.state);
                if (this.shopOpen) {
                    this.shopOpen = false;
                } else if (this.bankOpen) {
                    this.bankOpen = false;
                } else if(this.state === 'playing'){
                    this.pause();
                } else if(this.state === 'paused'){
                    this.resume();
                }
            }

            // Merchant interact (Slice D): 'e' either closes an already-open
            // shop panel or asks the server whether a merchant is in range
            if (isKey('e') && this.state === 'playing' && this.chunked && !e.repeat && !this.inventoryOpen && !this.bankOpen) {
                if (this.shopOpen) { this.shopOpen = false; return; }
                if (this.authorityClient) this.authorityClient.sendInteract();
                return;
            }

            // Account chest (SOMET-310): 'b' either closes an open bank panel
            // or asks the server whether a bank post is in range
            if (isKey('b') && this.state === 'playing' && this.chunked && !e.repeat && !this.inventoryOpen && !this.shopOpen) {
                if (this.bankOpen) { this.bankOpen = false; return; }
                if (this.authorityClient) this.authorityClient.sendOpenBank();
                return;
            }

            if (isKey('g') && this.state === 'playing' && this.chunked) {
                if (!e.repeat && this.authorityClient && !this.inventoryOpen && !this.bankOpen) this.authorityClient.sendPickup();
            }

            // Dev: cycle the global render-mode override (none -> rect -> static -> animated).
            // Moved to Shift+M so plain M can toggle the minimap HUD (handled in Minimap.jsx).
            if (isKey('m') && e.shiftKey && this.state === 'playing' && !e.repeat) {
                const mode = this.renderSystem.cycleRenderModeOverride();
                console.log(`Render-mode override: ${mode ?? 'off (per-entity)'}`);
            }

            // Dev: toggle tile textures on/off (falls back to flat color).
            // Moved to Shift+T so plain T can open the waypoint travel popup
            if (isKey('t') && e.shiftKey && this.renderSystem && this.chunked && !e.repeat) {
                const on = this.renderSystem.toggleTileTextures();
                this._showToast(`Tile textures ${on ? 'on' : 'off'}`);
            }
        };

        this._keyupHandler = (e) => {
            const key = (e.key || '').toLowerCase();
            const codeKey = CODE_TO_KEY[e.code] || key;
            this.keys[key] = false;
            if (codeKey) this.keys[codeKey] = false;
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
            // While a panel is open, clicks hit-test it and must NOT also
            // fire an attack. Shop is checked first — the two panels never
            // stack (see the 'e'/'i' key handlers above), but if they ever
            // did, an open shop should still consume the click.
            if (this.shopOpen) {
                this._handleShopClick(this._cursorX ?? 0, this._cursorY ?? 0);
                return;
            }
            if (this.bankOpen) {
                this._handleBankClick(this._cursorX ?? 0, this._cursorY ?? 0);
                return;
            }
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