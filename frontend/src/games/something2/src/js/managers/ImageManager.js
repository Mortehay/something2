import playerImg from "../../images/player.png";

// The game asks for every sprite in the catalogue up front (hundreds of ~200 KB
// PNGs). Fired all at once they saturate a single uplink -- behind a tunnel the
// browser saw 503s and HTTP/2 resets, and the authority websocket sharing that
// link starved and dropped. A small fixed window keeps the link usable; images
// still arrive in request order, and the renderer already falls back to colour
// until each one lands.
const MAX_CONCURRENT_LOADS = 6;
// One retry, after a pause: the failures seen were transient resets, and a
// permanent colour fallback for the whole session is a poor result for one.
const RETRY_DELAY_MS = 1500;

export class ImageManager{
    constructor(maxConcurrent = MAX_CONCURRENT_LOADS, retryDelayMs = RETRY_DELAY_MS){
        this.images = {};
        this.maxConcurrent = maxConcurrent;
        this.retryDelayMs = retryDelayMs;
        this._active = 0;
        this._queue = [];
    }

    // `priority` jumps the queue: loadAll() gates the first frame on 'player', and
    // that must not wait behind the sprite catalogue.
    load(name, path, {priority = false} = {}){
        return new Promise((resolve) => {
            this.images[name] = {img: null, loaded:false};
            const job = {name, path, resolve, retried:false};
            if (priority) this._queue.unshift(job); else this._queue.push(job);
            this._pump();
        })
    }

    _pump(){
        while (this._active < this.maxConcurrent && this._queue.length > 0) {
            this._start(this._queue.shift());
        }
    }

    _start(job){
        const {name, path} = job;
        this._active++;
        const img = new Image();
        this.images[name] = {img, loaded:false};
        const release = () => { this._active--; this._pump(); };

        img.onload = () => {
            this.images[name].loaded = true;
            release();
            job.resolve();
        };

        img.onerror = () => {
            release();
            if (!job.retried) {
                job.retried = true;
                setTimeout(() => { this._queue.push(job); this._pump(); }, this.retryDelayMs);
                return;
            }
            console.error(`Failed to load image ${name}, will use fallback`);
            job.resolve();
        };

        img.src = path;
    }

    get(name){
        return this.images[name]?.loaded ? this.images[name].img : null;

    }

    async loadAll(){
        await Promise.all([
            this.load('player', playerImg, {priority: true})
        ]);
        //testing image loading
        //await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
