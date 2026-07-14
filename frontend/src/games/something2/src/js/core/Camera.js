import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";
import { worldToScreen } from "./iso.js";

export class Camera {
  constructor() {
    // Projected screen-space center the camera is looking at.
    this.screenX = 0;
    this.screenY = 0;
    // Retained for off-screen culling in Map/Entity render (world-space extent
    // of the viewport is approximated generously by these).
    this.width = GAME_WIDTH;
    this.height = GAME_HEIGHT;
  }

  update(target) {
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;
    const s = worldToScreen(cx, cy);
    this.screenX = s.x;
    this.screenY = s.y;
  }

  apply(ctx) {
    ctx.save();
    // Put the looked-at screen point at the middle of the canvas.
    ctx.translate(
      Math.floor(GAME_WIDTH / 2 - this.screenX),
      Math.floor(GAME_HEIGHT / 2 - this.screenY),
    );
  }

  reset(ctx) {
    ctx.restore();
  }
}
