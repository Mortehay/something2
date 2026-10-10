import { describe, it, expect, vi } from 'vitest';
import { AudioEngine } from '../AudioEngine.js';

function fakeCtx() {
  const sources = [];
  const ctx = {
    state: 'suspended', currentTime: 0, destination: { name: 'dest' },
    resume() { this.state = 'running'; return Promise.resolve(); },
    close() { this.state = 'closed'; return Promise.resolve(); },
    createGain() {
      return { gain: { value: 1, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; }, cancelScheduledValues() {} },
        connect(n) { this.out = n; }, disconnect() { this.out = null; } };
    },
    createStereoPanner() {
      return { pan: { value: 0 }, connect(n) { this.out = n; }, disconnect() { this.out = null; } };
    },
    createBufferSource() {
      const s = { buffer: null, loop: false, loopStart: 0, loopEnd: 0, started: false, stopped: false, onended: null,
        connect(n) { this.out = n; }, disconnect() {}, start() { this.started = true; }, stop(t) { this.stopped = true; this.stopAt = t; } };
      sources.push(s);
      return s;
    },
    decodeAudioData: async (ab) => ({ duration: 2, tag: new TextDecoder().decode(ab) }),
  };
  return { ctx, sources };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function engineWith(bindings, { posted = [] } = {}) {
  const { ctx, sources } = fakeCtx();
  const engine = new AudioEngine({
    ctxFactory: () => ctx,
    fetchBytes: async (url) => new TextEncoder().encode(url).buffer,
    urlFor: (k) => `u:${k}`,
    rand: () => 0,
    postMisses: async (m) => { posted.push(...m); },
  });
  engine.setWorld({ world: 'vale', bindings });
  return { engine, ctx, sources, posted };
}

describe('AudioEngine', () => {
  it('plays world music and biome ambience on their own buses', async () => {
    const { engine, sources } = engineWith({
      'world/vale/music': [{ key: 'm.ogg', volume: 1, weight: 1, loopable: true }],
      'biome/forest/ambience': [{ key: 'f.ogg', volume: 0.5, weight: 1, loopable: true, loop_start_ms: 0, loop_end_ms: 1500 }],
    });
    engine.unlock();
    engine.tick('forest', 0);
    await flush(); await flush();
    const snap = engine.snapshot();
    expect(snap.music).toMatchObject({ key: 'm.ogg', playing: true });
    expect(snap.ambience).toMatchObject({ key: 'f.ogg', playing: true });
    const amb = sources.find((s) => s.buffer && s.buffer.tag === 'u:f.ogg');
    expect(amb.loop).toBe(true);
    expect(amb.loopEnd).toBe(1.5);
  });

  it('falls back to world ambience, and logs + posts one miss when nothing is bound', async () => {
    const { engine, posted } = engineWith({});
    engine.unlock();
    engine.tick('desert', 0);
    engine.tick('desert', 600);
    await flush();
    expect(engine.snapshot().ambience.playing).toBe(false);
    await engine.flushMisses();
    expect(posted).toEqual([
      { subject_kind: 'world', subject_key: 'vale', slot: 'music', world: 'vale' },
      { subject_kind: 'biome', subject_key: 'desert', slot: 'ambience', world: 'vale' },
    ]);
  });

  // Final review F6 (SOMET-590): biomeAt says undefined for "chunk not
  // loaded yet" and null for "loaded, no biome grid". A world with no biomes
  // only ever samples null, which the tracker ignores -- so world ambience
  // never played and never logged a miss. The first null now resolves the
  // world-level ambience once.
  it('a world without biomes plays its world ambience (null sample = loaded chunk, no grid)', async () => {
    const { engine } = engineWith({
      'world/vale/ambience': [{ key: 'w.ogg', volume: 1, weight: 1, loopable: true }],
    });
    engine.unlock();
    engine.tick(undefined, 0);            // chunk not loaded yet: nothing decided
    await flush(); await flush();
    expect(engine.snapshot().ambience.playing).toBe(false);
    engine.tick(null, 600);               // loaded, no biome grid: world fallback
    await flush(); await flush();
    expect(engine.snapshot().ambience).toMatchObject({ key: 'w.ogg', playing: true });
  });

  it('a world without biomes and no world ambience logs the world ambience miss', async () => {
    const { engine, posted } = engineWith({});
    engine.tick(null, 0);
    await engine.flushMisses();
    expect(posted).toContainEqual({ subject_kind: 'world', subject_key: 'vale', slot: 'ambience', world: 'vale' });
  });

  it('once a biome has played, a null sample keeps the current ambience', async () => {
    const { engine } = engineWith({
      'world/vale/ambience': [{ key: 'w.ogg', volume: 1, weight: 1, loopable: true }],
      'biome/forest/ambience': [{ key: 'f.ogg', volume: 1, weight: 1, loopable: true }],
    });
    engine.unlock();
    engine.tick('forest', 0);
    await flush(); await flush();
    engine.tick(null, 600);
    await flush(); await flush();
    expect(engine.snapshot().ambience).toMatchObject({ key: 'f.ogg', playing: true });
  });

  it('a biome with no clips falls back to the bound world ambience', async () => {
    const { engine, posted } = engineWith({
      'world/vale/ambience': [{ key: 'w.ogg', volume: 1, weight: 1, loopable: true }],
    });
    engine.unlock();
    engine.tick('desert', 0);
    await flush(); await flush();
    expect(engine.snapshot().ambience).toMatchObject({ key: 'w.ogg', playing: true });
    await engine.flushMisses();
    expect(posted.some((m) => m.slot === 'ambience')).toBe(false);
  });

  it('SOMET-605: a boss phase one-shot holds its voice against creature chatter, and an own swing still lands', async () => {
    const { engine, sources } = engineWith({
      'creature/Ignis/phase': [{ key: 'ignis-phase.ogg', volume: 1, weight: 1 }],
      'creature/slime/hurt': [{ key: 'slime-hurt.ogg', volume: 1, weight: 1 }],
      'item/Iron Sword/use': [{ key: 'sword.ogg', volume: 1, weight: 1 }],
    });
    engine.unlock();
    engine.sfxLimiter.maxVoices = 1;
    const opts = { listener: { x: 0, y: 0 }, ownActor: 'p:1' };
    engine.playSfxEvents([{ e: 'phase', c: 'Ignis', a: 'c:wb_1', x: 900, y: 0 }], opts);
    await flush(); await flush();
    expect(sources.map((s) => s.buffer.tag)).toEqual(['u:ignis-phase.ogg']);
    engine.playSfxEvents([{ e: 'hurt', c: 'slime', x: 0, y: 0 }], opts);
    await flush(); await flush();
    expect(sources.length).toBe(1);
    expect(sources[0].stopped).toBe(false);
    engine.playSfxEvents([{ e: 'use', k: 'melee', s: 'Iron Sword', a: 'p:1', x: 0, y: 0 }], opts);
    await flush(); await flush();
    expect(sources[0].stopped).toBe(true);
    expect(sources[1].buffer.tag).toBe('u:sword.ogg');
  });

  it('mute and volumes drive the master and bus gains', () => {
    const { engine } = engineWith({});
    engine.setVolumes({ master: 0.5, music: 0.2, ambience: 1, sfx: 1, muted: true });
    expect(engine.snapshot().gains).toMatchObject({ master: 0, music: 0.2, ambience: 1 });
    engine.setVolumes({ master: 0.5, music: 0.2, ambience: 1, sfx: 1, muted: false });
    expect(engine.snapshot().gains.master).toBe(0.5);
  });

  it('a decode failure is silence plus a warning, never a throw', async () => {
    const { ctx, sources } = fakeCtx();
    ctx.decodeAudioData = async () => { throw new Error('bad data'); };
    const engine = new AudioEngine({ ctxFactory: () => ctx, fetchBytes: async () => new ArrayBuffer(4), urlFor: (k) => k, rand: () => 0, postMisses: async () => {} });
    engine.setWorld({ world: 'vale', bindings: { 'world/vale/music': [{ key: 'x.ogg', weight: 1, volume: 1 }] } });
    engine.unlock();
    await flush(); await flush();
    expect(engine.snapshot().music.playing).toBe(false);
    expect(sources.every((s) => !s.started)).toBe(true);
  });

  // Review round 1 (SOMET-590): unlock() used to also call _startMusic()
  // whenever no music key was set. Game calls unlock() on every
  // keydown/mousedown, so a key pressed during the post-track gap (key=null,
  // musicTimer armed) -- or while a clip's buffer was still loading -- kept
  // re-picking and re-fetching a clip on every press. Fix: unlock() only
  // creates/resumes the context; only the rotation timer (or setWorld) may
  // start a clip.
  it('unlock() does not restart music mid-gap, and only the rotation timer starts the next clip', async () => {
    vi.useFakeTimers();
    try {
      const { engine, sources } = engineWith({
        'world/vale/music': [{ key: 'm.ogg', volume: 1, weight: 1, loopable: true }],
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(engine.snapshot().music).toMatchObject({ key: 'm.ogg', playing: true });
      expect(sources.length).toBe(1);

      // The clip ends: onended clears the key and arms the 3-8s rotation
      // timer (rand=0 -> exactly the 3000ms floor here).
      sources[0].onended();
      expect(engine.snapshot().music.playing).toBe(false);

      // Keys/clicks during the gap used to force a restart (or a re-fetch
      // if a buffer was still loading). They must now be a no-op for
      // playback -- only unlock()'s own ctx create/resume happens.
      engine.unlock();
      engine.unlock();
      engine.unlock();
      await vi.advanceTimersByTimeAsync(0);
      expect(sources.length).toBe(1);
      expect(engine.snapshot().music.playing).toBe(false);

      // Only the armed timer, once the full gap has elapsed, starts the
      // next clip.
      await vi.advanceTimersByTimeAsync(8000);
      expect(sources.length).toBe(2);
      expect(engine.snapshot().music).toMatchObject({ key: 'm.ogg', playing: true });
    } finally {
      vi.useRealTimers();
    }
  });

  // Review round 1 (SOMET-590): on a world transition (second initChunked
  // on the same Game), the engine used to keep the OLD world's bindings
  // until the async fetchWorldAudio resolved, so old music/rotation could
  // keep playing into the new world. Game.initChunked now synchronously
  // drops to a null world first; this is the engine-level contract that
  // relies on.
  it('setWorld to a null world stops both channels, clears any pending rotation timer, and records no miss for the null world', async () => {
    vi.useFakeTimers();
    try {
      const { engine, sources, posted } = engineWith({
        'world/vale/music': [{ key: 'm.ogg', volume: 1, weight: 1, loopable: true }],
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(engine.snapshot().music).toMatchObject({ key: 'm.ogg', playing: true });

      engine.setWorld({ world: null, bindings: {} });
      expect(engine.snapshot()).toMatchObject({
        world: null,
        music: { key: null, playing: false },
        ambience: { key: null, playing: false },
      });

      // No rotation timer survives the switch -- advancing well past the
      // max gap must not start a new source.
      await vi.advanceTimersByTimeAsync(9000);
      expect(sources.length).toBe(1);
      expect(engine.snapshot().music.playing).toBe(false);

      await engine.flushMisses();
      expect(posted).toEqual([]); // the clip resolved fine; none recorded, and none for the null world either
    } finally {
      vi.useRealTimers();
    }
  });

  describe('playSfxEvents', () => {
    it('a bound use event starts one source on the sfx bus with pan and gain set from position', async () => {
      const { engine, sources } = engineWith({
        'item/Iron Sword/use': [{ key: 'sword-use.ogg', volume: 0.8, weight: 1 }],
      });
      engine.unlock();
      engine.playSfxEvents(
        [{ e: 'use', k: 'melee', s: 'Iron Sword', a: 'p:1', x: 100, y: 0 }],
        { listener: { x: 0, y: 0 }, ownActor: 'p:1' },
      );
      await flush(); await flush();
      expect(sources.length).toBe(1);
      const src = sources[0];
      expect(src.buffer.tag).toBe('u:sword-use.ogg');
      expect(src.started).toBe(true);
      // src -> panner -> gain -> bus.sfx (see AudioEngine#_startSfxVoice)
      const panner = src.out;
      const gain = panner.out;
      expect(panner.pan.value).toBeCloseTo(100 / 600, 5);
      expect(gain.gain.value).toBeCloseTo(0.8 * (1 - 100 / 1600), 5);
      expect(engine.snapshot().sfx).toMatchObject({ voices: 1, playedTotal: 1, droppedTotal: 0 });
    });

    it('an event whose whole chain is unbound plays nothing and records one miss at the most specific key', async () => {
      // A world/music binding is supplied so setWorld's own _startMusic()
      // does not add an unrelated miss for this test to filter out.
      const { engine, posted } = engineWith({
        'world/vale/music': [{ key: 'm.ogg', volume: 1, weight: 1 }],
      });
      engine.unlock();
      engine.playSfxEvents([{ e: 'hurt', c: 'unknown-creature', x: 0, y: 0 }], { listener: { x: 0, y: 0 }, ownActor: 'p:1' });
      await flush(); await flush();
      expect(engine.snapshot().sfx).toMatchObject({ voices: 0, playedTotal: 0 });
      await engine.flushMisses();
      expect(posted).toEqual([{ subject_kind: 'creature', subject_key: 'unknown-creature', slot: 'hurt', world: 'vale' }]);
    });

    it('caps at 12 started voices out of 20 same-priority events, each a distinct clip', async () => {
      const bindings = {};
      const events = [];
      for (let i = 0; i < 20; i += 1) {
        bindings[`creature/slime${i}/hurt`] = [{ key: `hurt${i}.ogg`, volume: 1, weight: 1 }];
        events.push({ e: 'hurt', c: `slime${i}`, x: i, y: 0 });
      }
      const { engine, sources } = engineWith(bindings);
      engine.unlock();
      engine.playSfxEvents(events, { listener: { x: 0, y: 0 }, ownActor: 'p:1' });
      await flush(); await flush();
      expect(sources.length).toBe(12);
      expect(engine.snapshot().sfx).toMatchObject({ voices: 12, playedTotal: 12, droppedTotal: 8 });
    });

    it('an sfx event is silence plus a warning on decode failure, never a throw', async () => {
      const { ctx, sources } = fakeCtx();
      ctx.decodeAudioData = async () => { throw new Error('bad data'); };
      const engine = new AudioEngine({ ctxFactory: () => ctx, fetchBytes: async () => new ArrayBuffer(4), urlFor: (k) => k, rand: () => 0, postMisses: async () => {} });
      engine.setWorld({ world: 'vale', bindings: { 'creature/slime/hurt': [{ key: 'hurt.ogg', weight: 1, volume: 1 }] } });
      engine.unlock();
      expect(() => engine.playSfxEvents([{ e: 'hurt', c: 'slime', x: 0, y: 0 }], { listener: { x: 0, y: 0 } })).not.toThrow();
      await flush(); await flush();
      expect(sources.every((s) => !s.started)).toBe(true);
      expect(engine.snapshot().sfx.voices).toBe(0);
    });

    // Fix round 1, finding 2.
    it('an event at or beyond the 1600px falloff edge starts no source and fetches nothing', async () => {
      const fetchBytes = vi.fn(async (url) => new TextEncoder().encode(url).buffer);
      const { ctx, sources } = fakeCtx();
      const engine = new AudioEngine({ ctxFactory: () => ctx, fetchBytes, urlFor: (k) => `u:${k}`, rand: () => 0, postMisses: async () => {} });
      engine.setWorld({ world: 'vale', bindings: { 'creature/slime/hurt': [{ key: 'hurt.ogg', volume: 1, weight: 1 }] } });
      engine.unlock();
      engine.playSfxEvents([{ e: 'hurt', c: 'slime', x: 1600, y: 0 }], { listener: { x: 0, y: 0 } });
      await flush(); await flush();
      expect(sources.length).toBe(0);
      expect(fetchBytes).not.toHaveBeenCalled();
      expect(engine.snapshot().sfx).toMatchObject({ voices: 0, playedTotal: 0, droppedTotal: 0 });
    });

    // Fix round 1, finding 4 (promoted ruling).
    it('skips sfx entirely while the context is suspended, so a slot never fills with a source that would never end', async () => {
      const fetchBytes = vi.fn(async (url) => new TextEncoder().encode(url).buffer);
      const { ctx, sources } = fakeCtx(); // starts 'suspended'; deliberately never unlock()ed
      const engine = new AudioEngine({ ctxFactory: () => ctx, fetchBytes, urlFor: (k) => `u:${k}`, rand: () => 0, postMisses: async () => {} });
      engine.setWorld({ world: 'vale', bindings: { 'creature/slime/hurt': [{ key: 'hurt.ogg', volume: 1, weight: 1 }] } });
      engine.playSfxEvents([{ e: 'hurt', c: 'slime', x: 0, y: 0 }], { listener: { x: 0, y: 0 } });
      await flush(); await flush();
      expect(sources.length).toBe(0);
      expect(fetchBytes).not.toHaveBeenCalled();
      expect(engine.snapshot().sfx).toMatchObject({ voices: 0, playedTotal: 0 });
    });

    // Fix round 1, finding 1.
    describe('pending-voice cancellation', () => {
      it('an evicted voice whose buffer is still loading never starts, and its eviction still frees the slot', async () => {
        let resolveSlow;
        const { ctx, sources } = fakeCtx();
        const engine = new AudioEngine({
          ctxFactory: () => ctx,
          fetchBytes: async (url) => {
            if (url.includes('slow')) return new Promise((resolve) => { resolveSlow = resolve; });
            return new TextEncoder().encode(url).buffer;
          },
          urlFor: (k) => `u:${k}`,
          rand: () => 0,
          postMisses: async () => {},
        });
        engine.setWorld({
          world: 'vale',
          bindings: {
            'creature/slow/hurt': [{ key: 'slow.ogg', volume: 1, weight: 1 }],
            'creature/fast/hurt': [{ key: 'fast.ogg', volume: 1, weight: 1 }],
          },
        });
        engine.unlock();
        engine.sfxLimiter.maxVoices = 1; // one slot, so the second event must contend for it

        // Fills the only slot; its buffer never resolves until we say so below.
        engine.playSfxEvents([{ e: 'hurt', c: 'slow', x: 500, y: 0 }], { listener: { x: 0, y: 0 } });
        await flush();
        expect(engine.snapshot().sfx.voices).toBe(0); // admitted, but not yet started -- still loading

        // An own action must evict it even though it is still pending.
        engine.playSfxEvents(
          [{ e: 'hurt', c: 'fast', a: 'p:1', x: 0, y: 0 }],
          { listener: { x: 0, y: 0 }, ownActor: 'p:1' },
        );
        await flush(); await flush();
        expect(engine.snapshot().sfx).toMatchObject({ voices: 1, playedTotal: 1 });
        expect(sources.some((s) => s.buffer && s.buffer.tag === 'u:fast.ogg')).toBe(true);

        // Now let the evicted voice's buffer resolve. It must never start,
        // and must not disturb the voice that took its slot.
        resolveSlow(new TextEncoder().encode('u:slow.ogg').buffer);
        await flush(); await flush();
        expect(sources.some((s) => s.buffer && s.buffer.tag === 'u:slow.ogg')).toBe(false);
        expect(engine.snapshot().sfx).toMatchObject({ voices: 1, playedTotal: 1 });
      });

      it('setWorld while a voice is still loading cancels it: it never starts and never releases a voice from the new world', async () => {
        let resolveOld;
        const { ctx, sources } = fakeCtx();
        const engine = new AudioEngine({
          ctxFactory: () => ctx,
          fetchBytes: async (url) => {
            if (url.includes('old')) return new Promise((resolve) => { resolveOld = resolve; });
            return new TextEncoder().encode(url).buffer;
          },
          urlFor: (k) => `u:${k}`,
          rand: () => 0,
          postMisses: async () => {},
        });
        engine.setWorld({ world: 'vale', bindings: { 'creature/old/hurt': [{ key: 'old.ogg', volume: 1, weight: 1 }] } });
        engine.unlock();
        engine.playSfxEvents([{ e: 'hurt', c: 'old', x: 0, y: 0 }], { listener: { x: 0, y: 0 } });
        await flush();
        expect(engine.snapshot().sfx.voices).toBe(0); // admitted, still loading

        // The world changes before that buffer resolves.
        engine.setWorld({ world: 'other', bindings: { 'creature/new/hurt': [{ key: 'new.ogg', volume: 1, weight: 1 }] } });
        engine.unlock();
        engine.playSfxEvents([{ e: 'hurt', c: 'new', x: 0, y: 0 }], { listener: { x: 0, y: 0 } });
        await flush(); await flush();
        expect(engine.snapshot().sfx.voices).toBe(1); // the new-world voice started
        const [newVoiceId] = [...engine.sfxLimiter.voices.keys()];

        // The stale buffer resolves after the fact.
        resolveOld(new TextEncoder().encode('u:old.ogg').buffer);
        await flush(); await flush();
        expect(sources.some((s) => s.buffer && s.buffer.tag === 'u:old.ogg')).toBe(false); // never started
        // The new world's voice slot must be untouched -- not released by
        // the stale resolution (which is what a limiter id reset would let
        // happen if the stale voice's id had been reused).
        expect(engine.sfxLimiter.voices.has(newVoiceId)).toBe(true);
        expect(engine.snapshot().sfx.voices).toBe(1);
      });
    });
  });

  describe('tickNearby', () => {
    function creatureMap(list) {
      const m = new Map();
      for (const c of list) m.set(c.id, c);
      return m;
    }

    it('two creatures of a bound type within range each start their own nearby voice on cadence', async () => {
      const { engine, sources } = engineWith({
        'creature/slime/nearby': [{ key: 'slime-nearby.ogg', volume: 1, weight: 1 }],
      });
      engine.unlock();
      const creatures = creatureMap([
        { id: 1, type: 'slime', x: 50, y: 0 },
        { id: 2, type: 'slime', x: -50, y: 0 },
      ]);
      engine.tickNearby(creatures, [], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      expect(sources.length).toBe(2);
      expect(sources.every((s) => s.buffer && s.buffer.tag === 'u:slime-nearby.ogg')).toBe(true);
      expect(engine.snapshot().sfx).toMatchObject({ voices: 2, playedTotal: 2, droppedTotal: 0 });

      // Ticking again immediately (< 250ms later, same cadence window) must
      // not start a third voice for either creature.
      engine.tickNearby(creatures, [], { x: 0, y: 0 }, 100);
      await flush(); await flush();
      expect(sources.length).toBe(2);
    });

    it('a creature delta row without a type yet is skipped, not crashed on', async () => {
      const { engine, sources } = engineWith({
        'creature/slime/nearby': [{ key: 'slime-nearby.ogg', volume: 1, weight: 1 }],
      });
      engine.unlock();
      const creatures = creatureMap([{ id: 1, x: 10, y: 0 }]); // no `type`
      expect(() => engine.tickNearby(creatures, [], { x: 0, y: 0 }, 0)).not.toThrow();
      await flush(); await flush();
      expect(sources.length).toBe(0);
    });

    it('a creature outside the 8-tile radius produces no voice and no fetch', async () => {
      const { engine, sources } = engineWith({
        'creature/slime/nearby': [{ key: 'slime-nearby.ogg', volume: 1, weight: 1 }],
      });
      engine.unlock();
      const creatures = creatureMap([{ id: 1, type: 'slime', x: 5000, y: 0 }]);
      engine.tickNearby(creatures, [], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      expect(sources.length).toBe(0);
    });

    it('an unbound creature nearby chain plays nothing and records one miss at the most specific key', async () => {
      // A world/music binding is supplied so setWorld's own _startMusic()
      // does not add an unrelated miss for this test to filter out (same
      // trick the playSfxEvents miss test above uses).
      const { engine, posted } = engineWith({
        'world/vale/music': [{ key: 'm.ogg', volume: 1, weight: 1 }],
      });
      engine.unlock();
      const creatures = creatureMap([{ id: 1, type: 'wolf', x: 10, y: 0 }]);
      engine.tickNearby(creatures, [], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      await engine.flushMisses();
      expect(posted).toEqual([{ subject_kind: 'creature', subject_key: 'wolf', slot: 'nearby', world: 'vale' }]);
    });

    it('a loopable world-point clip loops while in range and fades out on leaving', async () => {
      const { engine, sources } = engineWith({
        'world_point/well/nearby': [{ key: 'well-loop.ogg', volume: 1, weight: 1, loopable: true }],
      });
      engine.unlock();
      const point = { id: 'w1', art: 'well', x: 30, y: 0 };
      engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      expect(sources.length).toBe(1);
      const loopSrc = sources[0];
      expect(loopSrc.buffer.tag).toBe('u:well-loop.ogg');
      expect(loopSrc.loop).toBe(true);
      expect(loopSrc.started).toBe(true);
      expect(loopSrc.stopped).toBe(false);
      expect(engine.snapshot().sfx.voices).toBe(0); // a loop is tracked outside sfxVoices (see nearbyLoops)

      // Still in range on a later tick: must not start a second loop source
      // for the same point.
      engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 300);
      await flush(); await flush();
      expect(sources.length).toBe(1);

      // The point leaves the radius: the loop is faded out (stopped) and its
      // limiter slot freed, so a fresh nearby voice can be admitted.
      engine.tickNearby(new Map(), [], { x: 0, y: 0 }, 600);
      await flush(); await flush();
      expect(loopSrc.stopped).toBe(true);
    });

    it('an own/nearest sfx event may evict a held nearby voice, and a later own action still lands', async () => {
      const { engine, sources } = engineWith({
        'creature/slime/nearby': [{ key: 'slime-nearby.ogg', volume: 1, weight: 1 }],
        'item/Iron Sword/use': [{ key: 'sword-use.ogg', volume: 1, weight: 1 }],
      });
      engine.unlock();
      engine.sfxLimiter.maxVoices = 1; // force contention over the single slot
      const creatures = creatureMap([{ id: 1, type: 'slime', x: 10, y: 0 }]);
      engine.tickNearby(creatures, [], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      expect(sources.length).toBe(1); // the nearby voice took the only slot

      engine.playSfxEvents(
        [{ e: 'use', k: 'melee', s: 'Iron Sword', a: 'p:1', x: 0, y: 0 }],
        { listener: { x: 0, y: 0 }, ownActor: 'p:1' },
      );
      await flush(); await flush();
      expect(sources.length).toBe(2);
      expect(sources[0].stopped).toBe(true); // the nearby voice was bumped
      expect(sources[1].buffer.tag).toBe('u:sword-use.ogg');
      expect(sources[1].started).toBe(true);
    });

    // SOMET-592 (M7): with rand() = 0 a weighted pick lands on the FIRST
    // clip -- the non-loopable one. The old code let that one pick choose
    // the path, so this point would have stayed on the cadence path for the
    // whole world visit although the admin marked a clip Loop.
    it('a slot with any loopable clip loops, and the loop plays a loopable clip, whatever a single pick would land on', async () => {
      const { engine, sources } = engineWith({
        'world_point/well/nearby': [
          { key: 'well-chime.ogg', volume: 1, weight: 5, loopable: false },
          { key: 'well-hum.ogg', volume: 1, weight: 1, loopable: true },
        ],
      });
      engine.unlock();
      engine.tickNearby(new Map(), [{ id: 'w1', art: 'well', x: 30, y: 0 }], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      expect(sources.length).toBe(1);
      expect(sources[0].buffer.tag).toBe('u:well-hum.ogg');
      expect(sources[0].loop).toBe(true);
    });

    // SOMET-592 (M8): at a full bus a combat event may bump a held loop; it
    // fades over ~50ms instead of stopping dead.
    it('an evicted loop fades out over ~50ms instead of stopping instantly', async () => {
      const { engine, sources, ctx } = engineWith({
        'world_point/well/nearby': [{ key: 'well-loop.ogg', volume: 1, weight: 1, loopable: true }],
        'item/Iron Sword/use': [{ key: 'sword-use.ogg', volume: 1, weight: 1 }],
      });
      engine.unlock();
      engine.sfxLimiter.maxVoices = 1;
      engine.tickNearby(new Map(), [{ id: 'w1', art: 'well', x: 30, y: 0 }], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      const loopSrc = sources[0];
      expect(loopSrc.loop).toBe(true);
      const loopGain = loopSrc.out.out; // src -> panner -> gain
      const ramps = [];
      const origRamp = loopGain.gain.linearRampToValueAtTime.bind(loopGain.gain);
      loopGain.gain.linearRampToValueAtTime = (v, t) => { ramps.push([v, t]); return origRamp(v, t); };
      ctx.currentTime = 10;

      engine.playSfxEvents(
        [{ e: 'use', k: 'melee', s: 'Iron Sword', a: 'p:1', x: 0, y: 0 }],
        { listener: { x: 0, y: 0 }, ownActor: 'p:1' },
      );
      await flush(); await flush();
      expect(ramps).toEqual([[0, 10.05]]);
      expect(loopSrc.stopAt).toBeCloseTo(10.05, 5);
      expect(sources[1].buffer.tag).toBe('u:sword-use.ogg');
      expect(engine.nearbyLoops.size).toBe(0);
    });

    it('setWorld stops an active nearby loop, releasing its slot and leaving no leaked source', async () => {
      const { engine, sources } = engineWith({
        'world_point/well/nearby': [{ key: 'well-loop.ogg', volume: 1, weight: 1, loopable: true }],
      });
      engine.unlock();
      const point = { id: 'w1', art: 'well', x: 30, y: 0 };
      engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      expect(sources.length).toBe(1);
      expect(sources[0].stopped).toBe(false);

      engine.setWorld({ world: 'other', bindings: {} });
      expect(sources[0].stopped).toBe(true);

      // Fix round 3: same de-vacuoused assertion as the in-flight tests
      // below -- a loop of 'nearest' admits would all succeed regardless of
      // whether the slot leaked (an unconditional eviction of a held
      // 'nearby' voice, not proof of release), so check the limiter's own
      // bookkeeping directly.
      expect(engine.sfxLimiter.voices.size).toBe(0);
    });

    // Fix round 1, item 1: loops used to share NearbyScheduler's 4-slot cap
    // with creature one-shots, so a village's handful of always-in-range
    // loopable posts (merchant/bank/gem/skill/waypoint, ~1 tile apart) could
    // starve every creature nearby -- and a 5th such point could never start
    // at all. Loops are now presence-driven and never touch the scheduler.
    it('5 loopable points in range each get their own loop, unbounded by the scheduler\'s 4-slot cap', async () => {
      // Distinct art/clip per point (as distinct village posts genuinely
      // would bind) -- five points sharing one clip key would instead hit
      // the unrelated same-clip-within-100ms throttle, which is not what
      // this test is checking.
      const bindings = {};
      const points = [];
      for (let i = 0; i < 5; i += 1) {
        bindings[`world_point/post${i}/nearby`] = [{ key: `post${i}-loop.ogg`, volume: 1, weight: 1, loopable: true }];
        points.push({ id: `w${i}`, art: `post${i}`, x: i * 10, y: 0 });
      }
      const { engine, sources } = engineWith(bindings);
      engine.unlock();
      engine.tickNearby(new Map(), points, { x: 0, y: 0 }, 0);
      await flush(); await flush();
      expect(sources.length).toBe(5);
      expect(sources.every((s) => s.loop === true && s.started === true)).toBe(true);
    });

    it('loopable points never occupy a scheduler slot, so a creature nearby still sounds with 4 loops already active', async () => {
      const bindings = { 'creature/slime/nearby': [{ key: 'slime-nearby.ogg', volume: 1, weight: 1 }] };
      const points = [];
      for (let i = 0; i < 4; i += 1) {
        bindings[`world_point/post${i}/nearby`] = [{ key: `post${i}-loop.ogg`, volume: 1, weight: 1, loopable: true }];
        points.push({ id: `w${i}`, art: `post${i}`, x: i * 10, y: 0 });
      }
      const { engine, sources } = engineWith(bindings);
      engine.unlock();
      const creatures = creatureMap([{ id: 1, type: 'slime', x: 50, y: 0 }]);
      engine.tickNearby(creatures, points, { x: 0, y: 0 }, 0);
      await flush(); await flush();
      // Before the fix, the 4 loops would have filled the scheduler's entire
      // cap and the creature's cadence sound would never have been admitted.
      expect(sources.length).toBe(5); // 4 loops + 1 creature one-shot
      expect(sources.filter((s) => s.loop).length).toBe(4);
      expect(sources.some((s) => s.buffer && s.buffer.tag === 'u:slime-nearby.ogg')).toBe(true);
    });

    // Fix round 1, item 4.
    it('a loop fades in from silence rather than popping to full gain', async () => {
      const { engine, ctx } = engineWith({
        'world_point/well/nearby': [{ key: 'well-loop.ogg', volume: 1, weight: 1, loopable: true }],
      });
      let captured;
      const origCreateGain = ctx.createGain.bind(ctx);
      ctx.createGain = () => {
        const g = origCreateGain();
        const calls = { setValueAtTime: [], linearRampToValueAtTime: [] };
        const origSet = g.gain.setValueAtTime.bind(g.gain);
        const origRamp = g.gain.linearRampToValueAtTime.bind(g.gain);
        g.gain.setValueAtTime = (v, t) => { calls.setValueAtTime.push(v); return origSet(v, t); };
        g.gain.linearRampToValueAtTime = (v, t) => { calls.linearRampToValueAtTime.push(v); return origRamp(v, t); };
        g._calls = calls;
        captured = g;
        return g;
      };
      engine.unlock();
      engine.tickNearby(new Map(), [{ id: 'w1', art: 'well', x: 0, y: 0 }], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      expect(captured._calls.setValueAtTime).toEqual([0]); // starts silent
      expect(captured._calls.linearRampToValueAtTime).toEqual([1]); // ramps up to vol(1) * falloff(1 at distance 0)
    });

    // Fix round 1, item 5: CreatureManager stores x/y as the entity's
    // TOP-LEFT corner (RenderSystem.drawCreature adds w/2,h/2 to reach the
    // centre) -- distance/pan must do the same, or a creature could be
    // wrongly admitted (or excluded) right at the radius edge.
    it('creature distance uses the box centre, not the stored top-left x/y', async () => {
      const { engine, sources } = engineWith({
        'creature/slime/nearby': [{ key: 'slime-nearby.ogg', volume: 1, weight: 1 }],
      });
      engine.unlock();
      // Top-left at x=780 is within the default 800px radius, but this
      // creature's true centre (top-left + half its 48px box) at x=804 is
      // just outside it. Using the raw top-left here would wrongly admit it.
      const creatures = creatureMap([{ id: 1, type: 'slime', x: 780, y: 0, width: 48, height: 48 }]);
      engine.tickNearby(creatures, [], { x: 0, y: 0 }, 0);
      await flush(); await flush();
      expect(sources.length).toBe(0);
    });

    // Fix round 1, item 3: Game.js now passes a thunk so the points array is
    // only built on a tick that proceeds past the 250ms throttle -- verify
    // tickNearby actually supports that shape (not just a plain array).
    it('accepts a thunk for the points argument, called only when the tick proceeds', async () => {
      const { engine, sources } = engineWith({
        'world_point/well/nearby': [{ key: 'well-loop.ogg', volume: 1, weight: 1, loopable: true }],
      });
      engine.unlock();
      let calls = 0;
      const thunk = () => { calls += 1; return [{ id: 'w1', art: 'well', x: 0, y: 0 }]; };

      engine.tickNearby(new Map(), thunk, { x: 0, y: 0 }, 0);
      expect(calls).toBe(1);
      // Within the same 250ms window: throttled, so the thunk must not run again.
      engine.tickNearby(new Map(), thunk, { x: 0, y: 0 }, 100);
      expect(calls).toBe(1);

      await flush(); await flush();
      expect(sources.length).toBe(1);
    });

    // Fix round 2 (CRITICAL): nearbyLoops.has() alone was too late a guard --
    // it is only set AFTER a loop's buffer resolves, so a slow (real,
    // uncached) fetch spanning more than one 250ms tick let every
    // intervening tick call _startNearbyLoop again, each minting its own
    // voiceId and awaiting the same cached buffer promise; when it finally
    // resolved, every attempt built and started a source, with
    // nearbyLoops.set() overwriting all but the last -- leaving untracked
    // orphan loops that _sweepNearbyLoops/_stopAllSfx could never find,
    // looping forever, even into a new world. These three tests use a
    // manually-resolved fetchBytes so the load can be held open across
    // several tickNearby calls, the way any real uncached fetch would be.
    describe('in-flight loop start (fix round 2)', () => {
      function deferredEngine(bindings) {
        let resolveLoad;
        const { ctx, sources } = fakeCtx();
        const engine = new AudioEngine({
          ctxFactory: () => ctx,
          fetchBytes: async () => new Promise((resolve) => { resolveLoad = resolve; }),
          urlFor: (k) => `u:${k}`,
          rand: () => 0,
          postMisses: async () => {},
        });
        engine.setWorld({ world: 'vale', bindings });
        engine.unlock();
        return { engine, sources, resolve: (url) => resolveLoad(new TextEncoder().encode(url).buffer) };
      }

      const bindings = { 'world_point/well/nearby': [{ key: 'well-loop.ogg', volume: 1, weight: 1, loopable: true }] };
      const point = { id: 'w1', art: 'well', x: 0, y: 0 };

      it('a slow buffer load spanning multiple ticks starts exactly one loop source, not one per tick', async () => {
        const { engine, sources, resolve } = deferredEngine(bindings);

        engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 0);
        await flush();
        expect(sources.length).toBe(0); // still loading

        // Two more ticks, 250ms apart, while the load is still pending --
        // before the fix, each of these would have started its own
        // competing attempt for the same point.
        engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 250);
        engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 500);
        await flush();
        expect(sources.length).toBe(0);

        resolve('u:well-loop.ogg');
        await flush(); await flush();
        expect(sources.length).toBe(1); // exactly one, despite three ticks having offered this point
        expect(sources[0].loop).toBe(true);
        expect(sources[0].started).toBe(true);
      });

      it('a point that leaves range while its buffer is loading never starts a source once it resolves, and frees its slot', async () => {
        const { engine, sources, resolve } = deferredEngine(bindings);

        engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 0);
        await flush();
        expect(sources.length).toBe(0);

        // The point leaves the AOI on the very next tick -- offered with an
        // empty points list, as Game.js would once it drops out of range.
        engine.tickNearby(new Map(), [], { x: 0, y: 0 }, 250);

        resolve('u:well-loop.ogg');
        await flush(); await flush();
        expect(sources.length).toBe(0); // never started

        // Fix round 3: a loop of 12 'nearest' admits was vacuous here -- the
        // eviction rules let 'nearest' bump a held 'nearby' voice
        // unconditionally, so all 12 would have succeeded even if the slot
        // had leaked (the first admit would simply have evicted it). Assert
        // the limiter's own bookkeeping directly instead.
        expect(engine.sfxLimiter.voices.size).toBe(0);
      });

      it('setWorld while a loop start is pending prevents it from ever starting, and leaves nothing to leak into the new world', async () => {
        const { engine, sources, resolve } = deferredEngine(bindings);

        engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 0);
        await flush();
        expect(sources.length).toBe(0);
        expect(engine.nearbyLoopStarting.has('pt:w1')).toBe(true); // in flight

        // The world changes before that buffer resolves.
        engine.setWorld({ world: 'other', bindings: {} });
        expect(engine.nearbyLoopStarting.size).toBe(0); // the marker itself must not survive the reset

        resolve('u:well-loop.ogg');
        await flush(); await flush();
        expect(sources.length).toBe(0); // never started, in either world

        // Fix round 3: same de-vacuoused assertion as the test above --
        // check the limiter's bookkeeping directly rather than a loop of
        // 'nearest' admits, which would all succeed regardless (an
        // unconditional eviction, not proof the slot was actually released).
        expect(engine.sfxLimiter.voices.size).toBe(0);
      });

      // Fix round 3 (CRITICAL, same defect class): a stale, already-cancelled
      // continuation must not wipe a NEWER attempt's marker for the same
      // point. Repro: point P picks clip A (v1, loading); P leaves range
      // (sweep cancels v1, deletes P's marker); P returns and this time picks
      // clip B (v2, marker=v2); THEN A's stale buffer resolves. Before the
      // fix, v1's cancelled-branch deleted P's marker unconditionally --
      // wiping v2's still-live entry -- so the next tick started a third
      // attempt (v3), and v2/v3 could both go on to succeed with
      // nearbyLoops.set() silently orphaning one of them.
      it('a stale cancelled attempt must not evict a newer attempt\'s marker (leave/return with a different clip)', async () => {
        let resolveA, resolveB;
        const { ctx, sources } = fakeCtx();
        let randSeq = [];
        const rand = () => (randSeq.length ? randSeq.shift() : 0);
        const engine = new AudioEngine({
          ctxFactory: () => ctx,
          fetchBytes: async (url) => {
            if (url.includes('clipA')) return new Promise((resolve) => { resolveA = resolve; });
            if (url.includes('clipB')) return new Promise((resolve) => { resolveB = resolve; });
            return new TextEncoder().encode(url).buffer;
          },
          urlFor: (k) => `u:${k}`,
          rand,
          postMisses: async () => {},
        });
        engine.setWorld({
          world: 'vale',
          bindings: {
            // Two clips in one slot's pool -- pickWeighted's draw decides
            // which one a given resolve+pick lands on (see randSeq below).
            'world_point/well/nearby': [
              { key: 'clipA.ogg', volume: 1, weight: 1, loopable: true },
              { key: 'clipB.ogg', volume: 1, weight: 1, loopable: true },
            ],
          },
        });
        engine.unlock();
        const point = { id: 'w1', art: 'well', x: 0, y: 0 };

        // Tick 1: rand()=0 -> pickWeighted's first clip, A. Starts loading (v1).
        randSeq = [0];
        engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 0);
        await flush();
        expect(sources.length).toBe(0);

        // Tick 2 (250ms later): the point leaves range -- the sweep cancels
        // v1's in-flight start (releases its slot, deletes its marker).
        engine.tickNearby(new Map(), [], { x: 0, y: 0 }, 250);
        expect(engine.nearbyLoopStarting.size).toBe(0);

        // Tick 3 (250ms later): the point returns. rand()=0.6 -> pickWeighted
        // lands on the second clip, B, this time. Starts loading (v2).
        randSeq = [0.6];
        engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 500);
        await flush();
        expect(sources.length).toBe(0);
        expect(engine.nearbyLoopStarting.has('pt:w1')).toBe(true); // v2, in flight

        // A's stale, already-cancelled buffer resolves now.
        resolveA(new TextEncoder().encode('u:clipA.ogg').buffer);
        await flush(); await flush();
        expect(sources.length).toBe(0); // A must never start a source
        expect(engine.nearbyLoopStarting.has('pt:w1')).toBe(true); // v2's marker must survive A's stale cleanup

        // A later tick must NOT start a third attempt: the marker (v2) is
        // still there, and the point is still in range and not yet looping.
        engine.tickNearby(new Map(), [point], { x: 0, y: 0 }, 750);
        await flush();

        // Now B (v2's real, still-pending buffer) resolves.
        resolveB(new TextEncoder().encode('u:clipB.ogg').buffer);
        await flush(); await flush();

        expect(sources.length).toBe(1); // exactly one source, ever
        expect(sources[0].loop).toBe(true);
        expect(sources[0].buffer.tag).toBe('u:clipB.ogg');
        expect(engine.nearbyLoops.has('pt:w1')).toBe(true); // tracked, not orphaned
        expect(engine.nearbyLoopStarting.size).toBe(0);
      });
    });

    describe('boss presence (SOMET-605)', () => {
      const bindings = { 'creature/Ignis/presence': [{ key: 'ignis-bed.ogg', volume: 0.8, weight: 1, loopable: false }] };
      // Controller ruling N-2: y: -48 puts the 96px box centre on y = 0, so
      // ignis(452) is exactly 500 world px from the listener.
      const ignis = (x) => creatureMap([{ id: 'wb_1', type: 'Ignis', x, y: -48, width: 96, height: 96, bossTier: 'world' }]);

      it('loops presence while the boss is within screen radius, then fades it out on exit', async () => {
        const { engine, sources } = engineWith(bindings);
        engine.unlock();
        engine.setScreenRadius(1000);
        engine.tickNearby(ignis(452), [], { x: 0, y: 0 }, 0); // centre 500 <= 1000
        await flush(); await flush();
        const bed = sources.find((s) => s.buffer && s.buffer.tag === 'u:ignis-bed.ogg');
        expect(bed).toBeTruthy();
        expect(bed.loop).toBe(true); // loops although the clip is not marked loopable
        expect(engine.snapshot().loops).toEqual([{ id: 'boss:wb_1', key: 'ignis-bed.ogg', priority: 'boss', distance: 500 }]);
        engine.tickNearby(ignis(552), [], { x: 0, y: 0 }, 300); // still in: no second source
        await flush(); await flush();
        expect(sources.filter((s) => s.buffer && s.buffer.tag === 'u:ignis-bed.ogg').length).toBe(1);
        engine.tickNearby(ignis(1052), [], { x: 0, y: 0 }, 600); // centre 1100 > 1000
        await flush(); await flush();
        expect(bed.stopped).toBe(true);
        expect(engine.snapshot().loops).toEqual([]);
      });

      it('plays at clip volume (no distance falloff), pans with the boss, fades out over FADE_S and fades back in on re-entry', async () => {
        const { engine, sources } = engineWith(bindings);
        engine.unlock();
        engine.setScreenRadius(1000);
        engine.tickNearby(ignis(552), [], { x: 0, y: 0 }, 0); // centre x = 600: pan +1
        await flush(); await flush();
        const first = sources[0];
        const panner = first.out;
        const gain = panner.out;
        expect(gain.gain.value).toBe(0.8); // a point loop at 600px would be 0.8 * (1 - 600/1600)
        expect(panner.pan.value).toBe(1);
        engine.tickNearby(ignis(-348), [], { x: 0, y: 0 }, 300); // centre x = -300: pan -0.5
        expect(panner.pan.value).toBe(-0.5);
        expect(engine.snapshot().loops[0].distance).toBe(300);
        engine.tickNearby(ignis(1052), [], { x: 0, y: 0 }, 600); // out
        expect(first.stopped).toBe(true);
        expect(first.stopAt).toBe(2); // FADE_S from currentTime 0, not an instant stop
        expect(gain.gain.value).toBe(0);
        engine.tickNearby(ignis(452), [], { x: 0, y: 0 }, 900); // back in
        await flush(); await flush();
        expect(sources.length).toBe(2);
        const second = sources[1];
        expect(second.loop).toBe(true);
        expect(second.started).toBe(true);
        expect(second.out.out.gain.value).toBe(0.8);
        expect(engine.snapshot().loops).toEqual([{ id: 'boss:wb_1', key: 'ignis-bed.ogg', priority: 'boss', distance: 500 }]);
      });

      it('an ordinary creature never gets a presence loop', async () => {
        const { engine, sources } = engineWith({ 'creature/Slime/presence': [{ key: 'x.ogg', volume: 1, weight: 1 }] });
        engine.unlock();
        engine.setScreenRadius(1000);
        engine.tickNearby(creatureMap([{ id: 1, type: 'Slime', x: 0, y: 0 }]), [], { x: 0, y: 0 }, 0);
        await flush(); await flush();
        expect(sources.length).toBe(0);
      });

      it('the boss leaving the creature map (death/despawn) fades the loop; setWorld stops it outright', async () => {
        const { engine, sources } = engineWith(bindings);
        engine.unlock();
        engine.setScreenRadius(1000);
        engine.tickNearby(ignis(0), [], { x: 0, y: 0 }, 0);
        await flush(); await flush();
        engine.tickNearby(new Map(), [], { x: 0, y: 0 }, 300);
        await flush(); await flush();
        expect(sources[0].stopped).toBe(true);
        expect(engine.snapshot().loops).toEqual([]);
        engine.tickNearby(ignis(0), [], { x: 0, y: 0 }, 600);
        await flush(); await flush();
        engine.setWorld({ world: 'other', bindings });
        expect(sources[sources.length - 1].stopped).toBe(true);
        expect(engine.snapshot().loops).toEqual([]);
      });

      it('no screen radius yet means no presence', async () => {
        const { engine, sources } = engineWith(bindings);
        engine.unlock();
        engine.tickNearby(ignis(0), [], { x: 0, y: 0 }, 0);
        await flush(); await flush();
        expect(sources.length).toBe(0);
      });

      it('creature nearby chatter cannot evict the presence loop', async () => {
        const { engine, sources } = engineWith({ ...bindings, 'creature/slime/nearby': [{ key: 'slime.ogg', volume: 1, weight: 1 }] });
        engine.unlock();
        engine.setScreenRadius(1000);
        engine.sfxLimiter.maxVoices = 1;
        const both = creatureMap([
          { id: 'wb_1', type: 'Ignis', x: 0, y: 0, width: 96, height: 96, bossTier: 'world' },
          { id: 2, type: 'slime', x: 5, y: 0 },
        ]);
        engine.tickNearby(both, [], { x: 0, y: 0 }, 0);
        await flush(); await flush();
        engine.tickNearby(both, [], { x: 0, y: 0 }, 11000); // past the cadence gap
        await flush(); await flush();
        const bed = sources.find((s) => s.buffer.tag === 'u:ignis-bed.ogg');
        expect(bed.stopped).toBe(false);
        expect(sources.some((s) => s.buffer.tag === 'u:slime.ogg' && s.started)).toBe(false);
      });

      it('a slow buffer spanning several ticks starts exactly one presence source', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const { ctx, sources } = fakeCtx();
        const engine = new AudioEngine({
          ctxFactory: () => ctx, urlFor: (k) => `u:${k}`, rand: () => 0, postMisses: async () => {},
          fetchBytes: async (url) => { await gate; return new TextEncoder().encode(url).buffer; },
        });
        engine.setWorld({ world: 'vale', bindings });
        engine.unlock();
        engine.setScreenRadius(1000);
        for (let t = 0; t <= 1000; t += 250) engine.tickNearby(ignis(0), [], { x: 0, y: 0 }, t);
        release();
        await flush(); await flush(); await flush();
        expect(sources.filter((s) => s.buffer && s.buffer.tag === 'u:ignis-bed.ogg').length).toBe(1);
      });
    });
  });
});
