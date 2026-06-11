import { GAME_WIDTH, GAME_HEIGHT, GRID_SIZE } from "../core/constants.js";

export class RenderSystem {
    constructor(canvas, imageManager){
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.ctx.imageSmoothingEnabled = false;
        this.imageManager = imageManager;
    }

    render(player, camera, map, remotePlayers, localUserId){
        // Clear background
        this.ctx.fillStyle = '#0f3460';
        this.ctx.fillRect(0,0,GAME_WIDTH,GAME_HEIGHT);

        // Apply camera for world-space objects
        camera.apply(this.ctx);

        // Render map (plane)
        map.render(this.ctx, camera);

        // Render remote players first so the local player draws on top.
        if (remotePlayers && remotePlayers.size > 0) {
            this.renderRemotePlayers(remotePlayers, player.width, player.height);
        }

        // Render local entity
        this.renderPlayer(player);

        // Restore camera transformation
        camera.reset(this.ctx);

        // Screen-space HUD on top.
        this.renderHud(player, remotePlayers, localUserId);
    }

    renderHud(player, remotePlayers, localUserId){
        const remoteCount = remotePlayers ? remotePlayers.size : 0;
        const lines = [
            `Players online: ${1 + remoteCount}`,
            `You: #${localUserId ?? "?"}  pos=(${Math.round(player.x)}, ${Math.round(player.y)})`,
        ];
        this.ctx.save();
        this.ctx.fillStyle = "rgba(0,0,0,0.55)";
        this.ctx.fillRect(10, 10, 260, 18 * lines.length + 12);
        this.ctx.fillStyle = "#e5e7eb";
        this.ctx.font = "13px monospace";
        this.ctx.textBaseline = "top";
        lines.forEach((t, i) => this.ctx.fillText(t, 18, 16 + i * 18));
        this.ctx.restore();
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

    renderRemotePlayers(remotePlayers, w, h){
        const playerImage = this.imageManager.get('player');
        for (const [userId, p] of remotePlayers) {
            if (playerImage) {
                this.ctx.globalAlpha = 0.85;
                this.ctx.drawImage(playerImage, p.x, p.y, w, h);
                this.ctx.globalAlpha = 1;
            } else {
                this.ctx.fillStyle = '#f59e0b';
                this.ctx.fillRect(p.x, p.y, w, h);
            }
            // Tag with user_id so multi-player is visually distinguishable.
            this.ctx.fillStyle = '#fff';
            this.ctx.font = '12px sans-serif';
            this.ctx.fillText(`#${userId}`, p.x, p.y - 4);
        }
    }
}