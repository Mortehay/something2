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
        connect(n) { this.out = n; }, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
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
  });
});
