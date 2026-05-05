import { MAP_TILE_SIZE } from "../core/constants.js";

export class Entity {
    constructor(x = 0, y = 0, width = 0, height = 0) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        
        this.image = null;
        this.sprite = null;
        this.color = '#FFFFFF';
        this.walkable = false;
        //main stats
        this.strength = 0;
        this.dexterity = 0;
        this.constitution = 0;
        this.intelligence = 0;
        this.wisdom = 0;
        this.charisma = 0;

        // Base stats (overridden by subclasses like Player)
        this.speed = 0;
        this.hitboxRadius = 0;
        this.damageMultiplier = 0;
        this.fireRateMultiplier = 0;
        this.speedMultiplier = 0;
        this.rangeMultiplier = 0;
        this.weapons = [];

        this.hp = 0;
        this.maxHp = 0;
        this.hpRegenRate = 0;
        this.mana = 0;
        this.maxMana = 0;
        this.manaRegenRate = 0;
    }

    render(ctx, camera) {
        // Skip rendering if off screen
        if (this.x + this.width < camera.x || this.x > camera.x + camera.width || 
            this.y + this.height < camera.y || this.y > camera.y + camera.height) return;

        ctx.fillStyle = this.color;
        ctx.fillRect(this.x, this.y, this.width, this.height);
    }
}
