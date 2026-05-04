import { Entity } from "./Entity.js";

export class Stone extends Entity {
    constructor(row, col) {
        super(row, col);
        this.color = '#A9A9A9'; // Dark gray fallback
    }
}
