const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const store = require('../src/services/audioPrompts');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audioPrompts store', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const key = `ap-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [key]); } finally { await pool.end(); }
  });

  assert.equal(await store.getActive(pool, 'world', key, 'music'), null);

  const a = await store.save(pool, 'world', key, 'music', {
    style: 'village', text: '  calm lute  ', sourceInput: 'ctx-1', model: 'qwen', via: 'box',
  });
  assert.equal(a.text, 'calm lute', 'trimmed');
  assert.deepEqual([a.style, a.source_input, a.model, a.via], ['village', 'ctx-1', 'qwen', 'box']);

  const b = await store.save(pool, 'world', key, 'music', { style: 'village', text: '' }, { expectActiveId: a.id });
  assert.equal(b.text, '', "'' is stored, not turned into null");
  assert.equal(b.source_input, null, 'hand-written row has no source_input');
  assert.equal((await store.getActive(pool, 'world', key, 'music')).id, b.id);

  const long = await store.save(pool, 'world', key, 'music', { text: 'x'.repeat(1200) });
  assert.equal(long.text.length, store.MAX_PROMPT_TEXT);

  await assert.rejects(
    store.save(pool, 'world', key, 'music', { text: 'stale edit' }, { expectActiveId: a.id }),
    (err) => err.status === 409, 'an edit based on a superseded row is refused');

  // Race: two saves with no expectActiveId at the same time -- both may not
  // win, and the loser must be a 409, never a 500.
  const results = await Promise.allSettled([
    store.save(pool, 'world', key, 'ambience', { text: 'one' }),
    store.save(pool, 'world', key, 'ambience', { text: 'two' }),
  ]);
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.status, 409, r.reason.message);
  const active = await pool.query(
    "SELECT count(*)::int AS n FROM audio_prompts WHERE subject_key = $1 AND slot = 'ambience' AND active", [key]);
  assert.equal(active.rows[0].n, 1);

  const bySlot = await store.listForSubject(pool, 'world', key);
  assert.equal(bySlot.music.active.id, long.id);
  // Only `a` and `b` were ever committed as superseded; the 409 above never
  // wrote a row (a conflict is refused, not recorded), so history is 2.
  assert.equal(bySlot.music.history.length, 2, 'two superseded music rows');
  assert.ok((await store.listAllActive(pool)).some((r) => r.subject_key === key && r.slot === 'music'));
});
