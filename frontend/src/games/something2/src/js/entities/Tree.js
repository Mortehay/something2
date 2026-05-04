import { Entity } from "./Entity.js";

export class Tree extends Entity {
    constructor(row, col) {
        super(row, col);
        this.color = '#006400'; // Dark green fallback
    }
}
