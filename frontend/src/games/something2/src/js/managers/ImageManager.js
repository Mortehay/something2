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
// How long nothing may be pending before the textures count as finished: chunks
// and creatures request their art in bursts right after the join. ONE rule for
// the "Loading textures…" chip and the Amber Stance ready signal, so the chip
// can never still be up when the client tells the server it is ready.
export const TEXTURES_QUIET_MS = 1000;

const defaultNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export class ImageManager{
    // `now` is the clock isQuiet() callers pass times from (performance.now).
    constructor(maxConcurrent = MAX_CONCURRENT_LOADS, retryDelayMs = RETRY_DELAY_MS, now = defaultNow){
        this.images = {};
        this.maxConcurrent = maxConcurrent;
        this.retryDelayMs = retryDelayMs;
        this._active = 0;
        this._queue = [];
        this._paused = false;
        // Lifetime counters for the preload screen: jobs created, and jobs that
        // have finished (loaded, or failed for good after the retry).
        this._total = 0;
        this._settled = 0;
        this._failed = 0;
        this._now = now;
        // When pending last became zero; null while anything is pending. Nothing
        // requested yet counts as idle from construction.
        this._idleSince = now();
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
        this._total++;
        this._idleSince = null;
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

    // SOMET-742. Holds back new requests; those in flight finish. The join frame
    // shares the player's link with these downloads and has a short timer.
    pause(){ this._paused = true; }

    resume(){
        this._paused = false;
        this._pump();
    }

    _pump(){
        while (!this._paused && this._active < this.maxConcurrent && this._queue.length > 0) {
            this._start(this._queue.shift());
        }
    }

    _start(job){
        const {name, path} = job;
        // A newer load() of this name (different path) replaced this job while it
        // waited: drop it rather than overwrite the newer record.
        const rec = this.images[name];
        if (!rec || rec.job !== job) { this._settleOne(); job.resolve(); return; }
        this._active++;
        const img = new Image();
        rec.img = img;
        const release = () => { this._active--; this._pump(); };
        const settle = () => {
            if (this.images[name] && this.images[name].job === job) this.images[name].job = null;
            this._settleOne();
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
                setTimeout(() => {
                    if (job.priority) this._queue.unshift(job); else this._queue.push(job);
                    this._pump();
                }, this.retryDelayMs);
                return;
            }
            this._failed++;
            console.error(`Failed to load image ${name}, will use fallback`);
            settle();
        };

        // SOMET-765. Art is served from the API origin, which may differ from
        // the page's; a plain load taints every canvas the image is drawn into
        // and makes any pixel read of it (walkAnchor) throw. The API sends
        // Access-Control-Allow-Origin + Vary: Origin for its allowed origins.
        img.crossOrigin = "anonymous";
        img.src = path;
    }

    _settleOne(){
        this._settled++;
        if (this._settled >= this._total) this._idleSince = this._now();
    }

    // True when nothing has been pending for at least `quietMs` up to `now`
    // (same clock as the constructor's `now`). Permanent failures count as
    // settled, as in stats().
    isQuiet(now, quietMs = TEXTURES_QUIET_MS){
        return this._idleSince !== null && now - this._idleSince >= quietMs;
    }

    // Progress of everything requested so far, for the first-entry preload screen.
    // `total` grows as chunks and creatures ask for more art, so a percentage is
    // "of what is known to be needed right now".
    stats(){
        return {total: this._total, settled: this._settled, failed: this._failed, pending: this._total - this._settled};
    }

    // SOMET-742. Resolves when the named images have landed or finally failed, or
    // at the limit, whichever is first. Still-queued ones go to the front in the
    // order asked, and stay at the front if they have to retry. An image past the limit keeps loading: the renderer's colour
    // fallback covers it until then. Names nothing asked for are not waited for.
    async whenSettled(names, {timeoutMs}){
        const jobs = names.map((n) => this.images[n]?.job).filter(Boolean);
        for (const job of [...jobs].reverse()) { job.priority = true; this._promote(job); }
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
