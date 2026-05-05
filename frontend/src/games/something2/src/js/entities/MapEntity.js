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

        // Display dimensions (can be larger than collision box)
        // Default to collision size, but can be overridden by type config
        this.displayWidth = width;
        this.displayHeight = height;
    }

    render(ctx, camera) {
        // Calculate centered display position
        const displayX = (this.x + this.width / 2) - this.displayWidth / 2;
        const displayY = (this.y + this.height / 2) - this.displayHeight / 2;

        // Skip rendering if display area is off screen
        if (displayX + this.displayWidth < camera.x || displayX > camera.x + camera.width || 
            displayY + this.displayHeight < camera.y || displayY > camera.y + camera.height) return;

        if (this.image && typeof this.image === 'string') {
            // Placeholder for image rendering logic
            // For now, still drawing a rectangle but we can load actual images
            ctx.fillStyle = this.color;
            ctx.fillRect(displayX - camera.x, displayY - camera.y, this.displayWidth, this.displayHeight);
            
            // If we have a cached image object, we can use ctx.drawImage
            if (this._imgObj) {
                 ctx.drawImage(this._imgObj, displayX - camera.x, displayY - camera.y, this.displayWidth, this.displayHeight);
            }
        } else {
            ctx.fillStyle = this.color;
            ctx.fillRect(displayX - camera.x, displayY - camera.y, this.displayWidth, this.displayHeight);
        }
    }
}
