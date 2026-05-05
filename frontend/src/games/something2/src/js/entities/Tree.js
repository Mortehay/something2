import { MapEntity } from "./MapEntity.js";

export class Tree extends MapEntity {
    constructor(row, col) {
        super(row, col);
        this.color = '#006400'; // Dark green fallback
    }
}
