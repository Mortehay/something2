import { GAME_WIDTH, GAME_HEIGHT, GRID_SIZE } from "../core/constants.js";

export class RenderSystem {
    constructor(canvas, imageManager){
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.ctx.imageSmoothingEnabled = false;
        this.imageManager = imageManager;
    }

    render(player){
        this.ctx.fillStyle = '#0f3460';
        this.ctx.fillRect(0,0,GAME_WIDTH,GAME_HEIGHT);
        this.renderGrid();
        this.renderPlayer(player);
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

    renderGrid(){
        this.ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        for(let i = 0; i < GAME_WIDTH; i += GRID_SIZE){
            this.ctx.moveTo(i,0);
            this.ctx.lineTo(i,GAME_HEIGHT);
        }
        
        for(let i = 0; i < GAME_HEIGHT; i += GRID_SIZE){
            this.ctx.moveTo(0,i);
            this.ctx.lineTo(GAME_WIDTH,i);
        }
        this.ctx.stroke(); 
        

        
    }
}