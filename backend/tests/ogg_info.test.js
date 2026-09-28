const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { inspectOgg, checkClipBuffer, AUDIO_SIZE_CAPS } = require('../src/services/oggInfo');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures/audio', f));

test('inspectOgg reads sample rate and duration from a real Vorbis file', () => {
  const r = inspectOgg(fx('tone.ogg'));
  assert.equal(r.ok, true);
  assert.equal(r.sampleRate, 44100);
  // Not derived from the fixture's own bytes by the same code path: 2 s is
  // what ffmpeg was told to make.
  assert.ok(Math.abs(r.durationMs - 2000) < 30, `durationMs ${r.durationMs} is not ~2000`);
});

test('inspectOgg rejects WAV, HTML, empty and truncated input', () => {
  assert.match(inspectOgg(fx('tone.wav')).error, /not an OGG/i);
  assert.match(inspectOgg(Buffer.from('<html>502 Bad Gateway</html>')).error, /not an OGG/i);
  assert.match(inspectOgg(Buffer.alloc(0)).error, /not an OGG/i);
  assert.equal(inspectOgg(fx('tone.ogg').subarray(0, 40)).ok, false, 'a header-only prefix has no duration');
});

test('checkClipBuffer enforces the per-kind size cap', () => {
  const big = Buffer.concat([fx('tone.ogg'), Buffer.alloc(AUDIO_SIZE_CAPS.sfx)]);
  assert.match(checkClipBuffer(big, 'sfx').error, /too large/i);
  assert.equal(checkClipBuffer(fx('tone.ogg'), 'ambience').ok, true);
  assert.match(checkClipBuffer(fx('tone.ogg'), 'speech').error, /kind/i);
});
