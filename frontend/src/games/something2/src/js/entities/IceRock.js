import { MapEntity } from "./MapEntity.js";

export class IceRock extends MapEntity {
    constructor(row, col) {
        super(row, col);
        this.color = '#ADD8E6'; // Light blue fallback
    }
}
