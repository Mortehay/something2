import playerImg from "../../images/player.png";

export class ImageManager{
    constructor(){
        this.images = {};
    }

    load(name, path){
        return new Promise((resolve) => {
            
            const img = new Image();
            img.src = path;

            this.images[name] = {img, loaded:false};

            img.onload = () => {
                this.images[name].loaded = true;
                //console.log(`Image ${name} loaded`);
                resolve();
            }

            img.onerror = () => {
                console.error(`Failed to load image ${name}, will use fallback`);
                resolve();
            }
        })
    }

    get(name){
        return this.images[name]?.loaded ? this.images[name].img : null;

    }

    async loadAll(){
        await Promise.all([
            this.load('player', playerImg)
        ]);
        //testing image loading
        //await new Promise(resolve => setTimeout(resolve, 1000));
    }
}