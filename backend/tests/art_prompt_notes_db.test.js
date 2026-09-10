const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const notes = require('../src/services/artPromptNotes.js');
const { buildObjectPrompt } = require('../src/services/objectPrompt.js');

// SOMET-548. Per-subject prompt corrections.
//
// THE VACUOUS TEST HERE WOULD BE "a note is stored". Storage is the easy half
// and proves nothing an operator cares about. What matters is that an active
// note REACHES THE PROMPT, that a revoked one does NOT, and that corrections
// sit in the position where the model will actually honour them.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'writes art_prompt_notes')) return;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    // Own table, own key prefix -- no shared-claim problem, so no advisory lock.
    await pool.query("DELETE FROM art_prompt_notes WHERE subject_key LIKE 'nt_%'");
    try {
      await body(t, pool);
    } finally {
      await pool.query("DELETE FROM art_prompt_notes WHERE subject_key LIKE 'nt_%'").catch(() => {});
    }
  });
}

// --- The composition, which is the point ----------------------------------

test('a correction reaches the prompt, and lands BEFORE the styling', () => {
  const p = buildObjectPrompt('a darts', {
    backdrop: 'flat solid neutral grey background',
    corrections: ['throwing darts, not a dartboard'],
  });
  assert.match(p, /throwing darts, not a dartboard/);
  // Placement is load-bearing, not cosmetic. The exclusions lead because this
  // model answers a bare subject with a tileset; a correction appended after
  // the styling would sit in the weakest position in the prompt -- exactly
  // where an instruction written BECAUSE the model ignored the intent is least
  // likely to be honoured.
  assert.ok(p.indexOf('throwing darts') < p.indexOf('pixel art RPG game asset'),
    'corrections must precede the styling block');
  assert.ok(p.indexOf('no other objects') < p.indexOf('throwing darts'),
    'and sit with the exclusions, after them');
});

test('no corrections leaves the prompt byte-for-byte unchanged', () => {
  // Every existing caller passes no corrections. If this drifts, every subject
  // in the catalogue silently changes prompt.
  const withNone = buildObjectPrompt('a sword', { backdrop: 'X' });
  const withEmpty = buildObjectPrompt('a sword', { backdrop: 'X', corrections: [] });
  const withBlank = buildObjectPrompt('a sword', { backdrop: 'X', corrections: ['', '  '] });
  assert.equal(withEmpty, withNone);
  assert.equal(withBlank, withNone, 'blank notes must not leave a dangling comma');
});

test('several corrections are joined in order', () => {
  const p = buildObjectPrompt('a wand', { corrections: ['first fix', 'second fix'] });
  assert.ok(p.indexOf('first fix') < p.indexOf('second fix'));
});

// --- Storage --------------------------------------------------------------

dbTest('an active note is returned for composition; a revoked one is not', async (t, pool) => {
  const a = await notes.create(pool, 'item', 'nt_wand', { note: 'no shadow beneath it' });
  await notes.create(pool, 'item', 'nt_wand', { note: 'wooden, not metal' });

  let active = await notes.listActive(pool, 'item', 'nt_wand');
  assert.equal(active.length, 2);

  assert.equal(await notes.deactivate(pool, a.id), true);
  active = await notes.listActive(pool, 'item', 'nt_wand');
  assert.deepEqual(active.map((n) => n.note), ['wooden, not metal'],
    'a revoked note must stop reaching the prompt');

  // But it must still be READABLE: the generation history records prompts that
  // contained it, and a prompt nobody can explain is not much of a record.
  const all = await notes.listAll(pool, 'item', 'nt_wand');
  assert.equal(all.length, 2, 'deactivating is not deleting');
  assert.equal(all.find((n) => n.id === a.id).active, false);
});

dbTest('active notes come back oldest-first, so the prompt is stable', async (t, pool) => {
  await notes.create(pool, 'item', 'nt_order', { note: 'one' });
  await notes.create(pool, 'item', 'nt_order', { note: 'two' });
  const active = await notes.listActive(pool, 'item', 'nt_order');
  // Stability matters more than recency: an unstable prompt makes two runs
  // incomparable, which defeats the history this feature sits next to.
  assert.deepEqual(active.map((n) => n.note), ['one', 'two']);
});

dbTest('an empty note is refused rather than stored as a no-op', async (t, pool) => {
  assert.equal(await notes.create(pool, 'item', 'nt_empty', { note: '   ' }), null);
  assert.equal((await notes.listAll(pool, 'item', 'nt_empty')).length, 0);
});

dbTest('a note is capped rather than allowed to swamp the prompt', async (t, pool) => {
  const created = await notes.create(pool, 'item', 'nt_long', { note: 'x'.repeat(1000) });
  assert.equal(created.note.length, notes.MAX_NOTE);
});

// --- The region -----------------------------------------------------------

test('a region is normalised to the unit square, or dropped', () => {
  assert.deepEqual(notes.normaliseRegion({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }),
    { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  // Out of range is clamped, not rejected: a drag that ran off the edge still
  // says something true about where the problem is.
  assert.deepEqual(notes.normaliseRegion({ x: -1, y: 2, w: 0.5, h: 0.5 }),
    { x: 0, y: 1, w: 0.5, h: 0.5 });
  // Malformed drops the REGION but the caller still keeps the note -- the words
  // are the valuable half, and losing them over a bad box would be the wrong
  // trade.
  assert.equal(notes.normaliseRegion({ x: 'a', y: 0, w: 1, h: 1 }), null);
  assert.equal(notes.normaliseRegion({ x: 0, y: 0, w: 0, h: 1 }), null);
  assert.equal(notes.normaliseRegion(null), null);
  assert.equal(notes.normaliseRegion('nope'), null);
});

dbTest('a malformed region does not lose the note', async (t, pool) => {
  const created = await notes.create(pool, 'item', 'nt_badbox', {
    note: 'no shadow', region: { x: 'nonsense' },
  });
  assert.equal(created.note, 'no shadow');
  assert.equal(created.region, null);
});

// --- SOMET-549: the marked box, said in words -----------------------------

test('a region becomes a phrase a diffusion model has actually seen', () => {
  // The case that motivated the whole feature: a shadow blob under `darts`.
  assert.equal(notes.regionPhrase({ x: 0.4, y: 0.75, w: 0.2, h: 0.2 }),
    'beneath the subject');
  assert.equal(notes.regionPhrase({ x: 0.4, y: 0.05, w: 0.2, h: 0.2 }), 'above the subject');
  assert.equal(notes.regionPhrase({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), 'in the centre');
  assert.equal(notes.regionPhrase({ x: 0.05, y: 0.05, w: 0.2, h: 0.2 }), 'in the top-left');
});

test('a wide short box is a band, not a corner', () => {
  // What a shadow under an object actually looks like when dragged.
  assert.equal(notes.regionPhrase({ x: 0.05, y: 0.78, w: 0.9, h: 0.15 }), 'along the bottom');
  assert.equal(notes.regionPhrase({ x: 0.02, y: 0.1, w: 0.2, h: 0.8 }), 'down the left side');
});

// THE DEGENERATE CASE, and the one most likely to be got wrong: a box over the
// whole image says nothing about POSITION. Inventing "in the centre" from it
// would put an instruction in the prompt that the operator never meant.
test('a box covering the frame produces NO positional phrase', () => {
  assert.equal(notes.regionPhrase({ x: 0, y: 0, w: 1, h: 1 }), null);
  assert.equal(notes.regionPhrase({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }), null);
});

test('a malformed or absent region produces no phrase rather than throwing', () => {
  assert.equal(notes.regionPhrase(null), null);
  assert.equal(notes.regionPhrase({ x: 'a', y: 0, w: 1, h: 1 }), null);
  assert.equal(notes.regionPhrase({ x: 0, y: 0, w: 0, h: 0 }), null);
});

test('noteToCorrection joins the words with the place, and survives either missing', () => {
  // w 0.4 is below the 0.6 band threshold, so this is a small box under the
  // subject rather than a strip across the frame -- "beneath the subject" is
  // the phrase, and it is the better one for a shadow blob.
  assert.equal(
    notes.noteToCorrection({ note: 'grey shadow', region: { x: 0.3, y: 0.8, w: 0.4, h: 0.15 } }),
    'grey shadow beneath the subject',
  );
  // Widen the same box past the threshold and it becomes a band.
  assert.equal(
    notes.noteToCorrection({ note: 'grey shadow', region: { x: 0.05, y: 0.8, w: 0.9, h: 0.15 } }),
    'grey shadow along the bottom',
  );
  // No region: the words alone are a perfectly good correction.
  assert.equal(notes.noteToCorrection({ note: 'wrong subject', region: null }), 'wrong subject');
  // No words: nothing. A bare box cannot say WHAT is wrong, only where, and
  // "beneath the subject" alone in a prompt is noise.
  assert.equal(notes.noteToCorrection({ note: '  ', region: { x: 0, y: 0.8, w: 1, h: 0.2 } }), '');
  assert.equal(notes.noteToCorrection(null), '');
});

// --- Two routes, not one (SOMET-558) --------------------------------------
//
// THE VACUOUS TEST HERE would assert that `kind` is stored. What matters is
// that an 'avoid' note leaves the POSITIVE prompt entirely and turns up in the
// negative terms instead -- storing a column that nothing reads is precisely
// the shape of dead feature this repo keeps finding green.
dbTest('an avoid note leaves the positive prompt and becomes a negative term',
  async (t, pool) => {
    await notes.create(pool, 'item', 'nt_darts', { note: 'throwing darts, not a dartboard' });
    await notes.create(pool, 'item', 'nt_darts', { note: 'grey shadow', kind: 'avoid' });

    const active = await notes.listActive(pool, 'item', 'nt_darts');
    // Precondition: the kind must survive the round trip, or the split below
    // is measuring a default rather than a decision.
    assert.deepEqual(active.map((n) => n.kind).sort(), ['avoid', 'reshape']);

    const { corrections, avoid } = notes.splitNotes(active);
    assert.deepEqual(avoid, ['grey shadow']);
    assert.deepEqual(corrections, ['throwing darts, not a dartboard']);

    // The end of the chain: the composed prompt must not contain the excluded
    // word at all. Appending "grey shadow" to a positive prompt is what
    // conditions a shadow IN, which is the defect this replaces.
    const prompt = buildObjectPrompt('three throwing darts', { corrections });
    assert.ok(prompt.includes('throwing darts, not a dartboard'));
    assert.ok(!prompt.includes('grey shadow'),
      'an exclusion in the positive prompt conditions the thing it names IN');
  });

// The default is load-bearing: every note written before this column existed
// must keep reaching the prompt exactly as it did.
dbTest('a note written with no kind still reshapes, as every existing note does',
  async (t, pool) => {
    const made = await notes.create(pool, 'item', 'nt_arrow', { note: 'fletched wooden shaft' });
    assert.equal(made.kind, 'reshape');
    const { corrections, avoid } = notes.splitNotes(await notes.listActive(pool, 'item', 'nt_arrow'));
    assert.deepEqual(corrections, ['fletched wooden shaft']);
    assert.deepEqual(avoid, []);
  });

// An unknown kind must not lose the operator's words.
dbTest('an unrecognised kind falls back to reshape rather than being refused',
  async (t, pool) => {
    const made = await notes.create(pool, 'item', 'nt_arrow', { note: 'steel broadhead', kind: 'nonsense' });
    assert.equal(made.kind, 'reshape', 'the CHECK constraint must never be reached with junk');
    assert.equal(made.note, 'steel broadhead');
  });

// THE REGION IS DROPPED for an avoid note, and that is deliberate. "beneath
// it" is a spatial instruction that only means something beside a description;
// a negative prompt is an unordered bag of terms to steer away from, so the
// region phrase would add the words "beneath it" to the things being avoided.
dbTest('an avoid note contributes its words without its region phrase', async (t, pool) => {
  // Its OWN subject key, and the nt_ prefix that dbTest's cleanup matches --
  // without the prefix nothing is deleted, rows accumulate across runs, and
  // which case fails depends on how many times the file has been run.
  await notes.create(pool, 'item', 'nt_shadow', {
    note: 'grey shadow', kind: 'avoid', region: { x: 0.3, y: 0.72, w: 0.25, h: 0.16 },
  });
  const active = await notes.listActive(pool, 'item', 'nt_shadow');
  assert.equal(active.length, 1, 'precondition: exactly this note');
  assert.ok(active[0].region, 'precondition: the region must actually be stored');
  const { avoid } = notes.splitNotes(active);
  assert.deepEqual(avoid, ['grey shadow']);
  // Proof the region phrase exists and was deliberately not used, rather than
  // this passing because regionPhrase happened to return nothing.
  assert.ok(notes.regionPhrase(active[0].region), 'regionPhrase must be non-empty here');
});
