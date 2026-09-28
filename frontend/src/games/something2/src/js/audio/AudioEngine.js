// AudioEngine.js -- plain Web Audio playback for music + ambience (spec §3).
// Never throws into the frame: every failure is silence plus one warning per
// clip URL per session. Slice 3 adds an sfx bus beside these two.
import { API_URL } from '../../../../../config.js';
import { assetUrl } from '../net/assets.js';
import { resolveChain, pickWeighted, ambienceChain, musicChain } from './audioLookup.js';
import { BiomeTracker } from './biomeTracker.js';
import { MissLog } from './missLog.js';
import { DEFAULT_VOLUMES } from './audioSettings.js';
import { postMisses as defaultPostMisses } from './audioClient.js';

const FADE_S = 2;
const BIOME_SAMPLE_MS = 500;
const MUSIC_GAP_MS = [3000, 8000];

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
    this.bus = { master: g(), music: g(), ambience: g() };
    this.bus.music.connect(this.bus.master);
    this.bus.ambience.connect(this.bus.master);
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
      gains: this.bus ? { master: this.bus.master.gain.value, music: this.bus.music.gain.value, ambience: this.bus.ambience.gain.value } : null,
    };
  }

  destroy() {
    this._stop('music');
    this._stop('ambience');
    this.flushMisses();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.bus = null;
  }
}
