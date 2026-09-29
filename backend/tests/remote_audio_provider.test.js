// backend/tests/remote_audio_provider.test.js
// The adapter against a fake box. Every fake reads the request it was sent, so
// a test cannot pass while the adapter sends the wrong path/body/auth.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const rap = require('../src/services/remoteAudioProvider');

const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));
const WAV = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.wav'));
const provider = { base_url: 'http://box.test:8001', auth_token: 'sk_test', modality: 'audio' };

function fakeBox(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${(init.method || 'GET')} ${u.pathname}`;
    calls.push({ key, url: u, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const h = routes[key];
    if (!h) return new Response('not found', { status: 404 });
    return h(u, init, calls.length);
  };
  return { fetchImpl, calls };
}
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const noSleep = async () => {};

test('listStyles returns styles and cues with auth', async () => {
  const { fetchImpl, calls } = fakeBox({
    'GET /api/audio/styles': (u) => (u.searchParams.get('kind') === 'sfx'
      ? json([{ value: 'hit', label: 'Hit', kind: 'sfx', engines: ['realistic', 'retro'], entity_default: 'a creature' }])
      : json([{ value: 'forest', label: 'Forest', kind: 'ambience', slots: { mood: {} } }])),
  });
  const r = await rap.listStyles(provider, { fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.styles.map((s) => s.value), ['forest']);
  assert.deepEqual(r.cues.map((c) => c.value), ['hit']);
  assert.equal(calls[0].headers.Authorization, 'Bearer sk_test');
});

test('generateTrack: synchronous base64 response', async () => {
  const { fetchImpl, calls } = fakeBox({
    'POST /api/audio': () => json({ audio: [OGG.toString('base64')], info: { loop_start: 0, loop_end: 88200, sample_rate: 44100, prompt: 'p', seed: 7 } }),
  });
  const r = await rap.generateTrack(provider, { kind: 'ambience', name: 'n1', style: 'forest', seed: 7 }, { fetchImpl, sleep: noSleep });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.buffer.equals(OGG));
  assert.equal(r.loopEndMs, 2000);
  assert.equal(calls[0].body.seed, 7, 'the seed is sent explicitly');
  assert.equal(calls[0].body.kind, 'ambience');
});

test('generateTrack: queued response polls the ledger then fetches the file', async () => {
  let polls = 0;
  const { fetchImpl, calls } = fakeBox({
    'POST /api/audio': () => json({ id: 'x', status: 'queued', name: 'n2' }),
    'GET /api/audio': () => { polls += 1; return json({ items: [polls < 2
      ? { name: 'n2', status: 'running' }
      : { name: 'n2', status: 'done', sample_rate: 48000, loop_start: 0, loop_end: 96000, prompt: 'pp', seed: 3 }] }); },
    'GET /api/audio/music/n2': () => new Response(OGG, { status: 200, headers: { 'content-type': 'audio/ogg' } }),
  });
  const r = await rap.generateTrack(provider, { kind: 'music', name: 'n2', seed: 3 }, { fetchImpl, sleep: noSleep });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.loopEndMs, 2000);
  const fileCall = calls.find((c) => c.key === 'GET /api/audio/music/n2');
  assert.equal(fileCall.url.searchParams.has('master'), false, 'never asks for the WAV master');
});

test('generateTrack rejects a WAV, reports a failed ledger row, and marks 409 retryable', async () => {
  let r = await rap.generateTrack(provider, { kind: 'music', name: 'w', seed: 1 }, {
    fetchImpl: fakeBox({ 'POST /api/audio': () => json({ audio: WAV.toString('base64') }) }).fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /not an OGG/i);

  r = await rap.generateTrack(provider, { kind: 'music', name: 'f', seed: 1 }, {
    fetchImpl: fakeBox({
      'POST /api/audio': () => json({ status: 'queued' }),
      'GET /api/audio': () => json({ items: [{ name: 'f', status: 'failed', error: 'CUDA out of memory' }] }),
    }).fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /CUDA out of memory/);

  r = await rap.generateTrack(provider, { kind: 'music', name: 'b', seed: 1 }, {
    fetchImpl: fakeBox({ 'POST /api/audio': () => json({ detail: 'switch pending' }, 409) }).fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.match(r.error, /switch pending/, 'the box\'s own detail must surface, not just the status code');
});

// SOMET-591: callJson's non-ok branch reads the box's own error body via
// safeFetch.errorDetail, the same mechanism the image side already used --
// "answered 500" alone sends the admin hunting on a machine they may not be
// able to see for a message this process already had in hand.
test('a non-2xx box response includes the box\'s own error detail and status, never the token',
  async () => {
    const { fetchImpl } = fakeBox({
      'GET /api/audio/styles': () => json({ detail: 'invalid token' }, 401),
    });
    const r = await rap.listStyles(provider, { fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.match(r.error, /answered 401 for GET \/api\/audio\/styles/);
    assert.match(r.error, /invalid token/);
    assert.doesNotMatch(r.error, /sk_test/, 'the provider\'s auth token must never appear in an error message');
  });

test('a box error body that is not JSON still surfaces as a readable prefix', async () => {
  const { fetchImpl } = fakeBox({
    'GET /api/audio/styles': () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
  });
  const r = await rap.listStyles(provider, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.match(r.error, /answered 502 for GET \/api\/audio\/styles/);
  assert.match(r.error, /502 Bad Gateway/);
});

test('generateTrack ignores a ledger row for a different job while polling', async () => {
  let polls = 0;
  const { fetchImpl } = fakeBox({
    'POST /api/audio': () => json({ status: 'queued' }),
    'GET /api/audio': () => {
      polls += 1;
      return json({ items: [polls === 1
        ? { name: 'other-job', status: 'done', sample_rate: 44100, loop_start: 0, loop_end: 44100, prompt: 'wrong', seed: 99 }
        : { name: 'n3', status: 'done', sample_rate: 48000, loop_start: 0, loop_end: 96000, prompt: 'right', seed: 3 }] });
    },
    'GET /api/audio/music/n3': () => new Response(OGG, { status: 200, headers: { 'content-type': 'audio/ogg' } }),
  });
  const r = await rap.generateTrack(provider, { kind: 'music', name: 'n3', seed: 3 }, { fetchImpl, sleep: noSleep });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.loopEndMs, 2000, 'must use n3\'s row (96000/48000), not the stale other-job row (44100/44100)');
  assert.equal(r.prompt, 'right');
  assert.equal(r.seed, 3);
});

test('generateTrack requires an explicit integer seed and never calls the box without one', async () => {
  const { fetchImpl, calls } = fakeBox({});
  const r = await rap.generateTrack(provider, { kind: 'music', name: 'noseed' }, { fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /explicit integer seed/i);
  assert.equal(calls.length, 0, 'no request should be sent without a seed');
});

test('propose passes context and kind through', async () => {
  const { fetchImpl, calls } = fakeBox({
    'POST /api/audio/propose': () => json({ kind: 'ambience', style: 'forest', slots: { mood: 'calm daytime' }, prompt: 'forest ambience' }),
  });
  const r = await rap.propose(provider, { context: 'pine forest', kind: 'ambience' }, { fetchImpl });
  assert.equal(r.style, 'forest');
  assert.deepEqual(calls[0].body, { context: 'pine forest', kind: 'ambience' });
});
