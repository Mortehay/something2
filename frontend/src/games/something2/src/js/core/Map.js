import { WORLD_WIDTH, WORLD_HEIGHT, MAP_TILE_SIZE } from "./constants.js";
import { Tree } from "../entities/Tree.js";
import { Stone } from "../entities/Stone.js";
import { IceRock } from "../entities/IceRock.js";
import { Environment } from "../entities/Environment.js";

export class Map {
    constructor() {
        this.tileSize = MAP_TILE_SIZE;
        this.cols = Math.ceil(WORLD_WIDTH / this.tileSize);
        this.rows = Math.ceil(WORLD_HEIGHT / this.tileSize);
        this.tiles = [];
        this.environments = [];
        this.showGrid = true;
        this.environmentTypes = null;
    }

    /**
     * Initialize the map with provided tile data
     * @param {Array} tiles 
     * @param {Array|Object} mapTiles
     * @param {Array} loadedEnvironments
     * @param {Object} environmentTypes
     */
    init(tiles, mapTiles, loadedEnvironments, environmentTypes) {
        this.mapTiles = mapTiles;
        this.environmentTypes = environmentTypes;
        this.environments = [];
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

        if (loadedEnvironments && loadedEnvironments.length > 0) {
            this.environments = loadedEnvironments.map(e => {
                let inst = null;
                const type = e.type || e.name;
                
                if (type === 'Tree') inst = new Tree(0, 0);
                else if (type === 'Stone') inst = new Stone(0, 0);
                else if (type === 'IceRock') inst = new IceRock(0, 0);
                else inst = new Environment(0, 0);
                
                if (inst) {
                    Object.assign(inst, e);
                    // Override with latest type config if available
                    if (this.environmentTypes && this.environmentTypes[type]) {
                        inst.color = this.environmentTypes[type].color;
                        inst.walkable = this.environmentTypes[type].walkable;
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

    generateEnvironments() {
        this.environments = [];
        if (!this.environmentTypes) {
            console.warn("Cannot generate environments: no environment types defined");
            return;
        }

        const envTypesList = Object.entries(this.environmentTypes).map(([name, config]) => ({
            name, ...config
        }));

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const tileType = this.tiles[r][c];
                if (!tileType) continue;

                // Find all environment types that can spawn on this tile
                const possibleEnvs = envTypesList.filter(env => env.spawnTiles && env.spawnTiles.includes(tileType));
                
                for (const envDef of possibleEnvs) {
                    if (Math.random() < envDef.chance) {
                        let inst = null;
                        if (envDef.name === 'Tree') inst = new Tree(r, c);
                        else if (envDef.name === 'Stone') inst = new Stone(r, c);
                        else if (envDef.name === 'IceRock') inst = new IceRock(r, c);
                        else inst = new Environment(r, c);

                        inst.type = envDef.name;
                        inst.color = envDef.color;
                        inst.walkable = envDef.walkable;
                        
                        this.environments.push(inst);
                        // We could break here if we only want one environment per tile, 
                        // but allowing multiple is more flexible.
                        break; 
                    }
                }
            }
        }
        console.log(`Generated ${this.environments.length} environment items.`);
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

        // Render environments over tiles
        for (const env of this.environments) {
            env.render(ctx, camera);
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
