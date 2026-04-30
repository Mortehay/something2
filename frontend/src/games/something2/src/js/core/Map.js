import { WORLD_WIDTH, WORLD_HEIGHT, MAP_TILE_SIZE } from "./constants.js";

const COLORS = {
    'grass': '#4ade80',
    'sand': '#fde047',
    'rocks': '#71717a',
    'earth': '#78350f',
    'snow': '#f8fafc',
    'ice': '#bae6fd'
};

export class Map {
    constructor() {
        this.tileSize = MAP_TILE_SIZE;
        this.cols = Math.ceil(WORLD_WIDTH / this.tileSize);
        this.rows = Math.ceil(WORLD_HEIGHT / this.tileSize);
        this.tiles = [];
        this.showGrid = true;
    }

    /**
     * Initialize the map with provided tile data
     * @param {Array} tiles 
     */
    init(tiles) {
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
                ctx.fillStyle = COLORS[tileType];
                ctx.fillRect(c * this.tileSize, r * this.tileSize, this.tileSize + 0.5, this.tileSize + 0.5);
            }
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
