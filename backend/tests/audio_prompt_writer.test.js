// backend/tests/audio_prompt_writer.test.js
const test = require('node:test');
const assert = require('node:assert');
const w = require('../src/services/audioPromptWriter');

const CAT = {
  worlds: new Map([['Vale', { biomes: ['Meadow'], level_min: 1, level_max: 5 }]]),
  biomes: new Map(), entities: new Map([['Wolf', { prompt: 'a grey wolf' }]]),
  items: new Map(), skills: new Map(), artDescriptions: new Map(),
};
const STYLES = { music: ['medieval_fantasy', 'village'], ambience: ['forest', 'night'] };

function fakeStore() {
  const saved = [];
  return {
    saved,
    save: async (db, kind, key, slot, body) => { saved.push({ kind, key, slot, ...body }); return { id: saved.length, kind, key, slot, ...body }; },
  };
}
function fakeTp(answers) {
  const calls = [];
  return {
    calls,
    complete: async (db, req, opts) => { calls.push({ req, opts }); return answers.shift(); },
  };
}

test('music: schema enum is the box styles; stored with source_input and via', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: true, json: { style: 'village', prompt: 'warm lute over soft drums' }, model: 'q', via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music', hint: 'darker' },
    { tp, store, catalog: CAT, styles: STYLES });
  assert.equal(r.ok, true, r.error);
  const req = tp.calls[0].req;
  assert.deepEqual(req.jsonSchema.properties.style.enum, ['medieval_fantasy', 'village']);
  assert.equal(req.system, w.SYSTEM_MUSIC);
  assert.match(req.prompt, /world "Vale"/);
  assert.match(req.prompt, /Admin hint: darker/);
  assert.deepEqual(store.saved[0], {
    kind: 'world', key: 'Vale', slot: 'music', style: 'village', text: 'warm lute over soft drums',
    sourceInput: 'world "Vale"; regions: Meadow; levels 1-5; slot: music', hint: 'darker', model: 'q', via: 'box',
  });
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
