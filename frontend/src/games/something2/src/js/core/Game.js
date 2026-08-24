import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";
import { fitCanvasBox } from "./canvasFit.js";
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
import { aimVector, cursorToWorld } from "./aim.js";
import { createInventory, applyJoined, applyEquipment, canEquipClient, typeOf, addItem, removeItem } from "./inventory.js";
import { resolveDrop } from '../systems/inventoryPanel.js';
import {
    buildTreeIndex, hitNodeAt, clampZoom, zoomAbout, DEFAULT_ZOOM,
} from '../systems/passiveTreePanel.js';
import {
    fetchPassiveTree, allocatePassive, respecPassives, fetchRespecQuote, fetchStartClass,
} from '../net/passiveTreeClient.js';
import { resolveAmmoHud, applyAmmoCount } from "./ammo.js";
import { chestsFromFrame, applyChestOpened } from "./worldChests.js";
import { addBlasts, pruneBlasts } from "./blasts.js";
import { indexEffects, addEffects, pruneEffects, capParticles } from "./vfx.js";
import { assetUrl } from "../net/assets.js";
import { shouldRepeatAttack, refusalStopsHold } from "./constantAttack.js";
import { authorityWsUrl } from "../net/authorityUrl.js";
import {
    emptyExtras, frameCarriesStats, mergeFrameStats, mergeSeedStats,
    mergeLevelInfo, buildCharacterView,
} from "./progressionExtras.js";
import { fetchProgression } from "../net/progressionClient.js";
import { API_URL } from "../../../../../config.js";

// How long the "out of ammo" HUD flash stays up after the server's `noammo`
// frame arrives.
const NO_AMMO_FLASH_MS = 600;

// Fallback weapon name shown when nothing is equipped in main_hand yet
// (mirrors the server's DEFAULT_WEAPON_NAME in authority/items.js).
const DEFAULT_WEAPON_NAME = "dagger";

// Native Map shadowed by the world Map import above; alias to keep the
// distinction obvious at the call sites.
const NativeMap = globalThis.Map;

// A press that never travels this far is a CLICK, not a drag. Without the
// threshold every click on a cell would arm a drag, and the select-then-click-
// a-slot flow the panel has always had would stop working.
const DRAG_THRESHOLD_PX = 4;

// SOMET-493: how long a clicked inspect target stays pinned once the cursor
// leaves it. Long enough to read three lines and two bars, short enough that a
// forgotten pin clears itself rather than becoming a card the player has to
// work out how to dismiss.
const INSPECT_PIN_MS = 6000;

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
        // SOMET-472. Set from the `joined` frame; false until then so a
        // pre-join frame draws the ordinary two-orb HUD.
        this.usesLifeCost = false;
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
        this.inventoryDrag = null;
        this.inventoryTab = 'all';
        this.inventoryPage = 0;

        // Ground items (Slice 3b-2b): render-only store of items on the
        // ground, plus a local mirror of the server-owned auto-loot flag.
        // SOMET-493 moved the toggle itself into the React Settings panel, so
        // this mirror is now read BY that panel (via getSettingsSnapshot)
        // rather than to label a canvas button -- the flag is still owned by
        // the server and still corrected by every `state` frame.
        this.groundItems = new GroundItemManager();
        this.autoLoot = false;

        // SOMET-493 -- inspect-on-hover. Off unless the player turns it on in
        // Settings; GameSettings.jsx owns the persisted preference and pushes
        // it here with setInspectEnabled, so localStorage is read in exactly
        // one place instead of by both halves of the app.
        this.inspectEnabled = false;
        // SOMET-494 -- "Constant attack". Same ownership as inspectEnabled:
        // GameSettings.jsx holds the persisted preference and pushes it here.
        this.constantAttack = false;
        // Whether the left button is currently down ON THE WORLD (a press that
        // opened a shop or hit a panel never sets it). Cleared by the release,
        // by losing focus, by the context menu, and by a resource refusal.
        this._attackHeld = false;
        this._lastAttackSentAt = 0;
        // A left-click PINS whatever the cursor was over, so the card survives
        // the pointer moving on. Kept as a key rather than an object: the
        // drawable is rebuilt every frame and a held reference would keep
        // describing a creature the server has already dropped.
        this._inspectPinnedKey = null;
        this._inspectPinnedUntil = 0;
        // The /api/map/config entityTypes map (name -> def), kept whole so the
        // card can read `prompt`/`mana`/`faction`/behaviour. decoTypes below
        // is a FILTERED copy for the renderer and deliberately excludes
        // creatures, so it cannot serve this.
        this.entityDefs = null;

        // World chests (SOMET-372) -- the guarded, lootable kind authored into
        // a map spec or spawned by a loot map, NOT the account chest/bank
        // above. Whole-list mirror of the server's AOI `chests` frame, exactly
        // like creatures and ground items: never reconciled as a delta, so a
        // chest that leaves the neighbourhood simply stops being sent.
        this.worldChests = [];

        // Wallet balance (Slice C, gold economy): server-owned, set from
        // `joined.gold` and kept live by `wallet` messages on pickup. Gold
        // never enters the inventory (see onPicked/onWallet below).
        this.gold = 0;

        // Progression (SOMET-242): the COMPOSED player_progression row (level,
        // experience, the six effective stats, and since SOMET-475 the
        // sources/modifiers/passivePoints/allocatedNodeIds composeStats
        // produced) -- set from `joined.progression` and refreshed by
        // `progression` push messages (kill XP, level-up, death, allocate,
        // respec). null until the first join lands. EXACTLY ONE WRITER: the
        // onProgression handler in initChunked. The inventory panel's Character
        // tab and the passive-tree overlay are its readers, and both read it
        // rather than caching a copy -- see core/progressionExtras.js.
        this.progression = null;

        // The handful of fields the progression row does NOT carry: the derived
        // stat bundle (which rides the socket frame beside the row but not the
        // join frame) and the server's own xpFloor/xpToNext/respecCost. Never
        // computed here -- see progressionExtras.js's header for both rules.
        this.progressionExtras = emptyExtras();
        // Latched true the first time a websocket frame carries the derived
        // bundle, after which the HTTP seed may no longer write it (the F1
        // race).
        this._statsFromSocket = false;
        this._progressionBundleBusy = false;
        // The Character tab's own paging state, beside inventoryTab/Page.
        this.characterModPage = 0;
        // Class identity for the Character tab's header and its strong/weak
        // tie-break. Supplied by GameShell from the resolved activeCharacter
        // rather than the wire: listCharacters already sends both.
        this.className = null;
        this.mainStat = null;

        // Merchant + shop (Slice D): `merchants` is the join-time list of
        // village merchant markers to render; `shop` is the catalog/buyback
        // snapshot from the last `shop` message (null when no shop is open),
        // and `shopOpen` gates the panel render/input independently of
        // `shop` itself staying populated across a close/reopen.
        this.merchants = [];
        // SOMET-297. Empty until a `joined` frame arrives, and reset here on
        // the same line merchants is -- both are per-world join payload.
        this.landmarks = [];
        this.doorways = [];
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

        // Passive tree overlay (SOMET-476). `passiveTree` is the immutable
        // graph, fetched ONCE on the first open; `passiveIndex` is its spatial
        // index, rebuilt only when the graph itself changes. The ALLOCATED SET
        // is NOT stored here -- it lives on this.progression, whose single
        // writer is the onProgression handler above (see progressionExtras.js's
        // F1 header for the cross-channel race that rule exists to prevent).
        this.passiveTree = null;
        this.passiveIndex = null;
        this.passiveTreeOpen = false;
        this.passiveStartClass = null;
        this.passiveView = { panX: GAME_WIDTH / 2, panY: GAME_HEIGHT / 2, zoom: DEFAULT_ZOOM };
        this.passiveDrag = null;
        // Contract §6.4. The COST is the server's number, refetched on every
        // open; it is never recomputed from respec_base_gold x level here,
        // which is the drift systems/characterTab.js's F2 rule records.
        this.passiveRespecCost = null;
        this.passiveGold = null;
        this.passiveRespecBusy = false;

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

    async initChunked({ worldId, characterId, chunkSize, tileTypes, vfxEffects = null, entityTypes = null, spawnX = 0, spawnY = 0, className = null, mainStat = null }) {
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
        this._disconnectCanvasContainerObserver();
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
        this.entityDefs = entityTypes || null;
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
        this.inventoryDrag = null;
        this.inventoryTab = 'all';
        this.inventoryPage = 0;
        this.groundItems = new GroundItemManager();
        this.autoLoot = false;
        // SOMET-494. The SETTING survives a join (it is the player's, not the
        // world's); the in-flight hold does not. Walking through a doorway
        // re-inits the world, and arriving in a new one already swinging --
        // off a button press made in the previous one -- is not something the
        // player asked for.
        this._attackHeld = false;
        this._lastAttackSentAt = 0;
        // SOMET-372. Cleared on join for the same reason merchants/landmarks
        // are: the first `chests` frame of the new world may be a few ticks
        // out, and until it lands the previous world's chests would otherwise
        // still be drawn -- in the new world's coordinates.
        this.worldChests = [];
        this.gold = 0;
        this.progression = null;
        // Reset alongside the row they describe: a stale derived bundle or a
        // stale xpFloor from the previous world would be read against the new
        // world's row for however long it takes the first frame to land.
        this.progressionExtras = emptyExtras();
        this._statsFromSocket = false;
        this.characterModPage = 0;
        this.className = className;
        this.mainStat = mainStat;
        this.merchants = [];
        // SOMET-297. Empty until a `joined` frame arrives, and reset here on
        // the same line merchants is -- both are per-world join payload.
        this.landmarks = [];
        this.doorways = [];
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
        // SOMET-476. The GRAPH is world-independent and deliberately survives a
        // join (it is ~1800 rows and identical everywhere), but the open state,
        // the pan and any in-flight drag belong to the world being left.
        this.passiveTreeOpen = false;
        this.passiveDrag = null;
        this.passiveRespecBusy = false;

        this._inputBuffer = [];
        // Connect to the authoritative sim; spawn comes from the server. The
        // token comes from the login the player already completed (stored in
        // localStorage + memory); user_id is read off the token's own claims.
        const token = getStoredToken();
        if (!token) throw new Error('not signed in');
        const claims = parseJwt(token);
        if (!claims || claims.user_id == null) throw new Error('invalid session token');
        this.localUserId = String(claims.user_id);
        const wsUrl = authorityWsUrl(API_URL, window.location);
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
                    this.landmarks = Array.isArray(msg.landmarks) ? msg.landmarks : [];
                    this.doorways = Array.isArray(msg.doorways) ? msg.doorways : [];
                    this.banks = Array.isArray(msg.banks) ? msg.banks : [];
                    this.progression = msg.progression || null;
                    // SOMET-472 -- a Cultist pays every mana cost in HP, so
                    // the mana orb would be a bar that never moves. Server-
                    // supplied, never inferred from the class name here: the
                    // client has no class catalog.
                    this.usesLifeCost = msg.usesLifeCost === true;
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
                // Kill XP / level-up / death / allocate / respec pushes. The
                // whole body is Game._applyProgressionFrame -- see there.
                onProgression: (msg) => this._applyProgressionFrame(msg),
                // SOMET-372. Both handlers are one line each on purpose: the
                // rules they carry (whole-list replacement, and the item-shape
                // mapping openChest needs) live in core/worldChests.js, where
                // they can be tested without a canvas.
                onChests: (msg) => { this.worldChests = chestsFromFrame(msg); },
                onChestOpened: (msg) => this._showToast(applyChestOpened(this.inventory, this.worldChests, msg)),
                // SOMET-482 -- a standalone presentation frame (today: the puff
                // a ground item leaves when its lifetime runs out). It goes
                // through the SAME addEffects/capParticles/pruneEffects path as
                // attacks and impacts rather than a parallel list, so the
                // lifetime and particle budget cannot drift between the two.
                onVfx: (msg) => {
                    if (!msg || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
                    addEffects(this.vfx, [{ v: msg.name, x: msg.x, y: msg.y }],
                               performance.now(), this.vfxDefs);
                    // Same budget the impacts path enforces the moment the list
                    // grows -- a crowded floor expiring at once is exactly when
                    // it would blow.
                    this.vfx = capParticles(this.vfx);
                },
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
                    // SOMET-494: an empty quiver is "the thing the attack
                    // depends on ran out" exactly as much as an empty mana
                    // pool is, so it ends a held attack too. It arrives on its
                    // own frame rather than through `attackrefused` because
                    // ammo is refused later, after the spend, and carries the
                    // item type the HUD has to zero.
                    this._stopConstantAttack();
                },
                onAttackRefused: (msg) => this._onAttackRefused(msg),
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
            doorways: this.doorways || [],
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

    // SOMET-483. One HTTP read of GET /api/progression, fired when the
    // Character tab is opened and again when the level actually changes.
    //
    // It writes ONLY progressionExtras -- never this.progression, which would
    // reintroduce the F1 race applyGoldResult's comment below describes. The
    // derived-`stats` half is additionally latched off once a socket frame has
    // carried it (mergeSeedStats), so a late response can never overwrite a
    // newer push. xpFloor/xpToNext/respecCost have no websocket sender at all,
    // so they are applied unconditionally.
    //
    // `_progressionBundleBusy` is a single-flight guard, not a cache: clicking
    // the tab five times must not issue five requests, but the sixth click
    // after the first settles must still refresh.
    // The websocket `progression` frame's whole effect. A METHOD rather than a
    // closure inside initChunked because the latch below is a rule, and a rule
    // buried in a closure that needs a live websocket to reach is a rule
    // nothing tests -- which is how this epic shipped nine features that were
    // live in the database and inert in play.
    //
    // This is still the SINGLE writer of this.progression: an unconditional
    // overwrite on the one channel that has a real ordering guarantee (see
    // progressionExtras.js's header, and applyGoldResult's below).
    //
    // The derived bundle rides the same frame (contract §6.3) and latches the
    // HTTP seed off once it has. A level change triggers ONE targeted refetch
    // of the level-dependent xpFloor/xpToNext/respecCost -- a level-up is a
    // real event, not the no-op push the original sheet was required not to
    // refetch on.
    _applyProgressionFrame(msg) {
        if (!msg || !msg.progression) return;
        const prevLevel = this.progression ? this.progression.level : null;
        this.progression = msg.progression;
        if (frameCarriesStats(msg)) {
            this.progressionExtras = mergeFrameStats(this.progressionExtras, msg);
            this._statsFromSocket = true;
        }
        if (msg.progression.level !== prevLevel) this._refreshProgressionBundle();
    }

    _refreshProgressionBundle() {
        if (this._progressionBundleBusy) return;
        this._progressionBundleBusy = true;
        fetchProgression()
            .then((bundle) => {
                if (!bundle) return;
                this.progressionExtras = mergeLevelInfo(this.progressionExtras, bundle);
                this.progressionExtras = mergeSeedStats(
                    this.progressionExtras, bundle, this._statsFromSocket,
                );
            })
            .catch(() => { /* the next tab-open or level-up retries */ })
            .finally(() => { this._progressionBundleBusy = false; });
    }

    // Everything the Character pane renders, assembled fresh each frame from
    // the single-writer row plus the extras above. Not cached: a kill that
    // levels the player up must move the bar on the very next frame.
    characterView() {
        return buildCharacterView({
            progression: this.progression,
            extras: this.progressionExtras,
            className: this.className,
            mainStat: this.mainStat,
        });
    }

    // SOMET-493 -- the in-game Settings panel's read side, following the same
    // convention as getMinimapSnapshot/getProgressionSnapshot above: React
    // polls Game rather than reaching into engine internals, so there is one
    // source of truth for what the settings currently are.
    //
    // `autoLoot` is the SERVER's value (every `state` frame overwrites it), so
    // a panel rendering from this snapshot cannot show a flip the server never
    // agreed to. `inspect` is a pure client preference and is simply mirrored.
    // null when not in a playing world -- the panel then shows its controls
    // disabled rather than lying about a world it is not in.
    getSettingsSnapshot() {
        if (this.state !== 'playing' || !this.chunked) return null;
        return {
            autoLoot: this.autoLoot === true,
            inspect: this.inspectEnabled === true,
            constantAttack: this.constantAttack === true,
        };
    }

    // Ask the server to turn auto-loot on/off. Returns whether the intent
    // actually went out: on a dead socket the send is silently dropped and no
    // later `state` frame can correct us, so an unconditional local flip would
    // leave the UI reading a value the server never agreed to -- the exact
    // failure this flag's wire echo exists to prevent. The optimistic local
    // mirror is kept (the panel would otherwise not move until the next state
    // frame) but only on a send that left.
    setAutoLoot(on) {
        const want = on === true;
        if (!this.authorityClient) return false;
        if (!this.authorityClient.sendAutoLoot(want)) return false;
        this.autoLoot = want;
        return true;
    }

    // SOMET-494 -- send an attack toward wherever the cursor is NOW.
    //
    // The aim is recomputed per send rather than captured at mousedown, so a
    // held attack follows the pointer: swinging at where the cursor was a
    // second ago is not what "hold to keep attacking" means to anyone.
    _sendAttackAtCursor() {
        if (!this.authorityClient || !this.camera) return;
        const pcx = this.player.x + this.player.width / 2;
        const pcy = this.player.y + this.player.height / 2;
        const { nx, ny } = aimVector(
            this._cursorX ?? this.canvas.width / 2,
            this._cursorY ?? this.canvas.height / 2,
            this.camera, pcx, pcy,
        );
        this.authorityClient.sendAttack(nx, ny);
        this._lastAttackSentAt = performance.now();
    }

    // True while any full-screen panel owns the cursor. The same three panels
    // RenderSystem suppresses the inspect card for -- it computes that from
    // the render params it is handed rather than calling this, since it must
    // answer for the frame it is drawing, not for the tick that follows.
    _anyPanelOpen() {
        return this.inventoryOpen === true || this.shopOpen === true || this.bankOpen === true
            || this.passiveTreeOpen === true;
    }

    // One repeat step, called from update(). Everything it decides lives in
    // core/constantAttack.js so the conditions can be asserted directly --
    // a stuck hold is an input bug no screenshot shows and no player can undo
    // without reloading.
    _tickConstantAttack() {
        if (!this._attackHeld) return;
        // A panel opening ENDS the hold rather than merely pausing it. Pausing
        // would resume swinging the moment the panel closed, off a button
        // press the player made before they went shopping.
        if (this._anyPanelOpen()) { this._attackHeld = false; return; }
        const should = shouldRepeatAttack({
            enabled: this.constantAttack === true,
            held: true,
            playing: this.state === 'playing' && !!this.chunked && !!this.authorityClient,
            panelOpen: false,
            lastSentAt: this._lastAttackSentAt,
        }, performance.now());
        if (should) this._sendAttackAtCursor();
    }

    // The server refused an attack. Only a refusal the player cannot wait out
    // ends the hold -- see refusalStopsHold for why a cooldown refusal must
    // not, and why a shock interrupt must not either.
    _onAttackRefused(msg) {
        if (refusalStopsHold(msg && msg.reason)) this._stopConstantAttack();
    }

    // Ends a held attack. Public-ish because two different server frames reach
    // it (`attackrefused` and `noammo`) and both mean the same thing to the
    // player: you have run out, so the character stops.
    _stopConstantAttack() {
        this._attackHeld = false;
    }

    // Purely local: no server involvement, so unlike setAutoLoot this always
    // takes. Turning it OFF drops any pinned target too, or the card would
    // hang on screen until the pin expired.
    setInspectEnabled(on) {
        this.inspectEnabled = on === true;
        if (!this.inspectEnabled) {
            this._inspectPinnedKey = null;
            this._inspectPinnedUntil = 0;
        }
        return this.inspectEnabled;
    }

    // SOMET-494. Also local. Turning it OFF drops any hold in progress, so the
    // character stops swinging the instant the box is unticked rather than
    // when the player happens to let go.
    setConstantAttack(on) {
        this.constantAttack = on === true;
        if (!this.constantAttack) this._attackHeld = false;
        return this.constantAttack;
    }

    // Write-through cache update for gold ONLY (SOMET-242 D1 fix, narrowed by
    // the F1 fix below). The passive-tree overlay's respec calls this right
    // after a successful respec HTTP response so the canvas-drawn gold HUD
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
    // too, through that same ordered channel). See progressionExtras.js's
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
        this._disconnectCanvasContainerObserver();
        if (this._keydownHandler) window.removeEventListener('keydown', this._keydownHandler);
        if (this._keyupHandler) window.removeEventListener('keyup', this._keyupHandler);
        if (this._contextMenuHandler) window.removeEventListener('contextmenu', this._contextMenuHandler);
        if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);
        if (this._mouseMoveHandler) this.canvas.removeEventListener('mousemove', this._mouseMoveHandler);
        if (this._mouseDownHandler) this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
        if (this._mouseUpHandler) this.canvas.removeEventListener('mouseup', this._mouseUpHandler);
        if (this._windowMouseUpHandler) window.removeEventListener('mouseup', this._windowMouseUpHandler);
        if (this._wheelHandler) this.canvas.removeEventListener('wheel', this._wheelHandler);
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
            this._tickConstantAttack();
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
                // The mana ORB is hidden outright, not fed a null pool: an
                // empty blue orb reads as "out of mana", which is the opposite
                // of the truth for a class that never spends it.
                showMana: !this.usesLifeCost,
                stamina: this.localStamina,
                maxStamina: this.localMaxStamina,
                weaponName: this._resolveWeaponName(),
                inventory: this.inventory,
                inventoryOpen: this.inventoryOpen,
                selectedItemId: this.inventorySelectedItemId,
                inventoryView: {
                    tab: this.inventoryTab,
                    page: this.inventoryPage,
                    gold: this.gold,
                    drag: this.inventoryDrag,
                    hoverX: this._cursorX ?? null,
                    hoverY: this._cursorY ?? null,
                    // SOMET-483. Built fresh, never cached -- see characterView.
                    character: this.characterView(),
                    modPage: this.characterModPage,
                },
                groundItems: this.groundItems.all(),
                worldChests: this.worldChests,
                gold: this.gold,
                merchants: this.merchants,
                landmarks: this.landmarks,
                doorways: this.doorways,
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
                progression: this.progression,
                // SOMET-476 — the passive-tree overlay. Every field here is
                // read straight off the single-writer progression row rather
                // than cached anywhere: a kill that levels the player up must
                // open new nodes on the very next frame.
                passiveTreeOpen: this.passiveTreeOpen,
                passiveIndex: this.passiveIndex,
                passiveView: this.passiveView,
                allocatedNodeIds: (this.progression && this.progression.allocatedNodeIds) || [],
                passivePoints: (this.progression && this.progression.passivePoints) || 0,
                startNodeId: this._passiveStartNodeId(),
                // Contract §6.4. `passiveRespecCost` is the SERVER's number; a
                // null keeps the button disabled rather than guessing one.
                passiveRespecCost: this.passiveRespecCost,
                passiveRespecBusy: this.passiveRespecBusy,
                passiveHoverX: this.passiveTreeOpen ? (this._cursorX ?? null) : null,
                passiveHoverY: this.passiveTreeOpen ? (this._cursorY ?? null) : null,
                // SOMET-493. `enabled` false short-circuits the whole pass in
                // RenderSystem, so a player who never turns it on pays one
                // property read per frame.
                inspect: {
                    enabled: this.inspectEnabled === true,
                    camera: this.camera,
                    cursorX: this._cursorX ?? null,
                    cursorY: this._cursorY ?? null,
                    pinnedKey: nowMs < this._inspectPinnedUntil ? this._inspectPinnedKey : null,
                    entityDefs: this.entityDefs,
                    itemTypes: this.inventory ? this.inventory.types : null,
                    localPlayer: { mana: this.localMana, maxMana: this.localMaxMana },
                },
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

    // The ONE way the inventory panel closes. Escape, the panel's [X] and the
    // 'i' toggle all land here so they cannot drift: an in-flight drag that
    // outlived its panel would otherwise resolve against a layout that is no
    // longer on screen.
    // Canvas-pixel position of a mouse event. mousedown/mouseup use this
    // rather than the last _cursorX/_cursorY, so a press is located by its own
    // event: a browser always sends a mousemove first, but depending on that
    // makes the press silently wrong whenever it does not.
    _canvasPoint(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (this.canvas.width / rect.width),
            y: (e.clientY - rect.top) * (this.canvas.height / rect.height),
        };
    }

    closeInventory() {
        this.inventoryOpen = false;
        this.inventorySelectedItemId = null;
        this.inventoryDrag = null;
    }

    // The ONE way the passive tree opens, for the same reason closeInventory
    // is the one way the inventory closes: the P toggle is the only caller
    // today, but the fetch/centre pair must not be duplicated at a second one.
    openPassiveTree() {
        this.passiveTreeOpen = true;
        // Recentred on every open: a player who panned into a far sector last
        // time should not reopen to an empty screen with no idea which way
        // home is.
        this.passiveView = { panX: GAME_WIDTH / 2, panY: GAME_HEIGHT / 2, zoom: DEFAULT_ZOOM };
        if (!this.passiveTree) {
            fetchPassiveTree()
                .then((tree) => {
                    this.passiveTree = tree;
                    this.passiveIndex = buildTreeIndex(tree);
                })
                .catch((err) => this._showToast(err.message));
        }
        if (this.passiveStartClass == null) {
            fetchStartClass()
                .then((name) => { this.passiveStartClass = name; })
                .catch(() => { this.passiveStartClass = null; });
        }
        this._refreshRespecQuote();
    }

    // The ONE way it closes. Escape, the panel's [X] and the 'p' toggle all
    // land here so an in-flight PAN that outlived its panel cannot resolve
    // against a layout that is no longer on screen -- the same hazard
    // closeInventory's header describes for an in-flight drag.
    closePassiveTree() {
        this.passiveTreeOpen = false;
        this.passiveDrag = null;
    }

    // Contract §6.4's affordability inputs, refetched rather than cached with
    // the graph: the cost is respec_base_gold x LEVEL and the player levels up
    // mid-session. Failure leaves the cost null, which respecDisabled reads as
    // "disabled", never as "free".
    _refreshRespecQuote() {
        return fetchRespecQuote()
            .then((q) => {
                this.passiveRespecCost = q.respecCost;
                this.passiveGold = q.gold;
            })
            .catch(() => { this.passiveRespecCost = null; });
    }

    // A press inside the open tree. Either it lands on a chrome control (the
    // [X], the respec button) and is consumed here, or it ARMS a pan -- and
    // whether that was a pan or a click on a node is decided on mouseup by
    // `moved`, exactly as the inventory drag decides between a drag and a click.
    _handlePassivePress(x, y) {
        const layout = this.renderSystem && this.renderSystem._passiveLayout;
        if (layout) {
            const hit = layout.hitAreas.find(
                (a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h
                    && (a.kind === 'passiveclose' || a.kind === 'passiverespec'),
            );
            if (hit && hit.kind === 'passiveclose') { this.closePassiveTree(); return; }
            if (hit && hit.kind === 'passiverespec') {
                // The hit area exists ONLY while the button is enabled
                // (layoutPassiveTree publishes it conditionally), so there is
                // no second affordability check here to drift from the first.
                this.passiveRespecBusy = true;
                respecPassives()
                    .then(({ gold }) => {
                        // gold ONLY. The progression comes back over the
                        // ordered websocket frame; applying the HTTP body here
                        // would be the second writer F1 removed.
                        if (Number.isFinite(gold)) this.gold = gold;
                        return this._refreshRespecQuote();
                    })
                    .catch((err) => this._showToast(err.message))
                    .finally(() => { this.passiveRespecBusy = false; });
                return;
            }
        }
        this.passiveDrag = { startX: x, startY: y, lastX: x, lastY: y, moved: false };
    }

    // A press that never travelled: resolve it against the node circles of the
    // frame the player was actually looking at.
    _handlePassiveClick(x, y) {
        const layout = this.renderSystem && this.renderSystem._passiveLayout;
        if (!layout) return;
        const node = hitNodeAt(layout, x, y);
        // A LOCKED node is not clickable. The server refuses it too
        // (passiveRules.isAllocatable), so this is an affordance, not a gate --
        // but firing the request anyway would toast a refusal on every stray
        // click in the tree.
        if (!node || node.state !== 'allocatable') return;
        // Fire and forget. The success body is discarded on purpose: the
        // server's ordered `progression` websocket frame is the ONLY writer of
        // this.progression (see the onProgression handler above and
        // core/progressionExtras.js's F1 header).
        allocatePassive(node.id).catch((err) => this._showToast(err.message));
    }

    // The client's copy of the server's class -> start-node lookup, used ONLY
    // to decide which nodes to DRAW as reachable. passiveTreeStore's
    // startNodeIdFor resolves it again on every allocate and is the only thing
    // that authorizes one. A class with no start node returns null and nothing
    // is drawn allocatable, rather than defaulting into another class's sector.
    _passiveStartNodeId() {
        if (!this.passiveTree || !this.passiveStartClass) return null;
        const start = this.passiveTree.nodes.find((n) => n.start_class === this.passiveStartClass);
        return start ? start.id : null;
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

        if (hit.kind === 'invclose') { this.closeInventory(); return; }
        if (hit.kind === 'invtab') {
            // Page resets with the tab: page 3 of All is very likely past the
            // end of Stones, and the layout would clamp it to 0 anyway — doing
            // it here keeps the state and the render agreeing. The Character
            // tab's own modifier page resets for the same reason.
            this.inventoryTab = hit.id;
            this.inventoryPage = 0;
            this.characterModPage = 0;
            if (hit.id === 'character') this._refreshProgressionBundle();
            return;
        }
        if (hit.kind === 'invpage') { this.inventoryPage = hit.id; return; }
        if (hit.kind === 'charmodpage') { this.characterModPage = hit.id; return; }

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
            KeyF: 'f', KeyM: 'm', KeyT: 't', KeyC: 'c',
            KeyR: 'r', KeyQ: 'q', KeyP: 'p', Space: ' ',
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
            if (isKey('i') && this.state === 'playing' && this.chunked && !e.repeat && !this.shopOpen && !this.bankOpen
                && !this.passiveTreeOpen) {
                if (this.inventoryOpen) this.closeInventory();
                else this.inventoryOpen = true;
            }

            // Character sheet (SOMET-483): C opens the inventory panel on its
            // Character tab. The standalone popup this key used to toggle is
            // deleted -- the key is REUSED rather than retired so the player's
            // muscle memory survives, and hotkeyRegistry.test.js pins that
            // nothing else claims it. Same gates as 'i', so the two centred
            // panels can never stack.
            //
            // Pressing it while the panel is already open on ANOTHER tab
            // switches to Character rather than closing: "show me my character"
            // is the intent, and a close would make the key's effect depend on
            // which tab happened to be showing.
            if (isKey('c') && this.state === 'playing' && this.chunked && !e.repeat
                && !this.shopOpen && !this.bankOpen && !this.passiveTreeOpen) {
                if (this.inventoryOpen && this.inventoryTab === 'character') {
                    this.closeInventory();
                } else {
                    this.inventoryOpen = true;
                    this.inventoryTab = 'character';
                    this.inventoryPage = 0;
                    this.characterModPage = 0;
                    this._refreshProgressionBundle();
                }
            }

            // Passive tree (SOMET-476). Gated on the other three panels being
            // closed for the same reason the 'i' binding is: two centred
            // panels must never stack. The graph is ~1800 nodes and never
            // changes during a session, so it is fetched once, lazily, on the
            // first open rather than on join.
            if (isKey('p') && this.state === 'playing' && this.chunked && !e.repeat
                && !this.inventoryOpen && !this.shopOpen && !this.bankOpen) {
                if (this.passiveTreeOpen) { this.closePassiveTree(); return; }
                this.openPassiveTree();
                return;
            }

            if (isKey('escape')) {
                if (typeof e.preventDefault === 'function') e.preventDefault();
                console.log("Escape pressed, current state:", this.state);
                if (this.shopOpen) {
                    this.shopOpen = false;
                } else if (this.bankOpen) {
                    this.bankOpen = false;
                } else if (this.passiveTreeOpen) {
                    this.closePassiveTree();
                } else if (this.inventoryOpen) {
                    this.closeInventory();
                }
            }

            // ONE INTENT PER KEY, and range is always the AUTHORITY's call.
            //
            // SOMET-471: a "universal interact" key that picked the NEAREST of
            // merchant/bank/chest client-side made the loser unreachable. The
            // bank post is derived one tile from the merchant post
            // (backend/src/services/mapService.js villageBankPost), and the
            // entry village's spawn point is 82px from the bank against 113px
            // from the merchant -- both inside the authority's INTERACT_RADIUS
            // of 120, but "nearest wins" ate every merchant press, so the shop
            // could not be opened at all. The authority resolves the two posts
            // with two SEPARATE proximity picks for exactly this reason; see
            // nearestBankVillage's header in backend/src/authority/server.js.
            //
            // Each key therefore NAMES the interaction it wants and the server
            // decides whether anything of that kind is in range; a refusal
            // comes back as an `error` frame and is already toasted. Keeping
            // the radius out of the client is also what stops a second copy of
            // INTERACT_RADIUS from drifting from the first.

            // Merchant shop ('e'): closes an open shop, or asks the server
            // whether a merchant is in range.
            if (isKey('e') && this.state === 'playing' && this.chunked && !e.repeat && !this.inventoryOpen && !this.bankOpen) {
                if (this.shopOpen) { this.shopOpen = false; return; }
                if (this.authorityClient) this.authorityClient.sendInteract();
                return;
            }

            // Account chest (SOMET-310) ('b'): closes an open bank panel, or
            // asks the server whether a bank post is in range.
            if (isKey('b') && this.state === 'playing' && this.chunked && !e.repeat && !this.inventoryOpen && !this.shopOpen) {
                if (this.bankOpen) { this.bankOpen = false; return; }
                if (this.authorityClient) this.authorityClient.sendOpenBank();
                return;
            }

            // World chest (SOMET-372) ('f'): asks the server to open the
            // nearest chest. Its own key rather than a smarter 'e' -- see the
            // block comment above.
            if (isKey('f') && this.state === 'playing' && this.chunked && !e.repeat
                && !this.inventoryOpen && !this.shopOpen && !this.bankOpen) {
                if (this.authorityClient) this.authorityClient.sendOpenChest();
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

        // Both of these also drop a held attack (SOMET-494). A right-click or a
        // tab-away never produces the mouseup that would otherwise end the
        // hold, and a stuck auto-attack is not something a player can undo
        // without reloading -- the same reason both already clear this.keys.
        this._contextMenuHandler = () => {
            this.keys = {};
            this._attackHeld = false;
        };

        this._blurHandler = () => {
            this.keys = {};
            this._attackHeld = false;
        };

        // Mouse aim (Slice 3b): track cursor canvas-px position, and on
        // left-click compute the aim vector toward it and send an attack.
        this._mouseMoveHandler = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this._cursorX = (e.clientX - rect.left) * (this.canvas.width / rect.width);
            this._cursorY = (e.clientY - rect.top) * (this.canvas.height / rect.height);
            if (this.inventoryDrag) {
                this.inventoryDrag.x = this._cursorX;
                this.inventoryDrag.y = this._cursorY;
                const dx = this._cursorX - this.inventoryDrag.startX;
                const dy = this._cursorY - this.inventoryDrag.startY;
                if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) this.inventoryDrag.armed = true;
            }
            if (this.passiveDrag) {
                // Pan by the DELTA since the last move, not from the press
                // origin: accumulating from the origin re-applies the whole
                // offset every frame and the tree shoots off screen.
                this.passiveView = {
                    ...this.passiveView,
                    panX: this.passiveView.panX + (this._cursorX - this.passiveDrag.lastX),
                    panY: this.passiveView.panY + (this._cursorY - this.passiveDrag.lastY),
                };
                this.passiveDrag.lastX = this._cursorX;
                this.passiveDrag.lastY = this._cursorY;
                const dx = this._cursorX - this.passiveDrag.startX;
                const dy = this._cursorY - this.passiveDrag.startY;
                if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) this.passiveDrag.moved = true;
            }
        };
        this._mouseDownHandler = (e) => {
            if (e.button !== 0) return;
            if (this.state !== 'playing' || !this.chunked || !this.authorityClient) return;
            // Locate the press by its own event and keep the tracked cursor in
            // step, so every path below (panel hit-tests and the attack aim)
            // reads the same point.
            const pt = this._canvasPoint(e);
            this._cursorX = pt.x;
            this._cursorY = pt.y;
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
            if (this.passiveTreeOpen) {
                this._handlePassivePress(this._cursorX ?? 0, this._cursorY ?? 0);
                return;
            }
            if (this.inventoryOpen) {
                const x = this._cursorX ?? 0, y = this._cursorY ?? 0;
                const areas = (this.renderSystem && this.renderSystem._invHitAreas) || [];
                const hit = areas.find((a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h);
                // A press on a cell or a slot is a drag CANDIDATE: it arms only
                // once the pointer travels, and if it never does, mouseup
                // issues the click it would otherwise have been.
                if (hit && (hit.kind === 'item' || hit.kind === 'slot')) {
                    const itemId = hit.kind === 'item' ? hit.id : (this.inventory.equipment[hit.id] ?? null);
                    this.inventoryDrag = {
                        itemId, from: { kind: hit.kind, id: hit.id },
                        x, y, startX: x, startY: y, armed: false,
                    };
                    return;
                }
                this._handleInventoryClick(x, y);
                return;
            }
            // SOMET-493 -- clicking an entity PINS its inspect card, so the
            // card can be read without holding the mouse perfectly still. This
            // is deliberately additive and never consumes the click: the same
            // press still opens a merchant or swings the weapon below. It sits
            // after the panel branches above (which all return) because a
            // click on an open panel is not a click on the world.
            //
            // `_inspectHoverKey` is what the LAST rendered frame decided was
            // under the cursor, not a fresh hit-test: re-testing here would
            // need its own copy of the drawables list and could disagree with
            // what the player actually saw.
            if (this.inspectEnabled) {
                const key = this.renderSystem ? this.renderSystem._inspectHoverKey : null;
                // Clicking empty ground clears the pin -- that is how a player
                // dismisses a card without waiting it out.
                this._inspectPinnedKey = key;
                this._inspectPinnedUntil = key ? performance.now() + INSPECT_PIN_MS : 0;
            }

            const pcx = this.player.x + this.player.width / 2;
            const pcy = this.player.y + this.player.height / 2;

            // Direct click on a world interactable (merchant, bank, chest).
            //
            // Unlike a key, a click carries WHICH ONE in the gesture itself --
            // the player pointed at a specific marker -- so choosing a kind
            // here is not the guess the keys must never make. The two radii do
            // different jobs and neither is a copy of the server's range rule:
            // MARKER_CLICK_R is a hit-test ("did they point at this marker?"),
            // and INTERACT_CLICK_R only decides whether the click is spent on
            // an interaction or on an attack, so it is deliberately TIGHTER
            // than the authority's INTERACT_RADIUS (120) -- same reasoning as
            // RenderSystem's WORLD_CHEST_PROMPT_R. A click on a marker the
            // player is nowhere near stays an attack rather than becoming a
            // frame the server would only refuse.
            const MARKER_CLICK_R = 50;
            const INTERACT_CLICK_R = 110;
            if (this.camera) {
                const w = cursorToWorld(this._cursorX ?? this.canvas.width / 2, this._cursorY ?? this.canvas.height / 2, this.camera);
                const pointedAt = (t) => Math.hypot(t.x - w.x, t.y - w.y) <= MARKER_CLICK_R
                    && Math.hypot(t.x - pcx, t.y - pcy) <= INTERACT_CLICK_R;
                for (const m of (Array.isArray(this.merchants) ? this.merchants : [])) {
                    if (pointedAt(m)) { this.authorityClient.sendInteract(); return; }
                }
                for (const b of (Array.isArray(this.banks) ? this.banks : [])) {
                    if (pointedAt(b)) { this.authorityClient.sendOpenBank(); return; }
                }
                for (const c of (Array.isArray(this.worldChests) ? this.worldChests : [])) {
                    if (pointedAt(c)) { this.authorityClient.sendOpenChest(); return; }
                }
            }

            // SOMET-494: reaching here means the press was NOT spent on a
            // panel, a merchant, a bank or a chest -- every one of those
            // returned above. So this is the one place a press becomes an
            // attack, and therefore the one place a hold may start.
            this._attackHeld = true;
            this._sendAttackAtCursor();
        };

        // SOMET-494. Releasing over the HUD, the sidebar or outside the window
        // never fires the canvas's own mouseup, so the hold would survive a
        // release the player has already made. Registered on `window` for that
        // reason and kept deliberately separate from _mouseUpHandler below,
        // which owns inventory-drag resolution and must stay canvas-scoped.
        this._windowMouseUpHandler = (e) => {
            if (e.button === 0) this._attackHeld = false;
        };

        this._mouseUpHandler = (e) => {
            if (e.button !== 0) return;
            if (this.passiveDrag) {
                const pan = this.passiveDrag;
                this.passiveDrag = null;
                // It travelled: that was a pan, not a click on a node.
                if (pan.moved) return;
                // The panel closed while the button was down (Escape, a world
                // change): there is no layout left to resolve against.
                if (!this.passiveTreeOpen) return;
                this._handlePassiveClick(pan.startX, pan.startY);
                return;
            }
            const drag = this.inventoryDrag;
            if (!drag) return;
            this.inventoryDrag = null;
            // The panel closed while the button was down (Escape, a world
            // change): there is no layout left on screen to resolve against,
            // so the gesture is simply dropped.
            if (!this.inventoryOpen) return;
            const { x, y } = this._canvasPoint(e);

            if (!drag.armed) {
                // Never travelled: this was a click all along.
                this._handleInventoryClick(drag.startX, drag.startY);
                return;
            }
            const layout = this.renderSystem && this.renderSystem._invLayout;
            if (!layout || !this.authorityClient) return;
            const r = resolveDrop(layout, drag, { x, y }, this.inventory);
            if (r.action === 'equip') {
                this.authorityClient.sendEquip(r.itemId, r.slot);
                this.inventorySelectedItemId = null;
            } else if (r.action === 'unequip') {
                this.authorityClient.sendUnequip(r.slot);
            } else if (r.action === 'drop') {
                this.authorityClient.sendDrop(r.itemId);
                this.inventorySelectedItemId = null;
            }
        };

        // SOMET-476. `passive: false` because the handler calls
        // preventDefault -- without it the browser scrolls the page behind the
        // canvas while the player is zooming the tree.
        this._wheelHandler = (e) => {
            if (!this.passiveTreeOpen) return;
            if (typeof e.preventDefault === 'function') e.preventDefault();
            const pt = this._canvasPoint(e);
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            this.passiveView = zoomAbout(
                this.passiveView, pt.x, pt.y, clampZoom(this.passiveView.zoom * factor),
            );
        };

        window.addEventListener('keydown', this._keydownHandler);
        window.addEventListener('keyup', this._keyupHandler);
        window.addEventListener('contextmenu', this._contextMenuHandler);
        window.addEventListener('blur', this._blurHandler);
        this.canvas.addEventListener('mousemove', this._mouseMoveHandler);
        this.canvas.addEventListener('mousedown', this._mouseDownHandler);
        this.canvas.addEventListener('mouseup', this._mouseUpHandler);
        window.addEventListener('mouseup', this._windowMouseUpHandler);
        this.canvas.addEventListener('wheel', this._wheelHandler, { passive: false });
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

    // The box the canvas has to fit inside. Its own parent element -- NOT the
    // window: the canvas is a child of GameShell's content area, which is the
    // window minus the sidebar and the header, and it clips what overflows.
    // See canvasFit.js for the failure this measurement is fixing (SOMET-489).
    _canvasContainerBox(){
        const parent = this.canvas ? this.canvas.parentElement : null;
        if (parent && typeof parent.getBoundingClientRect === 'function') {
            const rect = parent.getBoundingClientRect();
            // Returned even when it measures zero (a hidden container, or one
            // read before first layout). resizeCanvas() then leaves the last
            // good box alone -- falling back to the window HERE would restore
            // the very overflow this method exists to prevent, at exactly the
            // moment the container cannot contradict it.
            return { width: rect.width, height: rect.height };
        }
        // No parent at all: a detached canvas (unit tests, or a node not yet
        // inserted). The viewport is then the only box on offer.
        return { width: window.innerWidth, height: window.innerHeight };
    }

    // A window `resize` is not the only thing that changes the box: the
    // sidebar, the fullscreen transition and any panel around the canvas
    // resize the container while the window stands still. Observing the
    // container covers both, so this is the primary signal and the window
    // listener is only the fallback for browsers without ResizeObserver.
    // Re-attached from resizeCanvas() whenever the canvas is rebound to a new
    // node (bindGameCanvas), so the observer can never be left watching the
    // previous parent.
    _observeCanvasContainer(){
        const parent = this.canvas ? this.canvas.parentElement : null;
        if (parent === this._observedContainer) return;
        if (this._containerObserver) {
            this._containerObserver.disconnect();
            this._containerObserver = null;
        }
        this._observedContainer = parent || null;
        if (!parent || typeof ResizeObserver === 'undefined') return;
        this._containerObserver = new ResizeObserver(() => this.resizeCanvas());
        this._containerObserver.observe(parent);
    }

    _disconnectCanvasContainerObserver(){
        if (this._containerObserver) {
            this._containerObserver.disconnect();
            this._containerObserver = null;
        }
        this._observedContainer = null;
    }

    resizeCanvas(){
        if (!this.canvas) return;
        this._observeCanvasContainer();

        const box = this._canvasContainerBox();
        const fit = fitCanvasBox(box.width, box.height);
        // A container measured at zero (hidden, or pre-layout) would otherwise
        // collapse the element to 0x0 with nothing to resize it back.
        if (fit.width <= 0 || fit.height <= 0) return;

        // Guarded because assigning to width/height resets the backing store
        // AND the 2d context state, and this now runs on every container
        // resize rather than only on a window one.
        if (this.canvas.width !== GAME_WIDTH) this.canvas.width = GAME_WIDTH;
        if (this.canvas.height !== GAME_HEIGHT) this.canvas.height = GAME_HEIGHT;

        // Centred by absolute offsets inside the (position:relative) content
        // area rather than by a margin: a margin box is part of the flow the
        // container clips, which is what overflowed before.
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = `${fit.left}px`;
        this.canvas.style.top = `${fit.top}px`;
        this.canvas.style.margin = '0';
        this.canvas.style.width = `${fit.width}px`;
        this.canvas.style.height = `${fit.height}px`;
    }
}