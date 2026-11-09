const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runPromptWithWaits, busyWaitMs, maxHeldWaits, promptPhaseSeconds, PROMPT_ETA, SWITCH_WAIT_MS, CONCURRENT_PROMPT_ERROR,
} = require('../src/services/promptPhase.js');

// A prompt write scripted answer by answer: an Error to throw, or a value.
function scripted(answers) {
  const calls = { n: 0 };
  const write = async () => {
    const a = answers[Math.min(calls.n, answers.length - 1)];
    calls.n += 1;
    if (a instanceof Error) throw a;
    return a;
  };
  return { write, calls };
}
const busy = (msg = 'model switch in progress') => Object.assign(new Error(msg), { busy: true });
const HELD = 'Not enough free VRAM: llm-server holds the card; it unloads after 2 idle minutes';

function withEnv(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) { saved[k] = process.env[k]; if (over[k] == null) delete process.env[k]; else process.env[k] = over[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

test('a busy answer is waited out and retried; succeeds after two waits', () => withEnv(
  { ART_SWITCH_WAIT_MS: null }, async () => {
    const sleeps = [];
    const { write, calls } = scripted([busy(), busy(), 'a prompt']);
    const out = await runPromptWithWaits(write, { sleep: async (ms) => { sleeps.push(ms); }, maxWaits: 3 });
    assert.deepEqual(out, { ok: true, value: 'a prompt' });
    assert.equal(calls.n, 3);
    assert.deepEqual(sleeps, [5000, 10000]);
  },
));

test('a held card waits the time the box names', () => withEnv(
  { ART_CARD_HELD_WAIT_MS: null }, async () => {
    const sleeps = [];
    // No busy flag: the held-card text alone makes it busy.
    const { write } = scripted([new Error(HELD), 'ok']);
    const out = await runPromptWithWaits(write, { sleep: async (ms) => { sleeps.push(ms); }, maxWaits: 3 });
    assert.equal(out.ok, true);
    assert.equal(sleeps[0], 130000);
    assert.equal(busyWaitMs(HELD, 0), 130000);
  },
));

test('past the limit: "text model busy", write called maxWaits+1 times', async () => {
  const sleeps = [];
  const { write, calls } = scripted([busy('switching')]);
  const out = await runPromptWithWaits(write, { sleep: async (ms) => { sleeps.push(ms); }, maxWaits: 3 });
  assert.equal(out.ok, false);
  assert.equal(out.busy, true);
  assert.equal(out.stopped, undefined);
  assert.match(out.error, /^text model busy after 3 waits/);
  assert.match(out.error, /switching/);
  assert.equal(calls.n, 4);
  assert.equal(sleeps.length, 3);
});

test('a non-busy error fails at once, no sleep', async () => {
  const sleeps = [];
  const { write, calls } = scripted([new Error('describer returned nothing usable')]);
  const out = await runPromptWithWaits(write, { sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(out, { ok: false, busy: false, error: 'describer returned nothing usable' });
  assert.equal(calls.n, 1);
  assert.equal(sleeps.length, 0);
});

// Final review M3: a concurrent per-row Regenerate makes the description write
// hit the one-active unique index; the phase reports it readably, never raw.
test('a unique violation (23505) fails at once with "prompt changed concurrently — queue again"', async () => {
  const sleeps = [];
  const dup = Object.assign(new Error('duplicate key value violates unique constraint "art_prompt_descriptions_one_active"'), { code: '23505' });
  const { write, calls } = scripted([dup]);
  const out = await runPromptWithWaits(write, { sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(out, { ok: false, busy: false, error: 'prompt changed concurrently — queue again' });
  assert.equal(CONCURRENT_PROMPT_ERROR, out.error);
  assert.equal(calls.n, 1);
  assert.equal(sleeps.length, 0);
});

test('stop during a wait ends stopped, no further write', async () => {
  let stopping = false;
  const { write, calls } = scripted([busy('switching'), 'never reached']);
  const out = await runPromptWithWaits(write, {
    sleep: async () => { stopping = true; },
    shouldStop: () => stopping,
    maxWaits: 3,
  });
  assert.equal(out.ok, false);
  assert.equal(out.busy, true);
  assert.equal(out.stopped, true);
  assert.equal(calls.n, 1);
});

test('busy waits back off from ART_SWITCH_WAIT_MS and cap at a minute', () => withEnv(
  { ART_SWITCH_WAIT_MS: '1000' }, async () => {
    assert.equal(busyWaitMs('busy', 0), 1000);
    assert.equal(busyWaitMs('busy', 2), 4000);
    assert.equal(busyWaitMs('busy', 10), 60000);
  },
));

test('maxHeldWaits reads ART_MAX_HELD_WAITS, default 3', () => withEnv(
  { ART_MAX_HELD_WAITS: null }, async () => {
    assert.equal(maxHeldWaits(), 3);
    process.env.ART_MAX_HELD_WAITS = '5';
    assert.equal(maxHeldWaits(), 5);
  },
));

test('promptPhaseSeconds: 0 for none; 120 + 3 × 20 = 180 for three; PROMPT_ETA.placeholder is true', () => {
  assert.equal(promptPhaseSeconds(0), 0);
  assert.equal(promptPhaseSeconds(-1), 0);
  assert.equal(promptPhaseSeconds(3), 180);
  assert.equal(PROMPT_ETA.placeholder, true);
  assert.ok(Object.isFrozen(PROMPT_ETA));
});

test('a garbled ART_MAX_HELD_WAITS falls back to 3, so the wait loop still ends', () => withEnv(
  { ART_MAX_HELD_WAITS: 'lots', ART_SWITCH_WAIT_MS: null }, async () => {
    assert.equal(maxHeldWaits(), 3);
    const { write, calls } = scripted([busy('switching')]);
    const out = await runPromptWithWaits(write, { sleep: async () => {} });
    assert.match(out.error, /^text model busy after 3 waits/);
    assert.equal(calls.n, 4);
  },
));

test('a garbled ART_SWITCH_WAIT_MS falls back to 5000', () => withEnv(
  { ART_SWITCH_WAIT_MS: 'soon' }, async () => {
    assert.equal(SWITCH_WAIT_MS(), 5000);
    assert.equal(busyWaitMs('busy', 1), 10000);
  },
));
