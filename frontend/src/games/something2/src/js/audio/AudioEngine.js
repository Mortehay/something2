// AudioEngine.js -- plain Web Audio playback for music + ambience (spec §3).
// Never throws into the frame: every failure is silence plus one warning per
// clip URL per session. Slice 3 adds an sfx bus beside these two.
import { API_URL } from '../../../../../config.js';
import { assetUrl } from '../net/assets.js';
import { resolveChain, pickWeighted, ambienceChain, musicChain } from './audioLookup.js';
import { sfxChains } from './sfxResolve.js';
import { SfxLimiter } from './sfxLimits.js';
import { BiomeTracker } from './biomeTracker.js';
import { MissLog } from './missLog.js';
import { DEFAULT_VOLUMES } from './audioSettings.js';
import { postMisses as defaultPostMisses } from './audioClient.js';

const FADE_S = 2;
const BIOME_SAMPLE_MS = 500;
const MUSIC_GAP_MS = [3000, 8000];
// Spec §3 "Limits": linear falloff, silent at and beyond this distance, and
// full pan left/right by this many px either side of the listener.
const SFX_FALLOFF_PX = 1600;
const SFX_PAN_PX = 600;

export class AudioEngine {
  constructor({
    ctxFactory = () => new AudioContext(),
    fetchBytes = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
    urlFor = (key) => assetUrl(API_URL, key),
    now = () => performance.now(),
    rand = Math.random,
    postMisses = defaultPostMisses,
  } = {}) {
    Object.assign(this, { ctxFactory, fetchBytes, urlFor, now, rand, postMisses });
    this.ctx = null;
    this.buffers = new Map();   // url -> Promise<AudioBuffer|null>
    this.warned = new Set();
    this.misses = new MissLog();
    this.tracker = new BiomeTracker({ holdMs: 1500 });
    this.world = null;
    this.bindings = {};
    this.biome = null;
    this.lastBiomeSample = -Infinity;
    this.vol = { ...DEFAULT_VOLUMES };
    this.channels = { music: { key: null, node: null, gain: null }, ambience: { key: null, node: null, gain: null } };
    this.musicTimer = null;
    this.sfxLimiter = new SfxLimiter({ now: this.now });
    this.sfxVoices = new Map();     // voiceId -> BufferSourceNode, STARTED and currently playing
    this.sfxPending = new Set();    // voiceId, admitted but still awaiting its buffer -- see _startSfxVoice
    this.sfxStats = { playedTotal: 0, droppedTotal: 0 };
  }

  _ensureCtx() {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = this.ctxFactory();
    } catch (err) {
      this._warn('ctx', `[audio] Web Audio unavailable: ${err.message}`);
      return null;
    }
    const g = () => this.ctx.createGain();
    this.bus = { master: g(), music: g(), ambience: g(), sfx: g() };
    this.bus.music.connect(this.bus.master);
    this.bus.ambience.connect(this.bus.master);
    this.bus.sfx.connect(this.bus.master);
    this.bus.master.connect(this.ctx.destination);
    this._applyGains();
    return this.ctx;
  }

  _warn(key, msg) { if (!this.warned.has(key)) { this.warned.add(key); console.warn(msg); } }

  _applyGains() {
    if (!this.bus) return;
    this.bus.master.gain.value = this.vol.muted ? 0 : this.vol.master;
    this.bus.music.gain.value = this.vol.music;
    this.bus.ambience.gain.value = this.vol.ambience;
    this.bus.sfx.gain.value = this.vol.sfx;
  }

  setVolumes(v) { this.vol = { ...this.vol, ...v }; this._ensureCtx(); this._applyGains(); }
  volumes() { return { ...this.vol }; }

  // Fix (review round 1, SOMET-590): unlock() ONLY creates/resumes the
  // context. It used to also (re)start music whenever no music key was
  // set, but Game calls unlock() on every keydown/mousedown -- so a key
  // pressed during the post-track gap (key=null, musicTimer armed) or
  // while a clip's buffer is still loading (key not yet set) re-picked
  // and re-fetched a clip on every press. setWorld already starts music
  // on a world change, and _play already creates the context lazily, so
  // this never needed to do it too.
  unlock() {
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  setWorld({ world, bindings }) {
    this.world = world;
    this.bindings = bindings || {};
    this.tracker = new BiomeTracker({ holdMs: 1500 });
    this.biome = null;
    this.worldAmbienceTried = false;
    this.lastBiomeSample = -Infinity;
    this._stop('ambience');
    this._stop('music');
    this._stopAllSfx();
    if (world) this._startMusic();
  }

  tick(biome, nowMs = this.now()) {
    if (!this.world || nowMs - this.lastBiomeSample < BIOME_SAMPLE_MS) return;
    this.lastBiomeSample = nowMs;
    const committed = this.tracker.sample(biome, nowMs);
    if (committed !== undefined) { this.biome = committed; this._switchAmbience(); return; }
    // null (loaded chunk, no biome grid) before any biome has been committed:
    // a biome-less world. Resolve world ambience once (plays it, or logs its
    // miss). undefined (chunk not loaded) decides nothing, and once a biome
    // has played a null keeps the current ambience via the tracker.
    if (biome === null && this.tracker.current === undefined && !this.worldAmbienceTried) {
      this.worldAmbienceTried = true;
      this._switchAmbience();
    }
  }

  _resolve(chain) {
    const r = resolveChain(this.bindings, chain);
    if (!r.key) this.misses.record(r.missKey, this.world);
    return r;
  }

  // Spec §3 "Triggers" / "Limits". `events` is the wire `frame.sfx` list (may
  // be undefined/empty on a quiet tick); `listener` is where the player is
  // (world px) and `ownActor` is this client's own `p:<uid>` actor key, used
  // to give the player's own actions priority over everyone else's. Never
  // throws into the caller -- Game._onWorldState calls this every frame, and
  // one bad event must not break the render loop; a failure here is silence
  // plus one warning, same contract as everything else in this file.
  //
  // Fix round 1, finding 4 (promoted ruling): nothing plays while the
  // context is not 'running' -- e.g. suspended before the Play-click
  // gesture. A BufferSourceNode scheduled on a suspended context never
  // advances and never fires onended, so admitting it would occupy a voice
  // slot (and a same-clip throttle slot) forever; skipping here means no
  // admit and no fetch happen at all until the context actually resumes.
  playSfxEvents(events, { listener, ownActor } = {}) {
    if (!Array.isArray(events) || events.length === 0) return;
    const ctx = this._ensureCtx();
    if (!ctx || ctx.state !== 'running') return;
    for (const ev of events) {
      try {
        this._playSfxEvent(ev, listener || { x: 0, y: 0 }, ownActor);
      } catch (err) {
        this._warn('sfx-event', `[audio] sfx event failed: ${err.message}`);
      }
    }
  }

  _playSfxEvent(ev, listener, ownActor) {
    for (const { keys } of sfxChains(ev)) {
      const { clips, key } = this._resolve(keys);
      if (!key) continue; // miss already recorded by _resolve
      const clip = pickWeighted(clips, this.rand);
      if (!clip) continue;
      this._triggerSfx(clip, ev, listener, ownActor);
    }
  }

  _triggerSfx(clip, ev, listener, ownActor) {
    const dx = (ev.x || 0) - listener.x;
    const dy = (ev.y || 0) - listener.y;
    const distance = Math.hypot(dx, dy);
    // Fix round 1, finding 2: beyond the falloff edge a clip would play at
    // gain 0 anyway, so cull it before it can take a voice slot or a
    // same-clip throttle slot, and before it fetches anything.
    if (distance >= SFX_FALLOFF_PX) return;
    const priority = ownActor && ev.a === ownActor ? 'own' : 'nearest';
    const { ok, evict, voiceId } = this.sfxLimiter.admit({ clipKey: clip.key, priority, distance });
    if (!ok) { this.sfxStats.droppedTotal += 1; return; }
    if (evict != null) this._stopSfxVoice(evict);
    this._startSfxVoice(voiceId, clip, dx, distance);
  }

  // Fix round 1, finding 1. Marked pending BEFORE the await (synchronous, so
  // there is no gap for a same-tick eviction or a setWorld to miss it), and
  // the pending set is checked again straight after: _stopSfxVoice() (called
  // by an eviction) or _stopAllSfx() (called by setWorld/destroy) may have
  // cancelled this voice, in the real sense of "make sure it never starts",
  // while the buffer was loading. Starting it anyway after that point would
  // let a voice the limiter (and the player) already believes is gone
  // occupy a slot -- or, worse, keep playing into a world it no longer
  // belongs to.
  async _startSfxVoice(voiceId, clip, dx, distance) {
    this.sfxPending.add(voiceId);
    const buffer = await this._buffer(this.urlFor(clip.key));
    if (!this.sfxPending.delete(voiceId)) return; // cancelled while loading
    if (!this.ctx) { this.sfxLimiter.release(voiceId); return; }
    if (!buffer) { this.sfxLimiter.release(voiceId); this.sfxStats.droppedTotal += 1; return; }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    const vol = typeof clip.volume === 'number' ? clip.volume : 1;
    const falloff = Math.max(0, 1 - distance / SFX_FALLOFF_PX);
    gain.gain.value = vol * falloff;
    panner.pan.value = Math.max(-1, Math.min(1, dx / SFX_PAN_PX));
    src.connect(panner);
    panner.connect(gain);
    gain.connect(this.bus.sfx);
    src.onended = () => {
      this.sfxVoices.delete(voiceId);
      this.sfxLimiter.release(voiceId);
    };
    this.sfxVoices.set(voiceId, src);
    this.sfxStats.playedTotal += 1;
    src.start();
  }

  // Stops (or, if it is still loading, cancels) one voice. Used both for an
  // eviction and for a blanket stop -- the limiter has already forgotten
  // `voiceId` by the time this runs (admit() deletes an evicted voice
  // itself), so this only ever touches playback bookkeeping, never the
  // limiter's.
  _stopSfxVoice(voiceId) {
    if (this.sfxPending.delete(voiceId)) return; // still loading -- the await guard in _startSfxVoice will now bail
    const src = this.sfxVoices.get(voiceId);
    this.sfxVoices.delete(voiceId);
    if (!src) return;
    try { src.onended = null; src.stop(); } catch (_) { /* already stopped */ }
  }

  _stopAllSfx() {
    for (const voiceId of new Set([...this.sfxVoices.keys(), ...this.sfxPending])) this._stopSfxVoice(voiceId);
    // clear(), not a new instance (fix round 1, finding 1): voice ids must
    // stay monotonic across a reset. A voice from the world just left,
    // still awaiting its buffer at this exact moment, is already cancelled
    // above via sfxPending -- but a fresh SfxLimiter would also restart ids
    // at 1, letting that stale voice's id collide with (and later release)
    // an unrelated voice minted in the new world. Keeping the same limiter
    // and only clearing its bookkeeping closes that off structurally, not
    // just by timing.
    this.sfxLimiter.clear();
  }

  _startMusic() {
    if (!this.world) return;
    const { clips } = this._resolve(musicChain(this.world));
    const clip = pickWeighted(clips, this.rand);
    if (clip) this._play('music', clip, { loop: false });
  }

  _switchAmbience() {
    const { clips, key } = this._resolve(ambienceChain(this.world, this.biome));
    if (key && this.channels.ambience.chainKey === key) return;   // same source already playing
    const clip = pickWeighted(clips, this.rand);
    this.channels.ambience.chainKey = key;
    if (!clip) { this._stop('ambience'); return; }
    this._play('ambience', clip, { loop: true });
  }

  async _buffer(url) {
    if (!this.buffers.has(url)) {
      this.buffers.set(url, (async () => {
        try {
          const bytes = await this.fetchBytes(url);
          return await this.ctx.decodeAudioData(bytes);
        } catch (err) {
          this._warn(url, `[audio] could not load ${url}: ${err.message}`);
          return null;
        }
      })());
    }
    return this.buffers.get(url);
  }

  async _play(channel, clip, { loop }) {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const ch = this.channels[channel];
    const token = Symbol(channel);
    ch.pending = token;
    const buffer = await this._buffer(this.urlFor(clip.key));
    if (ch.pending !== token) return;            // superseded while loading
    if (!buffer) { this._stop(channel); return; }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (loop) {
      src.loop = true;
      if (clip.loop_end_ms > 0) {
        src.loopStart = (clip.loop_start_ms || 0) / 1000;
        src.loopEnd = clip.loop_end_ms / 1000;
      }
    }
    const gain = ctx.createGain();
    const target = typeof clip.volume === 'number' ? clip.volume : 1;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(target, ctx.currentTime + FADE_S);
    src.connect(gain);
    gain.connect(this.bus[channel]);
    this._fadeOut(ch);
    Object.assign(ch, { key: clip.key, node: src, gain });
    if (channel === 'music') {
      src.onended = () => {
        if (ch.node !== src) return;
        ch.key = null; ch.node = null;
        const [lo, hi] = MUSIC_GAP_MS;
        this.musicTimer = setTimeout(() => this._startMusic(), lo + this.rand() * (hi - lo));
      };
    }
    src.start();
  }

  _fadeOut(ch) {
    if (!ch.node || !this.ctx) return;
    const { node, gain } = ch;
    try {
      gain.gain.cancelScheduledValues(this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + FADE_S);
      node.onended = null;
      node.stop(this.ctx.currentTime + FADE_S);
    } catch (_) { /* already stopped */ }
  }

  _stop(channel) {
    const ch = this.channels[channel];
    ch.pending = null;
    this._fadeOut(ch);
    Object.assign(ch, { key: null, node: null, gain: null, chainKey: undefined });
    if (channel === 'music' && this.musicTimer) { clearTimeout(this.musicTimer); this.musicTimer = null; }
  }

  async flushMisses() { await this.postMisses(this.misses.drain()); }

  snapshot() {
    const ch = (c) => ({ key: this.channels[c].key, playing: Boolean(this.channels[c].node) });
    return {
      state: this.ctx ? this.ctx.state : 'none',
      world: this.world,
      biome: this.biome,
      music: ch('music'),
      ambience: ch('ambience'),
      sfx: { voices: this.sfxVoices.size, playedTotal: this.sfxStats.playedTotal, droppedTotal: this.sfxStats.droppedTotal },
      gains: this.bus ? { master: this.bus.master.gain.value, music: this.bus.music.gain.value, ambience: this.bus.ambience.gain.value, sfx: this.bus.sfx.gain.value } : null,
    };
  }

  destroy() {
    this._stop('music');
    this._stop('ambience');
    this._stopAllSfx();
    this.flushMisses();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.bus = null;
  }
}
