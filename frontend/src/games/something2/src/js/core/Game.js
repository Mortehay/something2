import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";
import { RenderSystem } from "../systems/RenderSystem.js";
import { Player } from "../entities/Player.js";
import { ImageManager } from "../managers/ImageManager.js";
import { Camera } from "./Camera.js";
import { Map } from "./Map.js";

export class Game {
    constructor() {
        console.log("Game constructor");
        this.canvas = null;
        this.ctx = null;
        this.imageManager = new ImageManager();

        this.player = new Player();
        this.camera = new Camera();
        this.map = new Map();
        
        this.keys = {};
        this.lastTime = 0;
        this.state = 'menu';
        this.onStateChange = null;
    }

    setOnStateChange(callback) {
        this.onStateChange = callback;
    }

    setState(newState) {
        if (this.state !== newState) {
            this.state = newState;
            if (this.onStateChange) {
                this.onStateChange(newState);
            }
        }
    }

    async init(tiles = null, mapTiles = null, loadedEnvironments = null, environmentTypes = null){
        this.canvas = document.getElementById('gameCanvas');
        if (!this.canvas) {
            console.error("Canvas not found!");
            return;
        }
        this.ctx = this.canvas.getContext('2d');

        this.renderSystem = new RenderSystem(this.canvas, this.imageManager);

        const initPromises = [this.imageManager.loadAll()];
        
        if (tiles) {
            this.map.init(tiles, mapTiles, loadedEnvironments, environmentTypes);
        }

        await Promise.all(initPromises);

        await Promise.all(initPromises);

        this.resizeCanvas();
        this._resizeHandler = () => this.resizeCanvas();
        window.addEventListener('resize', this._resizeHandler);
        this.setupInput();

        //start game loop
        this.lastTime = performance.now();
        this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
    }

    setMap(tiles, mapTiles, loadedEnvironments, environmentTypes = null) {
        this.map.init(tiles, mapTiles, loadedEnvironments, environmentTypes);
    }


    destroy() {
        if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
        if (this._keydownHandler) window.removeEventListener('keydown', this._keydownHandler);
        if (this._keyupHandler) window.removeEventListener('keyup', this._keyupHandler);
        if (this._contextMenuHandler) window.removeEventListener('contextmenu', this._contextMenuHandler);
        if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);
        
        cancelAnimationFrame(this.animationFrameId);
    }

    update(dt){
        if(this.state !== 'playing') return;
        this.player.update(dt, this.keys, this.map);
        this.camera.update(this.player);
    }

    render(){
        if(this.state === 'menu'){
            this.ctx.fillStyle = '#0f3460';
            this.ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
        } else {
            this.renderSystem.render(this.player, this.camera, this.map);
        }
    }

    gameLoop(timestamp){
        if(this.lastTime === 0) this.lastTime = timestamp;
        const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
        this.lastTime = timestamp;
        
        this.update(dt);
        this.render();
        
        this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
    }

    setupInput(){
        this._keydownHandler = (e) => {
            const key = e.key.toLowerCase();
            this.keys[key] = true;
            
            if(key === 'escape'){
                if(this.state === 'playing'){
                    this.pause();
                }else if(this.state === 'paused'){
                    this.resume();
                }
            }

            if(key === 'g' && this.state === 'playing'){
                this.map.toggleGrid();
            }
        };

        this._keyupHandler = (e) => {
            this.keys[e.key.toLowerCase()] = false;
        };

        this._contextMenuHandler = () => {
            this.keys = {};
        };

        this._blurHandler = () => {
            this.keys = {};
        };

        window.addEventListener('keydown', this._keydownHandler);
        window.addEventListener('keyup', this._keyupHandler);
        window.addEventListener('contextmenu', this._contextMenuHandler);
        window.addEventListener('blur', this._blurHandler);
    }

    startGame(){
        this.setState('playing');
        this.player.reset();
        this.lastTime = performance.now();
    }

    pause(){
        this.setState('paused');
    }

    resume(){
        this.setState('playing');
    }

    returnToMenu(){
        this.setState('menu');
    }

    resizeCanvas(){
        if (!this.canvas) return;
        const ratio = 16/9;
        let h,w;
        const margin = 15;

        const availableWidth = window.innerWidth - 2 * margin;
        const availableHeight = window.innerHeight - 2 * margin;

        if(availableWidth/availableHeight > ratio){
            h = availableHeight;
            w = h * ratio;
        }else{
            w = availableWidth;
            h = w / ratio;
        }

        this.canvas.width = GAME_WIDTH;
        this.canvas.height = GAME_HEIGHT;

        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
        this.canvas.style.margin = `${margin}px`;
    }
}