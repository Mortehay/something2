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
import { WorldAuthorityClient } from "../net/WorldAuthorityClient.js";
import { fetchDevToken } from "../net/EngineClient.js";
import { reconcile } from "../net/reconcile.js";
import { inputVector } from "../entities/Player.js";
import { PLAYER_SPEED_EFFECTIVE } from "./constants.js";
import { aimVector } from "./aim.js";

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

        // Combat (Slice 3b): weapon catalog from `joined`, local mana/weapon
        // state from `state`, and the projectile render store.
        this.weaponCatalog = [];
        this.localMana = null;
        this.localMaxMana = null;
        this.localWeaponId = null;
        this.projectiles = null;
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

    setState(newState) {
        if (this.state !== newState) {
            this.state = newState;
            if (this.onStateChange) {
                this.onStateChange(newState);
            }
        }
    }

    // Load each sprited entity type's atlas image + manifest from MinIO and
    // attach the manifest to the type's sprite descriptor. Because entity
    // instances share that descriptor object (Object.assign copies the ref),
    // attaching here also lights up already-created entities. Any failure
    // leaves the manifest unset, so rendering degrades to a rectangle.
    async preloadSprites(entityTypes) {
        if (!entityTypes) return;
        const MINIO = (import.meta.env && import.meta.env.VITE_MINIO_URL) || 'http://localhost:19000';
        const byAtlas = {};
        for (const name in entityTypes) {
            const spr = entityTypes[name] && entityTypes[name].sprite;
            if (spr && spr.atlas_key) byAtlas[spr.atlas_key] = spr;
        }
        const manifests = {};
        await Promise.all(Object.values(byAtlas).map(async (spr) => {
            await this.imageManager.load(spr.atlas_key, `${MINIO}/${spr.atlas_key}`);
            try {
                const res = await fetch(`${MINIO}/${spr.manifest_key}`);
                if (res.ok) manifests[spr.atlas_key] = await res.json();
            } catch { /* leave unset -> rect fallback */ }
        }));
        for (const name in entityTypes) {
            const spr = entityTypes[name] && entityTypes[name].sprite;
            if (spr && spr.atlas_key && manifests[spr.atlas_key]) spr.manifest = manifests[spr.atlas_key];
        }
        // Also attach to any entities whose sprite is a distinct object.
        for (const ent of this.map.entities) {
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

    async initChunked({ worldId, chunkSize, tileTypes, spawnX = 0, spawnY = 0 }) {
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
        this.streamer = new ChunkStreamer(this.chunkedMap, makeChunkFetcher(worldId, API_URL), 1);

        this.creatures = new CreatureManager();
        this.projectiles = new ProjectileManager();

        this._inputBuffer = [];
        // Connect to the authoritative sim; spawn comes from the server.
        const { token, user_id } = await fetchDevToken(API_URL);
        this.localUserId = String(user_id);
        const wsUrl = API_URL.replace(/^http/, 'ws') + '/authority';
        const spawn = await new Promise((resolve, reject) => {
            this.authorityClient = new WorldAuthorityClient({
                url: wsUrl,
                token,
                onJoined: (msg) => {
                    this.weaponCatalog = msg.weapons || [];
                    resolve(msg.spawn);
                },
                onState: (msg) => this._onWorldState(msg),
                onCreatures: (msg) => this.creatures.applySnapshot(msg.creatures),
                onError: (e) => console.error('[authority]', e),
                onClose: () => { this.authorityJoined = false; },
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
            next.set(p.id, { x: p.x, y: p.y, facing: p.facing, hp: p.hp, maxHp: p.maxHp });
        }
        this.remotePlayers = next;
        if (mine) {
            this.player.hp = mine.hp;
            this.player.maxHp = mine.maxHp;
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
        const me = (msg.players || []).find((p) => p.id === this.localUserId);
        if (me) {
            this.localMana = me.mana;
            this.localMaxMana = me.maxMana;
            this.localWeaponId = me.weaponId;
        }
        if (this.projectiles) this.projectiles.applySnapshot(msg.projectiles || []);
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

    render(){
        if(this.state === 'menu'){
            this.ctx.fillStyle = '#0f3460';
            this.ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
        } else if (this.chunked) {
            this.renderSystem.renderChunked(this.player, this.camera, this.chunkedMap, this.remotePlayers, this.localUserId, this.creatures.all(), this.projectiles ? this.projectiles.all() : [], this.weaponCatalog, this.localMana, this.localMaxMana, this.localWeaponId);
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

    setupInput(){
        if (this._inputAttached) return;
        this._inputAttached = true;

        this._keydownHandler = (e) => {
            const key = e.key.toLowerCase();
            this.keys[key] = true;

            if (this.state === 'playing' && this.chunked && this.authorityClient && this.weaponCatalog && /^[1-9]$/.test(key)) {
                const w = this.weaponCatalog[Number(key) - 1];
                if (w) this.authorityClient.sendEquip(w.id);
            }

            if(key === 'escape'){
                console.log("Escape pressed, current state:", this.state);
                if(this.state === 'playing'){
                    this.pause();
                }else if(this.state === 'paused'){
                    this.resume();
                }
            }

            if(key === 'g' && this.state === 'playing'){
                this.map.toggleGrid();
            }

            // Dev: cycle the global render-mode override (none -> rect -> static -> animated).
            if(key === 'm' && this.state === 'playing'){
                const mode = this.renderSystem.cycleRenderModeOverride();
                console.log(`Render-mode override: ${mode ?? 'off (per-entity)'}`);
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