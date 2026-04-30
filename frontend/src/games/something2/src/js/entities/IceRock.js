import { Environment } from "./Environment.js";

export class IceRock extends Environment {
    constructor(row, col) {
        super(row, col);
        this.color = '#ADD8E6'; // Light blue fallback
    }
}
