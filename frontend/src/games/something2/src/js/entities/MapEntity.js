import { Entity } from "./Entity.js";
import { MAP_TILE_SIZE } from "../core/constants.js";

export class MapEntity extends Entity {
    constructor(row, col) {
        // Randomize side length between 35% and 50% of tile (approx 1/8 to 1/4 area)
        const sizeRatio = Math.random() * 0.15 + 0.35;
        const width = MAP_TILE_SIZE * sizeRatio;
        const height = MAP_TILE_SIZE * sizeRatio;
        
        // Randomize position within the boundaries of the source tile
        const maxOffsetX = MAP_TILE_SIZE - width;
        const maxOffsetY = MAP_TILE_SIZE - height;

        const x = (col * MAP_TILE_SIZE) + (Math.random() * maxOffsetX);
        const y = (row * MAP_TILE_SIZE) + (Math.random() * maxOffsetY);

        super(x, y, width, height);
        
        this.row = row;
        this.col = col;
    }
}
