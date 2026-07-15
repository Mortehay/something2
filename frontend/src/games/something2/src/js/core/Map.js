import { WORLD_WIDTH, WORLD_HEIGHT, MAP_TILE_SIZE, ISO_TILE_W, ISO_TILE_H } from "./constants.js";
import { worldToScreen } from "./iso.js";
import { Tree } from "../entities/Tree.js";
import { Stone } from "../entities/Stone.js";
import { IceRock } from "../entities/IceRock.js";
import { Entity } from "../entities/Entity.js";
import { MapEntity } from "../entities/MapEntity.js";

export class Map {
    constructor() {
        this.tileSize = MAP_TILE_SIZE;
        this.cols = Math.ceil(WORLD_WIDTH / this.tileSize);
        this.rows = Math.ceil(WORLD_HEIGHT / this.tileSize);
        this.tiles = [];
        this.entities = [];
        this.showGrid = true;
        this.entityTypes = null;
    }

    /**
     * Initialize the map with provided tile data
     * @param {Array} tiles 
     * @param {Array|Object} mapTiles
     * @param {Array} loadedEntities
     * @param {Object} entityTypes
     */
    init(tiles, mapTiles, loadedEntities, entityTypes) {
        this.mapTiles = mapTiles;
        this.entityTypes = entityTypes;
        this.entities = [];
        if (tiles && Array.isArray(tiles) && tiles.length > 0) {
            this.tiles = tiles;
            this.rows = tiles.length;
            this.cols = tiles[0].length;
            console.log(`Map initialized with ${this.rows}x${this.cols} tiles`);
        } else {
            console.warn("Map initialized without valid tile data");
            // Fallback empty map
            this.tiles = Array(this.rows).fill(null).map(() => Array(this.cols).fill('grass'));
        }

        if (loadedEntities && loadedEntities.length > 0) {
            this.entities = loadedEntities.map(e => {
                let inst = null;
                const type = e.type || e.name;
                
                const r = e.row || 0;
                const c = e.col || 0;
                
                if (type === 'Tree') inst = new Tree(r, c);
                else if (type === 'Stone') inst = new Stone(r, c);
                else if (type === 'IceRock') inst = new IceRock(r, c);
                else inst = new MapEntity(r, c);
                
                if (inst) {
                    // Copy instance properties (x, y, row, col, etc.)
                    Object.assign(inst, e);
                    
                    // Apply type configuration (color, walkable, stats, image, display dimensions)
                    const typeConfig = this.entityTypes ? this.entityTypes[type] : null;
                    if (typeConfig) {
                        // Merge all type properties into the instance
                        Object.assign(inst, typeConfig);

                        // Ensure display dimensions fallback to collision dimensions if not set or invalid
                        if (!inst.displayWidth || inst.displayWidth <= 0) {
                            inst.displayWidth = inst.width;
                        }
                        if (!inst.displayHeight || inst.displayHeight <= 0) {
                            inst.displayHeight = inst.height;
                        }
                    }
                }
                return inst;
            }).filter(Boolean);
        }
    }

    getTileAt(x, y) {
        const c = Math.floor(x / this.tileSize);
        const r = Math.floor(y / this.tileSize);
        if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
            return this.tiles[r][c];
        }
        return null;
    }

    findSafeSpawn() {
        const centerR = Math.floor(this.rows / 2);
        const centerC = Math.floor(this.cols / 2);
        
        // Search in expanding squares
        for (let radius = 0; radius < Math.max(this.rows, this.cols); radius++) {
            for (let r = centerR - radius; r <= centerR + radius; r++) {
                for (let c = centerC - radius; c <= centerC + radius; c++) {
                    if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) continue;
                    
                    const tileType = this.tiles[r][c];
                    const def = this.mapTiles ? (this.mapTiles[tileType] || (Array.isArray(this.mapTiles) ? this.mapTiles.find(t => t.name === tileType || t.type === tileType) : null)) : null;
                    if (def && def.walkable === false) continue;
                    
                    const x = c * this.tileSize + this.tileSize / 2;
                    const y = r * this.tileSize + this.tileSize / 2;
                    
                    const hasCollision = this.entities.some(env => {
                        if (env.walkable) return false;
                        return x >= env.x && x <= env.x + env.width &&
                               y >= env.y && y <= env.y + env.height;
                    });
                    
                    if (!hasCollision) return { x, y };
                }
            }
        }
        return null;
    }

    generateEntities(entityTypes = null) {
        if (entityTypes) {
            this.entityTypes = entityTypes;
        }
        
        if (!this.tiles || this.tiles.length === 0) {
            console.warn("Cannot generate entities: map tiles not loaded yet");
            return;
        }

        this.entities = [];
        if (!this.entityTypes || Object.keys(this.entityTypes).length === 0) {
            console.warn("Cannot generate entities: no entity types defined");
            return;
        }

        const entityTypesList = Object.entries(this.entityTypes).map(([name, config]) => ({
            name, ...config
        }));

        // Clustered placement: seed clusters and grow them (denser toward the
        // center) so objects clump into stands instead of the uniform scatter a
        // per-tile roll produced. Carved paths are avoided; one object per tile.
        // Mirrors the backend density model in mapService.placeEntities.
        const PATH_RE = /path|dirt|road|trail|earth|sand/i;
        const occupied = new Set();
        const radius = Math.max(2, Math.round(Math.min(this.rows, this.cols) / 12));

        const makeInst = (entityDef, r, c) => {
            let inst;
            if (entityDef.name === 'Tree') inst = new Tree(r, c);
            else if (entityDef.name === 'Stone') inst = new Stone(r, c);
            else if (entityDef.name === 'IceRock') inst = new IceRock(r, c);
            else inst = new Entity(r, c);
            inst.type = entityDef.name;
            inst.color = entityDef.color;
            inst.walkable = entityDef.walkable;
            inst.render_mode = entityDef.render_mode;
            inst.image = entityDef.image;
            inst.sprite = entityDef.sprite;
            return inst;
        };

        for (const entityDef of entityTypesList) {
            if (!entityDef.spawnTiles || entityDef.spawnTiles.length === 0) continue;
            const clusters = Math.max(1, Math.round((this.rows * this.cols * (entityDef.chance || 0)) / 40));
            for (let k = 0; k < clusters; k++) {
                const cr = Math.floor(Math.random() * this.rows);
                const cc = Math.floor(Math.random() * this.cols);
                for (let r = Math.max(0, cr - radius); r <= Math.min(this.rows - 1, cr + radius); r++) {
                    for (let c = Math.max(0, cc - radius); c <= Math.min(this.cols - 1, cc + radius); c++) {
                        const key = r * this.cols + c;
                        if (occupied.has(key)) continue;
                        const tileType = this.tiles[r][c];
                        if (!tileType || PATH_RE.test(tileType)) continue;
                        if (!entityDef.spawnTiles.includes(tileType)) continue;
                        const dist = Math.sqrt((r - cr) ** 2 + (c - cc) ** 2);
                        if (dist > radius) continue;
                        // Denser toward the cluster center.
                        if (Math.random() < 0.85 * (1 - dist / radius)) {
                            this.entities.push(makeInst(entityDef, r, c));
                            occupied.add(key);
                        }
                    }
                }
            }
        }
        console.log(`Generated ${this.entities.length} entity items.`);
    }


    toggleGrid() {
        this.showGrid = !this.showGrid;
    }

    render(ctx, camera) {
        if (this.tiles.length === 0) return;

        // Draw tiles as diamonds. Iterate the whole grid but skip diamonds whose
        // projected center is far outside the canvas (cheap cull using camera center).
        const halfW = ISO_TILE_W / 2;
        const halfH = ISO_TILE_H / 2;
        const cullX = camera.width;   // generous screen-space margins
        const cullY = camera.height;

        for (let r = 0; r < this.rows; r++) {
            if (!this.tiles[r]) continue;
            for (let c = 0; c < this.cols; c++) {
                const tileType = this.tiles[r][c];
                if (!tileType) continue;

                // World-pixel center of this tile.
                const wx = c * this.tileSize + this.tileSize / 2;
                const wy = r * this.tileSize + this.tileSize / 2;
                const s = worldToScreen(wx, wy);

                // Cull: project relative to camera center.
                const relX = s.x - camera.screenX;
                const relY = s.y - camera.screenY;
                if (relX < -cullX || relX > cullX || relY < -cullY || relY > cullY) continue;

                const tileDef = this.mapTiles ? (this.mapTiles[tileType] || (Array.isArray(this.mapTiles) ? this.mapTiles.find(t => t.name === tileType || t.type === tileType) : null)) : null;
                ctx.fillStyle = tileDef ? tileDef.color : "#000000";

                // Diamond centered on (s.x, s.y).
                ctx.beginPath();
                ctx.moveTo(s.x, s.y - halfH);
                ctx.lineTo(s.x + halfW, s.y);
                ctx.lineTo(s.x, s.y + halfH);
                ctx.lineTo(s.x - halfW, s.y);
                ctx.closePath();
                ctx.fill();
            }
        }

        if (this.showGrid) {
            this.renderGrid(ctx, camera);
        }

        // NOTE: entities are no longer drawn here. RenderSystem collects and
        // depth-sorts all drawables (entities + players) so iso overlap is correct.
    }

    renderGrid(ctx, camera) {
        const halfW = ISO_TILE_W / 2;
        const halfH = ISO_TILE_H / 2;
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.lineWidth = 1;
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const wx = c * this.tileSize + this.tileSize / 2;
                const wy = r * this.tileSize + this.tileSize / 2;
                const s = worldToScreen(wx, wy);
                const relX = s.x - camera.screenX;
                const relY = s.y - camera.screenY;
                if (relX < -camera.width || relX > camera.width || relY < -camera.height || relY > camera.height) continue;
                ctx.beginPath();
                ctx.moveTo(s.x, s.y - halfH);
                ctx.lineTo(s.x + halfW, s.y);
                ctx.lineTo(s.x, s.y + halfH);
                ctx.lineTo(s.x - halfW, s.y);
                ctx.closePath();
                ctx.stroke();
            }
        }
    }
}
