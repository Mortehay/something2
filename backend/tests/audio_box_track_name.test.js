// backend/tests/audio_box_track_name.test.js
//
// Pure unit coverage for audioRoutes.boxTrackName (SOMET-590 review fix). No
// DB, no network -- it only needs to prove the name the box's ledger indexes
// generations by never collides for two different (subject_kind, subject_key,
// slot, seed) tuples the admin UI can legally send, even when subject_key
// runs up to its 200-char limit or differs only in characters the slug strips.
const test = require('node:test');
const assert = require('node:assert');
const { boxTrackName } = require('../src/api/audioRoutes.js');

test('boxTrackName', async (t) => {
  await t.test('keys that differ only in slugged-away characters get different names', () => {
    const a = boxTrackName('world', 'Dark Wood', 'music', 11);
    const b = boxTrackName('world', 'Dark.Wood', 'music', 11);
    assert.notEqual(a, b);
  });

  await t.test('a long key with two different seeds gives two different names, both ending in their seed', () => {
    const key = 'w'.repeat(150);
    const a = boxTrackName('world', key, 'music', 111111);
    const b = boxTrackName('world', key, 'music', 222222);
    assert.notEqual(a, b);
    assert.ok(a.endsWith('-111111'), a);
    assert.ok(b.endsWith('-222222'), b);
  });

  await t.test('two long keys sharing their first 120 chars still give different names', () => {
    const prefix = 'x'.repeat(120);
    const a = boxTrackName('world', `${prefix}AAAA`, 'music', 7);
    const b = boxTrackName('world', `${prefix}BBBB`, 'music', 7);
    assert.notEqual(a, b);
  });

  await t.test('every name is <= 120 chars and box-safe', () => {
    const cases = [
      boxTrackName('world', 'x'.repeat(200), 'ambience', 999999999),
      boxTrackName('biome', 'Dark Wood', 'ambience', 1),
      boxTrackName('world', 'a'.repeat(200), 'music', 2147483646),
    ];
    for (const name of cases) {
      assert.ok(name.length <= 120, `${name} (${name.length} chars)`);
      assert.match(name, /^[a-zA-Z0-9_-]+$/, name);
    }
  });
});
