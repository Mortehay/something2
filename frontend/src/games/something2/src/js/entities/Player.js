import { Entity } from "./Entity.js";
import { WORLD_WIDTH, WORLD_HEIGHT } from "../core/constants.js";
import { resolveMove } from "../systems/movement.js";

// Single source of the key → direction-vector mapping. Used by Player.update
// (local prediction) AND by Game (input sent to the authority) so the two
// never drift.
// SOMET-79: which keys count as MOVEMENT right now. WASD kept walking the
// character while the inventory or shop panel was open -- clicks were already
// suppressed, so the player was typing into a modal and moving underneath it,
// and because the authority is fed the same vector they really did move
// server-side.
//
// A plain function taking the state object rather than a Game method, for two
// reasons: it sits beside inputVector, which is the other half of the same
// rule, and it stays callable on any state-shaped object -- getMinimapSnapshot
// is exercised in tests against a hand-built `this` that has no class methods.
//
// Returns an empty key map rather than a zeroed vector because prediction
// (Player.update) and the authority send read the keys SEPARATELY: zeroing one
// and not the other would desync the client from the server, which is a worse
// bug than the one being fixed.
export function movementKeys(state) {
    if (!state) return {};
    return (state.inventoryOpen || state.shopOpen) ? {} : (state.keys || {});
}

export function inputVector(keys) {
    let dx = 0, dy = 0;
    if (keys['w'] || keys['arrowup']) { dx -= 1; dy -= 1; }
    if (keys['s'] || keys['arrowdown']) { dx += 1; dy += 1; }
    if (keys['a'] || keys['arrowleft']) { dx -= 1; dy += 1; }
    if (keys['d'] || keys['arrowright']) { dx += 1; dy -= 1; }
    return { dx, dy };
}

export class Player extends Entity {
    constructor(){
        super(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 64, 64);
        this.speed = 100;
        this.hitboxRadius = 30;
        this.damageMultiplier = 1;
        this.fireRateMultiplier = 1;
        this.speedMultiplier = 2;
        this.rangeMultiplier = 1;
        this.weapons = [];
    }

    reset(){
        this.x = WORLD_WIDTH / 2;
        this.y = WORLD_HEIGHT / 2;
        this.speed = 100;
        this.fireRateMultiplier = 1;
        this.damageMultiplier = 1;
        this.speedMultiplier = 2;
        this.rangeMultiplier = 1;
        this.weapons = [];
    }

    // Chunked world: delegate collision to the ChunkedMap via resolveMove. No
    // world-bounds clamp (infinite world); the streaming frontier (unloaded
    // chunk -> isWalkable false) is the only boundary. `map` is always a
    // ChunkedMap now that Game's non-chunked update()/render() path (and the
    // fixed-size legacy Map it drove) is gone — see F-030/SOMET-210.
    update(dt, keys, map){
        const { dx, dy } = inputVector(keys);
        if ((dx === 0 && dy === 0) || !map || typeof map.isWalkable !== 'function') return;

        const speed = this.speed * (this.speedMultiplier || 1);
        const r = resolveMove(map, { x: this.x, y: this.y, width: this.width, height: this.height, speed }, dx, dy, dt);
        this.x = r.x;
        this.y = r.y;
    }
}