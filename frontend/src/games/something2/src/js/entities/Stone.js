import { MapEntity } from "./MapEntity.js";

export class Stone extends MapEntity {
    constructor(row, col) {
        super(row, col);
        this.color = '#A9A9A9'; // Dark gray fallback
    }
}
