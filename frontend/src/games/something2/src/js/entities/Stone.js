import { Environment } from "./Environment.js";

export class Stone extends Environment {
    constructor(row, col) {
        super(row, col);
        this.color = '#A9A9A9'; // Dark gray fallback
    }
}
