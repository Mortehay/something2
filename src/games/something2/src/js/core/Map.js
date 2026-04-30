import { WORLD_WIDTH, WORLD_HEIGHT, MAP_TILE_SIZE } from "./constants.js";

const TILE_TYPES = ['grass', 'sand', 'rocks', 'earth', 'snow', 'ice'];

const RULES = {
    'grass': ['grass', 'sand', 'earth'],
    'sand': ['sand', 'grass', 'earth'],
    'rocks': ['rocks', 'earth', 'snow'],
    'earth': ['earth', 'grass', 'sand', 'rocks'],
    'snow': ['snow', 'rocks', 'ice'],
    'ice': ['ice', 'snow']
};

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

    async init() {
        const savedMap = localStorage.getItem('game_map_data');
        if (savedMap) {
            try {
                const tiles = JSON.parse(savedMap);
                // Check if dimensions match
                if (Array.isArray(tiles) && tiles.length === this.rows && tiles[0] && tiles[0].length === this.cols) {
                    this.tiles = tiles;
                    console.log("Map loaded from localStorage");
                    return;
                } else {
                    console.log("Map dimensions mismatch, generating new map...");
                }
            } catch (e) {
                console.error("Failed to parse saved map", e);
            }
        }

        console.log("Generating new map using WFC...");
        this.generateWFC();
        this.save();
    }

    toggleGrid() {
        this.showGrid = !this.showGrid;
    }

    save() {
        localStorage.setItem('game_map_data', JSON.stringify(this.tiles));
    }

    generateWFC() {
        const grid = Array(this.rows).fill(null).map(() => 
            Array(this.cols).fill(null).map(() => [...TILE_TYPES])
        );

        const getEntropy = (r, c) => grid[r][c].length;

        const getLowestEntropyCoords = () => {
            let minEntropy = Infinity;
            let coords = [];

            for (let r = 0; r < this.rows; r++) {
                for (let c = 0; c < this.cols; c++) {
                    if (grid[r][c].length > 1) {
                        const entropy = getEntropy(r, c);
                        if (entropy < minEntropy) {
                            minEntropy = entropy;
                            coords = [[r, c]];
                        } else if (entropy === minEntropy) {
                            coords.push([r, c]);
                        }
                    }
                }
            }
            return coords.length > 0 ? coords[Math.floor(Math.random() * coords.length)] : null;
        };

        const propagate = (r, c) => {
            const stack = [[r, c]];
            while (stack.length > 0) {
                const [currR, currC] = stack.pop();
                const currOptions = grid[currR][currC];

                const neighbors = [
                    [currR - 1, currC], [currR + 1, currC],
                    [currR, currC - 1], [currR, currC + 1]
                ];

                for (const [nR, nC] of neighbors) {
                    if (nR >= 0 && nR < this.rows && nC >= 0 && nC < this.cols) {
                        const neighborOptions = grid[nR][nC];
                        if (neighborOptions.length <= 1) continue;

                        const validForNeighbor = new Set();
                        currOptions.forEach(opt => {
                            RULES[opt].forEach(validOpt => validForNeighbor.add(validOpt));
                        });

                        const nextNeighborOptions = neighborOptions.filter(opt => validForNeighbor.has(opt));

                        if (nextNeighborOptions.length < neighborOptions.length) {
                            grid[nR][nC] = nextNeighborOptions;
                            stack.push([nR, nC]);
                        }
                    }
                }
            }
        };

        let next;
        while (next = getLowestEntropyCoords()) {
            const [r, c] = next;
            const options = grid[r][c];
            const pick = options[Math.floor(Math.random() * options.length)];
            grid[r][c] = [pick];
            propagate(r, c);
        }

        this.tiles = grid.map(row => row.map(cell => cell[0] || 'grass'));
    }

    render(ctx, camera) {
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
