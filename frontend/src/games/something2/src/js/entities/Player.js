import { GAME_WIDTH, GAME_HEIGHT, WORLD_WIDTH, WORLD_HEIGHT } from "../core/constants.js";

export class Player{
    constructor(){
        this.width = 64;
        this.height = 64;

        this.x = WORLD_WIDTH / 2;
        this.y = WORLD_HEIGHT / 2;

        this.speed = 100;
        
        //collision size
        this.hitboxRadius = 30;

        //multipliers (for upgrades) - applied for all weapons;
        this.damageMultiplier = 1;
        this.fireRateMultiplier = 1;
        this.speedMultiplier = 2;
        this.rangeMultiplier = 1;

        //weapons array - STARTS EMPTY
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

            if (isWalkable(nextTileX)) {
                this.x += stepX;
            }
            if (isWalkable(nextTileY)) {
                this.y += stepY;
            }
        }
        //keep player in bounds
        this.x = Math.max(0, Math.min(WORLD_WIDTH - this.width, this.x));
        this.y = Math.max(0, Math.min(WORLD_HEIGHT - this.height, this.y));

    }
}