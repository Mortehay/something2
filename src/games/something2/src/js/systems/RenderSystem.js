import { GAME_WIDTH, GAME_HEIGHT, GRID_SIZE } from "../core/constants.js";

export class RenderSystem {
    constructor(canvas, imageManager){
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.ctx.imageSmoothingEnabled = false;
        this.imageManager = imageManager;
    }

    render(player, camera, map){
        // Clear background
        this.ctx.fillStyle = '#0f3460';
        this.ctx.fillRect(0,0,GAME_WIDTH,GAME_HEIGHT);

        // Apply camera for world-space objects
        camera.apply(this.ctx);
        
        // Render map (plane)
        map.render(this.ctx, camera);
        
        // Render entities
        this.renderPlayer(player);
        
        // Restore camera transformation
        camera.reset(this.ctx);
    }

    renderPlayer(player){
        const playerImage = this.imageManager.get('player');
        
        if(playerImage){
            this.ctx.drawImage(playerImage, player.x, player.y, player.width, player.height);
        } else {
            //fallback if image not loaded
            this.ctx.fillStyle = '#1a1a2e';
            this.ctx.fillRect(player.x,player.y,player.width,player.height);
            this.ctx.strokeStyle = 'white';
            this.ctx.strokeRect(player.x,player.y,player.width,player.height);
        }
    }
}