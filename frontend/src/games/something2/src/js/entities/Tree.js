import { Environment } from "./Environment.js";

export class Tree extends Environment {
    constructor(row, col) {
        super(row, col);
        this.color = '#006400'; // Dark green fallback
    }
}
