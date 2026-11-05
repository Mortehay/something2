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
    //
    // Asking for a name that is already loaded, queued or in flight FROM THE SAME
    // PATH is a no-op that returns the existing promise. Every world transition
    // re-requests every tile and creature image; resetting the entry on each call
    // threw away images that were already on screen and re-queued them behind the
    // whole catalogue (the renderer fell back to boxes until they came back), and
    // a duplicate request let the first Image's onload mark the second record.
    // A DIFFERENT path under the same name (re-approved art) does reload, and an
    // entry that finally failed is retried by the next call.
    load(name, path, {priority = false} = {}){
        const cur = this.images[name];
        if (cur && cur.path === path && (cur.loaded || cur.job)) {
            if (cur.loaded) return Promise.resolve();
            if (priority) this._promote(cur.job);
            return cur.job.promise;
        }
        const job = {name, path, retried:false};
        job.promise = new Promise((resolve) => { job.resolve = resolve; });
        this.images[name] = {img: null, loaded:false, path, job};
        if (priority) this._queue.unshift(job); else this._queue.push(job);
        this._pump();
        return job.promise;
    }

    // Move a still-queued job to the front. A job already in flight is left alone.
    _promote(job){
        const i = this._queue.indexOf(job);
        if (i > 0) { this._queue.splice(i, 1); this._queue.unshift(job); }
    }

    _pump(){
        while (this._active < this.maxConcurrent && this._queue.length > 0) {
            this._start(this._queue.shift());
        }
    }

    _start(job){
        const {name, path} = job;
        // A newer load() of this name (different path) replaced this job while it
        // waited: drop it rather than overwrite the newer record.
        const rec = this.images[name];
        if (!rec || rec.job !== job) { job.resolve(); return; }
        this._active++;
        const img = new Image();
        rec.img = img;
        const release = () => { this._active--; this._pump(); };
        const settle = () => {
            if (this.images[name] && this.images[name].job === job) this.images[name].job = null;
            job.resolve();
        };

        img.onload = () => {
            if (this.images[name] && this.images[name].job === job) this.images[name].loaded = true;
            release();
            settle();
        };

        img.onerror = () => {
            release();
            if (!job.retried) {
                job.retried = true;
                setTimeout(() => { this._queue.push(job); this._pump(); }, this.retryDelayMs);
                return;
            }
            console.error(`Failed to load image ${name}, will use fallback`);
            settle();
        };

        img.src = path;
    }

    // SOMET-742. Resolves when the named images have landed or finally failed, or
    // at the limit, whichever is first. Still-queued ones go to the front in the
    // order asked. An image past the limit keeps loading: the renderer's colour
    // fallback covers it until then. Names nothing asked for are not waited for.
    async whenSettled(names, {timeoutMs}){
        const jobs = names.map((n) => this.images[n]?.job).filter(Boolean);
        for (const job of [...jobs].reverse()) this._promote(job);
        if (jobs.length === 0) return {timedOut:false};
        let timer;
        const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({timedOut:true}), timeoutMs); });
        const settled = Promise.all(jobs.map((j) => j.promise)).then(() => ({timedOut:false}));
        const result = await Promise.race([settled, limit]);
        clearTimeout(timer);
        return result;
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
