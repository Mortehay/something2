// SOMET-722. The checked-in sound files and the lists that name them must agree. A file nothing lists never reaches a
// board, and the seed had no way to say so: 2,258 of 7,202 sounds went missing behind "0 missing files".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { AUDIO_SEEDS_ROOT, AUDIO_KINDS, audioSeedLists } = require('../src/services/audioSeed.js');

test('every checked-in .ogg is listed, every listed file exists, and every binding has its clip', () => {
  const { clips, bindings } = audioSeedLists({ root: AUDIO_SEEDS_ROOT });
  assert.ok(clips.length > 0, 'the real lists were read');

  const listed = new Set(clips.map((c) => c.file));
  const onDisk = AUDIO_KINDS.flatMap((kind) => fs.readdirSync(path.join(AUDIO_SEEDS_ROOT, kind))
    .filter((f) => f.endsWith('.ogg')).map((f) => `${kind}/${f}`));
  assert.ok(onDisk.length > 0, 'the real files were read');

  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [], 'files on disk that no list names');
  assert.deepEqual([...listed].filter((f) => !onDisk.includes(f)), [], 'listed files that are not on disk');
  assert.equal(listed.size, clips.length, 'two clips share one file');

  const ids = new Set(clips.map((c) => c.id));
  assert.equal(ids.size, clips.length, 'a clip is listed twice');
  assert.deepEqual(bindings.filter((b) => !ids.has(b.clip_id)), [], 'bindings pointing at no clip');
});
