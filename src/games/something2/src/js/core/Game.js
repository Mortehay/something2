import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";
import { RenderSystem } from "../systems/RenderSystem.js";
import { Player } from "../entities/Player.js";
import { ImageManager } from "../managers/imageManager.js";

export class Game {
    constructor() {
        console.log("Game constructor");
        this.canvas = null;
        this.ctx = null;
        this.imageManager = new ImageManager();

        this.player = new Player();
        this.keys = {};
        this.lastTime = 0;
        this.state = 'menu';

        this.init();
    }

    async init(){

        this.canvas = document.getElementById('gameCanvas');
        if (!this.canvas) {
            console.error("Canvas not found!");
            return;
        }
        this.ctx = this.canvas.getContext('2d');

        this.renderSystem = new RenderSystem(this.canvas, this.imageManager);

        await Promise.all([
            this.imageManager.loadAll(),
        ]);

        //hide loading screen
        document.getElementById('loadingScreen').classList.remove('active');
        document.getElementById('mainMenu').classList.add('active');

        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
        this.setupInput();
        this.setupUI();

        //start game loop
        this.lastTime = performance.now();
        requestAnimationFrame((t) => this.gameLoop(t));
    }

    update(dt){
        if(this.state !== 'playing') return;
        this.player.update(dt, this.keys);
    }

    render(){
        if(this.state === 'menu'){
            this.ctx.fillStyle = '#0f3460';
            this.ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
        } else {
            this.renderSystem.render(this.player);
        }
    }

    gameLoop(timestamp){
        if(this.lastTime === 0) this.lastTime = timestamp;
        const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
        this.lastTime = timestamp;
        //console.log(dt);
        this.update(dt);

        this.render();
        
        requestAnimationFrame((t) => this.gameLoop(t));
    }

    setupInput(){
        window.addEventListener('keydown', (e) => {
            this.keys[e.key.toLowerCase()] = true;
            //Escape toogle pause/resume
            if(e.key.toLowerCase() === 'escape'){
                if(this.state === 'playing'){
                    this.pause();
                }else if(this.state === 'paused'){
                    this.resume();
                }
            }
        });
        window.addEventListener('keyup', (e) => {
            this.keys[e.key.toLowerCase()] = false;
        });
        //clear all keys when contex menu opens
        window.addEventListener('contextmenu', () => {
            this.keys = {};
        });
        //clear all keys when window loses focus
        window.addEventListener('blur', () => {
            this.keys = {};
        });
    }

    setupUI(){
        document.getElementById('playBtn').addEventListener('click', () => this.startGame());
        document.getElementById('resumeBtn').addEventListener('click', () => this.resume());
        document.getElementById('quitBtn').addEventListener('click', () => this.quitToMenu());
    }

    hideAllPanels(){
        document.querySelectorAll('.ui-panel').forEach(panel => {
            panel.classList.remove('active');
        });
    }

    startGame(){
        this.state = 'playing';
        this.hideAllPanels();

        //reset player
        //this.player = new Player();
        this.player.reset();

        this.lastTime = performance.now();

    }

    pause(){
        this.state = 'paused';
        document.getElementById('pauseMenu').classList.add('active');
    }

    resume(){
        this.state = 'playing';
        document.getElementById('pauseMenu').classList.remove('active');
    }

    quitToMenu(){
        this.returnToMenu();
    }

    returnToMenu(){
        this.state = 'menu';
        this.hideAllPanels();
        document.getElementById('mainMenu').classList.add('active');
    }

    resizeCanvas(){
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