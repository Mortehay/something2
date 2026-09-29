// AudioEngine.js -- plain Web Audio playback for music + ambience (spec §3).
// Never throws into the frame: every failure is silence plus one warning per
// clip URL per session. Slice 3 adds an sfx bus beside these two.
import { API_URL } from '../../../../../config.js';
import { assetUrl } from '../net/assets.js';
import { resolveChain, pickWeighted, ambienceChain, musicChain } from './audioLookup.js';
import { sfxChains } from './sfxResolve.js';
import { SfxLimiter } from './sfxLimits.js';
import { NearbyScheduler } from './nearbyScheduler.js';
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
// Task 7 (spec §3 "Creature `nearby`" / "World point `nearby`"): Game.update
// calls tickNearby() every frame; this throttles the actual scheduling work.
const NEARBY_TICK_MS = 250;
// Fix round 1, item 4: a loop fades IN rather than popping to full gain the
// instant a point comes into range.
const NEARBY_LOOP_FADE_S = 0.75;

// A point (landmark/chest/merchant/bank) has no id in every source array, so
// a static marker is identified by its art + position instead -- stable
// across ticks since these don't move, and distinct enough in practice.
function nearbyPointId(p) {
  return p.id != null ? `pt:${p.id}` : `pt:${p.art}:${p.x}:${p.y}`;
}

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
    // Task 7: creature/world-point "nearby" ambience. The scheduler's own
    // maxVoices cap (separate from the limiter's global 12) applies ONLY to
    // creature one-shots and non-loopable world points -- cadence-driven
    // sounds that take turns. A loopable world point is presence-driven
    // instead (fix round 1, item 1): "one looping source per point while in
    // range" is not a turn to wait for, so it never occupies a scheduler
    // slot -- only the global 12-voice limiter (still at 'nearby' tier)
    // bounds how many can play at once. Without this split, a handful of
    // loopable points clustered together (a village's posts) would sit in
    // the scheduler's 4 slots for their entire time in range and starve
    // every creature and non-loopable point nearby.
    this.nearbyScheduler = new NearbyScheduler({ now: this.now, rand: this.rand });
    this.nearbyLoops = new Map();         // point emitter id -> {src, gain, voiceId, key} for a loop while in range
    // point emitter id -> boolean, cached the first time a point's binding
    // resolves, so later ticks don't have to re-resolve+pick just to learn
    // which path (loop vs scheduler cadence) it takes -- see tickNearby.
    this.nearbyPointLoopable = new Map();
    this.sfxVoiceEnded = new Map(); // voiceId -> extra "voice ended" hook (nearby cadence path only; see _fireVoiceEnded)
    this._lastNearbyTick = -Infinity;
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
    // The evicted voice may be a one-shot OR a still-looping nearby world
    // point (Task 7's eviction ruling lets 'own'/'nearest' bump a held
    // 'nearby' voice) -- _stopSfxOrLoopVoice checks both.
    if (evict != null) this._stopSfxOrLoopVoice(evict);
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
  // `onEnded` (Task 7 only) is an extra hook fired once this voice is truly
  // gone -- normal completion, a decode failure, or being stopped outright --
  // so the NearbyScheduler slot it occupies is freed no matter how it ends.
  // Own/nearest sfx events pass none, so _fireVoiceEnded is a no-op for them.
  async _startSfxVoice(voiceId, clip, dx, distance, onEnded) {
    if (onEnded) this.sfxVoiceEnded.set(voiceId, onEnded);
    this.sfxPending.add(voiceId);
    const buffer = await this._buffer(this.urlFor(clip.key));
    if (!this.sfxPending.delete(voiceId)) return; // cancelled while loading
    if (!this.ctx) { this.sfxLimiter.release(voiceId); this._fireVoiceEnded(voiceId); return; }
    if (!buffer) { this.sfxLimiter.release(voiceId); this.sfxStats.droppedTotal += 1; this._fireVoiceEnded(voiceId); return; }
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
      this._fireVoiceEnded(voiceId);
    };
    this.sfxVoices.set(voiceId, src);
    this.sfxStats.playedTotal += 1;
    src.start();
  }

  // Invokes and clears a voice's onEnded hook (see _startSfxVoice), if one
  // was registered. Centralized here so every termination path -- normal
  // completion, decode failure, cancelled-while-loading (via
  // _stopSfxVoice), a forced eviction, or a manual loop stop -- frees a
  // NearbyScheduler slot exactly once, however the voice actually ended.
  _fireVoiceEnded(voiceId) {
    const cb = this.sfxVoiceEnded.get(voiceId);
    if (!cb) return;
    this.sfxVoiceEnded.delete(voiceId);
    cb();
  }

  // Stops (or, if it is still loading, cancels) one voice. Used both for an
  // eviction and for a blanket stop -- the limiter has already forgotten
  // `voiceId` by the time this runs (admit() deletes an evicted voice
  // itself), so this only ever touches playback bookkeeping, never the
  // limiter's.
  _stopSfxVoice(voiceId) {
    if (this.sfxPending.delete(voiceId)) { this._fireVoiceEnded(voiceId); return; } // still loading -- the await guard in _startSfxVoice will now bail
    const src = this.sfxVoices.get(voiceId);
    this.sfxVoices.delete(voiceId);
    this._fireVoiceEnded(voiceId);
    if (!src) return;
    try { src.onended = null; src.stop(); } catch (_) { /* already stopped */ }
  }

  // Task 7: an eviction target may be a one-shot (tracked in sfxVoices /
  // sfxPending) or a still-looping nearby world point (tracked separately in
  // nearbyLoops, since a loop never fires its own onended) -- this is the one
  // place callers need to stop "whichever voice this id is", so they don't
  // have to know which map it lives in.
  _stopSfxOrLoopVoice(voiceId) {
    for (const [emitterId, loop] of this.nearbyLoops) {
      if (loop.voiceId === voiceId) { this._stopNearbyLoop(emitterId); return; }
    }
    this._stopSfxVoice(voiceId);
  }

  // Immediate stop (eviction, or a blanket stop on world change/destroy --
  // same "no fade" contract a one-shot eviction already has). Always frees
  // the limiter slot itself: unlike a one-shot, a loop never calls
  // sfxLimiter.release() on its own, so whoever stops it must. Loops never
  // touch NearbyScheduler (fix round 1, item 1 -- they are presence-driven,
  // not cadence-driven), so there is no scheduler slot to free here.
  _stopNearbyLoop(emitterId) {
    const loop = this.nearbyLoops.get(emitterId);
    if (!loop) return;
    this.nearbyLoops.delete(emitterId);
    try { loop.src.onended = null; loop.src.stop(); } catch { /* already stopped */ }
    this.sfxLimiter.release(loop.voiceId);
  }

  // Spec §3 "World point `nearby`": a loopable clip fades out on leaving the
  // radius -- unlike an eviction or a world change, an ordinary walk away
  // from it should not click off. The limiter slot is freed immediately (not
  // after the ramp finishes): the eviction rules already prefer bumping a
  // 'nearby' voice first, so a fading-out voice contending for its own slot
  // back would be an odd race to leave open.
  _fadeOutNearbyLoop(emitterId) {
    const loop = this.nearbyLoops.get(emitterId);
    if (!loop) return;
    this.nearbyLoops.delete(emitterId);
    try {
      loop.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      loop.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + FADE_S);
      loop.src.onended = null;
      loop.src.stop(this.ctx.currentTime + FADE_S);
    } catch { /* already stopped */ }
    this.sfxLimiter.release(loop.voiceId);
  }

  _stopAllSfx() {
    for (const voiceId of new Set([...this.sfxVoices.keys(), ...this.sfxPending])) this._stopSfxVoice(voiceId);
    for (const emitterId of [...this.nearbyLoops.keys()]) this._stopNearbyLoop(emitterId);
    // clear(), not a new instance (fix round 1, finding 1): voice ids must
    // stay monotonic across a reset. A voice from the world just left,
    // still awaiting its buffer at this exact moment, is already cancelled
    // above via sfxPending -- but a fresh SfxLimiter would also restart ids
    // at 1, letting that stale voice's id collide with (and later release)
    // an unrelated voice minted in the new world. Keeping the same limiter
    // and only clearing its bookkeeping closes that off structurally, not
    // just by timing.
    this.sfxLimiter.clear();
    // The scheduler's emitter ids are scoped to a world's creatures/(non-loop)
    // points and never reused across a world change, so a full reset (unlike
    // the limiter's) needs no monotonic-id argument -- it just drops stale
    // state. The loopable-ness cache is world-scoped too, for the same reason.
    this.nearbyScheduler.clear();
    this.nearbyPointLoopable.clear();
  }

  // Spec §3 "Creature `nearby`" / "World point `nearby`". Called every frame
  // from Game.update; throttled to 250ms here so a 60fps caller doesn't spam
  // this with duplicate work -- `pointsOrThunk` may be a plain array OR a
  // zero-arg function returning one (fix round 1, item 3): Game.js passes a
  // thunk so building the merged points list (several array spreads) only
  // happens on a tick that actually proceeds past the throttle, not on every
  // frame it's called from.
  //
  // `creatures` is the CreatureManager's raw Map (id -> {id, type, x, y,
  // width, height, ...}) -- a delta row without `type` yet (SOMET-354) is
  // skipped rather than producing a malformed binding key. Creature x/y are
  // the entity's TOP-LEFT corner (see CreatureManager / RenderSystem's
  // drawCreature comment), so the box centre is used for distance/pan, same
  // as Game.js already does for the player.
  //
  // Points resolve to one of two paths (fix round 1, item 1):
  //   - a LOOPABLE clip is presence-driven: one looping source per point
  //     while in range, started the moment it's seen and kept until it
  //     leaves -- it never occupies a NearbyScheduler slot, only the global
  //     12-voice limiter (at 'nearby' tier) bounds how many can play. This
  //     is the fix: it used to share the scheduler's 4-slot cap with
  //     creatures, so a village's handful of always-in-range loopable posts
  //     could starve every creature sound nearby (and a 5th such point could
  //     never get a source at all).
  //   - a NON-loopable clip behaves exactly like a creature: fed into the
  //     scheduler every tick, cadence-gated, sharing its 4-slot cap.
  // Which path a point takes is cached in nearbyPointLoopable the first time
  // its binding resolves, so a stable point doesn't re-resolve+pick every
  // tick just to learn which path it's already on.
  tickNearby(creatures, pointsOrThunk, listener, nowMs = this.now()) {
    if (!this.world) return;
    if (nowMs - this._lastNearbyTick < NEARBY_TICK_MS) return;
    this._lastNearbyTick = nowMs;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return; // same contract as playSfxEvents
    const points = typeof pointsOrThunk === 'function' ? pointsOrThunk() : pointsOrThunk;

    const cadenceEmitters = [];
    if (creatures) {
      for (const c of creatures.values()) {
        if (!c || !c.type || c.id == null) continue;
        const cx = c.x + (c.width || 0) / 2;
        const cy = c.y + (c.height || 0) / 2;
        cadenceEmitters.push({ id: `c:${c.id}`, key: `creature/${c.type}/nearby`, x: cx, y: cy, kind: 'creature' });
      }
    }

    const pointsById = new Map();
    for (const p of (points || [])) {
      if (!p || !p.art) continue;
      const id = nearbyPointId(p);
      pointsById.set(id, p);
      if (this.nearbyLoops.has(id)) continue; // already looping -- presence alone keeps it going; _sweepNearbyLoops handles leaving
      const dx = p.x - listener.x;
      const dy = p.y - listener.y;
      const distance = Math.hypot(dx, dy);
      if (distance > this.nearbyScheduler.radiusPx) continue; // out of range: nothing to (re)start
      const key = `world_point/${p.art}/nearby`;
      if (this.nearbyPointLoopable.get(id) === false) {
        cadenceEmitters.push({ id, key, x: p.x, y: p.y, kind: 'point' });
        continue;
      }
      // Cached true, or not yet known -- resolve+pick to (re)start the loop,
      // or, on first sighting, to learn which path this point takes at all.
      const { clips, key: resolvedKey } = this._resolve([key]); // records the miss itself when unbound
      const clip = resolvedKey ? pickWeighted(clips, this.rand) : null;
      if (!clip) continue; // unresolved -- retry next tick
      this.nearbyPointLoopable.set(id, Boolean(clip.loopable));
      if (clip.loopable) this._startNearbyLoop(id, clip, dx, distance);
      else cadenceEmitters.push({ id, key, x: p.x, y: p.y, kind: 'point' });
    }

    for (const d of this.nearbyScheduler.tick(cadenceEmitters, listener)) {
      try {
        this._triggerNearby(d, listener);
      } catch (err) {
        this._warn('nearby-event', `[audio] nearby event failed: ${err.message}`);
        this.nearbyScheduler.ended(d.id);
      }
    }
    this._sweepNearbyLoops(pointsById, listener);
  }

  // Cadence path only (creatures and non-loopable points) -- a loopable
  // point never reaches here; see tickNearby.
  _triggerNearby(d, listener) {
    const { clips, key } = this._resolve([d.key]); // records the miss itself when unbound
    const clip = key ? pickWeighted(clips, this.rand) : null;
    if (!clip) { this.nearbyScheduler.ended(d.id); return; }
    const dx = d.x - listener.x;
    const dy = d.y - listener.y;
    const distance = Math.hypot(dx, dy);
    const { ok, evict, voiceId } = this.sfxLimiter.admit({ clipKey: clip.key, priority: 'nearby', distance });
    if (!ok) { this.nearbyScheduler.ended(d.id); this.sfxStats.droppedTotal += 1; return; }
    if (evict != null) this._stopSfxOrLoopVoice(evict);
    this._startSfxVoice(voiceId, clip, dx, distance, () => this.nearbyScheduler.ended(d.id));
  }

  // Presence-driven path (fix round 1, item 1): no NearbyScheduler slot
  // involved at all -- only the global limiter, at 'nearby' tier, bounds it.
  _startNearbyLoop(emitterId, clip, dx, distance) {
    const { ok, evict, voiceId } = this.sfxLimiter.admit({ clipKey: clip.key, priority: 'nearby', distance });
    if (!ok) { this.sfxStats.droppedTotal += 1; return; } // retried next tick -- still in range, still not in nearbyLoops
    if (evict != null) this._stopSfxOrLoopVoice(evict);
    this._startNearbyLoopVoice(emitterId, voiceId, clip, dx, distance);
  }

  // Mirrors _startSfxVoice's pending-cancellation guard exactly (same reason:
  // an eviction or a world change while the buffer is still loading must
  // stop this from ever starting), but builds a LOOPING source into
  // nearbyLoops instead of the one-shot sfxVoices map, since this clip never
  // ends on its own -- only _stopNearbyLoop / _fadeOutNearbyLoop end it.
  async _startNearbyLoopVoice(emitterId, voiceId, clip, dx, distance) {
    this.sfxPending.add(voiceId);
    const buffer = await this._buffer(this.urlFor(clip.key));
    if (!this.sfxPending.delete(voiceId)) return; // cancelled (evicted) while loading
    if (!this.ctx) { this.sfxLimiter.release(voiceId); return; }
    if (!buffer) { this.sfxLimiter.release(voiceId); this.sfxStats.droppedTotal += 1; return; }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    const vol = typeof clip.volume === 'number' ? clip.volume : 1;
    const falloff = Math.max(0, 1 - distance / SFX_FALLOFF_PX);
    const target = vol * falloff;
    // Fix round 1, item 4: fade IN rather than popping to full gain the
    // instant the point comes into range -- same pattern _play() already
    // uses for music/ambience.
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(target, this.ctx.currentTime + NEARBY_LOOP_FADE_S);
    panner.pan.value = Math.max(-1, Math.min(1, dx / SFX_PAN_PX));
    src.connect(panner);
    panner.connect(gain);
    gain.connect(this.bus.sfx);
    this.nearbyLoops.set(emitterId, { src, gain, voiceId, key: clip.key });
    this.sfxStats.playedTotal += 1;
    src.start();
  }

  // A loop never leaves the AOI on its own (no onended), so each tick checks
  // every currently-looping point against the latest positions: gone from
  // `points` entirely, or still present but now beyond the scheduler's
  // radius, both fade it out the same way.
  _sweepNearbyLoops(pointsById, listener) {
    for (const emitterId of [...this.nearbyLoops.keys()]) {
      const p = pointsById.get(emitterId);
      const stillNear = p && Math.hypot((p.x || 0) - listener.x, (p.y || 0) - listener.y) <= this.nearbyScheduler.radiusPx;
      if (!stillNear) this._fadeOutNearbyLoop(emitterId);
    }
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
