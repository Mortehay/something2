import { Entity } from "./Entity.js";
import { GAME_WIDTH, GAME_HEIGHT, WORLD_WIDTH, WORLD_HEIGHT } from "../core/constants.js";

export class Player extends Entity {
    constructor(){
        super(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 64, 64);
        this.speed = 100;
        this.hitboxRadius = 30;
        this.damageMultiplier = 1;
        this.fireRateMultiplier = 1;
        this.speedMultiplier = 2;
        this.rangeMultiplier = 1;
        this.weapons = [];
    }

    reset(){
        this.x = WORLD_WIDTH / 2;
        this.y = WORLD_HEIGHT / 2;
        this.speed = 100;
        this.fireRateMultiplier = 1;
        this.damageMultiplier = 1;
        this.speedMultiplier = 2;
        this.rangeMultiplier = 1;
        this.weapons = [];
    }

    update(dt, keys, map){
        let dx = 0,dy = 0;

        if(keys['w'] || keys['arrowup']) dy -= 1;
        if(keys['s'] || keys['arrowdown']) dy += 1;
        if(keys['a'] || keys['arrowleft']) dx -= 1;
        if(keys['d'] || keys['arrowright']) dx += 1;

        //normalize diagonal movement
        if(dx !== 0 || dy !== 0){
            const len = Math.sqrt(dx*dx + dy*dy);
            dx /= len;
            dy /= len;

            // calculate step size
            let stepX = dx * this.speed * this.speedMultiplier * dt;
            let stepY = dy * this.speed * this.speedMultiplier * dt;

            // calculate tile properties under player center
            const centerX = this.x + this.width / 2;
            const centerY = this.y + this.height / 2;
            const currentTile = map ? map.getTileAt(centerX, centerY) : null;
            
            let tileSpeed = 1;
            if (currentTile && map && map.mapTiles) {
                 const tileDef = map.mapTiles[currentTile] || (Array.isArray(map.mapTiles) ? map.mapTiles.find(t => t.name === currentTile || t.type === currentTile) : null);
                 if (tileDef && tileDef.speed !== undefined) {
                     tileSpeed = tileDef.speed;
                 }
            }

            stepX *= tileSpeed;
            stepY *= tileSpeed;

            const isWalkable = (tileType) => {
                if (!tileType) return true; // outside map bounds or no tile
                if (!map || !map.mapTiles) return true;
                const def = map.mapTiles[tileType] || (Array.isArray(map.mapTiles) ? map.mapTiles.find(t => t.name === tileType || t.type === tileType) : null);
                return def ? def.walkable !== false : true;
            };

            const nextTileX = map ? map.getTileAt(centerX + stepX, centerY) : null;
            const nextTileY = map ? map.getTileAt(centerX, centerY + stepY) : null;

            let canMoveX = isWalkable(nextTileX);
            let canMoveY = isWalkable(nextTileY);

            // Check against generated entities
            if (map && map.entities) {
                const checkEnvCollision = (nextPx, nextPy) => {
                    // Use a smaller core collision box representing the player's "feet/stump"
                    // This allows them to physically walk ON the tile without hitting the 1/4 area tree immediately
                    const pColX = nextPx + this.width / 2 - 15;
                    const pColY = nextPy + this.height - 25;
                    const pColW = 30;
                    const pColH = 25;

                    return map.entities.some(env => {
                        if (env.walkable) return false;
                        return pColX < env.x + env.width &&
                               pColX + pColW > env.x &&
                               pColY < env.y + env.height &&
                               pColY + pColH > env.y;
                    });
                };

                if (canMoveX && checkEnvCollision(this.x + stepX, this.y)) canMoveX = false;
                if (canMoveY && checkEnvCollision(this.x, this.y + stepY)) canMoveY = false;
            }

            if (canMoveX) {
                this.x += stepX;
            }
            if (canMoveY) {
                this.y += stepY;
            }
        }
        //keep player in bounds
        this.x = Math.max(0, Math.min(WORLD_WIDTH - this.width, this.x));
        this.y = Math.max(0, Math.min(WORLD_HEIGHT - this.height, this.y));

    }
}