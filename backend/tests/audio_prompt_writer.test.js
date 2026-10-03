// backend/tests/audio_prompt_writer.test.js
const test = require('node:test');
const assert = require('node:assert');
const w = require('../src/services/audioPromptWriter');

const CAT = {
  // Vale is an overworld village, so the world-music rule fixes its style to "village".
  worlds: new Map([['Vale', {
    biomes: ['Meadow'], level_min: 1, level_max: 5, allows_fast_travel: true, has_village: true, width: 96,
  }]]),
  biomes: new Map(), entities: new Map([['Wolf', { prompt: 'a grey wolf' }]]),
  items: new Map(), skills: new Map(), artDescriptions: new Map(),
};
const STYLES = { music: ['medieval_fantasy', 'village'], ambience: ['forest', 'night'] };

function fakeStore() {
  const saved = [];
  const saveOpts = [];
  return {
    saved,
    saveOpts,
    save: async (db, kind, key, slot, body, opts) => {
      saved.push({ kind, key, slot, ...body });
      saveOpts.push(opts);
      return { id: saved.length, kind, key, slot, ...body };
    },
  };
}
function fakeTp(answers) {
  const calls = [];
  return {
    calls,
    complete: async (db, req, opts) => { calls.push({ req, opts }); return answers.shift(); },
  };
}
function fakeStoreThrows(err) {
  return { saved: [], save: async () => { throw err; } };
}

test('music: schema enum is the box styles; stored with source_input and via', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: true, json: { style: 'village', prompt: 'warm lute over soft drums' }, model: 'q', via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music', hint: 'darker' },
    { tp, store, catalog: CAT, styles: STYLES });
  assert.equal(r.ok, true, r.error);
  const req = tp.calls[0].req;
  assert.deepEqual(req.jsonSchema.properties.style.enum, ['village']);
  assert.equal(req.system, w.SYSTEM_MUSIC);
  assert.match(req.prompt, /world "Vale"/);
  assert.match(req.prompt, /Admin hint: darker/);
  assert.deepEqual(store.saved[0], {
    kind: 'world', key: 'Vale', slot: 'music', style: 'village', text: 'warm lute over soft drums',
    sourceInput: 'world "Vale"; type: overworld village; regions: Meadow; levels 1-5; slot: music', hint: 'darker', model: 'q', via: 'box',
  });
});

// Live 2026-10-04: with one shared system prompt, "music" answers described
// ambience ("icy wind", "dripping water"). Each kind now gets its own.
test('ambience gets its own system prompt, and the music one is about music only', async () => {
  const tp = fakeTp([{ ok: true, json: { style: 'night', prompt: 'crickets, distant owl' }, model: 'q', via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'ambience' },
    { tp, store: fakeStore(), catalog: CAT, styles: STYLES });
  assert.equal(r.ok, true, r.error);
  const req = tp.calls[0].req;
  assert.equal(req.system, w.SYSTEM_AMBIENCE);
  assert.notEqual(w.SYSTEM_AMBIENCE, w.SYSTEM_MUSIC);
  assert.deepEqual(req.jsonSchema.properties.style.enum, ['forest', 'night']);
  assert.doesNotMatch(w.SYSTEM_MUSIC, /ambience/i);
  assert.doesNotMatch(w.SYSTEM_AMBIENCE, /\bmusic\b/i);
  for (const s of [w.SYSTEM_MUSIC, w.SYSTEM_AMBIENCE]) assert.match(s, /"style".*"prompt"/);
});

// Live 2026-10-04 style check: 18 of 20 worlds came back "dungeon", and ~8
// texts were near copies ("Low cello drones and dissonant lute chords").
// World music now has its style fixed by worldMusicStyle, and leads with one
// of the box's featured instruments for that style, picked per world.
const ROOMS = Array.from({ length: 12 }, (_, i) => [`Crypt: Room${i}`, { allows_fast_travel: false, has_village: false, width: 96 }]);
const ROOM_CAT = { ...CAT, worlds: new Map(ROOMS) };
const DUNGEON = {
  music: ['medieval_fantasy', 'dungeon'],
  ambience: ['cave'],
  slots: { dungeon: { featured: ['distant bells and viola da gamba', 'low bowed strings', 'slow harp over drone'], mood: ['mysterious', 'lonely', 'somber'] } },
};

async function roomRequest(key, styles = DUNGEON) {
  // Two answers: in the fallback case "dungeon" is not allowed, so the writer retries once.
  const answer = { ok: true, json: { style: 'dungeon', prompt: 'x' }, model: 'q', via: 'box' };
  const tp = fakeTp([answer, answer]);
  await w.writeSlotPrompt({}, { kind: 'world', key, slot: 'music' }, { tp, store: fakeStore(), catalog: ROOM_CAT, styles });
  return tp.calls[0].req;
}

test('world music: the rule fixes the style and the model may only return it', async () => {
  const req = await roomRequest('Crypt: Room0');
  assert.deepEqual(req.jsonSchema.properties.style.enum, ['dungeon']);
  assert.match(req.prompt, /^Style: dungeon \(fixed\)$/m);
  assert.doesNotMatch(req.prompt, /Allowed styles/);
});

test('world music: one featured instrument and mood per world, stable, and varied across worlds', async () => {
  const leads = [];
  for (const [key] of ROOMS) {
    // eslint-disable-next-line no-await-in-loop
    const req = await roomRequest(key);
    const lead = req.prompt.match(/^Lead instrument: (.+)$/m);
    const mood = req.prompt.match(/^Mood: (.+)$/m);
    assert.ok(lead && ['distant bells and viola da gamba', 'low bowed strings', 'slow harp over drone'].includes(lead[1]), req.prompt);
    assert.ok(mood && ['mysterious', 'lonely', 'somber'].includes(mood[1]), req.prompt);
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await roomRequest(key)).prompt, req.prompt, 'the same world must get the same request');
    leads.push(lead[1]);
  }
  assert.ok(new Set(leads).size >= 2, `12 worlds all got ${leads[0]}`);
});

test('world music: a rule style the box does not offer falls back to the model choosing', async () => {
  const req = await roomRequest('Crypt: Room0', { music: ['medieval_fantasy', 'village'], ambience: [] });
  assert.deepEqual(req.jsonSchema.properties.style.enum, ['medieval_fantasy', 'village']);
  assert.match(req.prompt, /Allowed styles: medieval_fantasy, village/);
  assert.doesNotMatch(req.prompt, /Lead instrument/);
});

test('sfx: entity contract, no style, cue in the context', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: true, json: { entity: 'a snarling grey wolf' }, model: 'q', via: 'fallback' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'creature', key: 'Wolf', slot: 'hurt' },
    { tp, store, catalog: CAT, styles: STYLES, cue: 'hit' });
  assert.equal(r.ok, true, r.error);
  assert.equal(tp.calls[0].req.system, w.SYSTEM_SFX);
  assert.deepEqual(Object.keys(tp.calls[0].req.jsonSchema.properties), ['entity']);
  assert.match(tp.calls[0].req.prompt, /sound cue: hit/);
  assert.equal(store.saved[0].style, null);
  assert.equal(store.saved[0].text, 'a snarling grey wolf');
  assert.equal(store.saved[0].via, 'fallback');
});

for (const [label, bad] of [
  ['json null', { ok: true, json: null, text: 'Sure! here', model: 'q', via: 'box' }],
  ['style not in list', { ok: true, json: { style: 'jazz', prompt: 'x' }, model: 'q', via: 'box' }],
  ['empty prompt', { ok: true, json: { style: 'village', prompt: '   ' }, model: 'q', via: 'box' }],
]) {
  test(`${label}: one retry, then fail WITHOUT storing`, async () => {
    const store = fakeStore();
    const tp = fakeTp([bad, bad]);
    const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' }, { tp, store, catalog: CAT, styles: STYLES });
    assert.equal(r.ok, false);
    assert.equal(tp.calls.length, 2, 'exactly one retry');
    assert.equal(store.saved.length, 0);
  });
}

test('bad then good: stores the good one', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: true, json: null, model: 'q', via: 'box' }, { ok: true, json: { style: 'village', prompt: 'ok' }, model: 'q', via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' }, { tp, store, catalog: CAT, styles: STYLES });
  assert.equal(r.ok, true);
  assert.equal(store.saved.length, 1);
});

test('provider failure is not retried and carries busy/via', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: false, error: 'text service answered 409', busy: true, via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' }, { tp, store, catalog: CAT, styles: STYLES, boxOnly: true });
  assert.deepEqual({ ok: r.ok, busy: r.busy, via: r.via }, { ok: false, busy: true, via: 'box' });
  assert.equal(tp.calls.length, 1);
  assert.equal(tp.calls[0].opts.boxOnly, true);
});

test('music with no box styles known: refuses rather than guessing', async () => {
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' },
    { tp: fakeTp([]), store: fakeStore(), catalog: CAT, styles: { music: [], ambience: [] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /no music styles/);
});

test('unknown subject: fails without calling the model', async () => {
  const tp = fakeTp([]);
  const r = await w.writeSlotPrompt({}, { kind: 'creature', key: 'Ghost', slot: 'hurt' }, { tp, store: fakeStore(), catalog: CAT, styles: STYLES });
  assert.equal(r.ok, false);
  assert.equal(tp.calls.length, 0);
});

test('sfx: whitespace-only entity, one retry, then fail WITHOUT storing', async () => {
  const store = fakeStore();
  const bad = { ok: true, json: { entity: '   ' }, model: 'q', via: 'box' };
  const tp = fakeTp([bad, bad]);
  const r = await w.writeSlotPrompt({}, { kind: 'creature', key: 'Wolf', slot: 'hurt' },
    { tp, store, catalog: CAT, styles: STYLES, cue: 'hit' });
  assert.equal(r.ok, false);
  assert.equal(tp.calls.length, 2, 'exactly one retry');
  assert.equal(store.saved.length, 0);
});

test('store.save rejects with a 409 conflict: no retry, ok:false, conflict:true', async () => {
  const err = new Error('this prompt was changed by someone else; reload it');
  err.status = 409;
  const store = fakeStoreThrows(err);
  const tp = fakeTp([{ ok: true, json: { style: 'village', prompt: 'ok' }, model: 'q', via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' }, { tp, store, catalog: CAT, styles: STYLES });
  assert.deepEqual(
    { ok: r.ok, conflict: r.conflict, busy: r.busy, via: r.via },
    { ok: false, conflict: true, busy: false, via: 'box' },
  );
  assert.match(r.error, /changed by someone else/);
  assert.equal(tp.calls.length, 1, 'no retry on a store failure');
});

test('store.save rejects with a non-conflict error: ok:false, error mentions could not store', async () => {
  const store = fakeStoreThrows(new Error('connection terminated'));
  const tp = fakeTp([{ ok: true, json: { style: 'village', prompt: 'ok' }, model: 'q', via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' }, { tp, store, catalog: CAT, styles: STYLES });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, undefined);
  assert.equal(r.busy, false);
  assert.equal(r.via, 'box');
  assert.match(r.error, /could not store/);
  assert.equal(tp.calls.length, 1, 'no retry on a store failure');
});

// Final review I1: the model writer must not silently replace a prompt that
// changed since the caller looked. The expectation the caller passes (an id,
// null = "I saw no prompt", undefined = "don't check") reaches store.save
// unchanged -- the store is what turns a mismatch into a 409.
for (const [label, expectActiveId] of [['an id', '42'], ['null (no prompt seen)', null]]) {
  test(`expectActiveId ${label} is passed to store.save`, async () => {
    const store = fakeStore();
    const tp = fakeTp([{ ok: true, json: { entity: 'a grey wolf' }, model: 'q', via: 'box' }]);
    const r = await w.writeSlotPrompt({}, { kind: 'creature', key: 'Wolf', slot: 'hurt' },
      { tp, store, catalog: CAT, styles: STYLES, cue: 'hit', expectActiveId });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(store.saveOpts[0], { expectActiveId });
  });
}

test('no expectActiveId given: store.save is told not to check (undefined)', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: true, json: { entity: 'a grey wolf' }, model: 'q', via: 'box' }]);
  await w.writeSlotPrompt({}, { kind: 'creature', key: 'Wolf', slot: 'hurt' }, { tp, store, catalog: CAT, styles: STYLES, cue: 'hit' });
  assert.equal(store.saveOpts[0].expectActiveId, undefined);
});
