import { MAP_TILE_SIZE } from "../core/constants.js";

export class Entity {
    constructor(row, col) {
        // Randomize side length between 35% and 50% of tile (approx 1/8 to 1/4 area)
        const sizeRatio = Math.random() * 0.15 + 0.35;
        this.width = MAP_TILE_SIZE * sizeRatio;
        this.height = MAP_TILE_SIZE * sizeRatio;
        
        // Randomize position within the boundaries of the source tile
        const maxOffsetX = MAP_TILE_SIZE - this.width;
        const maxOffsetY = MAP_TILE_SIZE - this.height;

        this.x = (col * MAP_TILE_SIZE) + (Math.random() * maxOffsetX);
        this.y = (row * MAP_TILE_SIZE) + (Math.random() * maxOffsetY);

        
        this.image = null;
        this.sprite = null;
        this.color = '#FFFFFF';
        this.walkable = false;
    }

    render(ctx, camera) {
        // Skip rendering if off screen
        if (this.x + this.width < camera.x || this.x > camera.x + camera.width || 
            this.y + this.height < camera.y || this.y > camera.y + camera.height) return;

        ctx.fillStyle = this.color;
        ctx.fillRect(this.x, this.y, this.width, this.height);
    }
}
