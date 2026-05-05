import { WORLD_WIDTH, WORLD_HEIGHT, MAP_TILE_SIZE } from "./constants.js";
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

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const tileType = this.tiles[r][c];
                if (!tileType) continue;

                // Find all entity types that can spawn on this tile
                const possibleEntities = entityTypesList.filter(entity => entity.spawnTiles && entity.spawnTiles.includes(tileType));
                
                for (const entityDef of possibleEntities) {
                    if (Math.random() < entityDef.chance) {
                        let inst = null;
                        if (entityDef.name === 'Tree') inst = new Tree(r, c);
                        else if (entityDef.name === 'Stone') inst = new Stone(r, c);
                        else if (entityDef.name === 'IceRock') inst = new IceRock(r, c);
                        else inst = new Entity(r, c);

                        inst.type = entityDef.name;
                        inst.color = entityDef.color;
                        inst.walkable = entityDef.walkable;
                        
                        this.entities.push(inst);
                        // We could break here if we only want one entity per tile, 
                        // but allowing multiple is more flexible.
                        break; 
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

        const startCol = Math.floor(camera.x / this.tileSize);
        const endCol = Math.ceil((camera.x + camera.width) / this.tileSize);
        const startRow = Math.floor(camera.y / this.tileSize);
        const endRow = Math.ceil((camera.y + camera.height) / this.tileSize);

        for (let r = Math.max(0, startRow); r < Math.min(this.rows, endRow); r++) {
            if (!this.tiles[r]) continue;
            for (let c = Math.max(0, startCol); c < Math.min(this.cols, endCol); c++) {
                const tileType = this.tiles[r][c];
                if (!tileType) continue;
                const tileDef = this.mapTiles ? (this.mapTiles[tileType] || (Array.isArray(this.mapTiles) ? this.mapTiles.find(t => t.name === tileType || t.type === tileType) : null)) : null;
                ctx.fillStyle = tileDef ? tileDef.color : '#000000';
                ctx.fillRect(c * this.tileSize, r * this.tileSize, this.tileSize + 0.5, this.tileSize + 0.5);
            }
        }

        // Render entities over tiles
        for (const entity of this.entities) {
            entity.render(ctx, camera);
        }

        if (this.showGrid) {
            this.renderGrid(ctx, camera, startRow, endRow, startCol, endCol);
        }
    }

    renderGrid(ctx, camera, startRow, endRow, startCol, endCol) {
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();

        // Vertical lines
        for (let c = Math.max(0, startCol); c <= Math.min(this.cols, endCol); c++) {
            const x = c * this.tileSize;
            ctx.moveTo(x, Math.max(0, startRow * this.tileSize));
            ctx.lineTo(x, Math.min(WORLD_HEIGHT, endRow * this.tileSize));
        }

        // Horizontal lines
        for (let r = Math.max(0, startRow); r <= Math.min(this.rows, endRow); r++) {
            const y = r * this.tileSize;
            ctx.moveTo(Math.max(0, startCol * this.tileSize), y);
            ctx.lineTo(Math.min(WORLD_WIDTH, endCol * this.tileSize), y);
        }
        ctx.stroke();
    }
}
