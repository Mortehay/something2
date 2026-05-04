import { Entity } from "./Entity.js";

export class IceRock extends Entity {
    constructor(row, col) {
        super(row, col);
        this.color = '#ADD8E6'; // Light blue fallback
    }
}
