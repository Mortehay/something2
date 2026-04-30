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

    update(dt,keys){
        let dx = 0,dy = 0;

        if(keys['w'] || keys['arrowup']) dy -= 1;
        if(keys['s'] || keys['arrowdown']) dy += 1;
        if(keys['a'] || keys['arrowleft']) dx -= 1;
        if(keys['d'] || keys['arrowright']) dx += 1;

        //normalize diagonal movement
        if(dx || dy){
            const len = Math.sqrt(dx*dx + dy*dy);
            dx /= len;
            dy /= len;

            this.x += dx * this.speed * this.speedMultiplier * dt;
            this.y += dy * this.speed * this.speedMultiplier * dt;
        }
        //keep player in bounds
        this.x = Math.max(0, Math.min(WORLD_WIDTH - this.width, this.x));
        this.y = Math.max(0, Math.min(WORLD_HEIGHT - this.height, this.y));

    }
}